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
