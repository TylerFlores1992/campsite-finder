/**
 * THE EGRESS-CASCADE WATCHDOG SHIPPED WITH NOTHING GUARDING IT (issue #14).
 *
 * On 2026-07-22 the Fly worker went from a rec.gov-only throttle into a FULL detection
 * outage. rec.gov shifted from fast 429s to slow 10-second timeouts; those hanging
 * connections starved the socket pool, so every OTHER source began timing out too. The
 * machine looked perfectly alive throughout — the Supabase heartbeat write kept
 * succeeding, so `msSinceAlive()` stayed fresh and the liveness watchdog never fired —
 * while cancellation alerting was silently dead. Recovery was a human typing
 * `flyctl machine restart`.
 *
 * A SECOND OUTAGE ON 2026-07-24 SHOWED WHY ONE EXTERNAL SIGNAL IS NOT ENOUGH. Egress
 * degraded so that ~all detects timed out, but an occasional source succeeding kept
 * resetting the zero-success timer — so a staleness check alone never tripped, and again a
 * human had to restart. That is why there are TWO external signals:
 *
 *   (a) `msSinceExternalFetchOk()` — a hard wedge, or the canary stopping entirely.
 *   (b) `externalFetchWedged()`    — a rolling failure RATIO, which is the only thing that
 *                                    catches the flapping case.
 *
 * WHY THIS FILE EXISTS. All four items on #14 were built — the timeout cut to 5s, the
 * scheduler's token bucket, timeouts counting toward the breaker, and this watchdog — and
 * then **nothing tested any of it for five weeks**. The dangerous half is not the pure
 * function; it is the WIRING, and this repo has paid repeatedly for a fix that is present
 * and inert (`6006428` changing only the copy, the `--claimed` flag the poller never
 * passed, the size guard checked inside the loop it guards against). Deleting
 * `markExternalFetchResult(false)` from the canary leaves every assertion about the ratio
 * true and makes the ratio permanently unreachable, because a failure would never be
 * recorded. That is invisible by reading either file, so it is guarded mechanically.
 *
 * NOT TESTED HERE: that Fly actually restarts the VM on exit(1). That is `restart_policy`
 * in `worker/fly.toml`, and it is asserted separately below by reading the config rather
 * than assumed.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  markAlive, msSinceAlive,
  markExternalFetchResult, msSinceExternalFetchOk, externalFetchWedged,
} from './liveness';

// ---------------------------------------------------------------------------
// BEHAVIOURAL — the two signals, and the case that needs both.
//
// `externalOutcomes` IS MODULE STATE, SHARED BY EVERY TEST IN THIS FILE, and the first
// version of these tests was silently order-dependent because of it: ten failures asked
// about a 60s window returned FALSE, because four earlier tests had left eleven successes
// inside the same window and the real ratio was 0.73. A cache-busted dynamic import does
// not isolate it either — verified, tsx dedupes the module regardless of the query string.
//
// So the isolation is a TIME BARRIER. The window under test is `W`, every test sleeps
// `BARRIER > W` first, and each test's own work takes microseconds — so a test sees its
// own outcomes and nothing else. `liveness.ts` gets no test-only reset export: production
// code should not grow a hatch to make a test easier to write.
// ---------------------------------------------------------------------------

/** Window every behavioural test asks about. */
const W = 100;
/** Longer than `W`, so the previous test's outcomes have aged out of it. */
const BARRIER = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => sleep(BARRIER));

test('a QUIET window never trips the ratio — it must not reboot a healthy idle machine', () => {
  // `attempts < minAttempts` returns false. Without this a machine that simply had not
  // probed yet would reboot itself in a loop, which is worse than the outage.
  markExternalFetchResult(false);
  assert.equal(externalFetchWedged(W, 6, 0.8), false,
    'one failure is not a wedge — the minimum-attempts floor is what stops a reboot loop');
});

