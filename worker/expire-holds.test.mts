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

/**
 * NON-NUMERIC FIXTURE UNIT IDS - see the header of `rc-holds.test.mts` for the incident.
 * These tests deliberately put rows into `requested` with a release time just past, which is
 * precisely the shape `dueHolds` hands to the production RC runner to cart. A real unit id is
 * numeric, so a sentinel cannot name a real campsite. `worker/hold-fixture-safety.test.mts`
 * enforces it; that guard found THIS file on its first run.
 */
const U = (n: string) => `__teh${n}`;

before(async () => {
  // Sweep anything an earlier aborted run left - see rc-holds.test.mts's before().
  // AGE-GATED, BECAUSE A SWEEP CANNOT TELL LITTER FROM A LIVE RUN BY THE ID ALONE (#76).
  // `npm test` runs on every push, so two CI runs overlap routinely — and before this,
  // a starting run DELETED a running one's working set, then logged "swept N fixture(s)
  // left by an earlier run", which reads as self-healing at the exact moment it is
  // destroying a live run. The victim died on a null several statements from the cause.
  // `offered_at` is the row's birth time and no status change moves it, so a concurrent
  // run's rows are seconds old and protected while real litter is minutes old.
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_teh%'
                 AND offered_at < NOW() - interval '10 minutes'`).catch(() => {});

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

/**
 * The real sweep, scoped to one row so `npm test` cannot fail live users' holds.
 *
 * AND WITH THE RUNNER'S LIVENESS PINNED. The grace is conditional on `rc_runner_heartbeat`
 * since 2026-08-17, which is the REAL mini-PC — so without this the outcome depends on
 * whether the owner's box happens to be up. It passed four consecutive `npm run verify` runs
 * and failed the moment the box went dark, sweeping a fixture that sits inside the
 * 45-minute grace with the 5-minute branch. A real-DB test may touch real rows; it must
 * never depend on real weather.
 *
 * `runnerAbsent: false` is the conservative branch — the one every assertion below was
 * written against.
 */
const sweep = (id: string, runnerAbsent = false) => failMissedHolds([id], { runnerAbsent });

test('a requested hold whose release passed long ago is failed, not left silent', async () => {
  await offer(U('8001'), pacific(-(HOLD_MISS_GRACE_MIN + 120)));
  // requestHold refuses a past release (correctly), so reproduce the real sequence:
  // tapped while the release was still ahead, then time passed.
  await mutate(
    `UPDATE rc_hold_requests SET status = 'requested', requested_at = NOW()
      WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('8001')]);
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('8001')]);

  const missed = await sweep(row.id);
  assert.equal(missed.length, 1, 'the whole point: this must not sit at `requested` forever');
  assert.equal(missed[0].unit_name, `#L${U('8001')}`, 'the caller needs enough to notify the user');
  const [after] = await query<{ status: string; error: string | null }>(
    `SELECT status, error FROM rc_hold_requests WHERE id = $1`, [row.id]);
  assert.equal(after.status, 'failed');
  assert.ok(after.error, 'a failure with no reason recorded is the bug one level up');
});

test('a hold still inside the grace is LEFT ALONE — the runner may yet take it', async () => {
  // Sweeping earlier than the feed gives up would tell the user "we couldn't" and then
  // cart it anyway. The grace must stay wider than dueHolds' 20-minute window.
  assert.ok(HOLD_MISS_GRACE_MIN > 20, 'grace must exceed the feed grace, or the two disagree');
  await offer(U('8002'), pacific(-5));
  await mutate(
    `UPDATE rc_hold_requests SET status = 'requested' WHERE watch_id = $1 AND unit_id = $2`,
    [watchId, U('8002')]);
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('8002')]);
  assert.equal((await sweep(row.id)).length, 0);
});

test('with the runner DEAD, the same hold is reported in minutes', async () => {
  // The whole point of the 2026-08-17 change: 45 minutes is bought by "the runner might
  // still cart it", and with a stale heartbeat that justification does not apply. Same row,
  // same age, opposite answer — which is what makes this a branch rather than a shorter
  // constant. Uses -8 minutes: inside the 45-minute grace, outside the 5-minute one, so it
  // can only pass if the branch is really being taken.
  await offer(U('8006'), pacific(-8));
  await mutate(
    `UPDATE rc_hold_requests SET status = 'requested' WHERE watch_id = $1 AND unit_id = $2`,
    [watchId, U('8006')]);
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('8006')]);

  // Alive: left alone, because a cart is still possible.
  assert.equal((await sweep(row.id, false)).length, 0);
  // Dead: reported, because nothing is coming.
  const missed = await sweep(row.id, true);
  assert.equal(missed.length, 1, 'a dead runner must not buy the hold another 40 minutes');
  const [after] = await query<{ status: string }>(
    `SELECT status FROM rc_hold_requests WHERE id = $1`, [row.id]);
  assert.equal(after.status, 'failed');
});

test('a FUTURE release is never swept', async () => {
  // The timezone trap: `release_at` is zone-less Pacific text. Compare it as a Date on a
  // UTC worker and "8am Pacific tomorrow" reads as seven hours earlier than it is, which
  // would fail live holds hours before their moment.
  await offer(U('8003'), pacific(180));
  const req = await requestHold(watchId, U('8003'));
  assert.ok(req);
  assert.equal((await sweep(req!.id)).length, 0, 'a hold three hours out is not missed');
});

test('an OFFERED hold is not "missed" — nobody promised anything', async () => {
  // We only owe an apology where we made a commitment. An unanswered offer is the opt-in
  // working; expireStaleHolds marks those `expired`, quietly and correctly.
  await offer(U('8004'), pacific(-(HOLD_MISS_GRACE_MIN + 60)));
  const [row] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`, [watchId, U('8004')]);
  assert.equal((await sweep(row.id)).length, 0);
});

test('a hold that WAS carted is never reported as missed', async () => {
  await offer(U('8005'), pacific(30));
  const req = await requestHold(watchId, U('8005'));
  await markCarted(req!.id, 'ck', 'ek');
  await mutate(
    `UPDATE rc_hold_requests SET release_at = $2 WHERE id = $1`,
    [req!.id, pacific(-(HOLD_MISS_GRACE_MIN + 60))]);
  assert.equal((await sweep(req!.id)).length, 0, 'success must not be apologised for');
});
