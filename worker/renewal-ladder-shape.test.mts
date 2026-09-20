/**
 * THE BACKOFF LADDER'S SHAPE — IN ITS OWN FILE, AND THAT IS THE WHOLE POINT.
 *
 * ── WHY THIS IS NOT IN `renewal-schedule.test.mts` ─────────────────────────────────────
 * `renewBackoffGapMs` doubles a gap in a loop. Its failure mode is not a red — it is a run
 * that never finishes: a loop bounded by `failures` (which has no upper bound) or by the
 * gap it is mutating (doubling zero never reaches the cap) spins to MAX_SAFE_INTEGER inside
 * the keep-warm's own `for(;;)`. A hung bot and a dead session is strictly worse than the
 * ramps the ladder buys.
 *
 * So the shape has to be asserted by something that CANNOT hang. The obvious move — put the
 * structural scan above the behaviour in the same file — was tried twice and does not work,
 * for two independent reasons, both MEASURED rather than reasoned:
 *
 *   1. It was placed at the top of the termination test, and the CEILING test two tests
 *      ABOVE it already calls `renewBackoffGapMs(Number.MAX_SAFE_INTEGER)`. The hang
 *      happened first and the scan never ran. Killed at 60s having asserted nothing.
 *   2. Moving it to the FIRST test in the file did not help either. **node:test buffers a
 *      file's output until the file completes**, so a hang anywhere in it produces
 *      `TAP version 13` and not one line more — with `--test` and run directly, both.
 *      An assertion that throws in test 1 is recorded and never reported.
 *
 * **So no position inside that file can speak through the hang.** A separate file can: this
 * one never calls the ladder, so it cannot hang, and it reports on its own. That is the only
 * arrangement in which a reinstated exit condition fails in milliseconds naming the line,
 * rather than as a test run somebody kills and shrugs at.
 *
 * ── TWO ASSERTIONS, BECAUSE NEITHER CATCHES THE OTHER'S MUTATION ───────────────────────
 * The loop may not be bounded by the gap it is doubling, AND the step count may not be
 * bounded by `failures`. Deleting `MAX_DOUBLINGS` from the clamp leaves the loop header
 * reading `n < steps` and sails straight past the first check — which is exactly how that
 * mutation survived the first round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = 'scripts/auto-cart-bot/renewal-schedule.mjs';

test('the backoff ladder is bounded by a CONSTANT, not by its own inputs', () => {
  const sched = readFileSync(SRC, 'utf8');

  // Anchored with an explicit `> -1` throughout: an `indexOf` miss returns -1 and
  // `slice(-1)` is the LAST CHARACTER of the file, which passes every check below
  // vacuously and for ever. A moved anchor must fail loudly, not silently approve.
  const at = sched.indexOf('export function renewBackoffGapMs');
  assert.ok(at > -1, 'renewBackoffGapMs moved or was renamed — this guard is measuring nothing');
  const ladder = sched.slice(at);

  const forAt = ladder.indexOf('for (');
  assert.ok(forAt > -1, 'the ladder must still have a loop to check');
  const loop = ladder.slice(forAt, ladder.indexOf(')', forAt) + 1);
  assert.ok(!/gap\s*<|<\s*gap/.test(loop),
    `the loop must not be bounded by the gap it is doubling — found: ${loop}`);

  const stepsAt = ladder.indexOf('const steps');
  assert.ok(stepsAt > -1, 'the step count moved — this guard is measuring nothing');
  const stepsStmt = ladder.slice(stepsAt, ladder.indexOf(';', stepsAt) + 1);
  assert.ok(stepsStmt.includes('MAX_DOUBLINGS'),
    `the step count must be clamped by a constant, not by \`failures\` — found: ${stepsStmt}`);

  const maxAt = sched.indexOf('MAX_DOUBLINGS =');
  assert.ok(maxAt > -1, 'MAX_DOUBLINGS is gone — the clamp above is naming something that does not exist');
});
