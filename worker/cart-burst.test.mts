/**
 * THE FAST LANE, AND EVERY WAY IT COULD DO HARM.
 *
 * On 2026-09-03 `#L005` at Leo Carrillo was tapped for an 08:00 PT release and never carted.
 * The runner was healthy; RC refused ~100 times with "The unit is not available for the
 * date(s) specified." Two measurements reframed that morning:
 *
 *   - RC's locks lapse LATE. Across 14 held units the poller alerted at T+3s, T+3s, T+4s,
 *     T+4s, T+10s, T+13s, T+13s, T+28s — and **not one before the predicted release**.
 *   - Our retry gap, measured from the runner's own log that morning: median 12s, max 24s.
 *
 * So we fired once into a lock that had not lapsed, then slept through most of the window in
 * which the site existed. Same morning, same park, the poller watched `rc-542::42527` open at
 * 08:00:13 and vanish by its next 15-second cycle.
 *
 * The burst is bounded in four independent ways, and each bound is a way it could do damage
 * to the thing it is trying to book from. Every one is mutation-verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shouldRetryBurst, isNotAvailable, describeBurst,
  BURST_WINDOW_MS, BURST_GAP_MS, BURST_BUDGET, BURST_LEAD_MS,
} from '../scripts/auto-cart-bot/cart-burst.mjs';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}
const RUNNER = () => code('scripts/auto-cart-bot/rc-hold-runner.mjs');

const NOT_AVAIL = 'The unit is not available for the date(s) specified.';
const base = {
  waitedForRelease: true, elapsedMs: 1_000, budgetLeft: 10,
  lastError: NOT_AVAIL, timedOut: false,
};

// ---------------------------------------------------------------------------
// 1. The bound that matters most: this must never fire on an ordinary retry.
// ---------------------------------------------------------------------------

test('a pass that did NOT wait for the release never bursts', () => {
  // THE DIFFERENCE BETWEEN A FAST LANE AND AN INCIDENT. `dueHolds` keeps serving a hold for
  // the whole 20-minute grace, so without this gate every feed poll would open a fresh
  // burst — on the order of a hundred bursts and thousands of POSTs at the site we are
  // trying to book from, on the morning it matters, from a residential IP RC's WAF has
  // blocked for twelve hours before.
  const r = shouldRetryBurst({ ...base, waitedForRelease: false });
  assert.equal(r.retry, false);
  assert.match(r.reason, /release pass/);
});

test('…and it does burst on the pass that DID wait', () => {
  const r = shouldRetryBurst(base);
  assert.equal(r.retry, true, 'otherwise the whole change is inert');
  assert.equal(r.waitMs, BURST_GAP_MS);
});

// ---------------------------------------------------------------------------
// 2. Only RC declining an unlapsed lock is worth retrying fast.
// ---------------------------------------------------------------------------

test('a wedged page stops the burst — that fault is OURS and hammering makes it worse', () => {
  const r = shouldRetryBurst({ ...base, timedOut: true });
  assert.equal(r.retry, false);
  assert.match(r.reason, /did not answer/);
});

test('anything RC says that we do not recognise stops the burst', () => {
  // CONSERVATIVE BY CONSTRUCTION. The dangerous direction is retrying fast into a fault that
  // fast retries worsen: a WAF 403, a rate limit, a dead session. Unrecognised must mean stop.
  for (const err of ['HTTP 403', 'HTTP 429', 'Access Denied', null, undefined, '']) {
    const r = shouldRetryBurst({ ...base, lastError: err });
    assert.equal(r.retry, false, String(err));
  }
});

test('the two refusals that look like "not available" but must NOT be retried', () => {
  // "already added" means the site is in a cart we hold — proof, and the read-back resolves
  // it. "maximum reservations" is capacity: retrying cannot change it.
  assert.equal(isNotAvailable(NOT_AVAIL), true);
  assert.equal(isNotAvailable("cart is already added, not available"), false);
  assert.equal(isNotAvailable("The maximum number of reservations allowed in the cart is '2'"), false);
});

// ---------------------------------------------------------------------------
// 3. Bounded in time and in attempts, and the budget is SHARED.
// ---------------------------------------------------------------------------

test('the window closes', () => {
  const r = shouldRetryBurst({ ...base, elapsedMs: BURST_WINDOW_MS });
  assert.equal(r.retry, false);
  assert.match(r.reason, /window/);
});

test('the budget runs out', () => {
  for (const left of [0, -1]) {
    assert.equal(shouldRetryBurst({ ...base, budgetLeft: left }).retry, false, String(left));
  }
});

test('the window covers every flip ever observed, and cannot eat the slow lane', () => {
  // Measured flips: T+3s .. T+28s. Below that and the burst stops before RC lets go, which
  // is the bug it exists to fix. Far above it and the fast lane becomes the only lane —
  // the 20-minute grace of ordinary retries is what catches a very late lapse (#94 was
  // still being alerted five minutes out).
  assert.ok(BURST_WINDOW_MS >= 28_000, `too short for the observed T+28s: ${BURST_WINDOW_MS}`);
  assert.ok(BURST_WINDOW_MS <= 120_000, `no longer a burst: ${BURST_WINDOW_MS}`);
});

test('the gap beats the slow lane without being a hammer', () => {
  // The measured slow-lane gap that lost the site was a median of 12s. Anything near that
  // buys nothing. Below ~250ms and, with each attempt already ~1s of RC round trips, this
  // stops being a retry and starts being a flood.
  assert.ok(BURST_GAP_MS >= 250, `a flood, not a retry: ${BURST_GAP_MS}`);
  assert.ok(BURST_GAP_MS <= 2_000, `no better than the 12s lane it replaces: ${BURST_GAP_MS}`);
});

// ---------------------------------------------------------------------------
// 3b. The lane opens BEFORE the predicted release — because nothing has ever
//     established that RC does not let go early.
// ---------------------------------------------------------------------------

test('the lane is open before T, and keeps trying there', () => {
  // Every poller sighting is at or after T, and that is NOT evidence of "never early": the
  // poller samples every 15s, so a flip at T-12s and one at T+3s produce the identical
  // reading. The runner has never once asked before T, so there is no observation either.
  const r = shouldRetryBurst({ ...base, elapsedMs: -12_000 });
  assert.equal(r.retry, true, 'a refusal before T must not end the lane');
});

test('the lead covers the whole sampling blind spot it is derived from', () => {
  // 15s is not a taste: it is exactly the poller's cadence, i.e. exactly the window in which
  // an early flip is invisible. Shorter and the blind spot is still partly unexamined.
  assert.ok(BURST_LEAD_MS >= 15_000, `leaves part of the 15s blind spot unasked: ${BURST_LEAD_MS}`);
  // And bounded: 2026-08-08 measured a cart 85s early being refused, so a lead anywhere near
  // that is spending requests on an answer we already have.
  assert.ok(BURST_LEAD_MS <= 60_000, `so early it is just the old 85s mistake: ${BURST_LEAD_MS}`);
});

test('an early win is REPORTED as early — the measurement is the whole point', () => {
  // A win at T-4.2s is the first direct evidence RC releases before its own prediction, and
  // an unsigned formatter would print it as "T+4.2s" and bury the finding. This project has
  // lost a diagnosis to a sign before.
  assert.match(describeBurst({ attempts: 3, elapsedMs: -4_200, won: true }), /T-4\.2s/);
  assert.match(describeBurst({ attempts: 3, elapsedMs: 4_200, won: true }), /T\+4\.2s/);
});

test('the total is bounded to something a WAF will not read as an attack', () => {
  assert.ok(BURST_BUDGET >= 10, `too small to cover the window: ${BURST_BUDGET}`);
  assert.ok(BURST_BUDGET <= 60, `too many requests in half a minute: ${BURST_BUDGET}`);
  // Each attempt is ~1s of round trips plus the gap, so this is the honest worst case.
  // The lane now runs from T-LEAD to T+WINDOW, so the lead counts towards the worst case.
  const span = BURST_LEAD_MS + BURST_WINDOW_MS;
  const worst = Math.min(BURST_BUDGET, Math.ceil(span / (BURST_GAP_MS + 1000)));
  assert.ok(worst <= 40, `worst case ${worst} attempts across ${span / 1000}s`);
  assert.ok(BURST_BUDGET >= Math.ceil(span / (BURST_GAP_MS + 1000)) * 0.5,
    'a budget that cannot reach the release moment stops the lane before the site opens');
});

// ---------------------------------------------------------------------------
// 4. …and the runner actually uses it, correctly. Every test above passes against
//    a runner that never calls any of this.
// ---------------------------------------------------------------------------

test('the runner calls the shared decision rather than inlining its own', () => {
  const src = RUNNER();
  assert.match(src, /import \{[^}]*\bshouldRetryBurst\b[^}]*\} from '\.\/cart-burst\.mjs'/);
  assert.match(src, /shouldRetryBurst\(\{/, 'the cart path must ASK, not decide');
});

test('the runner wakes BEFORE the release and measures from T, not from waking', () => {
  const src = RUNNER();
  assert.match(src, /const early = Math\.max\(0, wait - BURST_LEAD_MS\);/,
    'the sleep must stop short of the release');
  assert.match(src, /await sleepTicking\(early\);/, 'and it must sleep that shortened time');
  // T IS FIXED BEFORE THE SLEEP. `Date.now()` after waking makes T whenever we happened to
  // wake — which with an early lead is 15 seconds wrong, in the direction that hides an
  // early release. Same class of error as parsing a zone-less string with `new Date()`.
  const rm = src.indexOf('const releaseMoment = Date.now() + wait;');
  const slept = src.indexOf('await sleepTicking(early);');
  assert.ok(rm > -1, 'the release instant must include the wait');
  assert.ok(rm < slept, 'the release instant must be fixed before the sleep');
});

test('`waitedForRelease` is DERIVED from the actual wait, not passed as a constant', () => {
  // A hardcoded `true` here reinstates exactly the storm the first test guards against, and
  // it would read as a tidy simplification in a diff.
  const src = RUNNER();
  assert.match(src, /const waitedForRelease = wait > 0;/);
  const decl = src.indexOf('const waitedForRelease = wait > 0;');
  const use = src.indexOf('waitedForRelease,', decl);
  assert.ok(use > decl, 'the flag must be computed before the cart loop reads it');
});

test('the budget is opened OUTSIDE the per-hold loop, so holds share it', () => {
  // Per-hold it multiplies by CART_CONCURRENCY: four holds each spending twenty attempts is
  // eighty POSTs in thirty seconds.
  const src = RUNNER();
  const budget = src.indexOf('let burstBudget = BURST_BUDGET;');
  const pmap = src.indexOf('await pMap(holds, CART_CONCURRENCY');
  assert.ok(budget > -1 && pmap > -1, 'sanity: both present');
  assert.ok(budget < pmap, 'a budget declared inside pMap is a per-hold budget');
});

test('the budget is actually SPENT, or it bounds nothing', () => {
  assert.match(RUNNER(), /burstBudget -= 1;/);
});

test('a success and a throw both LEAVE the loop', () => {
  // Without the returns the retry loop runs on past a cart it already won, resubmitting over
  // a site we hold — which RC answers "cart is already added" and which would overwrite a
  // true success with a rejection.
  const src = RUNNER();
  const loop = src.indexOf('for (;;) {', src.indexOf('await pMap(holds, CART_CONCURRENCY'));
  const tail = src.slice(loop, loop + 4000);
  assert.match(tail, /await report\(\{ id: h\.id, ok: true[^}]*\}\);\s*\n\s*return;/,
    'a won cart must return');
  assert.match(tail, /catch \(err\) \{[\s\S]{0,600}?return;\s*\n\s*\}/,
    'a throw must return, never fall through into another attempt');
});

test('the cart key survives a fast retry', () => {
  // If the submit landed and only the read-back did not, the site is locked in THAT cart.
  // Minting a fresh one on the next attempt orphans it — the reason the slow lane already
  // carries the key across passes.
  assert.match(RUNNER(), /if \(cartKey\) h\.cartKey = cartKey;/);
});

test('the burst reports what it spent', () => {
  const won = describeBurst({ attempts: 7, elapsedMs: 9_400, won: true });
  assert.match(won, /attempt 7/);
  assert.match(won, /T\+9\.4s/);
  const lost = describeBurst({ attempts: 18, elapsedMs: 29_400, won: false, reason: 'window closed' });
  assert.match(lost, /18 fast attempt/);
  assert.match(lost, /29\.4s/, 'a count without an elapsed time cannot be read against the flips');
});
