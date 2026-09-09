/**
 * GUARDS FOR THE ONE-SHOT LEAK CAPTURE.
 *
 * The leak has cost one instrument per ramp, and a ramp arrives every 5-28 hours — so every
 * round trip is a day. This capture exists to end that: the region walk and the memory dump
 * ride the same 3 GB trigger, and between them they now answer BOTH branches of the remaining
 * question in one event. These tests pin the parts that decide what a reading MEANS, because
 * the branch that matters most (`VOID`) can otherwise only be reached by a real ramp — which
 * is exactly how the 2026-09-07 dump came to measure a five-second-old browser and be read as
 * an elimination.
 *
 * UNDER `src/`, NOT `worker/`, CHECKED AGAINST `worker-deploy.yml` RATHER THAN REMEMBERED:
 * `worker/**` is the FIRST entry in that workflow's `paths:`, so a guard placed there would
 * restart all three pollers over a diagnostic. Neither `scripts/**` nor `src/lib/bot-events.ts`
 * appears in the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dumpJoinReading, mappedSwarmReading, mappedNameReading, NAME_CENSUS_ACCESS,
  busyThreadReading, mappedSpanReading, BUSY_THREAD_SHARE, servicePairReading,
  spinSiteReading, SPIN_SITE_DOMINANCE,
} from './bot-events';

const scan = readFileSync('scripts/auto-cart-bot/ramp-scan.mjs', 'utf8');
const readout = readFileSync('scripts/bot-events-readout.mts', 'utf8');
/** Comments are stripped so a guard cannot pass on the prose that explains it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/* ── THE JOIN ─────────────────────────────────────────────────────────────────────────────── */

test('a dump that does not contain the ramping renderer is VOID, not a small reading', () => {
  const r = dumpJoinReading({ walkTargetPid: '9912', dumpPids: ['7316', '2960', '6376'] });
  assert.equal(r.kind, 'void');
  assert.match(r.text, /VOID/);
  assert.match(r.text, /9912/);
  // The pids it DID answer for, or a reader cannot tell a wrong-browser dump from an empty one.
  assert.match(r.text, /7316/);
});

test('a dump containing the ramping renderer joins', () => {
  const r = dumpJoinReading({ walkTargetPid: '9912', dumpPids: ['7316', '9912'] });
  assert.equal(r.kind, 'joined');
  assert.match(r.text, /9912/);
});

test('NO WALK is an absence, never a failed join', () => {
  const a = dumpJoinReading({ walkTargetPid: null, dumpPids: ['7316'], walkNearby: false });
  assert.equal(a.kind, 'no-walk');
  assert.doesNotMatch(a.text, /VOID/);
  // A walk that ran and did not complete is a different sentence from no walk at all.
  const b = dumpJoinReading({ walkTargetPid: null, dumpPids: ['7316'], walkNearby: true });
  assert.equal(b.kind, 'no-walk');
  assert.notEqual(a.text, b.text);
});

test('an EMPTY dump is void rather than joined', () => {
  // The dangerous direction: an empty pid list must not satisfy the join by vacuity.
  const r = dumpJoinReading({ walkTargetPid: '9912', dumpPids: [] });
  assert.equal(r.kind, 'void');
  assert.match(r.text, /no process at all/);
});

test('a void join with NO generation list asserts neither mechanism', () => {
  // Until 2026-09-08 this text asserted the 09-07 "a bail killed the generation" mechanism
  // unconditionally, and on the first ramp the stall trigger ever caught that was false.
  const r = dumpJoinReading({ walkTargetPid: '9912', dumpPids: ['7316', '2960'] });
  assert.equal(r.kind, 'void');
  assert.equal(r.cause, 'unknown');
  assert.doesNotMatch(r.text, /2026-09-07 shape/, 'a mechanism must not be named without evidence for it');
});

test('NO overlap with the walk generation is the 09-07 shape, and says so', () => {
  const r = dumpJoinReading({
    walkTargetPid: '9912',
    dumpPids: ['7316', '2960', '6376'],
    walkGenerationPids: ['9912', '3836', '4444'],
  });
  assert.equal(r.kind, 'void');
  assert.equal(r.cause, 'generation');
  assert.match(r.text, /2026-09-07/);
  assert.match(r.text, /timing/, 'the generation case must point at the timing, which is its fix');
});

test('OVERLAP with the walk generation means the TARGET went silent — a different fix', () => {
  // 2026-09-08 21:43, the real numbers: the dump answered for seven pids, every one of them in
  // the scan's own CHROME list, and waited out its full 20,000 ms for the eighth.
  const r = dumpJoinReading({
    walkTargetPid: '7644',
    dumpPids: ['9472', '1864', '6864', '14316', '4568', '5896', '13364'],
    walkGenerationPids: ['9472', '1664', '6864', '14316', '13364', '4568', '7644', '1864', '5896'],
  });
  assert.equal(r.kind, 'void');
  assert.equal(r.cause, 'target-silent');
  assert.match(r.text, /RIGHT browser/);
  // The whole point: this event must NOT be reported as the 09-07 mechanism, and must not
  // send the reader back to the trigger, which had just worked for the first time.
  assert.doesNotMatch(r.text, /2026-09-07/);
  assert.match(r.text, /Do NOT go looking at the trigger/);
});

