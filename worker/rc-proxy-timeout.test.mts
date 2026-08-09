/**
 * The rc-proxy batch must not be able to hang, and its budgets must add up.
 *
 * MEASURED 2026-08-09. `forward()`'s upstream fetch had no timeout, so one slow RDR
 * request held its fanout lane open indefinitely and the CALLER's flat 30s batch deadline
 * fired instead — which fails every request in the batch, so all N retried together.
 * Eleven consecutive batches timed out in one sample and every RC call in the log was
 * succeeding on attempt 2 or 3, never attempt 1. Vercel reported it as "502s from upstream
 * 403 errors"; there were zero 403s. They were our own aborts.
 *
 * These are source-level assertions on purpose: the failure is a missing argument and a
 * budget that does not divide, neither of which a mock of `fetch` would catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proxy = readFileSync('src/app/api/rc-proxy/route.ts', 'utf8');
const client = readFileSync('src/lib/sources/reservecalifornia/client.ts', 'utf8');

/** Pull `const NAME = Number(process.env.X ?? 12_000)` or `const NAME = 2` out of source. */
function constant(src: string, name: string): number {
  const m = src.match(new RegExp(String.raw`const ${name} = (?:Number\(process\.env\.\w+ \?\? )?([0-9_]+)`));
  assert.ok(m, `could not find ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

test('the proxy bounds every upstream request', () => {
  // The forwarding fetch — not any other fetch in the file — must carry a signal.
  const fwd = proxy.slice(proxy.indexOf('async function forward'), proxy.indexOf('export async function POST'));
  assert.match(fwd, /signal: AbortSignal\.timeout\(UPSTREAM_TIMEOUT_MS\)/,
    'a hung upstream call must not be possible — it takes the whole batch with it');
  // And the hang must land as THIS item's result, which is the route's stated contract.
  assert.match(fwd, /A transport failure is this item's result, not the batch's/);
});

test('a full batch fits inside the caller deadline, with margin', () => {
  // THE ARITHMETIC THAT WAS WRONG. The caller allows a flat UD_TIMEOUT_MS * 2 for the
  // whole batch, while the proxy runs ceil(n / FANOUT) rounds IN SERIES. At the previous
  // effective per-request bound of 15s a batch of 4 needed exactly the caller's 30s and
  // had zero margin — which is why batch(4) sat permanently on the edge.
  const FANOUT = constant(proxy, 'FANOUT');
  const upstream = constant(proxy, 'UPSTREAM_TIMEOUT_MS');
  const perRequest = constant(client, 'UD_TIMEOUT_MS');
  const callerDeadline = perRequest * 2; // AbortSignal.timeout(UD_TIMEOUT_MS * 2)

  assert.match(client, /AbortSignal\.timeout\(UD_TIMEOUT_MS \* 2\)/,
    'if the caller deadline changes shape, this test is measuring the wrong thing');

  // A batch of 4 is the size actually observed in production.
  const rounds = Math.ceil(4 / FANOUT);
  assert.ok(
    rounds * upstream < callerDeadline,
    `${rounds} rounds x ${upstream}ms must finish inside the caller's ${callerDeadline}ms`,
  );
  // And not merely fit — leave room for proxy overhead and the network, or it lands back
  // on the edge the moment upstream is slightly slow.
  assert.ok(
    callerDeadline - rounds * upstream >= 5_000,
    `only ${callerDeadline - rounds * upstream}ms of margin — too tight to survive a slow day`,
  );
});

test('a proxy-side timeout is still RETRYABLE to the caller', () => {
  // The timeout returns 502, and the retry rule is `status >= 500`. If that ever narrows,
  // this change would convert a retryable stall into a hard failure — strictly worse than
  // the bug it fixes, and silent.
  assert.match(client, /if \(status !== null\) return status === 429 \|\| status === 403 \|\| status >= 500;/);
  const fwd = proxy.slice(proxy.indexOf('async function forward'), proxy.indexOf('export async function POST'));
  assert.match(fwd, /return \{ ok: false, status: 502, error: `fetch failed: \$\{message\}` \};/);
});