test('MOSTLY-DEAD egress trips the ratio', () => {
  for (let i = 0; i < 10; i++) markExternalFetchResult(false);
  assert.equal(externalFetchWedged(W, 6, 0.8), true,
    'ten consecutive failures is the cascade this exists for');
});

test('THE FLAPPING WEDGE — the 2026-07-24 case that a staleness check alone missed', () => {
  // The shape that beat the first version: mostly failures, with the occasional success
  // that keeps `msSinceExternalFetchOk` fresh forever. The ratio is the ONLY signal that
  // can see this, so if this assertion is ever relaxed the flapping outage comes back.
  for (let i = 0; i < 9; i++) markExternalFetchResult(false);
  markExternalFetchResult(true);

  assert.ok(msSinceExternalFetchOk() < 1000,
    'the occasional success keeps the STALENESS timer fresh — that is the trap');
  assert.equal(externalFetchWedged(W, 6, 0.8), true,
    '9 failures in 10 is a wedge even though a success landed a moment ago');
});

test('A HEALTHY window does NOT trip', () => {
  for (let i = 0; i < 10; i++) markExternalFetchResult(true);
  assert.equal(externalFetchWedged(W, 6, 0.8), false);
});

test('THE WINDOW IS A WINDOW — outcomes older than it are ignored', async () => {
  for (let i = 0; i < 10; i++) markExternalFetchResult(false);
  assert.equal(externalFetchWedged(W, 6, 0.8), true, 'inside the window they count');

  // Let them age out, then ask about a window they fall outside. Without the cutoff an
  // ancient cascade would keep rebooting a machine that had already recovered.
  //
  // MEASURED REAL TIME, NOT A ZERO WINDOW. An earlier version passed 0 and failed: the
  // cutoff is `Date.now()`, the outcomes were recorded in the same millisecond, and the
  // comparison is `o.t < cutoff` — so they were still inside it. That was the TEST being
  // wrong about clock granularity, not the code; a zero-length window is not a real case.
  await sleep(BARRIER);
  assert.equal(externalFetchWedged(W, 6, 0.8), false,
    `outcomes ${BARRIER}ms old must fall outside a ${W}ms window, leaving zero attempts`);
});

test('A SUCCESS RESETS THE STALENESS TIMER AND A FAILURE DOES NOT', async () => {
  markExternalFetchResult(true);
  await sleep(BARRIER);
  markExternalFetchResult(false);

  // THE GAP IS THE WHOLE TEST. The first version recorded the two back to back and asserted
  // `since >= afterOk` — both were ~0, so `0 >= 0` held and the mutation that makes a
  // FAILURE reset the clock (`if (ok) lastExternalOkAt = now` -> `lastExternalOkAt = now`)
  // sailed through. Ageing the success first is what makes the two cases distinguishable:
  // if a failure reset the timer this reads ~0 instead of ~BARRIER, and a hard wedge — the
  // 2026-07-22 outage — becomes invisible to the watchdog again.
  const since = msSinceExternalFetchOk();
  assert.ok(since >= BARRIER - 5,
    `the staleness timer must still reflect the SUCCESS (~${BARRIER}ms ago), not the `
    + `failure that just landed — it read ${since}ms`);
});

test('the heartbeat signal is SEPARATE from the egress signal', () => {
  // The whole premise of #14: Supabase egress kept working while provider egress died. If
  // one call updated both clocks the cascade would be invisible again.
  markAlive();
  const beat = msSinceAlive();
  markExternalFetchResult(false);
  assert.ok(msSinceAlive() >= beat && msSinceAlive() < 1000,
    'an external outcome must not touch the heartbeat clock, nor the reverse');
});

// ---------------------------------------------------------------------------
// STRUCTURAL — the wiring, which is the half that can rot silently.
// ---------------------------------------------------------------------------

