/**
 * THE RAMP SCAN FIRES ONCE PER RAMP, AT THE ONSET, AND IS WIRED — see scripts/auto-cart-bot/ramp-scan.mjs.
 *
 * Eleven ramps in four days, each with ~35 GB of commit the memory series cannot attribute,
 * and the one instrument that could (the full `memory` scan) ran only when a human typed it.
 * These guards pin the trigger (the rc family past the threshold), the cooldown (one scan per
 * ramp, not one per two-minute tick for ten minutes), the failure posture (a scan that dies
 * stores nothing and throws nothing), the PowerShell's two invariants (no double quote, ASCII
 * only — the `\"`-is-not-a-cmd-escape and em-dash-in-a-.ps1 lessons), and the wiring into
 * bot.mjs's sampler, which is the half that would otherwise be inert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRampScan, RAMP_SCAN_MB, RAMP_SCAN_COOLDOWN_MS, RAMP_SCAN_PS } from '../scripts/auto-cart-bot/ramp-scan.mjs';

const BOT = readFileSync(new URL('../scripts/auto-cart-bot/bot.mjs', import.meta.url), 'utf8');
const botCode = BOT.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const fakeExec = (text: string) => (_f: string, _a: string[], _o: unknown, cb: (e: unknown, out: string, err: string) => void) => cb(null, text, '');

const harness = (opts: Partial<Parameters<typeof createRampScan>[0]> = {}) => {
  let t = 1_000_000;
  const posted: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const scan = createRampScan({
    post: async (e) => { posted.push(e as Record<string, unknown>); },
    log: (l) => lines.push(l),
    exec: fakeExec('TIME x\nOS commitUsedMB=46000 commitLimitMB=48000 ramFreeMB=6000 ramTotalMB=17000\nALLPROC count=200 privateSumMB=12000 workingSetSumMB=9000\nEND'),
    platform: 'win32',
    now: () => t,
    ...opts,
  });
  return { scan, posted, lines, advance: (ms: number) => { t += ms; } };
};

test('below the threshold nothing runs', async () => {
  const h = harness();
  assert.equal(await h.scan({ rcMb: 300 }), false);
  assert.equal(await h.scan({ rcMb: RAMP_SCAN_MB - 1 }), false);
  assert.equal(h.posted.length, 0);
});

test('at the threshold it scans once and posts a ramp-scan event with the trigger beside the text', async () => {
  const h = harness();
  assert.equal(await h.scan({ rcMb: RAMP_SCAN_MB, commitUsedMb: 46000, commitLimitMb: 48000, ramFreeMb: 6000, maxPid: 1260, maxType: 'renderer' }), true);
  assert.equal(h.posted.length, 1);
  const e = h.posted[0];
  assert.equal(e.kind, 'ramp-scan');
  const d = e.detail as Record<string, unknown>;
  assert.equal(d.rcMb, RAMP_SCAN_MB);
  assert.equal(d.commitUsedMb, 46000);
  assert.equal(d.maxType, 'renderer');
  assert.equal(d.complete, true, 'the END line proves the scan ran to the end');
  assert.match(String(e.text), /ALLPROC count=200 privateSumMB=12000/);
});

test('ONE SCAN PER RAMP — the cooldown outlasts a ramp, so ticks inside it do not re-scan', async () => {
  const h = harness();
  assert.equal(await h.scan({ rcMb: 3500 }), true);
  for (let i = 0; i < 6; i++) { h.advance(2 * 60_000); assert.equal(await h.scan({ rcMb: 5000 + i * 900 }), false); }
  assert.equal(h.posted.length, 1);
  // ...and the next ramp, hours later, is a new scan.
  h.advance(5 * 3600_000);
  assert.equal(await h.scan({ rcMb: 3400 }), true);
  assert.equal(h.posted.length, 2);
});

test('the cooldown sits between a ramp\'s length and the gap between ramps', () => {
  assert.ok(RAMP_SCAN_COOLDOWN_MS >= 12 * 60_000, 'a ramp lasts 10-12 min; shorter re-scans mid-ramp');
  assert.ok(RAMP_SCAN_COOLDOWN_MS <= 3 * 3600_000, 'ramps arrive every 5-6 h; longer misses the next one');
  assert.ok(RAMP_SCAN_MB >= 1500 && RAMP_SCAN_MB <= 6000, 'onset, not peak: baseline ~300 MB, ramps pass 3 GB inside one tick');
});

test('a scan that prints nothing stores nothing and throws nothing — and is not retried on the next tick', async () => {
  const h = harness({ exec: fakeExec('') });
  assert.equal(await h.scan({ rcMb: 4000 }), false);
  assert.equal(h.posted.length, 0);
  assert.match(h.lines.join('\n'), /printed nothing/);
  h.advance(2 * 60_000);
  assert.equal(await h.scan({ rcMb: 5000 }), false, 'stamped BEFORE the scan, so a struggling box is not hammered');
});

test('a post that throws is a log line, never an exception into the sampler', async () => {
  const h = harness({ post: async () => { throw new Error('camphawk.app unreachable'); } });
  assert.equal(await h.scan({ rcMb: 4000 }), false);
  assert.match(h.lines.join('\n'), /ramp scan failed/);
});

test('an incomplete scan says so in the detail', async () => {
  const h = harness({ exec: fakeExec('OS commitUsedMB=1 commitLimitMB=2 ramFreeMB=3 ramTotalMB=4\n[timeout]') });
  await h.scan({ rcMb: 4000 });
  assert.equal((h.posted[0].detail as Record<string, unknown>).complete, false);
});

test('not on win32, never', async () => {
  const h = harness({ platform: 'linux' });
  assert.equal(await h.scan({ rcMb: 9000 }), false);
});

// ── THE POWERSHELL'S INVARIANTS ──────────────────────────────────────────────────────────

test('the PowerShell carries no double quote and is pure ASCII', () => {
  assert.equal(RAMP_SCAN_PS.includes('"'), false, 'nothing has to survive Node -> execFile -> powershell.exe');
  assert.equal(/[^\x20-\x7e]/.test(RAMP_SCAN_PS), false, 'an em dash in a PowerShell string closed the string on 2026-08-11');
  assert.match(RAMP_SCAN_PS, /'END'/, 'the completion marker the detail reads');
});

test('every perf-counter read is wrapped, so a disabled class costs one line and not the scan', () => {
  assert.match(RAMP_SCAN_PS, /try \{ \$m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop;/);
  assert.match(RAMP_SCAN_PS, /catch \{ 'PERF unavailable: '/);
  assert.match(RAMP_SCAN_PS, /catch \{ 'PAGEFILE unavailable: '/);
});

test('the discriminator is present: private bytes over EVERY process, beside the commit figure', () => {
  assert.match(RAMP_SCAN_PS, /'OS commitUsedMB=\{0\}/);
  assert.match(RAMP_SCAN_PS, /'ALLPROC count=\{0\} privateSumMB=\{1\}/);
  assert.match(RAMP_SCAN_PS, /poolNonpagedMB=/, 'kernel pool is the "no process owns it" arm');
  assert.match(RAMP_SCAN_PS, /handles=\{8\}/, 'a renderer holding tens of thousands of handles is holding sections');
});

test('our Chromium is matched the way the sampler and stop-all match it, RC profile first', () => {
  assert.match(RAMP_SCAN_PS, /--user-data-dir=\\S\*\(\\\.rc-bot-profile\|auto-cart-bot\)/);
  const rc = RAMP_SCAN_PS.indexOf("if ($dir -match '\\.rc-bot-profile') { $fam = 'rc' }");
  const recgov = RAMP_SCAN_PS.indexOf("elseif ($dir -match 'auto-cart-bot')");
  assert.ok(rc > -1 && recgov > rc, 'the specific path is tested FIRST or every RC process files under rec.gov');
});

// ── THE WIRING ───────────────────────────────────────────────────────────────────────────

test('bot.mjs runs the ramp scan from the sampler\'s post, after the sample itself is posted', () => {
  assert.match(botCode, /import \{ createRampScan \} from '\.\/ramp-scan\.mjs';/);
  const post = botCode.slice(botCode.indexOf('const sampleMemory = createSampler({'), botCode.indexOf('const control = makeControlChannel('));
  const sample = post.indexOf('await reportControl({ memory, source });');
  const scan = post.indexOf('await rampScan(memory);');
  assert.ok(sample > -1 && scan > sample, 'the sample first, then the scan, both AWAITED under the sampler\'s in-flight guard');
  assert.match(botCode, /const rampScan = createRampScan\(\{\s*post: \(event\) => reportControl\(\{ event, source: 'bot' \}\)/,
    'the event rides the POST the bot already makes, with the source the row records');
});