test('every void cause still reports kind "void", so none can un-suppress the verdict', () => {
  // The caller branches on `kind === 'void'`. A cause it has never heard of must still
  // suppress — a new variant must not be able to put the quoted sentence back on the page.
  const cases = [
    dumpJoinReading({ walkTargetPid: '1', dumpPids: ['2'] }),
    dumpJoinReading({ walkTargetPid: '1', dumpPids: ['2'], walkGenerationPids: ['1', '3'] }),
    dumpJoinReading({ walkTargetPid: '1', dumpPids: ['3'], walkGenerationPids: ['1', '3'] }),
    dumpJoinReading({ walkTargetPid: '1', dumpPids: [], walkGenerationPids: ['1', '3'] }),
  ];
  for (const c of cases) assert.equal(c.kind, 'void', `cause ${c.cause} must still be void`);
  // And they must not all say the same thing, or the split buys nothing.
  assert.equal(new Set(cases.map((c) => c.cause)).size, 3);
});

test('the readout PASSES the walk generation, or the split is inert', () => {
  // The pure function can be perfect and unreachable: without this argument every void falls
  // to `unknown` and the two mechanisms stay indistinguishable in the only place they are read.
  const c = code(readout);
  assert.match(c, /walkGenerationPids:/, 'the readout must pass the browser generation');
  assert.match(c, /CHROME pid=/, 'it must read the pids out of the scan itself');
});

test('the readout SUPPRESSES the shared-memory verdict on a void join', () => {
  const c = code(readout);
  const void_ = c.indexOf("join.kind === 'void'");
  // THE USE, NOT THE DECLARATION. `const SHM_ANSWER_MB = 4_000` sits at the top of the file,
  // so a bare indexOf on the name matched it and the ordering assertion was true whatever the
  // branches did — the anchored-on-the-wrong-thing shape, caught by running it.
  const verdict = c.indexOf('>= SHM_ANSWER_MB');
  assert.ok(void_ > -1, 'the readout must branch on a void join');
  assert.ok(verdict > -1, 'the eliminate/confirm verdict must still be there');
  assert.ok(void_ < verdict, 'the void branch must come BEFORE the eliminate/confirm verdict');
});

test('the readout does the join itself rather than telling a human to', () => {
  const c = code(readout);
  assert.ok(c.includes('dumpJoinReading('), 'the readout must call the shared decision');
  // The instruction it replaces. Leaving it would put a to-do next to an answer.
  assert.doesNotMatch(c, /is the ramping renderer.s pid in the MDPROC list/);
});

/* ── THE 2-4M CENSUS ──────────────────────────────────────────────────────────────────────── */

test('one allocation base per region is N separate sections', () => {
  const r = mappedSwarmReading({ regions: 16387, allocBases: 16387 });
  assert.equal(r.kind, 'per-region');
  assert.match(r.text, /own mapping/i);
});

test('a handful of allocation bases is a carved-up mapping, a different bug', () => {
  const r = mappedSwarmReading({ regions: 16387, allocBases: 3 });
  assert.equal(r.kind, 'carved');
  assert.match(r.text, /carved/i);
});

test('an absent census reads as an absence, never as "no swarm"', () => {
  const r = mappedSwarmReading({ present: false });
  assert.equal(r.kind, 'absent');
  assert.match(r.text, /predates/);
});

test('no region in the band is its own reading', () => {
  const r = mappedSwarmReading({ regions: 0, allocBases: 0 });
  assert.equal(r.kind, 'none');
});

/* ── THE NAME CENSUS ──────────────────────────────────────────────────────────────────────── */

test('a census that could not run is a REFUSAL, not "nothing is file-backed"', () => {
  const r = mappedNameReading({ access: 1024, sampled: 0, named: 0 });
  assert.equal(r.kind, 'no-access');
  assert.match(r.text, /refusal/i);
  // The absent-reading-as-a-negative shape, which is what this whole distinction exists for.
  assert.doesNotMatch(r.text, /ALL ANONYMOUS/);
});

test('all-anonymous hands the question to the dump; a file NAMES the creator', () => {
  const anon = mappedNameReading({ access: NAME_CENSUS_ACCESS, sampled: 64, named: 0 });
  assert.equal(anon.kind, 'anonymous');
  assert.match(anon.text, /64 sampled/);
  const named = mappedNameReading({ access: NAME_CENSUS_ACCESS, sampled: 64, named: 61 });
  assert.equal(named.kind, 'file-backed');
  assert.match(named.text, /61 of 64/);
});

test('the access floor is the right one for GetMappedFileName', () => {
  // 0x400 QUERY_INFORMATION | 0x010 VM_READ. Below it the call cannot succeed, so a census
  // reporting zero names would be measuring its own permissions.
  assert.equal(NAME_CENSUS_ACCESS, 0x400 | 0x010);
  assert.equal(mappedNameReading({ access: NAME_CENSUS_ACCESS - 1, sampled: 9, named: 0 }).kind, 'no-access');
  assert.notEqual(mappedNameReading({ access: NAME_CENSUS_ACCESS, sampled: 9, named: 0 }).kind, 'no-access');
});

test('the readout RENDERS both census verdicts, not just computes them', () => {
  // A pure function can be perfect while nothing prints it — the fix-present-and-inert shape,
  // which this repo has paid for six times. Found by mutation: deleting the name-census render
  // left every other guard in this file green.
  const c = code(readout);
  for (const fn of ['mappedSwarmReading(', 'mappedNameReading(']) {
    assert.ok(c.includes(fn), `the readout must call ${fn}`);
  }
  assert.match(c, /printVerdict\([^\n]*swarm\.text\)/, 'the swarm verdict must be printed');
  assert.match(c, /printVerdict\([^\n]*names\.text\)/, 'the name-census verdict must be printed');
});

