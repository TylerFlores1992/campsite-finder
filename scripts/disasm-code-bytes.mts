/**
 * Disassemble what `code-bytes` returned.
 *
 *   npx tsx scripts/bot-ask.mts code-bytes 18096c6 > /tmp/hot.txt
 *   npx tsx scripts/disasm-code-bytes.mts /tmp/hot.txt 18096c6
 *
 * ## Why the alignment sweep is the whole point
 *
 * x86-64 is variable-length and `code-bytes` returns a window that starts 64 bytes BEFORE the
 * address, so the first byte is almost certainly mid-instruction. Disassembling from there
 * produces a plausible, confidently-wrong instruction stream — which is the worst output this
 * pipeline can give, because nothing about it looks wrong.
 *
 * ## What is ambiguous, and what is not
 *
 * THE INSTRUCTION AT THE TARGET IS NEVER AMBIGUOUS, and an earlier version of this script got
 * that backwards. Decoding is deterministic from a given byte, so any alignment that lands on
 * the target decodes the same bytes and MUST produce the same instruction — "the alignments
 * agree at the target" is true by construction and carries no information whatsoever. It was
 * very nearly shipped as the confidence reading: a tautology wearing a measurement's clothes.
 *
 * What alignment actually affects is everything BEFORE the target — the loop head, which is the
 * part that says what the loop is doing. So the sweep's real output is a CONVERGENCE POINT: the
 * earliest address from which every alignment agrees. From there to the target the stream is
 * trustworthy; before it, it is a guess, and the script says which is which rather than printing
 * one confident wall of assembly.
 *
 * `objdump` is used rather than a library because it is already in the container and needs no
 * install; `llvm-objdump` is the fallback.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Pull the `<rva>  aa bb cc ...` rows out of a `code-bytes` reply.
 *
 * Everything else in that output is PROVENANCE — the file path, the two symbol-server keys, the
 * section and window line — and it must not be mistaken for data. The row shape is anchored at
 * both ends so a line like `binary key DEADBEEF5000` cannot be read as hex bytes.
 */
export function parseCodeBytes(text: string): { base: number; bytes: Buffer } | null {
  const rows = text.split('\n')
    .map((l) => l.match(/^([0-9a-f]{8})\s+((?:[0-9a-f]{2}\s*)+)$/i))
    .filter((m): m is RegExpMatchArray => !!m);
  if (!rows.length) return null;
  return {
    base: parseInt(rows[0][1], 16),
    bytes: Buffer.from(rows.map((m) => m[2].replace(/\s+/g, '')).join(''), 'hex'),
  };
}

/**
 * The earliest address from which EVERY alignment still in range agrees on the boundaries.
 *
 * This is the script's actual output. Agreement AT the target is guaranteed by construction —
 * decoding is deterministic from a byte — so it measures nothing; what varies with alignment is
 * the stream BEFORE the target, and this says how much of it is trustworthy.
 *
 * An alignment that starts after an address gets no vote on it: it has no opinion, and counting
 * silence as agreement would report convergence that was never tested.
 */
