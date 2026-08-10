/**
 * The held-check cadence.
 *
 * What these guard is a SILENT loss: if the held check stops running often enough, no
 * error appears anywhere — `rcHeld` is simply empty, which is also what "nothing is
 * locked" looks like, which is the correct answer almost every cycle. The same shape as
 * the flex bug in `heldStayRun`, and as `hasAvailabilityInRange` returning a flat false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldCheckDue, clampHeldInterval, RC_HELD_CHECK_DEFAULT_MS } from './held-cadence';

const MIN = 60_000;

test('a worker that has never checked is due immediately', () => {
  // A deploy at 07:55 against an 08:00 release must look BEFORE the release, not one
  // full interval after boot. `lastAt = 0` is "never", not "just now".
  assert.equal(heldCheckDue(0, Date.now(), 5 * MIN), true);
});

test('due only once the interval has elapsed', () => {
  const t = 1_000_000;
  assert.equal(heldCheckDue(t, t + 4 * MIN, 5 * MIN), false);
  assert.equal(heldCheckDue(t, t + 5 * MIN, 5 * MIN), true, 'exactly the interval counts as due');
  assert.equal(heldCheckDue(t, t + 9 * MIN, 5 * MIN), true);
});

test('a backwards clock does not wedge the check off', () => {
  // Fly machines resume from snapshots and NTP steps them. A `lastAt` in the future would
  // otherwise suppress the check until real time caught up — potentially hours, with an
  // 8am release inside the gap. Failing toward checking costs one grid fetch.
  const t = 1_000_000;
  assert.equal(heldCheckDue(t + 60 * MIN, t, 5 * MIN), true);
});

test('the interval can never exceed the newsworthiness floor it depends on', () => {
  // holdIsNewsworthy refuses any coming-soon alert with under an hour of lead. An interval
  // at or above that floor means a lock found at T-59min is announced at T-0 — i.e. never
  // — and nothing would report it, because "no held unit" is the usual answer.
  assert.equal(clampHeldInterval(60 * MIN), 15 * MIN, 'an hour is clamped to a quarter of the floor');
  assert.equal(clampHeldInterval(6 * 60 * MIN), 15 * MIN);
  assert.equal(clampHeldInterval(5 * MIN), 5 * MIN, 'a sane value passes through');
});

test('a broken env var falls back rather than stopping the check', () => {
  // RC_HELD_CHECK_MS='' → Number('') is 0, and 0 or NaN as an interval would make every
  // cycle due (harmless) or the arithmetic meaningless. A bad env var must not be able to
  // change the poller's behaviour silently in either direction.
  assert.equal(clampHeldInterval(Number('')), RC_HELD_CHECK_DEFAULT_MS);
  assert.equal(clampHeldInterval(Number('abc')), RC_HELD_CHECK_DEFAULT_MS);
  assert.equal(clampHeldInterval(-1), RC_HELD_CHECK_DEFAULT_MS);
});

test('the default leaves several chances inside the lead floor', () => {
  // Not asserting "300000" — asserting the PROPERTY that makes it safe, so changing the
  // number deliberately still passes and changing it carelessly does not.
  assert.ok(RC_HELD_CHECK_DEFAULT_MS * 4 <= 60 * MIN,
    'at least four held checks must fit inside the one-hour newsworthiness floor');
});
