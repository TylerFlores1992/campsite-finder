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

// ---------------------------------------------------------------------------
// NO NIGHT THAT HAS ALREADY BEGUN BY THE RELEASE (2026-09-05)
//
// #L003 at Leo Carrillo: offered 13:10 PT on Sep 4 for a three-night stay ARRIVING Sep 4,
// releasing 08:00 on Sep 5. The user tapped it and waited for a morning that could not
// deliver — at 08:00 the runner asked RC for a stay whose first night was the night
// before, and RC refused every attempt of the grace window. The failure looked exactly
// like losing a race, which is what the hold readout called it.
// ---------------------------------------------------------------------------

test('a stay whose first night is past at the release is not offered at all', () => {
  // The live #L003 shape: three held nights, all released the morning AFTER the first.
  const held = [
    slice('2026-09-04', '2026-09-05T08:00:00'),
    slice('2026-09-05', '2026-09-05T08:00:00'),
    slice('2026-09-06', '2026-09-05T08:00:00'),
  ];
  // A fixed three-night watch asked for Sep 4-6. Two of those nights survive, which is
  // not the stay they asked for, so silence — the same rule as a partly-held window.
  assert.equal(heldStayRun(held, 3, FIXED), null);
});

test('the bookable remainder is still offered, with the arrival moved forward', () => {
  // Same nights, but a flexible two-night watch. Sep 5-6 really is free at 08:00 on
  // Sep 5, so dropping the whole offer would throw away a stay somebody can have.
  const held = [
    slice('2026-09-04', '2026-09-05T08:00:00'),
    slice('2026-09-05', '2026-09-05T08:00:00'),
    slice('2026-09-06', '2026-09-05T08:00:00'),
  ];
  const run = heldStayRun(held, 9, flex(2));
  // NOT ['2026-09-04', '2026-09-05'], which is what the first pass picks.
  assert.deepEqual(run?.dates, ['2026-09-05', '2026-09-06']);
  assert.equal(run?.availableAt, '2026-09-05T08:00:00');
});

test('a night releasing on its own morning is kept — RC sells a same-day arrival', () => {
  // MEASURED, not assumed: #L034 carted at T+1.4s on 2026-09-04 with release 08:00 Sep 4
  // against an arrival of Sep 4. The cutoff is `>=` and treating it as `>` would have
  // silenced the one hold this system has actually won.
  const sameDay = [slice('2026-09-04', '2026-09-04T08:00:00')];
  assert.deepEqual(heldStayRun(sameDay, 1, FIXED)?.dates, ['2026-09-04']);
});

test('re-picking is a fixed point, not one trim — the survivors carry their own locks', () => {
  // Dropping Sep 4 leaves Sep 5-6, and Sep 6 frees three days later than Sep 5 did. So
  // the release MOVES OUT when the run is re-picked, and Sep 5 is then past as well.
  // A single trim would return Sep 5-6 against a Sep 9 release: a stay advertised for a
  // morning four days after its first night, which is the bug wearing a smaller hat.
  const held = [
    slice('2026-09-04', '2026-09-05T08:00:00'),
    slice('2026-09-05', '2026-09-05T08:00:00'),
    slice('2026-09-06', '2026-09-09T08:00:00'),
  ];
  assert.equal(heldStayRun(held, 9, flex(2)), null);
});
