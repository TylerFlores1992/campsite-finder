/**
 * THE HAND-OFF DIAGNOSTIC MUST NOT LOSE THE REPORT THAT MATTERS.
 *
 * ## The failure this is a response to
 *
 * On 2026-09-22 a hand-off failed on a real phone showing `RC declined (401)`, and that
 * 401 appears in **zero** `rc_hold_requests.client_reports` rows, ALL TIME. The last
 * thing recorded was the sign-in prompt before it. The instrument built to explain
 * hand-off failures was blind exactly where the failure was.
 *
 * ## WHAT THIS DOES NOT CLAIM
 *
 * **The cause of that specific loss is NOT established, and no mechanism is written in.**
 * These guards pin two ways the last report could be deferred, both read off the code:
 *
 *   1. the debounce RESET on every report and had **no ceiling**, so an unbroken stream
 *      defers the flush indefinitely — and `rc-inject.js` rebroadcasts on the SAME 1500ms
 *      interval, so the margin was zero by construction;
 *   2. a `status` carrying a verdict queued behind `token`/`cartkey`, which arrive dozens
 *      of times a minute and are the only reason the batching exists.
 *
 * Closing both is worth doing whether or not either caused the 401.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLAIMFLOW = 'src/components/v2/ClaimFlow.tsx';
const INJECT = 'extension/rc-inject.js';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

test('a verdict-bearing stage flushes IMMEDIATELY, not on the debounce', () => {
  const s = code(CLAIMFLOW);
  assert.match(s, /FLUSH_NOW_STAGES\.has\(r\.stage\)/,
    'onReport must branch on the stage before queueing');
  // The branch must actually FLUSH and RETURN — falling through would re-arm the timer
  // and put the report back in the queue it was meant to skip.
  assert.match(s, /FLUSH_NOW_STAGES\.has\(r\.stage\)\)\s*\{[\s\S]{0,220}flushReports\(\);[\s\S]{0,40}return;/,
    'the immediate branch must call flushReports and return');
});

test('`status` is in the set — it is the stage that carried the lost 401', () => {
  const s = code(CLAIMFLOW);
  const m = s.match(/const FLUSH_NOW_STAGES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'FLUSH_NOW_STAGES must be a literal Set so this is checkable');
  const stages = m[1];
  for (const needed of ['status', 'error', 'idle', 'closed']) {
    assert.match(stages, new RegExp(`'${needed}'`), `${needed} must flush at once`);
  }
});

test('the CHATTY stages are NOT in the set, or the batching is pointless', () => {
  // `rc-inject.js` rebroadcasts both every 1500ms. Flushing on those would turn a
  // diagnostic into a request every 1.5s for thirty seconds, on a phone, at 08:00.
  const m = code(CLAIMFLOW).match(/const FLUSH_NOW_STAGES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m);
  for (const noisy of ['token', 'cartkey']) {
    assert.ok(!m[1].includes(`'${noisy}'`), `${noisy} must stay batched`);
  }
});

test('the debounce has a CEILING, so a busy stream cannot defer it for ever', () => {
  const s = code(CLAIMFLOW);
  assert.match(s, /const MAX_REPORT_WAIT_MS = \d+/, 'there must be a bound');
  // The timer must be computed from how long the OLDEST report has already waited —
  // a bare `setTimeout(flushReports, 1500)` after a clearTimeout is the unbounded form.
  assert.match(s, /oldestPending\.current/, 'the bound needs the oldest arrival time');
  assert.match(s, /MAX_REPORT_WAIT_MS - waited/,
    'the delay must shrink as the oldest report ages, or the ceiling does nothing');
  assert.match(s, /oldestPending\.current = null/, 'and reset when the buffer drains');
});

test('THE ARITHMETIC THAT MADE THE MARGIN ZERO — pinned from both files', () => {
  // This is the finding, and it is only visible by reading two files together: the
  // debounce interval and the rebroadcast interval were the SAME number, so "quiet for
  // one interval" raced a broadcast arriving exactly one interval apart. A guard on
  // either file alone cannot see it.
  const rebroadcast = code(INJECT).match(/\}, (\d+)\);/);
  assert.ok(rebroadcast, 'rc-inject.js must still rebroadcast on an interval');
  const ceiling = code(CLAIMFLOW).match(/const MAX_REPORT_WAIT_MS = (\d+)/);
  assert.ok(ceiling);
  assert.ok(Number(ceiling[1]) > Number(rebroadcast[1]),
    `the ceiling (${ceiling?.[1]}ms) must exceed the rebroadcast interval ` +
    `(${rebroadcast?.[1]}ms), or it fires mid-stream on every run`);
});

test('the flush still uses keepalive — an immediate flush is worth nothing if it dies with the page', () => {
  assert.match(code(CLAIMFLOW), /keepalive: true/,
    'a flush started as the webview closes must still go out');
});