export function convergencePoint(
  runs: Array<{ skip: number; boundaries: Set<number> }>, base: number, target: number,
): number {
  let converged = target;
  for (let a = target - 1; a > base; a--) {
    const voters = runs.filter((r) => a >= base + r.skip);
    if (voters.length < 2) break;
    // AGREEMENT IS ABOUT THE BOUNDARY SET, NOT ABOUT EVERY BYTE BEING A BOUNDARY. The first
    // version required `boundaries.has(a)` for every address it walked back over, which is only
    // true when every instruction is one byte long — and the fixture was all NOPs, so it looked
    // right and reported "converges only at the target" on the first real code it ever saw.
    // What matters is that the alignments agree on WHERE the boundaries are, including agreeing
    // that a mid-instruction byte is not one.
    const first = voters[0].boundaries.has(a);
    if (!voters.every((r) => r.boundaries.has(a) === first)) break;
    converged = a;
  }
  return converged;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

async function main() {
const [file, rvaArg] = process.argv.slice(2);
if (!file || !rvaArg) {
  console.error('usage: disasm-code-bytes.mts <code-bytes output file> <the RVA you asked for, hex>');
  process.exit(1);
}
const target = parseInt(rvaArg.replace(/^0x/, ''), 16);

const parsed = parseCodeBytes(readFileSync(file, 'utf8'));
if (!parsed) {
  console.error('no hex rows found — is this the output of `code-bytes`?');
  process.exit(1);
}
const { base, bytes } = parsed;
console.log(`${bytes.length} bytes from RVA 0x${base.toString(16)}; target 0x${target.toString(16)} is at +${target - base}\n`);

const dir = mkdtempSync(join(tmpdir(), 'dis-'));
const tool = (() => {
  for (const t of ['objdump', 'llvm-objdump']) {
    try { execFileSync(t, ['--version'], { stdio: 'ignore' }); return t; } catch { /* next */ }
  }
  throw new Error('no objdump available');
})();

function disasm(skip: number): { text: string; boundaries: Set<number> } {
  const bin = join(dir, `s${skip}.bin`);
  writeFileSync(bin, bytes.subarray(skip));
  const args = tool === 'objdump'
    ? ['-D', '-b', 'binary', '-m', 'i386:x86-64', '-M', 'intel', bin]
    : ['-D', '-b', 'binary', '--triple=x86_64', bin];
  const out = execFileSync(tool, args, { encoding: 'utf8' });
  const boundaries = new Set<number>();
  for (const l of out.split('\n')) {
    const m = l.match(/^\s*([0-9a-f]+):\t/i);
    if (m) boundaries.add(base + skip + parseInt(m[1], 16));
  }
  return { text: out, boundaries };
}

// Score every alignment before printing any of them. A sweep that stopped at the first
// plausible-looking run would be the guess this exists to avoid.
const runs = Array.from({ length: Math.min(16, bytes.length) }, (_, skip) => {
  const r = disasm(skip);
  const hitsTarget = r.boundaries.has(target);
  // A decoding that walks off the end mid-instruction, or fills with (bad), is a bad decoding.
  const bad = (r.text.match(/\(bad\)/g) ?? []).length;
  return { skip, hitsTarget, bad, ...r };
});

const best = [...runs].sort((a, b) =>
  Number(b.hitsTarget) - Number(a.hitsTarget) || a.bad - b.bad || a.skip - b.skip)[0];

console.log('alignment sweep (a decoding whose boundaries include the sampled address is the');
console.log('likely one — an instruction pointer is at a boundary by construction):');
for (const r of runs) {
  console.log(`  skip ${String(r.skip).padStart(2)}  ${r.hitsTarget ? 'HITS TARGET' : '           '}  ${String(r.bad).padStart(3)} bad`);
}
// THE REAL READING: where do the alignments CONVERGE? Everything from that address to the
// target is decoded the same way however you start, so it is trustworthy; before it, it is a
// guess. (Agreement AT the target is guaranteed by construction and says nothing — see header.)
const hitting = runs.filter((r) => r.hitsTarget);
console.log(`\n${hitting.length} of ${runs.length} alignments land on the target.`);
if (!hitting.length) {
  console.log('NO alignment put a boundary on the target. The window may be wrong, or the address');
  console.log('is not where this build puts that code — check the RVA before reading anything.');
} else {
  // An address is "converged" once every alignment that is still in range agrees it is a
  // boundary. Walk back from the target to find the earliest such run.
  const converged = convergencePoint(runs, base, target);
  const span = target - converged;
  console.log(span > 0
    ? `Every alignment agrees on the boundaries from 0x${converged.toString(16)} onward — the ` +
      `${span} byte(s) up to the target decode the same way whichever start you take, so THAT ` +
      `much of the loop head is trustworthy. Earlier than that, treat the stream as a guess.`
    : 'The alignments converge only AT the target, so nothing before it is trustworthy — read ' +
      'the target instruction and what follows, not the apparent loop head.');
}

console.log(`\n=== skip ${best.skip} ===\n`);
// Mark the sampled address so it is not hunted for by eye in a wall of hex.
for (const l of best.text.split('\n')) {
  const m = l.match(/^\s*([0-9a-f]+):\t/i);
  const at = m ? base + best.skip + parseInt(m[1], 16) : null;
  console.log(at === target ? `>>> ${l}` : `    ${l}`);
}
}
