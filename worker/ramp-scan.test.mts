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
 *
 * SINCE 2026-09-05 it also pins the COMMITTED-REGION WALK, and those guards are about one
 * property above all: it must REFUSE rather than answer small. A 32-bit host, a failed
 * Add-Type and a refused OpenProcess each have to print themselves, because an empty region
 * list reads as `there is no 32 GB mapping` — the absent-reading-as-a-negative shape that has
 * cost this repo more than any other. The walk goes last, walks a CONTROL beside the target,
 * and never reads a byte of the process's memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRampScan, RAMP_SCAN_MB, RAMP_SCAN_COOLDOWN_MS, RAMP_SCAN_PS } from '../scripts/auto-cart-bot/ramp-scan.mjs';

const BOT = readFileSync(new URL('../scripts/auto-cart-bot/bot.mjs', import.meta.url), 'utf8');
const SCAN = readFileSync(new URL('../scripts/auto-cart-bot/ramp-scan.mjs', import.meta.url), 'utf8');
const READOUT = readFileSync(new URL('../scripts/bot-events-readout.mts', import.meta.url), 'utf8');
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

// ── THE COMMITTED-REGION WALK ─────────────────────────────────────────────────────────────

test('the walk goes LAST, after every reading that already works', () => {
  // `execFile` hands back the stdout it buffered even when it kills the child on timeout, so
  // ordering is what makes a hung walk cost the walk and not the scan. Moved above ALLPROC —
  // the discriminator — and a hang would take the one line this whole instrument was built on.
  const walk = RAMP_SCAN_PS.indexOf('VirtualQueryEx');
  assert.ok(walk > -1, 'the region walk must be in the PowerShell at all');
  for (const earlier of ['OS commitUsedMB=', 'PERF committedMB=', 'ALLPROC count=', 'CHROME pid=', 'TOP {0}']) {
    assert.ok(RAMP_SCAN_PS.indexOf(earlier) > -1 && RAMP_SCAN_PS.indexOf(earlier) < walk,
      `${earlier} must be printed BEFORE the walk, or a hung walk costs it`);
  }
  assert.ok(RAMP_SCAN_PS.lastIndexOf("'END';") > walk, 'END still closes the script');
});

