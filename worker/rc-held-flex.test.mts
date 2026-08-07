// Which held nights we claim for a watch — the decision behind every RC "coming soon"
// alert and every 8am hold offer.
//
// THE BUG THIS EXISTS TO STOP. `findRCHeldUnit` had no flex spec, so the poller could
// only ask "is the WHOLE window held?". A flexible watch's window is its entire search
// range, so "any 4 nights between Sep 4 and Sep 13" became "are all NINE nights held by
// one unit?" — which never happens. Six of the nine live RC watches were flexible on
// 2026-08-07, so two thirds of them could not receive a coming-soon alert at all, and the
// failure was silent: the wrong answer is "no held unit", which is also the CORRECT
// answer on almost every cycle.
//
// Pure — no DB, no grid. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldStayRun } from '../src/lib/availability/reservecalifornia';

/** Slices as the grid gives them: a date and RC's lock, Pacific wall-clock, no zone. */
const slice = (Date_: string, Lock = '2026-08-07T08:00:00') => ({ Date: Date_, Lock });

const FIXED = undefined;
const flex = (nights: number, days: 'weekend' | null = null) => ({ nights, days });

test('a flexible watch matches a run INSIDE its window, not the whole window', () => {
  // Limekiln Redwood, live on 2026-08-07: unit #LC27 held Sep 9-10 inside a Sep 4-13
  // watch. Under the old rule this needed nine consecutive held nights and stayed silent.
  const held = [slice('2026-09-09'), slice('2026-09-10')];
  assert.equal(heldStayRun(held, 9, FIXED), null, 'the old whole-window rule finds nothing');
  const run = heldStayRun(held, 9, flex(2));
  assert.deepEqual(run?.dates, ['2026-09-09', '2026-09-10']);
});

test('the reported dates are the RUN, never every held night in the window', () => {
  // The offer carts exactly these nights. Reporting the whole window would queue a hold
  // for nights the user never asked for — and hold them off the market for everyone else.
  const held = [slice('2026-09-04'), slice('2026-09-05'), slice('2026-09-06'), slice('2026-09-07')];
  assert.deepEqual(heldStayRun(held, 9, flex(2))?.dates, ['2026-09-04', '2026-09-05']);
});

test('a gap does not become a stay', () => {
  const held = [slice('2026-09-04'), slice('2026-09-06'), slice('2026-09-07')];
  assert.equal(heldStayRun(held, 9, flex(3)), null, 'Sep 4 + 6 + 7 is not three consecutive nights');
  assert.deepEqual(heldStayRun(held, 9, flex(2))?.dates, ['2026-09-06', '2026-09-07']);
});

test('a weekend watch is not handed a midweek run', () => {
  // Sep 7-8 2026 is Mon-Tue. A "weekend" flex watch asked for a Saturday night.
  const midweek = [slice('2026-09-07'), slice('2026-09-08')];
  assert.equal(heldStayRun(midweek, 9, flex(2, 'weekend')), null);
  // Sep 12 2026 is a Saturday.
  const weekend = [slice('2026-09-11'), slice('2026-09-12')];
  assert.deepEqual(heldStayRun(weekend, 9, flex(2, 'weekend'))?.dates, ['2026-09-11', '2026-09-12']);
});

test('a FIXED watch still needs its whole stay held', () => {
  // Leo Carrillo, live on 2026-08-07: one held night against a three-night fixed watch.
  // Alerting here would promise a stay we cannot deliver, so silence is correct.
  assert.equal(heldStayRun([slice('2026-09-04')], 3, FIXED), null);
  const all = [slice('2026-09-04'), slice('2026-09-05'), slice('2026-09-06')];
  assert.deepEqual(heldStayRun(all, 3, FIXED)?.dates, ['2026-09-04', '2026-09-05', '2026-09-06']);
});

test('the release time is the LAST lock of the claimed run, not the first', () => {
  // Sending someone at 08:00 for a stay whose second night frees at 09:00 hands them a
  // booking that cannot be completed — and points the bot at a unit still locked.
  const held = [slice('2026-09-09', '2026-08-07T08:00:00'), slice('2026-09-10', '2026-08-07T09:00:00')];
  assert.equal(heldStayRun(held, 9, flex(2))?.availableAt, '2026-08-07T09:00:00');
});

test('the release time comes from the CLAIMED nights only', () => {
  // A later held night outside the run must not push the release time out; the user would
  // be told to wait hours for a stay that is free at 08:00.
  const held = [
    slice('2026-09-04', '2026-08-07T08:00:00'),
    slice('2026-09-05', '2026-08-07T08:00:00'),
    slice('2026-09-09', '2026-08-07T21:00:00'),
  ];
  assert.equal(heldStayRun(held, 9, flex(2))?.availableAt, '2026-08-07T08:00:00');
});
