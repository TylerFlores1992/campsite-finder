/**
 * A LOST CAMPSITE MUST NOT RENDER AS THE HAPPY PATH.
 *
 * `rc-holds-readout` printed a column headed `claimed` whose value was
 * `claimed_at ?? released_at` — so a hold the user never claimed showed the moment the BOT
 * LET GO, under a heading saying the user took it. The two campsites lost on 2026-09-21
 * (`#R359` and `#M450`, both `released` with `claimed_at` NULL) read as successes in the
 * one readout anybody opens after a release.
 *
 * An absent reading rendered as a positive fact, in a single `??`.
 *
 * ## And the obvious repair would have been wrong
 *
 * A `lost` status plus a sweep asserts a fact nobody has: `released` with no claim is
 * genuinely ambiguous, because a plain desktop browser has no injectable client, the user
 * books by hand, nothing is ever reported — and that is a SUCCESS. So `unresolved` is a
 * first-class answer here, and these tests pin that it stays one in BOTH directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { holdOutcome, describeHoldOutcome } from './hold-outcome';

const base = { status: 'released', claimed_at: null, released_at: '2026-09-21T15:27:34Z' };
const say = (...lines: string[]) => lines.map((status) => ({ stage: 'status', detail: { status } }));

test('a recorded claim outranks everything derived', () => {
  assert.equal(holdOutcome({ ...base, status: 'claimed', claimed_at: '2026-09-21T15:30:00Z' }), 'claimed');
  // Even against a failure line — `claimed_at` is written by the claim route from the
  // user's own session, and nothing inferred can beat a thing we recorded.
  assert.equal(
    holdOutcome({ ...base, claimed_at: '2026-09-21T15:30:00Z',
      client_reports: say('RC declined — the unit is not available') }),
    'claimed');
});

test('#R359 and #M450 — released, never claimed, nothing reported — are UNRESOLVED', () => {
  // THE REGRESSION. These two rows are what rendered as the happy path.
  assert.equal(holdOutcome(base), 'unresolved');
  assert.equal(holdOutcome({ ...base, client_reports: [] }), 'unresolved');
  assert.equal(holdOutcome({ ...base, client_reports: null }), 'unresolved');
});

test('UNRESOLVED is not rounded to a loss either — the desktop case is a success', () => {
  // The opposite error, and just as wrong. A plain browser reports nothing and the user
  // books by hand; calling that a loss would make the readout lie in the other direction.
  const o = holdOutcome(base);
  assert.notEqual(o, 'client-failed');
  assert.notEqual(o, 'claimed');
  assert.match(describeHoldOutcome(o), /UNRESOLVED/);
  assert.match(describeHoldOutcome(o), /desktop booking, or lost/,
    'the label must name BOTH possibilities, or a reader picks one');
});

test('a success anywhere outranks a later failure — the ordering that was paid for', () => {
  // On both proven holds the LAST line read `RC declined (200) - cart is already added`:
  // RC refusing a second submit over an entry we already held. Reading the last line
  // reported the two runs that settled the question as failures.
  assert.equal(
    holdOutcome({ ...base, client_reports: say('✓ Added to cart — opening your cart…',
      'RC declined (200) - cart is already added') }),
    'client-carted');
});

test('EACH success signal is pinned ALONE, because either one covers the other', () => {
  // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Deleting the `Added to cart` check
  // changed nothing: the case above carries BOTH signals, so the `already added` check
  // caught it and the suite stayed green over a rule that had been removed.
  //
  // Two independent checks need two independent cases — the same lesson as the claim
  // gate's two token carriers, where pinning one boundary let the other's mutation through.
  assert.equal(
    holdOutcome({ ...base, client_reports: say('✓ Added to cart — opening your cart…') }),
    'client-carted', 'our own success line alone must be enough');
  // And `already added` ALONE is RC saying the cart is ours — the same string the runner's
  // burst logged as "could not hold" for fifteen minutes over a site it held.
  assert.equal(
    holdOutcome({ ...base, client_reports: say('cart is already added') }),
    'client-carted', "RC's own already-added line alone must be enough");
});

test('an established loss says so, and only when something reported it', () => {
  assert.equal(
    holdOutcome({ ...base, client_reports: say('The unit is not available for the date(s) specified') }),
    'client-failed');
  assert.match(describeHoldOutcome('client-failed'), /LOST/);
});

test('no hand-off is its own answer, not an unanswered question', () => {
  // An expired hold nobody tapped had no exposure window and no race to lose. Filing it
  // under `unresolved` would pad the count of things needing investigation with rows that
  // have a complete story.
  assert.equal(holdOutcome({ status: 'expired', claimed_at: null, released_at: null }), 'not-handed-off');
  assert.equal(holdOutcome({ status: 'offered', claimed_at: null, released_at: null }), 'not-handed-off');
});

test('every outcome has a distinct label — none may read as another', () => {
  const all = ['claimed', 'client-carted', 'client-failed', 'unresolved', 'not-handed-off'] as const;
  const labels = all.map(describeHoldOutcome);
  assert.equal(new Set(labels).size, all.length, 'two outcomes render identically');
  for (const l of labels) assert.ok(l.length > 0);
});

// ── the wiring, which is where the `??` actually lived ──────────────────────────────

test('the readout no longer falls back to released_at under a `claimed` heading', () => {
  const src = readFileSync('scripts/rc-holds-readout.mts', 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/claimed_at \?\? h?\.?released_at/.test(src),
    'the `claimed_at ?? released_at` fallback is the bug — it must not come back');
  assert.match(src, /holdOutcome\(h\)/, 'the column must be derived, not guessed');
  assert.match(src, /describeHoldOutcome\(holdOutcome\(h\)\)/,
    'and the per-hold block must print the verdict, including when it is unresolved');
});