test('every way the walk can fail PRINTS ITSELF — it never answers with an empty region list', () => {
  // Three refusals, three different fixes: a 32-bit host can only see a 32-bit slice of a
  // 64-bit address space; Add-Type compiles through csc.exe and can fail on a box under
  // pressure; OpenProcess can be refused, which is the elevation blindness that has corrupted
  // three readings in CLAUDE.md. Each must be distinguishable from `walked, found nothing`.
  // NOT a proximity window from `Is64BitProcess`. Measured: at 120 characters it matched the
  // ADD-TYPE refusal on the next line, so a mutation deleting this one passed. The literal is
  // unique and carries both halves — the flag AND the sentence — in one anchor.
  assert.ok(RAMP_SCAN_PS.includes("$vmOk = $false; 'VMWALK unavailable: 32-bit PowerShell"),
    'a 32-bit host must stand the walk down AND say so, not report a small address space');
  assert.match(RAMP_SCAN_PS, /catch \{ \$vmOk = \$false; 'VMWALK unavailable: Add-Type '/,
    'a failed Add-Type must say so and stand the walk down');
  assert.match(RAMP_SCAN_PS, /status=open-failed err=/,
    'a refused OpenProcess must carry its error code');
  assert.match(RAMP_SCAN_PS, /foreach \(\$tp in \$targets\) \{ if \(-not \$vmOk\) \{ break \}/,
    'the walk must be gated on the flag those refusals set, or it runs against a missing type');
});

test('a CONTROL process is walked beside the target, because the finding is a DIFFERENCE', () => {
  // 32,780 MB is an EXCESS over a healthy renderer. With one term, `the ramping one holds a
  // 32 GB mapping` cannot be told from `every renderer does`.
  assert.match(RAMP_SCAN_PS, /Sort-Object -Property Priv -Descending/,
    'the target is the largest by private bytes — which at the trigger IS the ramping renderer');
  assert.match(RAMP_SCAN_PS, /\$ctl = @\(\$cand \| Where-Object \{ \$_\.Ty -eq 'renderer' \} \| Select-Object -Last 1\)/,
    'the control is an ordinary renderer');
  assert.match(RAMP_SCAN_PS, /\$ctl\[0\]\.Pid -ne \$targets\[0\]\.Pid/,
    'and it must not be the target again, which would report the same walk twice as a comparison');
});

test('the walk QUERIES the address space and never reads its contents', () => {
  // Same rule as the multi-GB heap snapshot and `response.body()`: an instrument that copies
  // the memory it is measuring into this process is the cure arriving as part of the disease.
  // And a renderer's pages are RC session material — a field we would then have to filter.
  for (const forbidden of ['ReadProcessMemory', 'MiniDump', 'WriteProcessMemory']) {
    assert.doesNotMatch(RAMP_SCAN_PS, new RegExp(forbidden),
      `${forbidden} copies the process's memory — the walk asks for region metadata only`);
  }
});

test('a truncated walk says so, and the histogram is COMMIT only', () => {
  // `capped` prints on the healthy path too, or a floor and a total read identically.
  assert.match(RAMP_SCAN_PS, /status=ok regions=' \+ \$regions \+ ' iters=' \+ \$it \+ ' capped=' \+ \$capped/,
    'the region count, the iteration count and the cap flag ride the healthy line');
  assert.match(RAMP_SCAN_PS, /if \(\$it -ge \$cap\) \{ \$capped = \$true; break \}/,
    'and the cap must actually set that flag rather than breaking silently');
  // The OS commit charge is the quantity that stepped 35 GB. Reserved address space is not it,
  // so bucketing reserve into the histogram would dilute the one number being read.
  assert.match(RAMP_SCAN_PS, /if \(\$mbi\.State -eq 4096\) \{\s*\$b = 'h gt1G'/,
    'the size histogram is gated on MEM_COMMIT (0x1000)');
  // Anchored on the emitted concatenation, not on a run of non-quote characters: the line is
  // built as 'VMHIST pid=' + $tp.Pid + ' commit ' + $k, so a [^']* window stops at the first
  // closing quote and can never reach the label.
  assert.ok(RAMP_SCAN_PS.includes("' commit ' + $k"), 'and the line it prints says commit');
});

test('`vmwalk` is reported separately from `complete`', () => {
  // The walk can refuse while everything above it succeeds. A scan missing only the walk and a
  // scan that was cut off are different facts and one boolean cannot carry both.
  assert.match(SCAN, /complete: text\.includes\('END'\)/);
  assert.match(SCAN, /vmwalk: text\.includes\('VMWALK '\)/);
});

test('the scan timeout leaves room for the Add-Type compile and two walks', () => {
  const to = Number(/timeout: ([\d_]+),/.exec(SCAN)?.[1]?.replace(/_/g, ''));
  // `envDefault` has misread a threshold twice in this repo by stopping at an underscore.
  assert.ok(Number.isFinite(to), 'the timeout must be readable');
  assert.ok(to >= 60_000, `45s no longer covers a csc.exe compile plus two address-space walks (got ${to})`);
  // And it must stay under the sampler's own two-minute cadence, or a slow scan costs more
  // than the one tick its in-flight guard is meant to absorb.
  assert.ok(to <= 110_000, `a scan may not outlast the sampler's interval (got ${to})`);
});

test('the readout REFUSES a bucket verdict that does not dominate', () => {
  // Caught by rendering the control and reading it: without the share gate, an ordinary
  // renderer with 18% in one bucket was told it held `a SWARM of per-object shared-memory
  // sections`. A verdict that fires on every input fires on the CONTROL, whose whole job is
  // to be normal — the cry-wolf failure, aimed at the one process that must never trip it.
  const at = READOUT.indexOf('% of the committed bytes sit in the');
  assert.ok(at > -1, 'the bucket verdict must still exist');
  const block = READOUT.slice(at - 400, at + 700);
  assert.match(block, /share < 60/, 'the verdict is gated on the leading bucket actually dominating');
  assert.match(block, /no bucket dominates/, 'and below the gate it must say so rather than staying silent');
});

test('the readout states the target-minus-control DIFFERENCE on one line', () => {
  // Printing two blocks and leaving the reader to subtract is how the control stops doing its
  // job — and the whole reason a second process is walked is to have both terms together.
  assert.match(READOUT, /EXCESS \$\{t\.mb - c\.mb\} MB/,
    'the excess must be computed and printed, not left to the reader');
  assert.match(READOUT, /NO CONTROL in this scan/,
    'and a scan with only one walk must say the figures are not yet a difference');
});

test('the readout tells a scan that predates the walk from one whose walk refused', () => {
  // An older box sends no `vmwalk` key at all; a current box that could not walk sends false.
  // Collapsing them would report a missing feature as a failed measurement, and vice versa.
  assert.match(READOUT, /x\.vmwalk === undefined/);
  assert.match(READOUT, /predates it/);
  assert.match(READOUT, /did NOT run/);
});