/* ── THE WALK ITSELF ──────────────────────────────────────────────────────────────────────── */

test('the walk asks for VM_READ first and records which access it got', () => {
  const c = code(scan);
  assert.ok(c.includes('OpenProcess(1040'), 'must try PROCESS_QUERY_INFORMATION | PROCESS_VM_READ first');
  assert.ok(c.includes('OpenProcess(1024'), 'must fall back rather than losing the walk');
  // Without the access in the output, a name census that could not run and one that found
  // every region anonymous render identically.
  assert.match(c, /VMMAP2M[^\n]*access=/);
});

test('the 2-4M band is the histogram bucket EXACTLY, so the two lines are one population', () => {
  const c = code(scan);
  // 2 MiB and 4 MiB. A band that merely looked similar would make VMMAP2M and VMHIST d
  // disagree by design, and a reader diffing them would chase the difference.
  assert.match(c, /\$rs -ge 2097152 -and \$rs -le 4194304/);
  assert.match(c, /\$rs -le 4194304\) \{ \$b = 'd 2-4M' \}/);
});

test('the name census is BOUNDED — it must not call once per region', () => {
  const c = code(scan);
  assert.match(c, /\$nSamp -lt 64/, 'the sample must be capped');
  // 15-16k regions: one call each turns a diagnostic into a cost on a box already at 40% commit.
  assert.ok(!/K32GetMappedFileNameW\(\$h, \$mbi\.BaseAddress, \$sb, 300\);[\s\S]{0,200}\$nSamp\+\+/.test(c)
    || c.indexOf('$nSamp -lt 64') < c.indexOf('K32GetMappedFileNameW($h'),
    'the cap must be checked before the call');
});

test('the walk still refuses rather than answering small', () => {
  const c = code(scan);
  // Pre-existing and load-bearing: an empty region list reads as "there is no 32 GB mapping".
  assert.match(c, /VMWALK unavailable: 32-bit PowerShell/);
  assert.match(c, /status=open-failed/);
  assert.match(c, /\$ok = \$false/);
});

test('the walk emits ASCII only', () => {
  // Windows PowerShell 5.1 reads a BOM-less script as Windows-1252, and byte 0x94 is a curly
  // quote it accepts as a string delimiter — which took all four supervised processes down
  // on 2026-08-11. The comments here are JS; the emitted script is what must be clean.
  const ps = /export const RAMP_SCAN_PS = \[([\s\S]*?)\n\]\.join/.exec(scan)?.[1] ?? '';
  assert.ok(ps.length > 0, 'the PS block must be findable');
  const emitted = ps.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bad = [...emitted].filter((ch) => ch.charCodeAt(0) > 126);
  assert.deepEqual(bad, [], `non-ASCII in the emitted PowerShell: ${bad.join(' ')}`);
});

/**
 * ── SPINNING OR BLOCKED, AND WHERE THE SECTIONS SIT (2026-09-09) ─────────────────────────
 *
 * Both readings exist because every CDP instrument is structurally unable to answer. A wedged
 * renderer contributes ZERO allocator dumps at every dump level — Chromium's coordinator gives
 * up on it at ~15 s and emits an EMPTY process dump, measured in `dump-wedge-probe.mjs` — so
 * neither a longer timeout nor a cheaper level can help, and the alloc trail's
 * `[resident]: EMPTY` says the renderer is quiet for its whole life, which closes the "ask it
 * earlier" idea too. The region walk asks Windows and needs nothing from the process.
 */
test('a thread holding the window is SPINNING, and the main thread is the discriminator', () => {
  const main = busyThreadReading({ threads: 19, windowMs: 1200, busyMs: 1180, topDeltaMs: 1180, topIsMain: true });
  assert.equal(main.kind, 'spinning-main');
  assert.match(main.text, /MAIN thread/);
  const worker = busyThreadReading({ threads: 19, windowMs: 1200, busyMs: 1180, topDeltaMs: 1180, topIsMain: false });
  assert.equal(worker.kind, 'spinning-worker');
  assert.match(worker.text, /WORKER thread/);
  // The two need opposite fixes, so they must never render the same sentence.
  assert.notEqual(main.text, worker.text);
});

test('nobody burning CPU is BLOCKED — a different finding, not a quiet spin', () => {
  const r = busyThreadReading({ threads: 19, windowMs: 1200, busyMs: 30, topDeltaMs: 20, topIsMain: true, topWait: 'LpcReceive' });
  assert.equal(r.kind, 'blocked');
  assert.match(r.text, /BLOCKED/);
  assert.match(r.text, /LpcReceive/, 'what it is waiting on is the whole value of this branch');
  assert.equal(/SPINNING/.test(r.text), false);
});

test('no census is an ABSENCE, never "it was not spinning"', () => {
  for (const args of [{}, { threads: 19 }, { windowMs: 1200 }, { threads: 19, windowMs: 0, topDeltaMs: 5 }]) {
    const r = busyThreadReading(args);
    assert.equal(r.kind, 'unavailable', JSON.stringify(args));
    assert.match(r.text, /absence, not a reading/);
  }
});

