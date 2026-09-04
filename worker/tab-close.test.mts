/**
 * THE THROWAWAY TAB'S CLOSE IS BOUNDED, TIMED, AND WIRED — see scripts/auto-cart-bot/tab-close.mjs.
 *
 * Every Okta trip ended with `await tab.close().catch(() => {})`, unbounded, against a
 * renderer that on every recorded ramp went on growing for ten minutes after the trip's work
 * should have ended. Whether those minutes were the trip's body or this one await was the
 * number nothing recorded. These guards pin: the close gives up on a deadline; a hung close
 * asks the resident loop for a recycle exactly once; every close is reported, hung or not;
 * and — the half that matters — the keep-warm actually CALLS it at all three sites and READS
 * the recycle request, because a helper that is perfect and inert is the shape this repo has
 * paid for six times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeTabBounded, takePendingRecycle, TAB_CLOSE_MS } from '../scripts/auto-cart-bot/tab-close.mjs';

const KW = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
const code = KW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const fakeClock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

test('a close that resolves is reported prompt, with the trip duration beside it', async () => {
  const clk = fakeClock();
  const reports: Array<[string, Record<string, unknown>]> = [];
  const tab = { close: async () => { clk.advance(40); } };
  const r = await closeTabBounded(tab, {
    label: 'renewal', startedAt: clk.now() - 61_000, ramMb: -700,
    now: clk.now, report: (k, d) => { reports.push([k, d]); },
  });
  assert.equal(r.hung, false);
  assert.equal(r.closeMs, 40);
  assert.equal(r.tripMs, 61_000);
  assert.equal(takePendingRecycle(), null, 'a prompt close owes no recycle');
  assert.equal(reports.length, 1, 'REPORTED ON EVERY CLOSE — the healthy baseline is what makes a bad number readable');
  assert.equal(reports[0][0], 'tab-close');
  assert.deepEqual(
    { label: reports[0][1].label, hung: reports[0][1].hung, closeMs: reports[0][1].closeMs, tripMs: reports[0][1].tripMs, ramMb: reports[0][1].ramMb },
    { label: 'renewal', hung: false, closeMs: 40, tripMs: 61_000, ramMb: -700 },
  );
});

test('a close that never resolves is given up on at the deadline and asks for ONE recycle', async () => {
  const lines: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  const tab = { close: () => new Promise<void>(() => {}) };        // never settles
  const r = await closeTabBounded(tab, {
    label: 'auto-login', startedAt: Date.now() - 5_000, timeoutMs: 30,
    log: (l) => lines.push(l), report: (_k, d) => { reports.push(d); }, sleep: async () => {},
  });
  assert.equal(r.hung, true);
  assert.ok(r.closeMs >= 25 && r.closeMs < 5_000, `closeMs ${r.closeMs} should be about the deadline`);
  assert.match(lines.join('\n'), /did not close in \d+s/, 'a hung close is LOUD');
  const reason = takePendingRecycle();
  assert.match(String(reason), /auto-login tab would not close/);
  assert.equal(takePendingRecycle(), null, 'CLEARS ON READ — one hung close, one recycle, not one per iteration for ever');
  assert.equal(reports[0].hung, true);
});

test('a close that rejects is treated as closed, not hung — the failure that matters is the one that never resolves', async () => {
  const tab = { close: async () => { throw new Error('Target closed'); } };
  const r = await closeTabBounded(tab, { label: 'warmup', startedAt: Date.now() });
  assert.equal(r.hung, false);
  assert.equal(takePendingRecycle(), null);
});

test('a failed report never delays or breaks the close', async () => {
  const tab = { close: async () => {} };
  const r = await closeTabBounded(tab, {
    label: 'renewal', startedAt: Date.now(),
    report: () => Promise.reject(new Error('camphawk.app unreachable')),
  });
  assert.equal(r.hung, false);
});

test('the deadline is longer than any single renewal step and shorter than a ramp', () => {
  // Steps inside renewSession are bounded at 20-45s; a ramp runs ten minutes. A close that
  // takes longer than a step is already the anomaly; one that waits out a ramp is no bound.
  assert.ok(TAB_CLOSE_MS >= 20_000 && TAB_CLOSE_MS <= 120_000, `TAB_CLOSE_MS ${TAB_CLOSE_MS}`);
});

// ── THE WIRING, which is the half that has been inert six times before ───────────────────

test('rc-keepwarm has NO bare tab.close() left — every throwaway tab goes through closeTabBounded', () => {
  assert.equal((code.match(/await tab\.close\(\)/g) ?? []).length, 0,
    'an unbounded `await tab.close()` is the hazard this module removes');
  const calls = code.match(/closeTabBounded\(tab, \{ label: '([a-z-]+)'/g) ?? [];
  const labels = calls.map((c) => /label: '([a-z-]+)'/.exec(c)![1]).sort();
  assert.deepEqual(labels, ['auto-login', 'renewal', 'warmup'], 'all three trips, each named');
});

test('every closeTabBounded call passes the trip start, the RAM delta and the reporter', () => {
  for (const m of code.matchAll(/closeTabBounded\(tab, \{([^}]*)\}/g)) {
    const args = m[1];
    assert.match(args, /startedAt: tripStartedAt/, `trip duration: ${args}`);
    assert.match(args, /ramMb: tripRam/, `RAM delta: ${args}`);
    assert.match(args, /report: reportBotEvent/, `reporter: ${args}`);
  }
  // And tripRam is actually ASSIGNED from the trace, not merely declared.
  assert.equal((code.match(/tripRam = ram;/g) ?? []).length, 3, 'assigned once per trip');
});

test('the resident loop reads the recycle request beside oktaTrip, after the runner preemption', () => {
  const loop = code.indexOf('const hungClose = takePendingRecycle();');
  assert.ok(loop > -1, 'the loop must READ the request — a flag nobody reads is the fix-present-and-inert shape');
  const preempt = code.indexOf('if (profileRequested(PROFILE_DIR)) {', code.indexOf('let oktaTrip = null;'));
  const okta = code.indexOf('if (oktaTrip) {');
  assert.ok(preempt > -1 && preempt < loop, 'AFTER the runner preemption — a cart never waits behind a tidy-up');
  assert.ok(okta > loop, 'beside the oktaTrip consumer, above it');
  const block = code.slice(loop, code.indexOf('if (oktaTrip) {', loop));
  assert.match(block, /break;/, 'a hung close BREAKS into the reopen path, which is the only thing that ends a ramp');
});

test('reportBotEvent posts an allow-listed event with a source, fire-and-forget', () => {
  const fn = code.slice(code.indexOf('function reportBotEvent('), code.indexOf('async function reportSession('));
  assert.match(fn, /event: \{ kind, detail, text \}/);
  assert.match(fn, /source: 'rc-keepwarm'/);
  assert.match(fn, /\.then\(\(\) => \{\}, /, 'a failed report is a log line, never a throw into the finally');
});
