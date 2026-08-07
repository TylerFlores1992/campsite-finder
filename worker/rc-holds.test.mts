// The opt-in hold state machine.
//
// Run: npm test  (hits the REAL database, like claim.test.mts — the interesting logic
// lives inside the SQL, so a mock would test a fake.)
//
// The rule these exist to protect: **only `requested` authorises the bot to cart.** An
// `offered` row is a question nobody answered, and carting one would take a site off the
// market that no user asked for — the exact behaviour this whole design exists to avoid.
//
// SAFETY: the fixture watch is dated 2020 so the poller's `end_date > CURRENT_DATE`
// filter can never see it, and every row is deleted on the way out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, requestHold, dueHolds, markCarted, markClaimed, expireStaleHolds } from '../src/lib/rc-holds';

let watchId: string;
let userId: string;
let campgroundId: string;

/** RC's own format: Pacific wall-clock, no zone. */
const pacific = (offsetMinutes: number) => {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
};

before(async () => {
  const [u] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const [c] = await query<{ id: string }>(`SELECT id FROM campgrounds WHERE source = 'reservecalifornia' ORDER BY id LIMIT 1`);
  assert.ok(u && c, 'need a user and an RC campground to hang fixtures off');
  userId = u.id; campgroundId = c.id;
  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [userId, campgroundId],
  );
  watchId = w.id;
});

after(async () => {
  if (watchId) {
    await mutate(`DELETE FROM rc_hold_requests WHERE watch_id = $1`, [watchId]).catch(() => {});
    await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]).catch(() => {});
  }
});

const offer = (unitId: string, releaseAt: string) =>
  offerHold({
    watchId, userId, campgroundId, unitId, unitName: `#L${unitId}`,
    arrivalDate: '2026-09-04', nights: 2, releaseAt,
  });

