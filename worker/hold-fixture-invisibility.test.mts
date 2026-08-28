// A TEST FIXTURE MUST NOT MAKE THE PRODUCTION BOT SIGN IN, OR RING THE OWNER'S PHONE.
//
// MEASURED 2026-08-18, by causing it. `npm test` hits the production DB on purpose, and the
// hold suites insert `requested`/`carted`/`claiming` rows with releases a minute or two out.
// Since 2026-08-15 every fixture carries a NON-NUMERIC sentinel unit id so the production
// runner cannot lock a stranger's campsite with one - `hold-fixture-safety.test.mts` enforces
// that. **The sentinel protected the CART. Nothing protected the LOGIN.**
//
// While a test run was in flight, the mini-PC's keep-warm read a real `nextRelease` one minute
// away and did exactly what it is built to do:
//
//     20:00:44  hold releases in 1m and the session will not cover it - signing in
//     20:00:49      -> signed in, but the token will not cover the hold - dropping it to sign in fresh
//     20:02:21  RC Chromium at 4037 MB (limit 1500) - RECYCLING the browser
//
// That is an unattended sign-in from the household address - the act that cost twelve hours of
// IP block on 2026-08-06, and is rationed to two attempts per release for that reason - plus a
// four-gigabyte Okta ramp that killed the browser mid-login. Fired by CI, on every pull request.
//
// `holdAtRisk` is the sharper half: it is the ALARM's trigger, so a fixture releasing in one
// minute against a dead RC session rings the owner's phone twice.
//
// REAL-DB, AND THAT IS THE POINT. The fix is one predicate inside two SQL statements. A test
// asserting against a copy of that predicate would assert the copy - the `rc-holds-readout`
// lesson. This drives the real functions against real rows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { offerHold, requestHold, nextHoldRelease, holdAtRisk } from '../src/lib/rc-holds';

let watchId = '';
let userId = '';
let campgroundId = '';

/** The same sentinel shape the hold suites use, and that `hold-fixture-safety` enforces. */
const U = (n: string) => `__tfi${n}`;

/** Pacific wall-clock, `minutes` from now - the zone-less shape `release_at` stores. */
function pacific(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}:${g('second')}`;
}

before(async () => {
  // AGE-GATED, BECAUSE A SWEEP CANNOT TELL LITTER FROM A LIVE RUN BY THE ID ALONE (#76).
  // `npm test` runs on every push, so two CI runs overlap routinely — and before this,
  // a starting run DELETED a running one's working set, then logged "swept N fixture(s)
  // left by an earlier run", which reads as self-healing at the exact moment it is
  // destroying a live run. The victim died on a null several statements from the cause.
  // `offered_at` is the row's birth time and no status change moves it, so a concurrent
  // run's rows are seconds old and protected while real litter is minutes old.
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_tfi%'
                 AND offered_at < NOW() - interval '10 minutes'`).catch(() => {});
  const [u] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const [c] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'reservecalifornia' ORDER BY id LIMIT 1`);
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

/** A `requested` fixture releasing shortly - precisely the shape that fired the sign-in. */
async function queueFixture(unitId: string, minutes: number) {
  await offerHold({
    watchId, userId, campgroundId, unitId, unitName: `#${unitId}`,
    arrivalDate: '2026-09-04', nights: 2, releaseAt: pacific(minutes),
  });
  await requestHold(watchId, unitId);
}

test('a sentinel fixture is invisible to nextHoldRelease — no unattended sign-in', async () => {
  const before = await nextHoldRelease();
  await queueFixture(U('9401'), 1);
  const after = await nextHoldRelease();
  assert.equal(after, before,
    'a fixture releasing in one minute must not become the release the keep-warm signs in for');
});

test('a sentinel fixture is invisible to holdAtRisk — the phone does not ring', async () => {
  // holdAtRisk is what `alarmIfSessionUnusable` calls on EVERY feed poll. A fixture inside
  // its window, with the RC session dead, is two phone calls forty-five seconds apart.
  const risk = await holdAtRisk(45);
  assert.equal(risk?.hold?.unit_id?.startsWith('__t') ?? false, false,
    `holdAtRisk returned a test fixture (${risk?.hold?.unit_id}) — it would ring the owner`);
});

/**
 * THE HALF THAT MATTERS MORE, and the one that has to be built carefully.
 *
 * Excluding fixtures is worthless if it also excludes the booking somebody is waiting on:
 * `nextHoldRelease` is what buys the 08:00 sign-in and `holdAtRisk` is the only thing that
 * wakes a human when the session is dead. An `AND false` slipped into either would pass both
 * tests above and silently switch off the whole auto-cart morning. So a numeric id must be
 * shown coming straight back.
 *
 * BUT A NUMERIC `requested` ROW IS THE EXACT THING THAT MUST NEVER EXIST - it is an
 * instruction to the production runner to lock whatever real campsite carries that number,
 * which is the 2026-08-15 incident. Three independent reasons this row cannot cause one:
 *
 *   1. It is `carted`, not `requested`. `dueHolds` - the ONLY path that POSTs a precart -
 *      returns `requested` alone.
 *   2. Nothing else acts on it either: `pendingClaims` takes `claiming`, and
 *      `expireStaleHolds`'s release list takes `carted` older than 45 minutes. This one is
 *      seconds old and deleted before it could age.
 *   3. The id is `0`. Real RC unit ids are positive integers in the thousands, so this cannot
 *      collide with a site even if something did act on it - and at one digit it sits under
 *      `hold-fixture-safety.test.mts`'s two-digit floor, so that guard stays untouched rather
 *      than needing an exemption carved into it.
 *
 * Reason 3 alone would be the "vanishingly unlikely" reasoning this repo has been burned by.
 * It is third on the list on purpose.
 */
const UNREACHABLE_NUMERIC = '0';

test('a REAL numeric unit id is still seen by both — the filter is not a blanket mute', async () => {
  await offerHold({
    watchId, userId, campgroundId, unitId: UNREACHABLE_NUMERIC, unitName: '#test',
    arrivalDate: '2026-09-04', nights: 2, releaseAt: pacific(1),
  });
  // Straight to `carted`, never through `requested`. Going via requestHold would put a
  // numeric row in front of the live runner for however long the next statement takes.
  await mutate(
    `UPDATE rc_hold_requests SET status = 'carted', carted_at = NOW()
      WHERE watch_id = $1 AND unit_id = $2`, [watchId, UNREACHABLE_NUMERIC]);
  try {
    assert.ok(await nextHoldRelease(), 'a numeric unit id must still produce a release time');
    const risk = await holdAtRisk(45);
    assert.equal(risk?.hold?.unit_id, UNREACHABLE_NUMERIC,
      'a numeric unit id inside the window must still be able to ring the phone');
  } finally {
    await mutate(`DELETE FROM rc_hold_requests WHERE watch_id = $1 AND unit_id = $2`,
      [watchId, UNREACHABLE_NUMERIC]).catch(() => {});
  }
});
