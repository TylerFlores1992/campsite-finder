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
import { createRampScan, RAMP_SCAN_MB, RAMP_SCAN_COOLDOWN_MS, RAMP_SCAN_COMMIT_MB, RAMP_SCAN_PS } from '../scripts/auto-cart-bot/ramp-scan.mjs';

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

test('THE BURST FIRES IT: commit past its threshold scans even though private bytes are far below rcMb', async () => {
  // The measured shape, verbatim from 2026-09-09 13:45:54 — commit 10,081 MB while `rc_mb`
  // is 410. Under the rcMb trigger alone this sample does nothing and the scan lands 110 s
  // later, after the mapping is complete. Not a round fixture: a threshold sized wrong is
  // only visible against the real numbers.
  const h = harness();
  assert.equal(await h.scan({ rcMb: 410, commitUsedMb: 10_081 }), true);
  assert.equal(h.posted.length, 1);
  const dd = h.posted[0].detail as Record<string, unknown>;
  assert.equal(dd.trigger, 'commitUsedMb', 'an in-burst scan and an after-the-fact scan must not arrive looking identical');
  assert.equal(dd.rcMb, 410);
});

test('THE COMMIT TRIGGER IS A SECOND ONE, NOT A REPLACEMENT — rcMb still fires with no commit figure at all', async () => {
  // Commit is a WHOLE-BOX number and the owner's desktop shares it. If `rcMb` ever stopped
  // firing on its own, a box that could not report commit would go unscanned for ever.
  const h = harness();
  assert.equal(await h.scan({ rcMb: RAMP_SCAN_MB }), true);
  assert.equal((h.posted[0].detail as Record<string, unknown>).trigger, 'rcMb');
});

test('BOTH in one sample is reported as both, because it is neither of the other two readings', async () => {
  const h = harness();
  assert.equal(await h.scan({ rcMb: 3500, commitUsedMb: 44_847 }), true);
  assert.equal((h.posted[0].detail as Record<string, unknown>).trigger, 'both');
});

test('AN ABSENT COMMIT FIGURE NEVER FIRES — a null is not a zero and not a reason to scan', async () => {
  // `parseSample` returns nulls rather than zeros for a reading it could not take. What this
  // pins is the BEHAVIOUR — an unreadable figure does not scan — and the mutation it catches
  // is a NaN-tolerant comparison (`!(commitMb < threshold)`), which fires on every tick of a
  // box that reports no commit at all. It deliberately does NOT claim to pin `isFinite`:
  // verified 2026-09-10 that removing it changes nothing, because NaN >= n and 0 >= n are
  // both already false. A guard is worth only the mutation it actually catches.
  const h = harness();
  assert.equal(await h.scan({ rcMb: 300, commitUsedMb: null }), false);
  assert.equal(await h.scan({ rcMb: 300, commitUsedMb: undefined }), false);
  assert.equal(await h.scan({ rcMb: 300, commitUsedMb: 'n/a' }), false);
  assert.equal(await h.scan({ rcMb: 300 }), false);
  assert.equal(h.posted.length, 0, 'an unreadable figure is an absence, never a trigger');
});

test('THE COMMIT THRESHOLD IS BOUNDED FROM BOTH SIDES BY THE MEASUREMENT THAT CHOSE IT', () => {
  // 6,266 samples over 7 days: median commit 7,213 MB, and only three samples between 9,000
  // and 12,000. Below ~8,000 this starts firing on the box's ordinary state; above ~20,000 it
  // gives back the head start it exists to buy, because the burst is already complete by then
  // (13:46:27 read 44,847). Bounding it from both sides is what stops it being "tuned" in
  // either direction by somebody who has not re-taken the measurement.
  assert.ok(RAMP_SCAN_COMMIT_MB >= 8_000, 'below the box\'s ordinary commit it fires on nothing happening');
  assert.ok(RAMP_SCAN_COMMIT_MB <= 20_000, 'above this the burst is over and the head start is gone');
});

