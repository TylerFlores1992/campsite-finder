/**
 * A hold offer belongs to a RELEASE — the fix for "we only offer a hold once".
 *
 * ## The report, 2026-09-04
 *
 *   "We currently only offer a hold once to users, and if the site becomes available
 *    again they don't see it."
 *
 * `rc_hold_requests_unique` was (watch_id, unit_id, arrival_date) — no release in it — and
 * `offerHold`'s `DO UPDATE ... WHERE status = 'offered'` therefore refused every later
 * offer for a campsite whose row had gone terminal. `offerHold` returned null, the poller
 * withheld the button, and nothing existed for the watch page to list. One row was the
 * whole history of a (watch, unit, arrival) for ever.
 *
 * Migration 074 puts `release_at` in the key.
 *
 * ## Why this is a REAL-DB suite
 *
 * The entire fix is a conflict target inside one `INSERT ... ON CONFLICT`, and the property
 * that matters is what the database REFUSES. A mock would assert a copy of the statement,
 * which is the mistake `rc-holds-readout` already paid for — so these drive the real
 * `offerHold` against the real index.
 *
 * It also means this suite FAILS LOUDLY IF THE MIGRATION HAS NOT BEEN APPLIED: a
 * three-column index makes `ON CONFLICT (a,b,c,d)` unmatched, `offerHold` catches and
 * returns null, and the first test reads "the second release was refused". That is the
 * right way round — a green suite over an unapplied migration would be worthless.
 *
 * ## Fixture safety
 *
 * Non-numeric `__tpr` unit ids, so the production hold runner can never cart one even if a
 * run dies mid-test (2026-08-15). Watches dated 2020 so the poller's `end_date >
 * CURRENT_DATE` filter cannot see them. A per-suite prefix plus an age gate on
 * `offered_at`, so neither a sibling suite nor a second run of this one wipes live rows
 * (#76 / #203).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, declineHold, requestHold, holdWindowLoad } from '../src/lib/rc-holds';

const U = (n: string) => `__tpr${n}`;
const USER = 'test-perrelease-user';
const WATCH = 'test-perrelease-watch';
const ARRIVAL = '2030-09-05';
/** Two different 08:00 releases for the SAME campsite and the SAME arrival — a site
 *  cancelled, released, booked by somebody else, and cancelled again. */
const FIRST = '2030-08-01T08:00:00';
const SECOND = '2030-08-15T08:00:00';
/** A third, used ONLY by the capacity test so it is not counting the rows the tests above
 *  left at SECOND — which is exactly how its first version read a clean pass as a failure. */
const THIRD = '2030-08-29T08:00:00';
let campgroundId = '';