test('the busy threshold is bounded on both sides', () => {
  // Too low and ordinary background work reads as a spin; at 1.0 only a perfect core counts
  // and a thread interrupted by the sampler itself would read as blocked.
  assert.ok(BUSY_THREAD_SHARE >= 0.1, 'below this, idle noise reads as spinning');
  assert.ok(BUSY_THREAD_SHARE <= 0.5, 'above this, a genuinely busy thread reads as blocked');
});

test('a span about the size of the regions is ONE reservation; orders larger is scattered', () => {
  const packed = mappedSpanReading({ regions: 16385, packedMb: 32770, spanMb: 33000 });
  assert.equal(packed.kind, 'packed');
  assert.match(packed.text, /VMTOP/, 'the reader is sent to the reservation that contains it');
  const scattered = mappedSpanReading({ regions: 16385, packedMb: 32770, spanMb: 90_000_000 });
  assert.equal(scattered.kind, 'scattered');
  assert.notEqual(packed.text, scattered.text);
  assert.equal(mappedSpanReading({ regions: 4 }).kind, 'unavailable');
  assert.match(mappedSpanReading({}).text, /absence, not a reading/);
});

test('a wedged renderer that is PRESENT AND EMPTY still voids the shared-memory verdict', () => {
  // Recording the empty process (so "asked and contributed nothing" stops reading as "never
  // appeared") would otherwise flip every future ramp dump from VOID to `joined` — i.e. turn
  // a reading that eliminates nothing into one that reads as success.
  const r = dumpJoinReading({
    walkTargetPid: '7644',
    dumpPids: ['9472', '6864', '7644'],
    dumpEmptyPids: ['7644'],
    walkGenerationPids: ['9472', '6864', '7644'],
    walkNearby: true,
  });
  assert.equal(r.kind, 'void', 'the caller suppresses on void, and this must keep suppressing');
  assert.equal(r.cause, 'target-empty');
  assert.match(r.text, /ZERO allocator dumps/);
  assert.match(r.text, /eliminates nothing/);
  assert.match(r.text, /Do NOT go looking at the trigger or the budget/);
  // A renderer that really did contribute must still read as joined.
  assert.equal(dumpJoinReading({
    walkTargetPid: '7644', dumpPids: ['9472', '7644'], dumpEmptyPids: [], walkGenerationPids: ['9472', '7644'], walkNearby: true,
  }).kind, 'joined');
});