test('THE READOUT SAYS WHICH TRIGGER FIRED — a commit scan must not render as an rcMb one', () => {
  // The line hardcoded `trigger rc ${x.rcMb} MB` until 2026-09-10, so a commit-triggered scan
  // would have printed `trigger rc null MB` — an absent reading wearing a finding's clothes,
  // on the one line that says how to read the whole scan.
  assert.match(READOUT, /x\.trigger === 'commitUsedMb'/, 'the readout must branch on the trigger');
  assert.match(READOUT, /DURING the burst/, 'and say that an in-burst scan is the one that can name a thread');
  assert.match(READOUT, /trigger not reported/, 'a pre-trigger row is an absence, not an rcMb scan');
  assert.doesNotMatch(READOUT, /trigger rc \$\{x\.rcMb\} MB \(threshold/, 'the unconditional rc label is what this replaces');
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

test('a throw inside one walk costs that reading and not the handle, the control or END', () => {
  // Without the try, a PowerShell exception mid-walk takes the SECOND process's walk and the
  // END marker with it — so a scan whose readings all succeeded would report `complete: false`.
  // The Node side catches either way; what this buys is that the failure is ONE named line.
  const t = RAMP_SCAN_PS.indexOf('try {', RAMP_SCAN_PS.indexOf('foreach ($tp in $targets)'));
  const caught = RAMP_SCAN_PS.indexOf('status=error');
  const close = RAMP_SCAN_PS.indexOf('CloseHandle($h)');
  assert.ok(t > -1 && caught > t, 'the walk body must be wrapped and the catch must name itself');
  assert.ok(close > caught, 'CloseHandle sits OUTSIDE the try, so a throw still releases the handle');
  // A nested type name relies on argument-mode parsing treating `+` as part of the word, and
  // this script cannot be run from here to find out. Quoted, it is unambiguous everywhere.
  assert.ok(RAMP_SCAN_PS.includes("New-Object 'ChMem+MBI'"), 'the nested type name stays quoted');
});

test('a caught throw does NOT then print a success line beneath its own error', () => {
  // The catch names the failure; the emissions below it would still run, so a walk that threw
  // printed `status=ok regions=` with empty totals right after `status=error`. The readout
  // counts `VMWALK ` lines, so that reads as a COMPLETED walk that found nothing — an absent
  // reading wearing an answer's clothes, which is the one thing this instrument must refuse.
  const arm = RAMP_SCAN_PS.indexOf('$ok = $true');
  const caught = RAMP_SCAN_PS.indexOf('} catch { $ok = $false;');
  const gate = RAMP_SCAN_PS.indexOf('if ($ok) {');
  const okLine = RAMP_SCAN_PS.indexOf('status=ok regions=');
  assert.ok(arm > -1, 'the no-throw flag is armed before the try');
  assert.ok(caught > arm, 'the catch clears it');
  assert.ok(gate > caught && gate < okLine, 'and the success emissions sit behind it');
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

/**
 * ── THE THREAD CENSUS AND THE ADDRESS SPAN (2026-09-09) ──────────────────────────────────
 *
 * Both answer questions no CDP instrument can reach. A wedged renderer contributes ZERO
 * allocator dumps at every dump level — measured in `dump-wedge-probe.mjs`, where Chromium's
 * coordinator gives up on it at ~15 s and emits an EMPTY process dump — and the alloc trail
 * reported `[resident]: EMPTY, that renderer answered no CDP call at all` for a whole browser
 * life. So there is no "ask it before it goes quiet" window either. The walk asks Windows,
 * which needs nothing from the process, and these two lines are what it asks.
 *
 * THESE ARE STRUCTURAL BECAUSE THE SUBJECT IS POWERSHELL AND THERE IS NONE IN THE DEV
 * CONTAINER. That is a real limit and it is why the balance assertions below exist: PowerShell
 * parses the WHOLE script before executing any of it, so a syntax error anywhere costs the
 * region walk too — the one instrument that still works. Balanced delimiters are the strongest
 * check available without an interpreter, and they are checked outside single-quoted strings
 * so an apostrophe in a message cannot be read as a delimiter.
 */
test('the joined PowerShell is parseable-shaped: balanced, ASCII, no double quotes', () => {
  let inStr = false; let brace = 0; let paren = 0; let bracket = 0; let firstNegative: string | null = null;
  for (let i = 0; i < RAMP_SCAN_PS.length; i++) {
    const c = RAMP_SCAN_PS[i];
    if (c === "'") { if (inStr && RAMP_SCAN_PS[i + 1] === "'") { i++; continue; } inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') brace++; else if (c === '}') { brace--; if (brace < 0 && !firstNegative) firstNegative = `brace at ${i}`; }
    else if (c === '(') paren++; else if (c === ')') { paren--; if (paren < 0 && !firstNegative) firstNegative = `paren at ${i}`; }
    else if (c === '[') bracket++; else if (c === ']') { bracket--; if (bracket < 0 && !firstNegative) firstNegative = `bracket at ${i}`; }
  }
  assert.equal(inStr, false, 'an unterminated single-quoted string swallows the rest of the script');
  assert.equal(firstNegative, null, `a closing delimiter with nothing open: ${firstNegative}`);
  assert.equal(brace, 0, 'unbalanced braces — PowerShell parses the whole script before running any of it');
  assert.equal(paren, 0, 'unbalanced parentheses');
  assert.equal(bracket, 0, 'unbalanced brackets');
});

test('VMTHREAD samples TWICE and reports the window, or a delta means nothing', () => {
  assert.match(RAMP_SCAN_PS, /Start-Sleep -Milliseconds 1200/, 'two snapshots with a gap ARE the measurement');
  assert.match(RAMP_SCAN_PS, /windowMs=1200/, 'a delta without its window cannot be read as a share of a core');
  assert.match(RAMP_SCAN_PS, /'VMTHREAD pid='/, 'the per-process line');
  assert.match(RAMP_SCAN_PS, /'VMTHREADTOP pid='/, 'the per-thread lines');
  // The main thread is the discriminator: a spin on it is Blink/JS/the command-buffer client
  // and is also why the renderer answers no CDP call. Without StartTime there is nothing to
  // identify it by, since this deliberately uses no P/Invoke to read thread NAMES.
  assert.match(RAMP_SCAN_PS, /\$th\.StartTime -lt \$mainAt/, 'the earliest thread is the process main thread');
  assert.match(RAMP_SCAN_PS, /main=' \+ \(\$rw\.Tid -eq \$mainId\)/, 'each top thread says whether it is the main one');
});

test('VMTHREAD cannot take the whole scan down with it', () => {
  // The region walk is the one instrument that still works and it is emitted BEFORE this. A
  // runtime throw here must cost the census and nothing else.
  const i = RAMP_SCAN_PS.indexOf("'VMTHREAD pid='");
  const guard = RAMP_SCAN_PS.lastIndexOf("} catch { 'VMTHREAD unavailable: '", RAMP_SCAN_PS.length);
  assert.ok(i > -1, 'the census is present');
  assert.ok(guard > i, 'the census is wrapped in its own catch, which reports rather than going silent');
  assert.ok(RAMP_SCAN_PS.indexOf("'VMWALK pid='") < i, 'the walk is emitted before the census, so a census fault cannot cost it');
});

test('VMSPAN reports the span AND what the regions themselves occupy', () => {
  // A span alone is not a reading: it only means something against the packed size, which is
  // what separates one reservation from 16k independent mappings.
  assert.match(RAMP_SCAN_PS, /'VMSPAN pid='/);
  assert.match(RAMP_SCAN_PS, /spanMB=/, 'how far apart the population is spread');
  assert.match(RAMP_SCAN_PS, /packedMB=/, 'what it would occupy if it were contiguous — the comparison term');
  assert.match(RAMP_SCAN_PS, /if \(\$n2m -gt 0\)/, 'a span over zero regions is not a span');
});
