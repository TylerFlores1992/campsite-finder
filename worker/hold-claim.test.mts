/**
 * ONE CAMPSITE IS ONE TEXT — the guard over the 2026-08-24 alert storm.
 *
 * REAL DB ON PURPOSE. The whole decision lives inside one `UPDATE .. WHERE NOT (@>)`;
 * a mock would test a fake, and the bug this replaces was a SQL-level property (a
 * per-campground value written into a single-valued column) that reads as correct in
 * every language but SQL. Same reasoning as `claim.test.mts` and `watch-mutes.test.mts`.
 *
 * The fixture watch is dated 2020 so the poller's `end_date > CURRENT_DATE` filter can
 * never see it, and it is deleted on the way out.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { claimHoldNotification, releaseHoldClaims } from './hold-claim';

const WATCH = 'test-hold-claim-0001';
const RELEASE = '2026-08-25T08:00:00';
/** Same hour, different instant — the lock creeping forward by a minute must not re-alert. */
const RELEASE_CREPT = '2026-08-25T08:01:00';

before(async () => {
  await mutate(`DELETE FROM watches WHERE id = $1`, [WATCH]);
  const [{ id: userId }] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const [{ id: cg }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`);
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active)
     VALUES ($1, $2, $3, '2020-01-01', '2020-01-03', true)`,
    [WATCH, userId, cg],
  );
});

after(async () => {
  await mutate(`DELETE FROM watches WHERE id = $1`, [WATCH]);
});

const keys = async () =>
  (await query<{ k: string[] | null }>(
    `SELECT rc_hold_notified_keys AS k FROM watches WHERE id = $1`, [WATCH]))[0].k ?? [];

test('the SAME unit found under two divisions is announced ONCE', async () => {
  // THE REPORTED BUG. RC lists one physical campsite under more than one facility —
  // "Morro Lottery sites" and "Upper Section (sites 86-140)" are both park 680 and both
  // carry unit 43191 — so the poller reaches this twice per cycle for one campsite.
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), true, 'first wins');
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false,
    'the sibling division must NOT get a second alert for the same campsite');
});

test('and it stays suppressed across many cycles, which is what "storm" means', async () => {
  for (let cycle = 0; cycle < 12; cycle++) {
    assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false,
      `cycle ${cycle} re-alerted — this is the 26-texts-an-hour bug`);
    assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false);
  }
});

test('a lock creeping forward within the hour does not re-alert', async () => {
  assert.equal(await claimHoldNotification(WATCH, RELEASE_CREPT, '43191'), false,
    'the key is the release HOUR, not the exact instant');
});

test('two DIFFERENT units in the same hour EACH get their alert', async () => {
  // This is the property migration 070 wanted and a single-valued column could not give.
  // It is also the reason the fix is a set rather than simply reverting the namespace.
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99001'), true);
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99002'), true);
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99001'), false);
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99002'), false);
  // ...and the first unit is still suppressed — a later claim must not evict an earlier one.
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false,
    'a single-valued column would have been overwritten here — that WAS the bug');
});

test('releasing one unit re-opens only that unit', async () => {
  await releaseHoldClaims(WATCH, '99001');
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99001'), true,
    'a site that went live must be announceable again if it is cancelled again');
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '99002'), false,
    'clearing one unit must not re-open every other site releasing in the same hour');
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false);
});

test('a legacy wildcard claim suppresses, so nothing re-announces on deploy', async () => {
  // Migration 067 backfills a live pre-067 claim as `<hour>|*`. Without this term every
  // watch mid-claim would send one more alert the moment the poller ships — on the very
  // watches that had just received twenty-six.
  await mutate(`UPDATE watches SET rc_hold_notified_keys = ARRAY['2026-9-9T8|*'] WHERE id = $1`,
    [WATCH]);
  assert.equal(await claimHoldNotification(WATCH, '2026-09-09T08:00:00', '55555'), false,
    'a backfilled legacy claim must cover that hour');
  assert.equal(await claimHoldNotification(WATCH, '2026-09-10T08:00:00', '55555'), true,
    'but only that hour — the wildcard must not suppress the next release for ever');
});

test('an inactive watch never claims', async () => {
  await mutate(`UPDATE watches SET active = false, rc_hold_notified_keys = '{}' WHERE id = $1`,
    [WATCH]);
  assert.equal(await claimHoldNotification(WATCH, RELEASE, '43191'), false);
  assert.deepEqual(await keys(), [], 'and writes nothing');
  await mutate(`UPDATE watches SET active = true WHERE id = $1`, [WATCH]);
});
