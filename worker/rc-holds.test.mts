// The opt-in hold state machine.
//
// Run: npm test  (hits the REAL database, like claim.test.mts — the interesting logic
// lives inside the SQL, so a mock would test a fake.)
//
// The rule these exist to protect: **only `requested` authorises the bot to cart.** An
// `offered` row is a question nobody answered, and carting one would take a site off the
// market that no user asked for — the exact behaviour this whole design exists to avoid.
//
// SAFETY, AND THE FIRST VERSION OF THIS PARAGRAPH WAS WRONG (2026-08-15).
//
// It said: "the fixture watch is dated 2020 so the poller's `end_date > CURRENT_DATE` filter
// can never see it, and every row is deleted on the way out." Both halves are true and
// neither protects against the thing that actually happened.
//
// The danger here is not the poller, it is the RC HOLD RUNNER on the mini-PC. `dueHolds`
// selects `requested` rows by `release_at` alone - it does not join `watches` and does not
// care whether the watch is active or dated 2020 - so a fixture in `requested` state near its
// release time is handed to the production runner as an instruction to CART THAT UNIT. The
// 2020 dates buy nothing on that path. That left "we delete on the way out" as the whole
// protection, and an aborted run is exactly the case that skips it.
//
// It bit on 2026-08-15. A run died between its first minute and its `after()`, leaving four
// `requested` fixtures with NUMERIC unit ids on a real ReserveCalifornia campground. The
// production runner picked them up and tried to cart unit 9003 at Westport-Union Landing SB
// every 15 seconds for the next quarter of an hour. Nothing was locked only because the RC
// session happened to be dead - luck, not design. It was visible as a second symptom too: the
// runner asks the keep-warm for the Chromium profile on every attempt, so the RC browser
// opened and closed on a ~20s beat and the session could never stay alive.
//
// SO THE UNIT IDS ARE NON-NUMERIC NOW (`U()` below), which is the same rule
// `scripts/rc-test-hold.mts` already follows and for the same reason: a real RC unit id is
// numeric, so a sentinel cannot collide with a real site. That holds even DURING a run,
// which cleanup-on-exit never could - the runner polls every 15s and a run lasts longer
// than that. `before()` also sweeps anything a previous aborted run left, so the failure
// self-heals on the next run instead of waiting for someone to notice.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, requestHold, dueHolds, markCarted, markClaimed, expireStaleHolds, noteAttempt, recordSessionHealth, reportCartFailure } from '../src/lib/rc-holds';

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

/**
 * THE FIXTURE UNIT ID, AND IT MUST NEVER BE NUMERIC.
 *
 * Real ReserveCalifornia unit ids are numbers. `dueHolds` hands a `requested` row straight to
 * the production hold runner, which POSTs the unit id to RC's precart - so a numeric fixture
 * id is an instruction to lock whatever real site happens to carry that number. A sentinel is
 * refused by RC, which makes the whole class of accident impossible rather than merely
 * cleaned up afterwards. Same rule, same reason, as `scripts/rc-test-hold.mts`.
 *
 * Kept short and obviously not-a-unit so it is recognisable in `rc-holds-readout.mts` output.
 */
const U = (n: string) => `__trh${n}`;

