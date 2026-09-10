/**
 * Just enough PE64 to turn a code address into bytes on disk — and to name the build.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * VMSTACK put the leak's spinning main thread in NATIVE code at fixed offsets in a known build
 * (2026-09-09, and again on 2026-09-10 with the command buffer disabled):
 *
 *     count=11 at=chrome.dll+0x18096c6
 *     count=9  at=chrome.dll+0x180968b
 *
 * A module-relative address is stable for a build, so it symbolizes offline — except that all
 * four Playwright CDN hosts are 000 at this environment's proxy, so the matching binary cannot
 * be fetched and the container's own Chromium is the wrong revision AND the wrong platform.
 *
 * **The box already has the exact binary.** This reads it from DISK — the shipped file, never a
 * running process — so it touches neither the `ReadProcessMemory` ban nor anything a renderer
 * has in memory. A code address and a section name cannot carry a session.
 *
 * It answers in two independent ways, which is the point of doing both here:
 *
 *   1. THE BYTES, to disassemble. That names what the loop DOES, which is what the
 *      investigation actually wants and is arguably better than a function name.
 *   2. THE PDB IDENTITY (`guid` + `age` + name), which is the symbol-server key for this exact
 *      build. It costs one extra positioned read and it is the thing a later session WITH
 *      egress needs; deriving it now means the answer does not wait on the proxy twice.
 *
 * ── THE LAYOUT, SO THE OFFSETS BELOW ARE CHECKABLE ────────────────────────────────────────
 *
 * DOS header  : `e_lfanew` (DWORD) at 0x3C points at "PE\0\0".
 * COFF header : 20 bytes after the signature — Machine, NumberOfSections, TimeDateStamp,
 *               PointerToSymbolTable, NumberOfSymbols, SizeOfOptionalHeader, Characteristics.
 * Optional hdr: PE32+ (`magic` 0x20B) has NO BaseOfData, so its data directories sit at
 *               optional-header offset 112. PE32 (0x10B) puts them at 96. Getting that wrong
 *               reads the wrong directory and yields a plausible, useless answer — hence the
 *               magic is checked and an unexpected value REFUSES rather than assuming 64-bit.
 * Sections    : 40 bytes each — Name(8), VirtualSize, VirtualAddress, SizeOfRawData,
 *               PointerToRawData, ...
 *
 * RVA -> file offset is `rva - VirtualAddress + PointerToRawData` within the containing
 * section. There is no global formula: sections are aligned differently in the file and in
 * memory, so a "subtract the headers" shortcut is wrong by kilobytes.
 */

import fs from 'node:fs';

/** IMAGE_DEBUG_TYPE_CODEVIEW — the entry carrying the PDB GUID. */
const DEBUG_TYPE_CODEVIEW = 2;

/**
 * @param {Buffer} head the first bytes of the file — must cover the section table
 *   (headers are `SizeOfHeaders` bytes, conventionally 0x400-0x1000; 64 KB is generous).
 */
export function parsePeHeaders(head) {
  if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ)');
  const peOff = head.readUInt32LE(0x3c);
  if (peOff + 24 > head.length || head.readUInt32LE(peOff) !== 0x00004550) {
    throw new Error('not a PE file (no PE signature)');
  }
  const coff = peOff + 4;
  const numberOfSections = head.readUInt16LE(coff + 2);
  const timeDateStamp = head.readUInt32LE(coff + 4);
  const sizeOfOptional = head.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = head.readUInt16LE(opt);

  // REFUSE rather than assume. A wrong data-directory offset does not fail loudly — it reads
  // some other structure and returns something shaped like an answer.
  if (magic !== 0x20b) throw new Error(`expected PE32+ (0x20b), got 0x${magic.toString(16)}`);

  const sizeOfImage = head.readUInt32LE(opt + 56);
  const numberOfRvaAndSizes = head.readUInt32LE(opt + 108);
  const dataDirs = opt + 112;

  const sections = [];
  const secTable = opt + sizeOfOptional;
  for (let i = 0; i < numberOfSections; i++) {
    const s = secTable + i * 40;
    if (s + 40 > head.length) throw new Error('section table runs past the bytes provided');
    sections.push({
      name: head.subarray(s, s + 8).toString('latin1').replace(/\0+$/, ''),
      vsize: head.readUInt32LE(s + 8),
      va: head.readUInt32LE(s + 12),
      rawSize: head.readUInt32LE(s + 16),
      rawPtr: head.readUInt32LE(s + 20),
    });
  }

  const debugDir = numberOfRvaAndSizes > 6
    ? { rva: head.readUInt32LE(dataDirs + 6 * 8), size: head.readUInt32LE(dataDirs + 6 * 8 + 4) }
    : { rva: 0, size: 0 };

  return { timeDateStamp, sizeOfImage, sections, debugDir };
}

/**
 * @returns {{offset:number, section:string}} where in the FILE the given RVA's bytes live.
 *
 * A section may be larger in memory than on disk (`.bss`-style tails are zero-filled by the
 * loader and not stored), so an RVA inside `vsize` but past `rawSize` has no bytes to read.
 * Returning the next section's data for it would be silently wrong, so it refuses.
 */
