/**
 * Capacity — never promise more holds than we can actually take.
 *
 * Two failures, both seen on 2026-08-13, and they compound:
 *
 *   1. Three holds were queued for one 08:00 release and RC refused the third in its own
 *      words: *"the maximum number of reservations allowed in the cart is '2'."* Nothing of
 *      ours had failed. The cost of an over-promise is not the missed cart — it is that a
 *      user who believes the site is handled STOPS WATCHING, and loses a morning they could
 *      have won with an alarm clock.
 *
 *   2. Two holds carted at 08:00 were still `carted` at 09:40 with `last_attempt_note` =
 *      "RC session is dead". The release loop lives inside `withRC`, so a dead session
 *      skips it; `expireStaleHolds` hands the runner a list and never changes a status.
 *      The seats leaked, and with a ceiling of two that is the entire fleet held by nobody.
 *
 * Hits the REAL database, like the rest of the hold suite — the logic being protected is
 * inside the SQL, and the 2026-08-13 leak was invisible to anything that mocked it.
 *
 * SAFETY: the fixture watch is dated 2020 so the poller's `end_date > CURRENT_DATE` filter
 * can never see it, `carted_at` is moved by UPDATE rather than by waiting, and every row is
 * deleted on the way out.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, holdWindowLoad, markCarted } from '../src/lib/rc-holds';
import { reclaimLapsedHolds, HOLD_LAPSE_MIN } from './expire-holds';
import { RC_HOLD_CAPACITY, RC_SITES_PER_CART, RC_MAX_CARTS } from '../src/lib/limits';

let watchId: string;
let userId: string;
let campgroundId: string;

/** A release window far enough out that no real row can share it and skew a count. */
const WINDOW = '2031-04-05T08:00:00';
const ARRIVAL = '2031-05-01';

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

const offer = (unitId: string) =>
  offerHold({
    watchId, userId, campgroundId, unitId, unitName: `#${unitId}`,
    arrivalDate: ARRIVAL, nights: 1, releaseAt: WINDOW,
  });

test('the capacity constant is the arithmetic, not a number somebody typed', () => {
  // If these ever drift apart, the offer gate and the reason it exists have parted company.
  assert.equal(RC_HOLD_CAPACITY, RC_SITES_PER_CART * RC_MAX_CARTS);
  // RC's, measured. Raising it needs evidence from RC, not from us.
  assert.equal(RC_SITES_PER_CART, 2);
});

test('an offer counts against the window from the moment it is made', async () => {
  // `offered` COUNTS. The button is in an email we cannot retract, so it is a promise
  // whether or not anyone has tapped it — counting only taps is how three people end up
  // holding two seats.
  assert.equal(await holdWindowLoad(WINDOW), 0);
  await offer('7001');
  assert.equal(await holdWindowLoad(WINDOW), 1);
  await offer('7002');
  assert.equal(await holdWindowLoad(WINDOW), 2);
});

test('a hold is not counted against itself', async () => {
  // THE RE-ALERT CASE. The poller asks "is there room for this one", and an opening that
  // re-alerts must be judged without its own existing row — otherwise a hold already
  // offered silently loses its button the second time it is mentioned.
  const load = await holdWindowLoad(WINDOW, { watchId, unitId: '7001', arrivalDate: ARRIVAL });
  assert.equal(load, 1, 'the other hold counts, this one does not');
});

test('a different release window is a different pool', async () => {
  // Capacity is per release, not global: two sites opening at 08:00 tomorrow have nothing
  // to do with two opening the day after.
  assert.equal(await holdWindowLoad('2031-04-06T08:00:00'), 0);
});

test('terminal holds give their seat back', async () => {
  await mutate(`UPDATE rc_hold_requests SET status = 'released' WHERE watch_id = $1 AND unit_id = '7002'`, [watchId]);
  assert.equal(await holdWindowLoad(WINDOW), 1, 'a released hold is not holding anything');
  await mutate(`UPDATE rc_hold_requests SET status = 'offered' WHERE watch_id = $1 AND unit_id = '7002'`, [watchId]);
});

test('a read failure fails CLOSED, so a wobble cannot over-promise', async () => {
  // Same direction as `rcBotUsable`: if we cannot tell how full the window is, do not
  // offer. A hold nobody honours costs a campsite; a missing button costs a convenience.
  const load = await holdWindowLoad(WINDOW, { watchId, unitId: '7001', arrivalDate: 'not-a-date' });
  assert.ok(load >= RC_HOLD_CAPACITY, 'a failed count must never look like it has room');
});

test('a carted hold that could never be released stops holding a seat', async () => {
  // THE LEAK. Two of these on 2026-08-13 were the whole fleet, held for nobody, because
  // the release loop needs an RC session and the session is dead most of the day.
  await offer('7003');
  const [h] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = '7003'`, [watchId]);
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = $1`, [h.id]);
  await markCarted(h.id, '11111111-2222-3333-4444-555555555555', 'entry-1');

  // Fresh: still ours, still holding a seat. Nothing may reclaim it yet.
  let lapsed = await reclaimLapsedHolds();
  assert.equal(lapsed.some((x) => x.id === h.id), false, 'a hold carted seconds ago is live, not lapsed');

  // Old enough that RC has certainly dropped the cart on its own timer.
  await mutate(
    `UPDATE rc_hold_requests SET carted_at = NOW() - ($2 || ' minutes')::interval WHERE id = $1`,
    [h.id, String(HOLD_LAPSE_MIN + 5)],
  );
  lapsed = await reclaimLapsedHolds();
  assert.equal(lapsed.some((x) => x.id === h.id), true, 'a stuck hold must be reclaimed');

  const [after_] = await query<{ status: string; cart_key: string | null; error: string | null }>(
    `SELECT status, cart_key, error FROM rc_hold_requests WHERE id = $1`, [h.id]);
  assert.equal(after_.status, 'expired');
  // THE KEYS SURVIVE. We did not release this — RC lapsed it — so the evidence stays, and a
  // later healthy pass could still try. Wiping them would destroy the only record of what
  // we were holding.
  assert.ok(after_.cart_key, 'cart_key must not be cleared by the reclaim');
  // And the note must not claim we released it, because we did not.
  assert.match(String(after_.error), /could not release|assuming/i);
});
