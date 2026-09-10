/**
 * Guards for the PE64 reader behind `code-bytes`.
 *
 * WHY A SYNTHETIC IMAGE RATHER THAN A REAL `chrome.dll`. The real one is 200 MB, is on a
 * Windows box this repo cannot reach, and would make the test depend on a binary nobody can
 * check in. What matters is the ARITHMETIC — RVA to file offset across a section table whose
 * file and memory alignments differ — and that is exactly what a hand-built image pins.
 *
 * The numbers below are deliberately UNEQUAL (`va` 0x1000 vs `rawPtr` 0x400, and a second
 * section whose skew differs again). A fixture where the two happen to match passes against a
 * reader that ignores the section table entirely, which is the vacuous-guard shape this repo
 * has recorded more than twenty times.
 *
 * Under `src/lib/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:` and this guards two bot-side files. Read, not remembered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeHeaders, rvaToFileOffset, parseCodeView, readCodeWindow, formatCodeWindow }
  from '../../scripts/auto-cart-bot/pe-rva.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A minimal PE32+ with two sections and a debug data directory. */
function makePe(opts: { magic?: number; sections?: Array<[string, number, number, number, number]> } = {}) {
  const buf = Buffer.alloc(0x600);
  buf.writeUInt16LE(0x5a4d, 0);            // MZ
  const peOff = 0x80;
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x00004550, peOff);    // PE\0\0
  const coff = peOff + 4;
  const sections = opts.sections ?? [
    // name,     vsize,   va,      rawSize, rawPtr
    ['.text', 0x2000, 0x1000, 0x2000, 0x400],
    ['.rdata', 0x1000, 0x3000, 0x0800, 0x2400],
  ] as Array<[string, number, number, number, number]>;
  buf.writeUInt16LE(sections.length, coff + 2);
  buf.writeUInt32LE(0xdeadbeef, coff + 4); // TimeDateStamp
  const sizeOfOptional = 0xf0;
  buf.writeUInt16LE(sizeOfOptional, coff + 16);
  const opt = coff + 20;
  buf.writeUInt16LE(opts.magic ?? 0x20b, opt);
  buf.writeUInt32LE(0x5000, opt + 56);     // SizeOfImage
  buf.writeUInt32LE(16, opt + 108);        // NumberOfRvaAndSizes
  buf.writeUInt32LE(0x3100, opt + 112 + 6 * 8);       // Debug directory RVA
  buf.writeUInt32LE(28, opt + 112 + 6 * 8 + 4);       // ...and its size
  const secTable = opt + sizeOfOptional;
  sections.forEach(([name, vsize, va, rawSize, rawPtr], i) => {
    const s = secTable + i * 40;
    buf.write(name, s, 'latin1');
    buf.writeUInt32LE(vsize, s + 8);
    buf.writeUInt32LE(va, s + 12);
    buf.writeUInt32LE(rawSize, s + 16);
    buf.writeUInt32LE(rawPtr, s + 20);
  });
  return buf;
}

test('headers parse, and the section table comes back intact', () => {
  const pe = parsePeHeaders(makePe());
  assert.equal(pe.timeDateStamp, 0xdeadbeef);
  assert.equal(pe.sizeOfImage, 0x5000);
  assert.deepEqual(pe.sections.map((s: { name: string }) => s.name), ['.text', '.rdata']);
  assert.equal(pe.debugDir.rva, 0x3100);
});

test('an RVA maps to its own section, and the section is named back', () => {
  const pe = parsePeHeaders(makePe());
  assert.deepEqual(rvaToFileOffset(pe, 0x1000), { offset: 0x400, section: '.text' });
  assert.deepEqual(rvaToFileOffset(pe, 0x1096), { offset: 0x496, section: '.text' });
  assert.deepEqual(rvaToFileOffset(pe, 0x3000), { offset: 0x2400, section: '.rdata' });
  // The section NAME is asserted as well as the offset: a reader that returned the right
  // number from the wrong section would be right by luck of this fixture's alignment, and
  // wrong on the real image. The test below is the one that actually separates them.
});