export function rvaToFileOffset(pe, rva) {
  for (const s of pe.sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
      const delta = rva - s.va;
      if (delta >= s.rawSize) {
        throw new Error(`RVA 0x${rva.toString(16)} is in ${s.name} but past its raw data (uninitialised)`);
      }
      return { offset: s.rawPtr + delta, section: s.name };
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is in no section of this image`);
}

/**
 * The CodeView (RSDS) record: `"RSDS"`, a 16-byte GUID, a 4-byte age, then a NUL-terminated
 * PDB path.
 *
 * THE GUID IS MIXED-ENDIAN AND THAT IS NOT A DETAIL. The first three fields are little-endian
 * integers and the last eight bytes are raw, so a straight hex dump of the sixteen bytes
 * produces a key that looks right and matches nothing on a symbol server. The age is appended
 * in hex WITHOUT zero padding — `...E1` for age 1, not `...E01`.
 */
export function parseCodeView(buf) {
  if (buf.length < 24 || buf.subarray(0, 4).toString('latin1') !== 'RSDS') return null;
  const d1 = buf.readUInt32LE(4);
  const d2 = buf.readUInt16LE(8);
  const d3 = buf.readUInt16LE(10);
  const rest = buf.subarray(12, 20).toString('hex').toUpperCase();
  const age = buf.readUInt32LE(20);
  const end = buf.indexOf(0, 24);
  const name = buf.subarray(24, end === -1 ? buf.length : end).toString('latin1');
  const guid =
    d1.toString(16).toUpperCase().padStart(8, '0') +
    d2.toString(16).toUpperCase().padStart(4, '0') +
    d3.toString(16).toUpperCase().padStart(4, '0') +
    rest;
  return { guid, age, name, key: `${guid}${age.toString(16).toUpperCase()}` };
}

/**
 * Read a window of code around an RVA, plus the build identity, from a PE on disk.
 *
 * SEPARATE FROM THE COMMAND ON PURPOSE. The `code-bytes` handler derives `chrome.dll` from
 * Playwright's own resolved browser directory and passes it in — that derivation is the
 * SAFETY property (a caller-supplied path would be an arbitrary file read on the box holding
 * the RC session), and this is the part that can be wrong about arithmetic. Splitting them
 * means the arithmetic gets a test against a real file without the command growing a path
 * parameter to make it testable, which would trade the property for the test.
 *
 * Positioned reads, never a whole-file load: `chrome.dll` is ~200 MB and the process calling
 * this is the one that carts campsites.
 */
export function readCodeWindow(dllPath, rva, { before = 64, window = 320 } = {}) {
  const fd = fs.openSync(dllPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const head = Buffer.alloc(Math.min(0x10000, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const pe = parsePeHeaders(head);

    const startRva = Math.max(0, rva - before);
    const { offset, section } = rvaToFileOffset(pe, startRva);
    const bytes = Buffer.alloc(Math.max(0, Math.min(window, size - offset)));
    if (bytes.length) fs.readSync(fd, bytes, 0, bytes.length, offset);

    let pdb = null;
    if (pe.debugDir.rva) {
      // THE IDENTITY IS A BONUS AND MUST NEVER COST THE BYTES. A malformed or absent debug
      // directory is common enough (stripped builds), and throwing here would lose the one
      // reading that is actually the point.
      try {
        const d = rvaToFileOffset(pe, pe.debugDir.rva);
        const dir = Buffer.alloc(Math.min(pe.debugDir.size, 28 * 16));
        fs.readSync(fd, dir, 0, dir.length, d.offset);
        for (let i = 0; i + 28 <= dir.length; i += 28) {
          if (dir.readUInt32LE(i + 12) !== DEBUG_TYPE_CODEVIEW) continue;
          const cvSize = Math.min(dir.readUInt32LE(i + 16), 1024);
          // PointerToRawData is already a FILE offset — mapping it through rvaToFileOffset
          // again would land somewhere plausible and wrong.
          const cvPtr = dir.readUInt32LE(i + 24);
          const cv = Buffer.alloc(cvSize);
          fs.readSync(fd, cv, 0, cvSize, cvPtr);
          pdb = parseCodeView(cv);
          break;
        }
      } catch { pdb = null; }
    }
    return { pe, pdb, startRva, offset, section, bytes, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Render a reading as the fixed-width dump the command returns. */
export function formatCodeWindow(dllPath, rva, r) {
  const lines = [
    `file       ${dllPath}`,
    `size       ${r.size} bytes   timeDateStamp 0x${r.pe.timeDateStamp.toString(16)}   sizeOfImage 0x${r.pe.sizeOfImage.toString(16)}`,
    // TimeDateStamp + SizeOfImage is the symbol-server key for the BINARY; GUID + age is the
    // key for the PDB. Different keys, and a later session needs whichever one is published.
    `binary key ${r.pe.timeDateStamp.toString(16).toUpperCase().padStart(8, '0')}${r.pe.sizeOfImage.toString(16)}`,
    r.pdb ? `pdb        ${r.pdb.name}  key ${r.pdb.key}` : 'pdb        (no CodeView record found)',
    `asked      RVA 0x${rva.toString(16)}   window starts 0x${r.startRva.toString(16)} in ${r.section} at file offset 0x${r.offset.toString(16)}`,
    '',
  ];
  for (let i = 0; i < r.bytes.length; i += 16) {
    const row = r.bytes.subarray(i, i + 16);
    lines.push(`${(r.startRva + i).toString(16).padStart(8, '0')}  ${row.toString('hex').replace(/(..)/g, '$1 ').trim()}`);
  }
  return lines.join('\n');
}