test('the readout passes the empty pids, or the pure function cannot see them', () => {
  // The fix-present-and-inert shape: busyThreadReading, mappedSpanReading and the empty-pid
  // branch can all be perfect and unreachable if the caller never supplies them.
  assert.match(readout, /dumpEmptyPids:/, 'the join needs them or a wedged renderer reads as having answered');
  // REACHABLE, not merely present. `void 0 && printVerdict(..., busyThreadReading({...}))`
  // matches a bare name check just as happily as a live call — the `if (false)` shape this
  // file has now paid for twice — so the call is pinned as the statement it has to be.
  // RE-ANCHORED 2026-09-09, NOT RELAXED. The verdict is assigned now so its KIND can be
  // paired with the GPU process's; the property is unchanged and both halves are pinned as
  // line-initial statements, so `void 0 && ...` and `if (false) ...` still fail it.
  assert.match(code(readout), /\n\s*const busy = busyThreadReading\(\{/,
    'the thread verdict must be computed');
  assert.match(code(readout), /\n\s*printVerdict\('      ', busy\.text\)/,
    'the thread verdict must be rendered, not merely constructed');
  assert.match(code(readout), /\n\s*printVerdict\('      ', mappedSpanReading\(\{/,
    'the span verdict must be rendered, not merely constructed');
  assert.match(readout, /VMTHREADTOP/, 'the per-thread lines are rendered, not just the verdict');
});

/* ── THE SERVICE BESIDE THE CLIENT (2026-09-09) ──────────────────────────────────────────────
 *
 * The thread census takes a third subject: the GPU process of the target's own browser
 * generation. `MappedMemoryManager` predicts a service nobody is pumping, because the command
 * buffer's tokens cannot advance while the renderer's main thread never returns to its message
 * loop — so an IDLE GPU process is what the candidate predicts and a BUSY one is a different
 * investigation. Both words are findings, which is what makes the reading worth taking.
 *
 * The magnitudes are already guarded above; these pin the DECISIONS, and above all the two
 * that would each turn a non-answer into a confident one: an absence rendering as an idle
 * service, and a target paired with a second copy of itself.
 */

test('an absent GPU census is an ABSENCE, never an idle service', () => {
  const r = servicePairReading({ renderer: 'spinning-main', gpu: undefined });
  assert.equal(r.kind, 'absent');
  assert.match(r.text, /ABSENCE/);
  // The whole hazard: 'we could not look' and 'the service was idle' point in opposite
  // directions, and this verdict is one sentence away from being read as a confirmation.
  assert.doesNotMatch(r.text, /client-allocates|MappedMemoryManager|predicts/);
  // A census that RAN and could not be read is the same non-answer.
  assert.equal(servicePairReading({ renderer: 'spinning-main', gpu: 'unavailable' }).kind, 'absent');
});

test('a scan that looked and found no GPU process says so in its own words', () => {
  const note = 'gpu-process not found in the target browser generation (target pid=10604 ppid=8100)';
  const r = servicePairReading({ renderer: 'spinning-main', gpu: undefined, gpuNote: note });
  assert.match(r.text, /not found in the target browser generation/,
    'the scan\'s own sentence, or a deliberate miss reads like a box that predates the census');
  assert.match(r.text, /10604/, 'which target it looked from');
});

test('spinning renderer beside an idle GPU is the shape — and says it is not proof', () => {
  const r = servicePairReading({ renderer: 'spinning-main', gpu: 'blocked' });
  assert.equal(r.kind, 'service-idle');
  assert.match(r.text, /client-allocates-service-never-drains/);
  assert.match(r.text, /CONSISTENT WITH, NOT PROOF/,
    'three mechanisms have been guessed on this leak and each cost a session');
  // The failure mode of the same hypothesis predicts an idle GPU too, so the verdict has to
  // carry that or it reads as a confirmation it has not earned.
  assert.match(r.text, /nothing was ever sent to it/);
  assert.doesNotMatch(r.text, /CONFIRM(ED|S)\b/i);
});

test('a busy GPU process is the branch that argues AGAINST the candidate, not a failure', () => {
  const r = servicePairReading({ renderer: 'spinning-main', gpu: 'spinning-worker' });
  assert.equal(r.kind, 'service-busy');
  assert.match(r.text, /NOT the client-allocates-service-never-drains shape/);
  assert.match(r.text, /new investigation/);
});

test('the pairing refuses when either half is missing its own reading', () => {
  assert.equal(servicePairReading({ renderer: 'blocked', gpu: 'blocked' }).kind, 'renderer-not-spinning');
  assert.match(servicePairReading({ renderer: 'blocked', gpu: 'blocked' }).text, /does not arise/);
  // One process is a number; the reading is the comparison. Same argument that put a control
  // renderer in the walk at all.
  assert.equal(servicePairReading({ renderer: undefined, gpu: 'blocked' }).kind, 'no-renderer-reading');
});

test('the census takes the GPU process and the WALK deliberately does not', () => {
  const c = code(scan);
  // A third address-space walk costs csc.exe plus a full VirtualQueryEx sweep inside the 90 s
  // budget, and the 09-08 dump already reported the GPU process holding 2 MB across 25
  // mappings — it does not hold the 32 GB. The census is the cheap half: ONE Start-Sleep is
  // shared by every subject.
  assert.match(c, /\$tthreads = @\(\$targets\)/, 'the census list starts from the walk list');
  assert.match(c, /foreach \(\$tp in \$tthreads\) \{ \$t1\[\$tp\.Pid\]/, 'first snapshot covers the GPU process');
  assert.match(c, /foreach \(\$tp in \$tthreads\) \{',/, 'second snapshot covers it too');
  const walk = c.indexOf('foreach ($tp in $targets) { if (-not $vmOk)');
  assert.ok(walk > -1, 'the WALK still iterates $targets — a third walk is what the budget cannot afford');
  assert.doesNotMatch(c, /foreach \(\$tp in \$tthreads\) \{ if \(-not \$vmOk\)/, 'the walk must not take the census list');
});

test('the GPU process is matched on PARENT and is never the target itself', () => {
  const c = code(scan);
  // $ours spans BOTH profile families and the rec.gov keepalive opens its own browser twice
  // per 30 minutes. A largest-first pick would sometimes read a DIFFERENT browser's idle GPU
  // process and report it as this one's — a false confirmation of the leading hypothesis.
  assert.match(c, /\$_\.PPid -eq \$tg\.PPid/, 'the sibling match: same browser generation');
  assert.match(c, /\$_\.PPid -eq \$tg\.Pid/, 'and the case where the target IS the browser');
  assert.match(c, /PPid = \$o\.ParentProcessId/, 'the parent has to be carried on the candidate or nothing can match on it');
  // Without this the target matches its own sibling test, $tthreads carries it twice, and the
  // readout pairs one process with a second copy of itself.
  assert.match(c, /\$_\.Pid -ne \$tg\.Pid/, 'the target can never be its own service');
  // No match REPORTS ITSELF rather than falling back to a guess.
  assert.match(c, /'VMTHREAD gpu-process not found/, 'an absence that says so');
});

test('the readout RENDERS the GPU census and the pairing, or both are inert', () => {
  const c = code(readout);
  // The GPU process is not walked, so nothing in the per-pid loop would ever print it. A
  // reading produced and never rendered is the shape this file has paid for seven times.
  assert.match(c, /\n\s*printVerdict\('  ', servicePairReading\(\{/,
    'the pairing verdict must be a rendered statement, not merely constructed');
  assert.match(c, /type=gpu-process/, 'the GPU census line has to be found by type');
  assert.match(c, /gpuNote: gpuMiss/, 'a deliberate miss must reach the verdict or it renders as silence');
  assert.match(c, /rendererBusy = busy\.kind/, 'the renderer half of the pairing must be captured');
  // Re-anchored 2026-09-09: the verdict is now assigned so its KIND can be paired. The
  // property being pinned is unchanged — rendered, not merely constructed — and both halves
  // are line-initial statements so `void 0 && ...` and `if (false) ...` cannot satisfy them.
  assert.match(c, /\n\s*const busy = busyThreadReading\(\{/, 'the renderer verdict is computed once');
  assert.match(c, /\n\s*printVerdict\('      ', busy\.text\)/, 'and rendered');
});

/**
 * ── VMSTACK: WHAT IS THE SPINNING THREAD EXECUTING? (2026-09-09) ─────────────────────────
 *
 * The census answered SPINNING and stopped there. These cover the step past it — sampling the
 * thread's instruction pointer from outside the process, which is the only route left once a
 * renderer answers no CDP call — and above all the REFUSAL, because the failure mode here is
 * not silence. `Rip` sits at byte 248 of the x64 CONTEXT (six debug registers, not eight); get
 * that wrong and the read returns a stack pointer, which belongs to no module and renders as
 * `JIT-compiled JavaScript`. A plausible answer for the wrong reason would send the next
 * session to the wrong half of the system, so the executability check and its refusal are
 * guarded harder than either verdict.
 */
test('a wrong CONTEXT offset is REFUSED rather than reported as JIT', () => {
  // A spinning thread executes at every instant, so its instruction pointer is always on an
  // executable page. Addresses that are not are not instruction pointers, whatever else the
  // classes say — and the JIT branch is exactly what a stack pointer would masquerade as.
  const r = spinSiteReading({ present: true, read: 40, executable: 6, notExecutable: 34, module: 0, anonExec: 6 });
  assert.equal(r.kind, 'suspect-offset');
  assert.match(r.text, /REFUSED/);
  assert.equal(/JIT-compiled/.test(r.text), false, 'a refused reading must not also name a culprit');
});

test('the refusal outranks a class that would otherwise dominate', () => {
  // The dangerous shape: a bad offset whose values happen to land inside a module's DATA. The
  // module count would dominate and read as a clean native answer, so the executable axis has
  // to be consulted FIRST and independently.
  const r = spinSiteReading({ present: true, read: 40, executable: 1, notExecutable: 39, module: 38, anonExec: 0 });
  assert.equal(r.kind, 'suspect-offset', 'a dominant module count must not outrank a non-executable majority');
});

test('samples inside a loaded module are a NATIVE loop, and carry the build that symbolizes it', () => {
  const r = spinSiteReading({
    present: true, read: 40, executable: 40, notExecutable: 0, module: 38, anonExec: 2,
    distinct: 4, topAt: 'chrome.dll+0x9961707', topCount: 20, build: '141.0.7390.55',
  });
  assert.equal(r.kind, 'module');
  assert.match(r.text, /141\.0\.7390\.55/, 'an offset with no build is a number nobody can symbolize');
  assert.match(r.text, /chrome\.dll\+0x9961707/, 'the address to act on rides the verdict');
  assert.match(r.text, /tight loop/);
});

test('a native reading with no build says the offset cannot be symbolized yet', () => {
  const r = spinSiteReading({ present: true, read: 40, executable: 40, module: 40, anonExec: 0, distinct: 3 });
  assert.equal(r.kind, 'module');
  assert.match(r.text, /cannot be symbolized/);
});

test('executable pages in no loaded image are GENERATED CODE — the page, not Chromium', () => {
  const r = spinSiteReading({
    present: true, read: 40, executable: 40, notExecutable: 0, module: 1, anonExec: 39, distinct: 5,
  });
  assert.equal(r.kind, 'jit');
  assert.match(r.text, /generated code/i);
  assert.match(r.text, /no Chromium change/, 'the two branches must state their DIFFERENT fixes');
  assert.match(r.text, /does NOT by itself name which script/, 'and must not overclaim which script');
});

test('neither class dominating is a real reading and refuses to choose', () => {
  // The share gate, and the same reason the bucket verdict has one: a verdict that fires on
  // every input fires on the inputs that mean nothing.
  const r = spinSiteReading({ present: true, read: 40, executable: 40, module: 20, anonExec: 20, distinct: 30 });
  assert.equal(r.kind, 'mixed');
  assert.match(r.text, /NO CLASS DOMINATES/);
  assert.equal(/generated code:|NATIVE CODE:/.test(r.text), false, 'a mixed reading names neither');
});

test('the dominance gate is bounded on both sides', () => {
  assert.ok(SPIN_SITE_DOMINANCE > 0.5, 'at or below half, both classes could "dominate" at once');
  assert.ok(SPIN_SITE_DOMINANCE <= 0.9, 'above this, a real answer with ordinary noise is reported as mixed');
});

test('no VMSTACK line is an ABSENCE, never "it was not looping"', () => {
  const r = spinSiteReading({ present: false });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.text, /ABSENCE, not a reading/);
});

test('a thread that read NOTHING is a failed measurement, not an answer', () => {
  // read=0 means the thread could not be opened or every GetThreadContext failed. Rounding
  // that to either class is the absent-reading-as-a-negative shape this file exists for.
  const r = spinSiteReading({ present: true, read: 0, executable: 0, notExecutable: 0 });
  assert.equal(r.kind, 'unread');
  assert.match(r.text, /failed measurement/);
});

test('a BLOCKED thread is deliberately not sampled and says so', () => {
  const r = spinSiteReading({ present: true, status: 'not-spinning' });
  assert.equal(r.kind, 'not-sampled');
  assert.match(r.text, /BLOCKED/);
});

test('the distinct count separates a tight loop from a wide one, and claims nothing more', () => {
  const tight = spinSiteReading({ present: true, read: 40, executable: 40, module: 40, distinct: 3, build: 'x' });
  const wide = spinSiteReading({ present: true, read: 40, executable: 40, module: 40, distinct: 37, build: 'x' });
  assert.match(tight.text, /tight loop/);
  assert.match(wide.text, /wide loop body/);
  assert.equal(tight.kind, wide.kind, 'spread describes the loop, it does not change which class it is in');
});

test('the sampler NEVER touches the browser process, the GPU process or the control', () => {
  // The one thread suspended is a renderer main thread the census has just found spinning —
  // already doing nothing the product needs. The BROWSER process is not: it drives the profile
  // lock, the supervisor channel and every other browser on the box.
  const c = code(scan);
  assert.match(c, /\$tp\.Pid -eq \$targets\[0\]\.Pid -and \$tp\.Ty -eq 'renderer'/,
    'the spin carriers are set for the TARGET only, and only when it is a renderer');
  assert.ok(!/\$spinPid = \$tthreads/.test(c), 'the GPU process is never a sample subject');
});

test('a blocked thread is never suspended — the gate is the census delta, not the verdict text', () => {
  const c = code(scan);
  assert.match(c, /elseif \(\$spinDl -lt 600\) \{ 'VMSTACK pid='/,
    'below half a core over the 1200 ms window it stands down rather than suspending');
  const gate = c.indexOf('$spinDl -lt 600');
  const sample = c.indexOf('[ChThr]::Sample');
  assert.ok(gate > -1 && sample > gate, 'and the stand-down is evaluated BEFORE the sampler runs');
});

test('every suspend is paired with its resume in a C# finally, not on the next line', () => {
  // A throw between the suspend and the resume is the one failure mode that could leave a
  // thread stopped. PowerShell cannot be interrupted inside the C# method, so the pairing has
  // to live there rather than in the script around it.
  assert.match(scan, /finally \{ ResumeThread\(h\); \}/,
    'the resume must be in a finally — a resume on the line after the read is not paired');
  const susp = scan.indexOf('SuspendThread(h) != uint.MaxValue');
  const res = scan.indexOf('finally { ResumeThread(h); }');
  assert.ok(susp > -1 && res > susp, 'and it must follow the suspend it pairs with');
});

test('the sampler compiles into its OWN class under its OWN flag, or a fault costs the walk', () => {
  // VMTHREAD's header records the standing decision against P/Invoke here: PowerShell parses
  // the whole script before running any of it and a fault costs the region walk, which is the
  // one instrument that still works. A second Add-Type under a second flag is what answers it.
  const c = code(scan);
  assert.match(c, /public class ChThr/, 'a separate class, not more DllImports bolted onto ChMem');
  assert.match(c, /catch \{ \$stkOk = \$false; 'VMSTACK unavailable: Add-Type '/,
    'a failed compile must stand THIS instrument down and say so');
  assert.ok(c.indexOf('$cs2 =') > c.indexOf('Add-Type -TypeDefinition $cs -ErrorAction Stop'),
    'and it must compile AFTER ChMem, so a fault here cannot reach the walk');
  assert.ok(c.indexOf("'VMWALK pid='") < c.indexOf("'VMSTACK pid='"), 'the walk is emitted first');
});

test('the thread handle asks for suspend and context ONLY — never to read the process', () => {
  // 10 = THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT. Same rule as the walk: query, never read.
  //
  // ASSERTED AGAINST THE EMITTED SCRIPT, NOT THE FILE. The comments above these lines NAME the
  // forbidden calls in order to explain why they are not used, so a whole-file scan fails on
  // its own explanation — and the fix a hurried reader reaches for is deleting the comment.
  // What runs is the subject; a comment cannot copy anything.
  const ps = /export const RAMP_SCAN_PS = \[([\s\S]*?)\n\]\.join/.exec(scan)?.[1] ?? '';
  assert.ok(ps.length > 0, 'the PS block must be findable');
  const emitted = ps.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(emitted, /OpenThread\(10, false, tid\)/, 'nothing wider than pause-and-read-a-register');
  for (const forbidden of ['ReadProcessMemory', 'MiniDump', 'WriteProcessMemory']) {
    assert.doesNotMatch(emitted, new RegExp(forbidden), `${forbidden} would copy the process's memory`);
  }
});

test('the CONTEXT is aligned by hand, because a stack struct is only guaranteed 8', () => {
  // x64 GetThreadContext requires 16-byte alignment. The offsets are asserted by value because
  // they are the whole correctness of the read: 48 = ContextFlags, 1048577 = CONTEXT_CONTROL,
  // 248 = Rip in a struct carrying SIX debug registers.
  assert.match(scan, /Marshal\.AllocHGlobal\(1248\)/, '1232 for the CONTEXT plus 16 of slack');
  assert.match(scan, /\(raw\.ToInt64\(\) \+ 15\) & ~15L/, 'rounded UP to the next 16-byte boundary');
  assert.match(scan, /Marshal\.WriteInt32\(c, 48, 1048577\)/, 'ContextFlags = CONTEXT_CONTROL');
  assert.match(scan, /Marshal\.ReadInt64\(c, 248\)/, 'Rip');
});

test('the two axes are counted independently, or a bad offset hides inside a module', () => {
  // `is it in a loaded image` and `is its page executable` answer different questions.
  // Collapsing them would let a wrong offset returning a pointer into chrome.dll's DATA count
  // as a module hit and read as a clean answer.
  const c = code(scan);
  assert.match(c, /\$nExec = \$nExec \+ 1 \} else \{ \$ex = 0; \$nNon = \$nNon \+ 1 \}/);
  assert.match(c, /if \(\$hit\) \{ \$nMod = \$nMod \+ 1 \} elseif \(\$ex -eq 1\) \{ \$nJit = \$nJit \+ 1 \}/);
  assert.match(c, /'VMSTACKEXEC pid='/, 'the executable axis is emitted on its own line');
  assert.match(c, /'VMSTACKCLASS pid='/, 'and the module axis on another');
});

test('a failed VirtualQueryEx never attributes the PREVIOUS address\'s protection', () => {
  // $mbi2 is reused across iterations, so an unguarded read after a failed query reports the
  // last address's page as this one's.
  const c = code(scan);
  assert.match(c, /\$ex = -1;/, 'the per-iteration reset');
  assert.match(c, /if \(\$ex -eq 0\) \{ \$lab = 'NOT-EXECUTABLE protect=0x' \+ \$mbi2\.Protect/,
    'and every use of $mbi2 is gated on this iteration having answered');
});

test('the readout RENDERS the verdict and the addresses, or both are inert', () => {
  // The pure function can be perfect and unreachable. And on the module branch the per-address
  // lines ARE the payload — a verdict with no offset leaves a reader with a conclusion and
  // nothing to act on.
  assert.match(readout, /spinSiteReading\(\{/, 'the verdict is computed');
  assert.match(readout, /printVerdict\('  ', spinSiteReading\(\{/, 'AND printed');
  // NOT a bare /VMSTACKTOP/: that string also appears on the line that FILTERS for it, so the
  // assertion passed against a readout whose render had been replaced with `void stkTops`.
  // Verified by mutation. Pin the console.log, which is the only part a reader ever sees.
  assert.match(readout, /for \(const t of stkTops\.slice\(0, 6\)\) console\.log\(/,
    'the sampled addresses must be PRINTED, not merely collected');
  assert.match(readout, /notExecutable: stkExec && num/, 'the refusal axis is passed, or it can never fire');
  assert.match(readout, /build: stkBuild/, 'and the build, or a native answer cannot be symbolized');
});

test('an empty module list REFUSES rather than reporting a unanimous JIT answer', () => {
  // `anonExec` means "executable and in no loaded image". With zero modules enumerated that is
  // true of every address by construction, so a failed Process.Modules read would manufacture
  // a confident JIT verdict out of nothing — and send the next session hunting a script that
  // is not there. Process.Modules can throw part-way against a process under pressure, which
  // is exactly the process this runs against.
  const r = spinSiteReading({
    present: true, read: 40, executable: 40, notExecutable: 0, module: 0, anonExec: 40, modules: 0,
  });
  assert.equal(r.kind, 'no-modules');
  assert.match(r.text, /REFUSED/);
  assert.equal(/generated code/i.test(r.text), false, 'a refused reading must not also name a culprit');
});

test('a populated module list still lets the JIT branch fire', () => {
  // The refusal must not swallow the real answer: this is the branch it exists to protect.
  const r = spinSiteReading({
    present: true, read: 40, executable: 40, notExecutable: 0, module: 1, anonExec: 39, modules: 118,
  });
  assert.equal(r.kind, 'jit');
});

test('a NULL module count is "not reported", never "zero modules found"', () => {
  // Number(undefined) is NaN and never equals 0, so the undefined case guards itself — but
  // Number(null) IS 0, and a check written without that in mind refuses every caller passing
  // null. Verified by mutation: dropping the null handling makes this test, and only this
  // test, fail. Same trap that made the ramp-dump grace inert on 2026-09-08.
  const r = spinSiteReading({
    present: true, read: 40, executable: 40, module: 0, anonExec: 40, modules: null,
  });
  assert.equal(r.kind, 'jit', 'null means the count was not reported, not that none were found');
});

test('a scan that reports no module count at all is not treated as zero', () => {
  // An older box sends no VMSTACKMOD line. Absent and zero are different facts, and rounding
  // the first to the second would refuse every reading from a box mid-update.
  const r = spinSiteReading({ present: true, read: 40, executable: 40, module: 0, anonExec: 40 });
  assert.equal(r.kind, 'jit', 'undefined means "not reported", not "none found"');
});

test('an UNMEASURED delta is a failed measurement, not a quiet thread', () => {
  // The census writes -1 when it could not read a thread's CPU time on both passes. Folding
  // that into BLOCKED would report an absent reading as a finding about the thread.
  const r = spinSiteReading({ present: true, status: 'unmeasured' });
  assert.equal(r.kind, 'unmeasured');
  assert.match(r.text, /says nothing either way/);
  assert.equal(/BLOCKED/.test(r.text), false, 'unmeasured must not borrow the blocked wording');
});

test('the script emits the two stand-downs as DIFFERENT statuses, and unmeasured is tested first', () => {
  const c = code(scan);
  assert.match(c, /elseif \(\$spinDl -lt 0\).*status=unmeasured/, 'a negative delta has its own status');
  assert.match(c, /elseif \(\$spinDl -lt 600\).*status=not-spinning/);
  assert.ok(c.indexOf('status=unmeasured') < c.indexOf('status=not-spinning'),
    'the -lt 0 arm must come first, or a negative delta is swallowed by the -lt 600 arm');
});

test('the readout carries the status VALUE and the module count, or both guards are inert', () => {
  assert.match(readout, /const stkStatus = stk && \/ status=\(\\S\+\)\/\.exec\(stk\)\?\.\[1\]/,
    'the status is read as a value, not tested for one of them');
  assert.match(readout, /status: stkStatus,/, 'and passed through');
  assert.match(readout, /modules: stkMod && num/, 'the module count reaches the refusal, or it can never fire');
});
