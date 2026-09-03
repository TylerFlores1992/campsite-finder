/**
 * THE CART CALL MUST BE BOUNDED, BECAUSE PLAYWRIGHT'S EVALUATE IS NOT.
 *
 * On 2026-09-02 the hold runner logged `ready for 1 hold(s) — holding 77.0s`, waited out the
 * lead, and then went silent for ever: it never carted, never polled the feed again, and
 * `list-processes` showed the node process still ALIVE. `supervise.ps1` restarts on EXIT only,
 * so nothing recovered it, and the Fly `runner-watch` alarm needs a hold due inside 45 minutes
 * — which the sweep had just failed. It would have sat there indefinitely.
 *
 * `page.evaluate` waits for ever by construction: it needs an execution context, and a page
 * whose main thread is blocked never provides one. `rc-token.evaluateWithin` was written for
 * exactly this on 2026-08-17 and the keep-warm was fixed; the RUNNER's cart path — the most
 * release-critical call in the product — was never carried across.
 *
 * NOT PROVEN that this evaluate is what hung. Nothing recorded which await it was, and a
 * Playwright call failing to honour its own timeout is still live. These guard the property
 * that makes the question survivable either way: the loop advances.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { precartInPage } from '../scripts/auto-cart-bot/rc-cart.mjs';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const ARGS = { unitId: 42546, arrival: '2026-12-01', nights: 1, cartKey: null };

test('a page that never answers does NOT hang the caller — it reports timedOut', async () => {
  // THE OBSERVED FAILURE. Before this, the await below never settled and the runner's loop
  // stopped for ever with the process still alive.
  const wedged = { evaluate: () => new Promise(() => {}) };
  const r = await precartInPage(wedged, ARGS, { timeoutMs: 30 }) as { timedOut?: number };
  assert.equal(r.timedOut, 30, 'the timeout must name its own bound, so the note can quote it');
});

test('a working cart is untouched — the bound only catches a wedge', async () => {
  const good = { evaluate: async () => ({ finalKey: 'abc', submitted: { v: { isSuccess: true } } }) };
  const r = await precartInPage(good, ARGS, { timeoutMs: 30 }) as { finalKey?: string; timedOut?: number };
  assert.equal(r.finalKey, 'abc');
  assert.equal(r.timedOut, undefined, 'a cart that answered must not be labelled a timeout');
});

test('a slow-but-successful cart still wins the race', async () => {
  const slow = { evaluate: () => new Promise((res) => setTimeout(() => res({ finalKey: 'late' }), 10)) };
  const r = await precartInPage(slow, ARGS, { timeoutMs: 400 }) as { finalKey?: string };
  assert.equal(r.finalKey, 'late');
});

test('the default bound is generous, and far above anything a working cart takes', () => {
  // It exists to catch a WEDGE, not to police a slow morning: RC's web tier has needed three
  // attempts and five minutes to answer a page. Too tight is a cart killed at 08:00:00.
  const src = code('scripts/auto-cart-bot/rc-cart.mjs');
  const m = src.match(/CART_EVAL_TIMEOUT_MS\s*=\s*Number\([^)]*\|\|\s*([\d_]+)\)/);
  assert.ok(m, 'the default must be a readable literal');
  const ms = Number(m![1].replace(/_/g, ''));
  assert.ok(ms >= 30_000, `too tight to survive a slow RC: ${ms}ms`);
  assert.ok(ms <= 180_000, `so long it is not a bound at all: ${ms}ms`);
});

test('the timer is cleared, so a fast cart cannot hold the process open', () => {
  const src = code('scripts/auto-cart-bot/rc-cart.mjs');
  assert.match(src, /\.finally\(\(\) => clearTimeout\(timer\)\)/,
    'an uncleared timer keeps the event loop alive past the work');
});

test('the runner reports a timeout as OURS, never as an RC refusal', () => {
  // Reporting a wedged browser as RC's error sends the next reader to the wrong side of the
  // fault — the shape this repo records more than any other.
  const src = code('scripts/auto-cart-bot/rc-hold-runner.mjs');
  assert.match(src, /result\?\.timedOut/, 'the runner must distinguish a timeout');
  const at = src.indexOf('result?.timedOut');
  assert.match(src.slice(at, at + 260), /did not answer|not responding/,
    'and say what actually happened, in our own words');
});

test('the read-back still runs after a timeout — the cart may have landed', () => {
  // The two POSTs happen inside the page; a timeout loses the ANSWER, not necessarily the
  // cart. Skipping the verification on timeout would turn "we do not know" into "it failed".
  const src = code('scripts/auto-cart-bot/rc-hold-runner.mjs');
  const cart = src.indexOf('const result = await precartInPage(');
  const check = src.indexOf('findCartEntry(', cart);
  const branch = src.indexOf('if (check.found)', cart);
  assert.ok(cart > -1 && check > cart && branch > check,
    'the cart read-back must sit between the precart and the verdict, unconditionally');
});