before(async () => {
  // SWEEP FIRST. A run that dies before `after()` leaves its fixtures behind, and until
  // 2026-08-15 they sat there being retried by the production runner until a human noticed.
  // Doing this on the way IN means the next run repairs the last one - the cheapest possible
  // moment, and one that does not depend on anybody reading a dashboard.
  //
  // Matched on the sentinel, never on the watch id: the leaked rows belong to a PREVIOUS
  // run's watch, which this process has never seen. Deleted rather than expired so a rerun
  // starts from the same blank slate `after()` would have left.
  // AGE-GATED, BECAUSE A SWEEP CANNOT TELL LITTER FROM A LIVE RUN BY THE ID ALONE (#76).
  // `npm test` runs on every push, so two CI runs overlap routinely — and before this,
  // a starting run DELETED a running one's working set, then logged "swept N fixture(s)
  // left by an earlier run", which reads as self-healing at the exact moment it is
  // destroying a live run. The victim died on a null several statements from the cause.
  // `offered_at` is the row's birth time and no status change moves it, so a concurrent
  // run's rows are seconds old and protected while real litter is minutes old.
  const swept = await mutate<{ id: string }>(
    `DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_trh%'
       AND offered_at < NOW() - interval '10 minutes' RETURNING id`,
  ).catch(() => []);
  if (swept.length) console.log(`swept ${swept.length} hold fixture(s) left by an earlier run`);

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
  // ONE `pacific(120)`, NOT TWO — and it is the release that makes it "the same opening".
  // `pacific()` reads Date.now() and formats to the second, so two calls straddle a second
  // boundary now and then. Since migration 074 put `release_at` in the unique key, two
  // strings a second apart are two DIFFERENT releases and correctly get two rows: the
  // fixture was describing "the same opening" with a value that was not stable across the
  // two calls. The property being asserted is unchanged and is now actually exercised.
  const release = pacific(120);
  const a = await offer(U('9001'), release);
  const b = await offer(U('9001'), release);
  assert.ok(a, 'first offer should insert');
  assert.equal(b, a, 're-alerting the same opening must update, not stack a second row');
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('9001')]);
  assert.equal(Number(rows[0].n), 1);
});

test('an OFFERED hold is never due — nobody asked for it', async () => {
  // The whole point. This row's release time is imminent, and it must still be invisible
  // to the bot, because the user never tapped.
  await offer(U('9002'), pacific(1));
  const due = await dueHolds(120, 20);
  assert.equal(due.some((h) => h.unit_id === U('9002')), false, 'an unanswered offer must not authorise a cart');
});

test('tapping makes it requested, and only then is it due', async () => {
  await offer(U('9003'), pacific(1));
  const req = await requestHold(watchId, U('9003'));
  assert.ok(req, 'the tap should find the open offer');
  assert.equal(req!.status, 'requested');
  const due = await dueHolds(120, 20);
  assert.equal(due.some((h) => h.unit_id === U('9003')), true);
});

test('a tap on an offer whose release has PASSED does nothing', async () => {
  // Someone opens yesterday's email. Queueing a cart for an opening that has been and
  // gone would hold a site for a stay nobody is watching any more.
  await offer(U('9004'), pacific(-180));
  assert.equal(await requestHold(watchId, U('9004')), null);
});

test('a tap for a unit with no offer at all does nothing', async () => {
  assert.equal(await requestHold(watchId, 'no-such-unit'), null);
});

test('re-alerting must NOT walk a requested hold back to offered', async () => {
  // The poller re-offers on every coming-soon alert. If that reset the status, a user
  // who had already tapped would silently lose their answer and never get the site.
  await offer(U('9005'), pacific(90));
  await requestHold(watchId, U('9005'));
  await offer(U('9005'), pacific(90));
  const [row] = await query<{ status: string }>(
    `SELECT status FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('9005')]);
  assert.equal(row.status, 'requested', 'a later alert must not discard the tap');
});

test('a carted hold records how to RELEASE it, not just that we hold it', async () => {
  await offer(U('9006'), pacific(30));
  const req = await requestHold(watchId, U('9006'));
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
  await offer(U('9007'), pacific(30));
  const req = await requestHold(watchId, U('9007'));
  await markCarted(req!.id, 'cart-key-xyz', 'entry-key-xyz');
  await mutate(`UPDATE rc_hold_requests SET carted_at = NOW() - interval '90 minutes' WHERE id = $1`, [req!.id]);
  const { toRelease } = await expireStaleHolds(45);
  assert.equal(toRelease.some((h) => h.id === req!.id), true,
    'holding a site the user never came for is the inventory-grabbing this design avoids');
});

test('an unanswered offer past its release is expired', async () => {
  await offer(U('9008'), pacific(-240));
  await expireStaleHolds(45);
  const [row] = await query<{ status: string }>(
    `SELECT status FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('9008')]);
  assert.equal(row.status, 'expired');
});

// ── The claim handshake ──────────────────────────────────────────────────────────
// Only the session that made a cart entry can remove it, so a claim is a two-party
// swap across a polling boundary. These cover the states that make it safe.