const canary = readFileSync(new URL('./canary.ts', import.meta.url), 'utf8');
const poller = readFileSync(new URL('./poller.ts', import.meta.url), 'utf8');
const flyToml = readFileSync(new URL('./fly.toml', import.meta.url), 'utf8');

/** Comments stripped — this file's neighbours quote the broken shapes to explain them. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

test('THE CANARY RECORDS BOTH OUTCOMES — recording only successes makes the ratio dead code', () => {
  const src = code(canary);
  assert.match(src, /markExternalFetchResult\(true\)/,
    'a successful detect probe must keep the staleness timer fresh');
  assert.match(src, /markExternalFetchResult\(false\)/,
    'a FAILED detect probe must be recorded too — without it the failure ratio can never '
    + 'reach its threshold, so the flapping-wedge watchdog is permanently unreachable while '
    + 'every test of the pure function still passes');
});

test('BOTH CASCADE CHECKS ARE WIRED TO AN EXIT, not merely computed', () => {
  const src = code(poller);
  for (const [call, why] of [
    ['msSinceExternalFetchOk()', 'the hard-wedge signal'],
    ['externalFetchWedged(', 'the flapping-wedge signal (the 2026-07-24 case)'],
  ] as const) {
    const at = src.indexOf(call);
    assert.ok(at > -1, `${why} is not consulted by the poller at all`);
    // The exit must follow the check, and closely: a signal that is read and then not
    // acted on is exactly the shape #14 was reopened by.
    const after = src.slice(at, at + 900);
    assert.match(after, /process\.exit\(1\)/,
      `${why} is read but nothing exits — Fly only reboots the VM on a non-zero exit, so `
      + 'without it the machine sits wedged exactly as it did on 2026-07-22');
  }
});

test('THE EXIT IS ONLY WORTH ANYTHING IF FLY RESTARTS THE MACHINE', () => {
  // `process.exit(1)` is the whole remedy, and it does nothing unless the platform brings
  // the VM back. Read from fly.toml rather than assumed, because a config change made for
  // an unrelated reason would silently turn the watchdog into a way to STOP alerting.
  assert.doesNotMatch(code(flyToml), /restart_policy\s*=\s*["']no["']/i,
    'a restart policy of "no" turns every watchdog exit into a permanent outage');
});

test('THE THRESHOLDS ARE BOUNDED FROM BOTH SIDES', () => {
  const src = code(poller);
  const num = (name: string) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*Number\\(process\\.env\\.${name}\\s*\\?\\?\\s*([^)]+)\\)`));
    assert.ok(m, `${name} must exist with a literal default`);
    // Defaults are written as products (`5 * 60 * 1000`), so evaluate rather than parse
    // the first integer — a bare \d+ read `6 * 60 * 1000` as SIX, which is how a guard
    // here has approved the wrong value before.
    return Number(new Function(`return (${m![1]})`)());
  };
  const ratio = num('WATCHDOG_EXTERNAL_MAX_FAIL_RATIO');
  assert.ok(ratio >= 0.5 && ratio <= 1,
    `a fail ratio of ${ratio} is outside 0.5..1 — below half is not "mostly dead" and `
    + 'would reboot on ordinary provider flakiness');
  const minAttempts = num('WATCHDOG_EXTERNAL_MIN_ATTEMPTS');
  assert.ok(minAttempts >= 3,
    `${minAttempts} attempts is too few to call a wedge — the floor is what stops a quiet `
    + 'window rebooting a healthy machine');
  const windowMs = num('WATCHDOG_EXTERNAL_WINDOW_MS');
  const staleMs = num('WATCHDOG_EXTERNAL_STALE_MS');
  assert.ok(windowMs >= 60_000, 'a window under a minute cannot accumulate enough probes');
  assert.ok(staleMs > windowMs,
    'the hard-wedge staleness bound must be the SLOWER of the two, or the ratio signal — '
    + 'the only one that catches a flapping wedge — never gets a chance to speak');
});
