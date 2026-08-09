/**
 * The capacity gauge's levels — the only leading indicator on the admin page.
 *
 * The rule it replaced warned only at `demand === capacity`, so the first signal was
 * "the next watch degrades everyone" with zero lead time to clone a machine, which a
 * human has to do. The obvious fix is a percentage and it is the wrong shape; these
 * tests pin the behaviour that made an absolute reserve the right one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECGOV_CAPACITY_RESERVE, RECGOV_MONTHS_PER_MACHINE } from '../src/lib/health-thresholds';

/** The level rule, mirrored from lib/capacity so this stays a pure test (no DB). */
function level(demand: number, machines: number): 'ok' | 'warn' | 'fail' {
  const free = machines * RECGOV_MONTHS_PER_MACHINE - demand;
  return free < 0 ? 'fail' : free < RECGOV_CAPACITY_RESERVE ? 'warn' : 'ok';
}

test('over capacity fails, and it is the case that pages', () => {
  assert.equal(level(9, 2), 'fail'); // 9 > 8
  assert.equal(level(8, 2), 'warn', 'exactly at capacity is not yet over');
});

test('there is real lead time before saturation', () => {
  // THE BUG THIS FIXES. Under the old rule 7/8 was silent green and 8/8 was the first
  // word you got — one campground-month of notice, for a fix that needs a human at a
  // terminal running flyctl.
  assert.equal(level(7, 2), 'warn', '7/8 must warn, not sit green');
  assert.equal(level(5, 2), 'warn', 'and so must 5/8 — under the reserve');
  assert.equal(level(4, 2), 'ok', 'a full machine of headroom is fine');
  assert.equal(level(3, 2), 'ok'); // today
});

test('the reserve holds its meaning as the fleet grows — a percentage would not', () => {
  // This is the whole argument for an absolute threshold. At 10 machines a 75% rule
  // would warn at 30/40, i.e. with TWO AND A HALF MACHINES of runway, and the banner
  // would sit amber for weeks until it meant nothing. The reserve warns at the same real
  // headroom — one machine's worth — regardless of size.
  for (const machines of [1, 2, 5, 10, 50]) {
    const cap = machines * RECGOV_MONTHS_PER_MACHINE;
    assert.equal(level(cap - RECGOV_CAPACITY_RESERVE, machines), 'ok',
      `exactly the reserve free must be ok at ${machines} machines`);
    assert.equal(level(cap - RECGOV_CAPACITY_RESERVE + 1, machines), 'warn',
      `one below the reserve must warn at ${machines} machines`);
    // And the warning must not fire absurdly early on a big fleet.
    const pct75 = Math.ceil(cap * 0.75);
    if (machines >= 5) {
      assert.equal(level(pct75, machines), 'ok',
        `75% must still be OK at ${machines} machines — that is what a percentage got wrong`);
    }
  }
});

test('the reserve is one machine, not an arbitrary number', () => {
  // If these ever diverge the comment in health-thresholds is lying, and the message
  // "clone a machine" stops matching what the threshold actually reserves.
  assert.equal(RECGOV_CAPACITY_RESERVE, RECGOV_MONTHS_PER_MACHINE);
});