test('only a CARTED hold can be claimed — there is nothing else to hand over', async () => {
  const { startClaim } = await import('../src/lib/rc-holds');
  await offer(U('9101'), pacific(60));
  const req = await requestHold(watchId, U('9101'));
  // Requested but not yet carted: pressing claim must not pretend we hold something.
  const early = await startClaim(req!.id);
  assert.equal(early?.status, 'requested', 'a requested-but-uncarted hold is not claimable');
});

test('a double-tap is a no-op, not an error', async () => {
  const { startClaim } = await import('../src/lib/rc-holds');
  await offer(U('9102'), pacific(60));
  const req = await requestHold(watchId, U('9102'));
  await markCarted(req!.id, 'ck', 'ek');
  const first = await startClaim(req!.id);
  const second = await startClaim(req!.id);
  assert.equal(first?.status, 'claiming');
  assert.equal(second?.status, 'claiming', 'a second tap on a phone is normal, not a failure');
});

test('a claim shows up in the URGENT lane, and release marks it released', async () => {
  const { startClaim, pendingClaims, markReleased } = await import('../src/lib/rc-holds');
  await offer(U('9103'), pacific(60));
  const req = await requestHold(watchId, U('9103'));
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
  await offer(U('9104'), pacific(60));
  const req = await requestHold(watchId, U('9104'));
  assert.equal(await markCarted(req!.id, 'ck', 'ek'), true, 'first carting is the transition');
  assert.equal(await markCarted(req!.id, 'ck', 'ek'), false, 'a repeat must not re-alert');
});

test('a skipped pass is recorded WITHOUT closing the hold or touching updated_at', async () => {
  // THE 2026-08-07 BUG, as a test. The runner polled its feed happily all morning and
  // could not open Chromium, so `withRC` returned null on every pass and the row sat at
  // `requested` with `updated_at` frozen at the tap — byte-identical to a row no process
  // had ever looked at. That ambiguity is what made it undiagnosable six hours later.
  //
  // Three things must all hold, and each one has a way of being got wrong:
  //   • the note is recorded            (otherwise we are back to 08-07)
  //   • the STATUS does not move        (a skip must retry; `failed` would close a live
  //                                      hold and fire the missed-hold alert for nothing)
  //   • `updated_at` does NOT move      (that column means "the hold changed"; a failed
  //                                      attempt is not a change, and conflating them
  //                                      destroys the "unchanged since the tap" tell)
  await offer(U('9105'), pacific(60));
  const req = await requestHold(watchId, U('9105'));
  const [before] = await query<{ updated_at: string; status: string }>(
    `SELECT updated_at::text, status FROM rc_hold_requests WHERE id = $1`, [req!.id],
  );

  await noteAttempt([req!.id], 'RC session is dead — needs a human sign-in');

  const [after_] = await query<{ updated_at: string; status: string; last_attempt_note: string | null; last_attempt_at: string | null }>(
    `SELECT updated_at::text, status, last_attempt_note, last_attempt_at::text
       FROM rc_hold_requests WHERE id = $1`, [req!.id],
  );
  assert.match(after_.last_attempt_note ?? '', /session is dead/, 'the reason must be recorded');
  assert.ok(after_.last_attempt_at, 'and when it was tried');
  assert.equal(after_.status, before.status, 'a skip must NOT change status — it retries');
  assert.equal(after_.updated_at, before.updated_at, 'a failed attempt is not a change to the hold');
});

test('a hold that is still due is returned again after a skip — the retry is the point', async () => {
  // The corollary of the test above, and the reason `noteAttempt` is not `markFailed`:
  // recording why we could not act must leave the hold in the bot's queue. If a skip
  // dropped it out of `dueHolds`, a transient profile lock would permanently lose a site.
  const due = await dueHolds(60 * 60, 24 * 60);
  assert.ok(due.some((h) => h.unit_id === U('9105')), 'a noted hold is still due');
});