async function sweep() {
  await mutate(
    `DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_tpr%'
       AND offered_at < NOW() - interval '10 minutes'`,
    [],
  );
  await mutate(`DELETE FROM watches WHERE id = $1`, [WATCH]);
  await mutate(`DELETE FROM users WHERE id = $1`, [USER]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  await mutate(`INSERT INTO users (id, email) VALUES ($1,$2)`, [USER, 'perrelease@camphawk.invalid']);
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1,$2,$3,'2020-01-01','2020-01-03',true,'2020-01-01T00:00:00Z')`,
    [WATCH, USER, campgroundId],
  );
});

after(sweep);

function offer(unit: string, releaseAt: string, unitName: string | null = null) {
  return offerHold({
    watchId: WATCH,
    userId: USER,
    campgroundId,
    unitId: unit,
    unitName,
    arrivalDate: ARRIVAL,
    nights: 1,
    releaseAt,
  });
}

const rowsFor = (unit: string) =>
  query<{ id: string; status: string; release_at: string }>(
    `SELECT id, status, release_at FROM rc_hold_requests
      WHERE watch_id = $1 AND unit_id = $2 ORDER BY release_at ASC`,
    [WATCH, unit],
  );

const setStatus = (id: string, status: string) =>
  mutate(`UPDATE rc_hold_requests SET status = $2 WHERE id = $1`, [id, status]);

// ── the bug itself ───────────────────────────────────────────────────────────────────

test('a DECLINED offer does not block the next release of the same campsite', async () => {
  const unit = U('1001');
  const first = await offer(unit, FIRST);
  assert.ok(first, 'the first offer should be recorded');

  assert.equal(await declineHold(first!), true, 'the user says no to this release');

  // A fortnight later RC locks the same campsite for a different 08:00. Before 074 this
  // returned null and the user was never told.
  const second = await offer(unit, SECOND);
  assert.ok(
    second,
    'the site was locked again for a LATER release and produced no offer — this is the ' +
      'reported bug: one terminal row retired that campsite for the life of the watch',
  );
  assert.notEqual(second, first, 'a new release must be its own row, not a revived decline');

  const rows = await rowsFor(unit);
  assert.equal(rows.length, 2, 'two releases, two rows');
  assert.equal(
    rows.find((r) => r.release_at === FIRST)?.status,
    'expired',
    'the decline must STAND for the release it was made against — that is what the user ' +
      'said no to, and reviving it would make declining meaningless',
  );
  assert.equal(rows.find((r) => r.release_at === SECOND)?.status, 'offered');
});

test('an offer nobody answered does not block the next one either', async () => {
  const unit = U('1002');
  const first = await offer(unit, FIRST);
  // What expire-holds does when 08:00 passes with no tap.
  await setStatus(first!, 'expired');
  assert.ok(await offer(unit, SECOND), 'a lapsed offer must not retire the campsite');
});

test('a FAILED cart does not retire the campsite for ever', async () => {
  // The sharpest case: the bot tried, RC refused, `failed` is terminal. Before 074 a
  // transient RC failure meant that watch could never be offered that site again.
  const unit = U('1003');
  const first = await offer(unit, FIRST);
  await setStatus(first!, 'failed');
  assert.ok(await offer(unit, SECOND), 'a failed cart must not be permanent');
});

// ── and the guard it must not break ──────────────────────────────────────────────────

test('a re-alert for the SAME release still updates in place, never stacks', async () => {
  const unit = U('1004');
  const first = await offer(unit, FIRST, null);
  const again = await offer(unit, FIRST, '#L042');
  assert.equal(again, first, 'the same opening is the same row');
  const rows = await rowsFor(unit);
  assert.equal(rows.length, 1, 'a re-alert must not stack duplicates — a user who taps ' +
    'once could otherwise be carted twice, and the bot holds entries it can only release one of');
  const [named] = await query<{ unit_name: string | null }>(
    `SELECT unit_name FROM rc_hold_requests WHERE id = $1`, [first!]);
  assert.equal(named.unit_name, '#L042', 'a later alert may still fill in the human label');
});

test('a re-alert must NOT walk a tapped hold back to `offered`', async () => {
  // The DO UPDATE's `WHERE status = 'offered'` guard. Widening the key does not replace
  // it: within one release a re-alert still has to leave the user's answer alone.
  const unit = U('1005');
  const first = await offer(unit, FIRST);
  await setStatus(first!, 'requested');
  const again = await offer(unit, FIRST);
  assert.equal(again, null, 'no row back means the user has already answered — a success');
  const rows = await rowsFor(unit);
  assert.equal(rows.length, 1, 'and it must not have inserted a second row for the same release');
  assert.equal(rows[0].status, 'requested', 'their tap must survive a later alert');
});

// ── the neighbours that read these rows ──────────────────────────────────────────────

test('tapping picks the SOONEST future offer, not an older one', async () => {
  const unit = U('1006');
  await offer(unit, SECOND);
  await offer(unit, FIRST);
  const got = await requestHold(WATCH, unit);
  assert.equal(got?.release_at, FIRST, 'two live offers for one campsite must resolve to ' +
    'the next release, or a tap queues a cart for the wrong morning');
});

test('capacity is counted per release — an old row cannot fill a new window', async () => {
  // AGAINST A BASELINE, NOT AGAINST ZERO. `holdWindowLoad` answers for the whole table at
  // one release, so it sees every row anyone has at THIRD — including the earlier tests in
  // this very file, which is what a first, wrong version of this test read as a failure.
  // Same shape as the bounded-vs-unbounded baseline #202's guard had to be re-taught.
  const unit = U('1007');
  const before = await holdWindowLoad(THIRD, { watchId: WATCH, unitId: unit, arrivalDate: ARRIVAL });
  await offer(unit, FIRST);
  const after = await holdWindowLoad(THIRD, { watchId: WATCH, unitId: unit, arrivalDate: ARRIVAL });
  assert.equal(after, before, 'holdWindowLoad filters on release_at, so a live offer for a ' +
    'DIFFERENT release must not read as a seat taken at this one');

  // And the positive half, or the assertion above passes just as well against a
  // holdWindowLoad that always answers the same number.
  await offer(unit, THIRD);
  assert.equal(
    await holdWindowLoad(THIRD, { watchId: WATCH, unitId: U('1007-other'), arrivalDate: ARRIVAL }),
    before + 1,
    'an offer at THIS release must count',
  );
});
