// Telling a user we did NOT hold the site we promised to hold.
//
// THE INCIDENT (2026-08-07, first real run of the day-before flow). Offered 05:26, tapped
// 06:00, site released at 08:00 exactly as predicted — and the mini-PC runner never
// picked it up. Six hours later the row still read `requested`, `updated_at` unchanged
// since the tap: no cart, no `failed`, no error, and no word to the user, who had been
// told "you'll get a text when it's in the cart".
//
// Run: npm test  (real DB, like the other hold suites)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, requestHold, markCarted } from '../src/lib/rc-holds';
import { failMissedHolds, HOLD_MISS_GRACE_MIN } from './expire-holds';

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
  assert.ok(u && c);
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
    arrivalDate: '2026-09-04', nights: 1, releaseAt,
  });

/** The real sweep, scoped to one row so `npm test` cannot fail live users' holds. */
const sweep = (id: string) => failMissedHolds([id]);

test('a requested hold whose release passed long ago is failed, not left silent', async () => {
  await offer('8001', pacific(-(HOLD_MISS_GRACE_MIN + 120)));
  // requestHold refuses a past release (correctly), so reproduce the real sequence:
  // tapped while the release was still ahead, then time passed.
  await mutate(
    `UPDATE rc_hold_requests SET status = 'requested', requested_at = NOW()
      WHERE watch_id = $1 AND unit_id = '8001'`, [watchId]);
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '8001'`, [watchId]);

  const missed = await sweep(row.id);
  assert.equal(missed.length, 1, 'the whole point: this must not sit at `requested` forever');
  assert.equal(missed[0].unit_name, '#L8001', 'the caller needs enough to notify the user');
  const [after] = await query<{ status: string; error: string | null }>(
    `SELECT status, error FROM rc_hold_requests WHERE id = $1`, [row.id]);
  assert.equal(after.status, 'failed');
  assert.ok(after.error, 'a failure with no reason recorded is the bug one level up');
});

test('a hold still inside the grace is LEFT ALONE — the runner may yet take it', async () => {
  // Sweeping earlier than the feed gives up would tell the user "we couldn't" and then
  // cart it anyway. The grace must stay wider than dueHolds' 20-minute window.
  assert.ok(HOLD_MISS_GRACE_MIN > 20, 'grace must exceed the feed grace, or the two disagree');
  await offer('8002', pacific(-5));
  await mutate(
    `UPDATE rc_hold_requests SET status = 'requested' WHERE watch_id = $1 AND unit_id = '8002'`,
    [watchId]);
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '8002'`, [watchId]);
  assert.equal((await sweep(row.id)).length, 0);
});

test('a FUTURE release is never swept', async () => {
  // The timezone trap: `release_at` is zone-less Pacific text. Compare it as a Date on a
  // UTC worker and "8am Pacific tomorrow" reads as seven hours earlier than it is, which
  // would fail live holds hours before their moment.
  await offer('8003', pacific(180));
  const req = await requestHold(watchId, '8003');
  assert.ok(req);
  assert.equal((await sweep(req!.id)).length, 0, 'a hold three hours out is not missed');
});

test('an OFFERED hold is not "missed" — nobody promised anything', async () => {
  // We only owe an apology where we made a commitment. An unanswered offer is the opt-in
  // working; expireStaleHolds marks those `expired`, quietly and correctly.
  await offer('8004', pacific(-(HOLD_MISS_GRACE_MIN + 60)));
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '8004'`, [watchId]);
  assert.equal((await sweep(row.id)).length, 0);
});

test('a hold that WAS carted is never reported as missed', async () => {
  await offer('8005', pacific(30));
  const req = await requestHold(watchId, '8005');
  await markCarted(req!.id, 'ck', 'ek');
  await mutate(
    `UPDATE rc_hold_requests SET release_at = $2 WHERE id = $1`,
    [req!.id, pacific(-(HOLD_MISS_GRACE_MIN + 60))]);
  assert.equal((await sweep(req!.id)).length, 0, 'success must not be apologised for');
});
