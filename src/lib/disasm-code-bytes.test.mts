/**
 * Guards for the two pure halves of `scripts/disasm-code-bytes.mts`.
 *
 * WHY THIS EXISTS AT ALL, given it is a developer tool rather than product code: the first
 * version of that script reported "all alignments agree on the instruction at the target" as its
 * CONFIDENCE READING, and that is a **tautology** — decoding is deterministic from a byte, so any
 * alignment landing on the target decodes the same bytes and must produce the same answer. It was
 * caught by reasoning, minutes from being shipped as a measurement. A constant dressed as a
 * signal is exactly what a test surfaces and a review does not.
 *
 * Under `src/lib/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:`. Read from the workflow, not remembered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// `.mjs`, NOT `.mts`, and that is a TypeScript rule rather than a typo: a source `.mts` is
// imported by its EMITTED specifier, and spelling it `.mts` fails typecheck with TS5097
// (`allowImportingTsExtensions`). `npm test` passes either way — only `npm run typecheck`
// catches it, which is the same blind spot the worker tsconfig was added for.
import { parseCodeBytes, convergencePoint } from '../../scripts/disasm-code-bytes.mjs';

const dump = [
  'file       C:\\pw\\chrome-win\\chrome.dll',
  'size       214748364 bytes   timeDateStamp 0xdeadbeef   sizeOfImage 0x9000000',
  // A line that an UNANCHORED row regex genuinely swallows: eight hex characters, whitespace,
  // then hex pairs. The shipped format does not currently emit one — verified by mutation, which
  // is how this fixture was found to be vacuous — so it stands for a format the output could
  // grow. The anchor is cheap; a silently prepended eight bytes of "instruction" is not.
  'binary key deadbeef 50 00 00',
  'pdb        chrome.dll.pdb  key 0403020106050807090A0B0C0D0E0F102',
  'asked      RVA 0x18096c6   window starts 0x1809686 in .text at file offset 0x1234',
  '',
  '01809686  48 8b 01 f0 48 0f b1 0a',
].join('\n');

test('it reads the hex rows and takes the first row as the base', () => {
  const r = parseCodeBytes(dump)!;
  assert.equal(r.base, 0x1809686);
  assert.equal(r.bytes.toString('hex'), '488b01f0480fb10a');
});

test('PROVENANCE LINES ARE NOT DATA — the keys must not be read as bytes', () => {
  // `binary key DEADBEEF9000000` is hex-ish and unanchored parsing would swallow it, silently
  // prepending garbage to the instruction stream. The row shape is anchored at both ends.
  const r = parseCodeBytes(dump)!;
  assert.ok(!r.bytes.toString('hex').includes('deadbeef'), 'the binary key leaked into the bytes');
  assert.ok(!r.bytes.toString('hex').includes('500000'), 'the key\'s trailing pairs leaked in');
  assert.equal(r.bytes.length, 8, 'exactly the one hex row');
});

test('a reply with no hex rows returns null rather than an empty reading', () => {
  // The "(… does not exist)" answer and a real dump must not both parse to "zero bytes", which
  // would disassemble as an empty stream and print a confident nothing.
  assert.equal(parseCodeBytes('(C:\\pw\\chrome.dll does not exist)'), null);
  assert.equal(parseCodeBytes(''), null);
});

const base = 0x1000;
/** Boundaries as if every alignment resynchronised by `resyncAt`. */
const runs = (resyncAt: number, skips = [0, 1, 2, 3]) =>
  skips.map((skip) => ({
    skip,
    boundaries: new Set<number>(
      Array.from({ length: 64 }, (_, i) => base + skip + i)
        .filter((a) => a >= base + resyncAt || (a - base - skip) % 3 === 0),
    ),
  }));

test('convergence is where every alignment STILL IN RANGE agrees', () => {
  const target = base + 0x20;
  const got = convergencePoint(runs(0x10), base, target);
  assert.ok(got <= base + 0x10, `expected convergence at or before +0x10, got +0x${(got - base).toString(16)}`);
  assert.ok(got < target, 'it must find something earlier than the target');
});

test('NO convergence returns the target itself, not a fabricated earlier point', () => {
  // If the alignments already disagree at the byte below the target, nothing before it is
  // trustworthy and the honest answer is the target. Returning anything earlier would license
  // reading a loop head that is a guess.
  //
  // UPDATED when convergence was corrected to compare boundary SETS rather than requiring every
  // walked byte to BE a boundary. Under the old rule any pair of sparse sets "failed" at once,
  // so this passed for the wrong reason; agreeing that a byte is MID-INSTRUCTION is agreement,
  // and the disagreement now has to be constructed rather than falling out of sparseness.
  const target = base + 0x20;
  const disagreeImmediately = [
    { skip: 0, boundaries: new Set([target - 1, target]) },
    { skip: 1, boundaries: new Set([target]) },          // says target-1 is mid-instruction
  ];
  assert.equal(convergencePoint(disagreeImmediately, base, target), target);
});

test('agreeing that a byte is MID-INSTRUCTION counts as agreement', () => {
  // The bug this replaced: requiring `boundaries.has(a)` for every byte walked back is only
  // satisfiable when every instruction is one byte long. The fixture that hid it was all NOPs,
  // and it reported "converges only at the target" on the first REAL code it ever saw.
  const target = base + 0x20;
  // Both agree on the boundaries at 0x10 and 0x18 AND on the mid-instruction bytes between
  // them; they first differ at 0x08. So the walk must cross the gaps and stop at the real
  // disagreement — under the old rule it would have stopped at 0x1f, the first non-boundary.
  const bothSparse = [
    { skip: 0, boundaries: new Set([base + 0x08, base + 0x10, base + 0x18, target]) },
    { skip: 1, boundaries: new Set([base + 0x10, base + 0x18, target]) },
  ];
  assert.equal(convergencePoint(bothSparse, base, target), base + 0x09,
    'multi-byte gaps must not stop the walk; only a real disagreement should');
});

test('AN ALIGNMENT THAT STARTS AFTER AN ADDRESS GETS NO VOTE ON IT', () => {
  // Counting a run that cannot see an address as agreeing with it would stop the walk early and
  // UNDER-report how much of the loop head is trustworthy.
  //
  // THE FIRST VERSION OF THIS TEST PROVED THE OPPOSITE OF ITS TITLE, and its own comment said so
  // out loud: every run in that fixture started before the address under test, so the range
  // filter was never exercised and deleting it passed. Caught by mutation, not by review.
  const target = base + 0x20;
  const everywhere = (from: number) =>
    new Set(Array.from({ length: 0x21 }, (_, i) => base + i).filter((a) => a >= base + from));
  const withLateStarter = [
    { skip: 0, boundaries: everywhere(0) },
    { skip: 1, boundaries: everywhere(1) },
    // Starts at base+0x10, so it has NO OPINION about anything below that.
    { skip: 0x10, boundaries: everywhere(0x10) },
  ];
  const got = convergencePoint(withLateStarter, base, target);
  assert.ok(got < base + 0x10,
    `the late starter must not veto addresses it cannot see — converged at +0x${(got - base).toString(16)}`);
});

test('a single voter is never enough to declare convergence', () => {
  // One alignment agreeing with itself is not agreement; it is the same tautology one level down.
  const target = base + 0x20;
  const lonely = [{ skip: 0, boundaries: new Set([base + 0x08, base + 0x10, target]) }];
  assert.equal(convergencePoint(lonely, base, target), target);
});