test('session health records both verdicts, and never invents one', async () => {
  // `unknown` is not reported at all (see rc-keepwarm's reportSession) — a busy profile,
  // a 403 from RC's edge and a network blip all mean "we could not tell", and writing
  // those as `false` would send the owner to do a human sign-in over a healthy session.
  // What this asserts is the storage contract underneath that: the column carries the
  // verdict it was given, and NULL is a real third state meaning nobody has said.
  const read = async () =>
    (await query<{ session_ok: boolean | null; session_source: string | null; session_detail: string | null }>(
      `SELECT session_ok, session_source, session_detail FROM rc_runner_heartbeat WHERE id = 1`,
    ))[0];
  const original = await read();

  await recordSessionHealth(false, 'RC rejected the token (401)', 'keepwarm');
  let now = await read();
  assert.equal(now.session_ok, false);
  assert.equal(now.session_source, 'keepwarm');
  assert.match(now.session_detail ?? '', /401/);

  await recordSessionHealth(true, null, 'runner');
  now = await read();
  assert.equal(now.session_ok, true, 'a later good verdict must clear a bad one');
  assert.equal(now.session_source, 'runner');

  // Put back whatever the real bot last said, so a test run cannot leave the dashboard
  // asserting something about production that a test made up.
  await recordSessionHealth(
    original.session_ok ?? true, original.session_detail, original.session_source ?? 'keepwarm',
  );
  if (original.session_ok == null) {
    await mutate(`UPDATE rc_runner_heartbeat SET session_ok = NULL, session_at = NULL,
                  session_detail = NULL, session_source = NULL WHERE id = 1`);
  }
});

test('a cart failure BEFORE the release is retryable, not final', async () => {
  // THE BUG THAT COST THE FIRST HOLD THAT GOT THIS FAR (2026-08-08). The feed serves a
  // hold 90 seconds early so the bot can be ready; the runner carted immediately, RC said
  // "The unit is not available for the date(s) specified" — correctly, since the site had
  // not been released — and the server wrote that down as `failed`. `failed` is terminal
  // and `dueHolds` only returns `requested`, so the single attempt was GUARANTEED to be
  // too early and there was never a second one. Measured: attempt 07:58:35 PT for an
  // 08:00:00 release.
  await offer(U('9106'), pacific(60));
  const req = await requestHold(watchId, U('9106'));

  const outcome = await reportCartFailure(req!.id, 'The unit is not available for the date(s) specified.');
  assert.equal(outcome.state, 'retry', 'a failure while the release is still ahead must not be final');

  const [row] = await query<{ status: string; error: string | null; last_attempt_note: string | null }>(
    `SELECT status, error, last_attempt_note FROM rc_hold_requests WHERE id = $1`, [req!.id],
  );
  assert.equal(row.status, 'requested', 'it must stay in the feed so the next pass retries');
  assert.equal(row.error, null, 'and must not present an early miss as the reason it failed');
  assert.match(row.last_attempt_note ?? '', /not available/, 'but the attempt is still recorded');

  // The retry is the whole point: it has to come back from the feed.
  const due = await dueHolds(60 * 60, 24 * 60);
  assert.ok(due.some((h) => h.unit_id === U('9106')), 'a retryable failure stays due');
});

test('once the window has closed, a cart failure IS final', async () => {
  // The other half. Without this the hold would sit `requested` forever, invisible to the
  // bot (out of dueHolds' grace) and never resolved — the missed-hold sweep would be the
  // only thing that ever closed it, 45 minutes later, with no reason attached.
  await offer(U('9107'), pacific(-90));   // released 90 minutes ago
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('9107')]);
  const [row0] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('9107')]);

  const outcome = await reportCartFailure(row0.id, 'RC said no');
  assert.equal(outcome.state, 'failed', 'past the grace window there is nothing left to retry');
  assert.ok(outcome.hold, 'the row comes back so the caller can TELL the user it failed');

  // Exactly once. A repeat report must not send a second "we couldn't hold it" — the same
  // transition rule as markCarted and migration 039.
  const again = await reportCartFailure(row0.id, 'RC said no');
  assert.equal(again.state, 'already-failed', 'a repeat report is not a new failure');
  assert.equal(again.hold, null, 'and carries nothing to notify about');
  const [row] = await query<{ status: string; error: string | null }>(
    `SELECT status, error FROM rc_hold_requests WHERE id = $1`, [row0.id]);
  assert.equal(row.status, 'failed');
  assert.match(row.error ?? '', /RC said no/, 'and the reason is recorded where the user-facing sweep reads it');
});