test('a differently-skewed section is not read with the first section\'s delta', () => {
  // THE MUTATION THIS EXISTS FOR: a reader that computes one global skew from section 0 and
  // applies it everywhere passes the .text assertions above and fails here.
  const pe = parsePeHeaders(makePe({
    sections: [
      ['.text', 0x2000, 0x1000, 0x2000, 0x400],
      ['.rdata', 0x1000, 0x9000, 0x0800, 0x2400],   // skew 0x6C00, not 0xC00
    ],
  }));
  assert.deepEqual(rvaToFileOffset(pe, 0x9010), { offset: 0x2410, section: '.rdata' });
});

test('an RVA past a section\'s RAW data refuses rather than reading the next section', () => {
  // A section can be bigger in memory than on disk. Returning neighbouring bytes for the tail
  // would disassemble into confident nonsense — the worst possible output here.
  const pe = parsePeHeaders(makePe({
    sections: [['.data', 0x4000, 0x1000, 0x0100, 0x400], ['.rdata', 0x1000, 0x9000, 0x800, 0x2400]],
  }));
  assert.throws(() => rvaToFileOffset(pe, 0x1200), /past its raw data/);
});

test('an RVA in no section refuses', () => {
  assert.throws(() => rvaToFileOffset(parsePeHeaders(makePe()), 0x99000), /no section/);
});

test('PE32 is REFUSED, never assumed to be PE32+', () => {
  // PE32 puts its data directories at optional-header offset 96, not 112. Assuming 64-bit
  // reads a different structure and returns something shaped like an answer.
  assert.throws(() => parsePeHeaders(makePe({ magic: 0x10b })), /expected PE32\+/);
});

test('a non-PE input refuses instead of parsing garbage', () => {
  assert.throws(() => parsePeHeaders(Buffer.alloc(0x200)), /not a PE file/);
  const noSig = makePe(); noSig.writeUInt32LE(0, 0x80);
  assert.throws(() => parsePeHeaders(noSig), /no PE signature/);
});

test('the PDB key is MIXED-ENDIAN, which is the whole reason it is computed here', () => {
  // A straight hex dump of the sixteen GUID bytes produces a key that looks right and matches
  // nothing on a symbol server. The first three fields are little-endian integers; the last
  // eight bytes are raw.
  const cv = Buffer.concat([
    Buffer.from('RSDS', 'latin1'),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]),
    Buffer.from([1, 0, 0, 0]),                       // age 1
    Buffer.from('chrome.dll.pdb\0', 'latin1'),
  ]);
  const got = parseCodeView(cv)!;
  assert.equal(got.guid, '0403020106050807090A0B0C0D0E0F10');
  assert.equal(got.age, 1);
  assert.equal(got.name, 'chrome.dll.pdb');
  // Age is appended in hex with NO zero padding — the symbol-server convention.
  assert.equal(got.key, '0403020106050807090A0B0C0D0E0F101');
});

test('a two-digit age is not zero-padded either', () => {
  const cv = Buffer.concat([
    Buffer.from('RSDS', 'latin1'), Buffer.alloc(16), Buffer.from([0x1f, 0, 0, 0]),
    Buffer.from('x.pdb\0', 'latin1'),
  ]);
  assert.equal(parseCodeView(cv)!.key.endsWith('1F'), true);
});

test('a debug record that is not RSDS reports NOTHING rather than a wrong key', () => {
  // NB09 (PDB 2.0) and unrelated debug types both land here. A fabricated key sends the next
  // session to a symbol server with a lookup that can only ever 404, and the 404 reads as
  // "symbols are not published" rather than "we computed the key wrong".
  assert.equal(parseCodeView(Buffer.from('NB10rubbish', 'latin1')), null);
  assert.equal(parseCodeView(Buffer.alloc(4)), null);
});

/**
 * ── THE READING HALF, AGAINST A REAL FILE ─────────────────────────────────────────────────
 *
 * `readCodeWindow` takes a path so it can be exercised here; the COMMAND derives `chrome.dll`
 * from Playwright's own browser directory and never accepts one. That split is deliberate: a
 * path parameter on the command would be an arbitrary file read on the box holding the RC
 * session, so the arithmetic is made testable WITHOUT trading the property away.
 */