test('an offer is created, and re-offering the same opening does not duplicate it', async () => {
  const a = await offer('9001', pacific(120));
  const b = await offer('9001', pacific(120));
  assert.ok(a, 'first offer should insert');
  assert.equal(b, a, 're-alerting the same opening must update, not stack a second row');
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '9001'`, [watchId]);
  assert.equal(Number(rows[0].n), 1);
});

test('an OFFERED hold is never due — nobody asked for it', async () => {
  // The whole point. This row's release time is imminent, and it must still be invisible
  // to the bot, because the user never tapped.
  await offer('9002', pacific(1));
  const due = await dueHolds(120, 20);
  assert.equal(due.some((h) => h.unit_id === '9002'), false, 'an unanswered offer must not authorise a cart');
});

test('tapping makes it requested, and only then is it due', async () => {
  await offer('9003', pacific(1));
  const req = await requestHold(watchId, '9003');
  assert.ok(req, 'the tap should find the open offer');
  assert.equal(req!.status, 'requested');
  const due = await dueHolds(120, 20);
  assert.equal(due.some((h) => h.unit_id === '9003'), true);
});

test('a tap on an offer whose release has PASSED does nothing', async () => {
  // Someone opens yesterday's email. Queueing a cart for an opening that has been and
  // gone would hold a site for a stay nobody is watching any more.
  await offer('9004', pacific(-180));
  assert.equal(await requestHold(watchId, '9004'), null);
});

test('a tap for a unit with no offer at all does nothing', async () => {
  assert.equal(await requestHold(watchId, 'no-such-unit'), null);
});

test('re-alerting must NOT walk a requested hold back to offered', async () => {
  // The poller re-offers on every coming-soon alert. If that reset the status, a user
  // who had already tapped would silently lose their answer and never get the site.
  await offer('9005', pacific(90));
  await requestHold(watchId, '9005');
  await offer('9005', pacific(90));
  const [row] = await query<{ status: string }>(
    `SELECT status FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '9005'`, [watchId]);
  assert.equal(row.status, 'requested', 'a later alert must not discard the tap');
});

test('a carted hold records how to RELEASE it, not just that we hold it', async () => {
  await offer('9006', pacific(30));
  const req = await requestHold(watchId, '9006');
  await markCarted(req!.id, 'cart-key-abc', 'entry-key-def');
  const [row] = await query<{ status: string; cart_key: string; cart_entry_key: string }>(
    `SELECT status, cart_key, cart_entry_key FROM rc_hold_requests WHERE id = $1`, [req!.id]);
  assert.equal(row.status, 'carted');
  // Without the ENTRY key we could only empty the whole cart, dropping every other
  // user's hold along with this one.
  assert.equal(row.cart_entry_key, 'entry-key-def');
  await markClaimed(req!.id);
  const [after] = await query<{ status: string }>(`SELECT status FROM rc_hold_requests WHERE id = $1`, [req!.id]);
  assert.equal(after.status, 'claimed');
});

test('a carted hold nobody claimed is surfaced for RELEASE, not left sitting', async () => {
  await offer('9007', pacific(30));
  const req = await requestHold(watchId, '9007');
  await markCarted(req!.id, 'cart-key-xyz', 'entry-key-xyz');
  await mutate(`UPDATE rc_hold_requests SET carted_at = NOW() - interval '90 minutes' WHERE id = $1`, [req!.id]);
  const { toRelease } = await expireStaleHolds(45);
  assert.equal(toRelease.some((h) => h.id === req!.id), true,
    'holding a site the user never came for is the inventory-grabbing this design avoids');
});

test('an unanswered offer past its release is expired', async () => {
  await offer('9008', pacific(-240));
  await expireStaleHolds(45);
  const [row] = await query<{ status: string }>(
    `SELECT status FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '9008'`, [watchId]);
  assert.equal(row.status, 'expired');
});

// ── The claim handshake ──────────────────────────────────────────────────────────
// Only the session that made a cart entry can remove it, so a claim is a two-party
// swap across a polling boundary. These cover the states that make it safe.

test('only a CARTED hold can be claimed — there is nothing else to hand over', async () => {
  const { startClaim } = await import('../src/lib/rc-holds');
  await offer('9101', pacific(60));
  const req = await requestHold(watchId, '9101');
  // Requested but not yet carted: pressing claim must not pretend we hold something.
  const early = await startClaim(req!.id);
  assert.equal(early?.status, 'requested', 'a requested-but-uncarted hold is not claimable');
});

test('a double-tap is a no-op, not an error', async () => {
  const { startClaim } = await import('../src/lib/rc-holds');
  await offer('9102', pacific(60));
  const req = await requestHold(watchId, '9102');
  await markCarted(req!.id, 'ck', 'ek');
  const first = await startClaim(req!.id);
  const second = await startClaim(req!.id);
  assert.equal(first?.status, 'claiming');
  assert.equal(second?.status, 'claiming', 'a second tap on a phone is normal, not a failure');
});

test('a claim shows up in the URGENT lane, and release marks it released', async () => {
  const { startClaim, pendingClaims, markReleased } = await import('../src/lib/rc-holds');
  await offer('9103', pacific(60));
  const req = await requestHold(watchId, '9103');
  await markCarted(req!.id, 'ck', 'ek');
  await startClaim(req!.id);
  const pending = await pendingClaims();
  assert.equal(pending.some((h) => h.id === req!.id), true, 'the bot must see it immediately');
  await markReleased(req!.id);
  const [row] = await query<{ status: string; released_at: string | null }>(
    `SELECT status, released_at FROM rc_hold_requests WHERE id = $1`, [req!.id]);
  assert.equal(row.status, 'released');
  assert.ok(row.released_at, 'the exposure window starts here — it must be recorded');
});

test('markCarted reports the TRANSITION, so the "held" alert fires once', async () => {
  // The runner re-reads its feed every pass. Without this, a hold it already carted
  // would text the user again on every single pass — the same bug as alerting on the
  // state rather than the transition (migration 039).
  await offer('9104', pacific(60));
  const req = await requestHold(watchId, '9104');
  assert.equal(await markCarted(req!.id, 'ck', 'ek'), true, 'first carting is the transition');
  assert.equal(await markCarted(req!.id, 'ck', 'ek'), false, 'a repeat must not re-alert');
});