function writePeFile(): { file: string; marker: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'pe-'));
  const file = join(dir, 'fake.dll');
  const buf = makePe();
  const full = Buffer.alloc(0x3000);
  buf.copy(full, 0);

  // .text is va 0x1000 -> rawPtr 0x400. Put a recognisable run at RVA 0x1100 (file 0x500).
  const marker = Buffer.from([0x48, 0x8b, 0x01, 0xf0, 0x48, 0x0f, 0xb1, 0x0a, 0xeb, 0xfa]);
  marker.copy(full, 0x500);

  // A CodeView record inside .rdata (va 0x3000 -> rawPtr 0x2400). The debug directory is at
  // RVA 0x3100, i.e. file 0x2500, and its PointerToRawData points at file 0x2600 directly.
  const dbg = 0x2500;
  full.writeUInt32LE(2, dbg + 12);        // Type = CODEVIEW
  full.writeUInt32LE(64, dbg + 16);       // SizeOfData
  full.writeUInt32LE(0x2600, dbg + 24);   // PointerToRawData (a FILE offset already)
  const cv = Buffer.concat([
    Buffer.from('RSDS', 'latin1'),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]),
    Buffer.from([2, 0, 0, 0]),
    Buffer.from('fake.pdb\0', 'latin1'),
  ]);
  cv.copy(full, 0x2600);

  writeFileSync(file, full);
  return { file, marker };
}

test('readCodeWindow returns the bytes actually at that RVA, and the PDB identity with them', () => {
  const { file, marker } = writePeFile();
  const r = readCodeWindow(file, 0x1100, { before: 0, window: 16 });
  assert.equal(r.section, '.text');
  assert.equal(r.offset, 0x500);
  assert.equal(r.bytes.subarray(0, marker.length).toString('hex'), marker.toString('hex'));
  assert.equal(r.pdb?.name, 'fake.pdb');
  assert.equal(r.pdb?.key, '0403020106050807090A0B0C0D0E0F102');
});

test('the window starts BEFORE the address, because x86 is variable-length', () => {
  // The caller has to find instruction boundaries by trying alignments, so it needs bytes on
  // both sides. A window that began exactly at the address would disassemble from the middle
  // of an instruction and produce confident nonsense.
  const { file, marker } = writePeFile();
  const r = readCodeWindow(file, 0x1100, { before: 0x40, window: 0x80 });
  assert.equal(r.startRva, 0x10c0);
  assert.equal(r.offset, 0x4c0);
  assert.equal(r.bytes.subarray(0x40, 0x40 + marker.length).toString('hex'), marker.toString('hex'));
});

test('a debug record whose PointerToRawData is treated as an RVA yields the WRONG pdb', () => {
  // Guarding the specific mistake: PointerToRawData is already a file offset, and mapping it
  // through rvaToFileOffset a second time lands somewhere plausible and wrong. If the reader
  // ever does that here, no RSDS signature is found and pdb goes null rather than wrong —
  // which is why the assertion is that it is FOUND.
  const { file } = writePeFile();
  assert.ok(readCodeWindow(file, 0x1100).pdb, 'the CodeView record must be found at its file offset');
});

test('a stripped image reports no pdb and still returns the bytes', () => {
  // THE BYTES ARE THE POINT; the identity is a bonus. A build with no CodeView record must not
  // cost the reading that the whole command exists for.
  const dir = mkdtempSync(join(tmpdir(), 'pe-'));
  const file = join(dir, 'nodebug.dll');
  const full = Buffer.alloc(0x3000);
  makePe().copy(full, 0);
  full.writeUInt32LE(0, 0x80 + 4 + 20 + 112 + 6 * 8);   // clear the debug directory RVA
  Buffer.from([0x90, 0x90, 0xcc]).copy(full, 0x500);
  writeFileSync(file, full);
  const r = readCodeWindow(file, 0x1100, { before: 0, window: 8 });
  assert.equal(r.pdb, null);
  assert.equal(r.bytes.subarray(0, 3).toString('hex'), '9090cc');
});

test('the rendering names the section, the window start and both symbol-server keys', () => {
  // A dump with no provenance is a dump of something. The section says the address is code,
  // the window start says where to begin disassembling, and the two keys are what a session
  // WITH egress would look the build up by.
  const { file } = writePeFile();
  const out = formatCodeWindow(file, 0x1100, readCodeWindow(file, 0x1100, { before: 0, window: 16 }));
  assert.match(out, /in \.text at file offset 0x500/);
  assert.match(out, /binary key DEADBEEF5000/);
  assert.match(out, /pdb\s+fake\.pdb\s+key 0403020106050807090A0B0C0D0E0F102/);
  assert.match(out, /^00001100 {2}48 8b 01 f0/m);
});
