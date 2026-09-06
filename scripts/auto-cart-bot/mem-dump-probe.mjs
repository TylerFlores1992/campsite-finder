/**
 * DOES A MEMORY-INFRA DUMP NAME THE OWNER OF A SHARED-MEMORY MAPPING?
 *
 * `rc-mem-dump.mjs` exists to answer the one question the committed-region walk left open:
 * the ramping renderer holds 16,387 pagefile-backed sections of ~2 MB, and nothing on the
 * Windows side can say what created them. The dump asks Chromium instead. This probe is the
 * check that the asking works — run against a real browser, before the module was trusted.
 *
 *   node scripts/auto-cart-bot/mem-dump-probe.mjs
 *
 * IT RUNS IN THE DEV SANDBOX, NOT ON THE MINI-PC, which is why it imports `playwright-core`
 * where every sibling imports `playwright` — the same deliberate exception `alloc-trail-probe`
 * documents. `MEM_DUMP_PROBE_CHROMIUM` overrides the binary.
 *
 * ## What it does, and why a control matters here too
 *
 * It uploads thirty 1024x1024 WebGL textures, which forces real GPU transfer traffic through
 * `base` shared memory, then takes the dump through the REAL `takeMemoryDump` and prints what
 * the REAL aggregation made of it. A pass is not "the dump returned" — it is "a shared-memory
 * mapping was attributed to a named owner". Those are different, and the second is the only
 * one that would have caught an ownership-graph misread.
 *
 * ## It cannot tell you the leak's answer, and must not be read as if it could
 *
 * This is Linux. The box is Windows, and WHETHER THE 2 MB SECTIONS GO THROUGH
 * `base::SharedMemoryMapping` AT ALL is exactly what is unknown — see the module header. What
 * a green run here establishes is that the instrument reads a real trace correctly, which is
 * the failure mode a fixture cannot rule out. The native sampler passed its dev-container
 * validation and turned out to emit no symbols at all on Windows; do not repeat the reading
 * error, only the discipline.
 */
import { chromium } from 'playwright-core';
import { takeMemoryDump, renderMemDump, summariseMemDump } from './rc-mem-dump.mjs';

const EXECUTABLE = process.env.MEM_DUMP_PROBE_CHROMIUM || undefined;

const browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
let verdict = 1;
try {
  const page = await browser.newPage();
  await page.goto('data:text/html,<canvas id=c width=1600 height=1200></canvas>');
  const gl = await page.evaluate(() => {
    const ctx = document.getElementById('c').getContext('webgl2');
    if (!ctx) return false;
    globalThis.keep = [];
    for (let i = 0; i < 30; i++) {
      const t = ctx.createTexture();
      ctx.bindTexture(ctx.TEXTURE_2D, t);
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 1024, 1024, 0, ctx.RGBA, ctx.UNSIGNED_BYTE,
        new Uint8Array(1024 * 1024 * 4));
      globalThis.keep.push(t);
    }
    ctx.finish();
    return true;
  });
  if (!gl) console.log('! no WebGL2 in this Chromium — the GPU arm of this probe proves nothing.');

  const cdp = await browser.newBrowserCDPSession();
  const r = await takeMemoryDump(cdp);
  console.log(`takeMemoryDump -> ok=${r.ok} ms=${r.ms}${r.why ? ` why=${r.why}` : ''}${r.partial ? ` partial=${r.partial}` : ''}`);
  if (!r.ok) {
    console.log('x THE QUESTION WAS NEVER REACHED — the dump did not run, so nothing here is');
    console.log('  evidence about the aggregation. Read the reason above first.');
  } else {
    console.log(`\n${renderMemDump(r.folded)}\n`);
    console.log('summary:', JSON.stringify(summariseMemDump(r.folded, 'probe'), null, 2));

    const named = r.folded.processes.flatMap((p) => p.owners)
      .filter((o) => o.owner !== '(owner in another process)' && o.bytes > 0);
    const anyShm = r.folded.processes.some((p) => p.shmCount > 0);
    const anyRoots = r.folded.processes.some((p) => p.roots.length > 0);
    if (!anyRoots) {
      console.log('x THE QUESTION WAS NEVER REACHED — no allocator dumps at all. Either the');
      console.log('  memory-infra category is unavailable in this build or the fold is wrong;');
      console.log('  those need opposite fixes, so this refuses a verdict rather than guessing.');
    } else if (!anyShm) {
      console.log('x THE QUESTION WAS NEVER REACHED — allocator dumps arrived but not one');
      console.log('  shared_memory dump among them, so the ownership path was never exercised.');
    } else if (named.length === 0) {
      console.log('x OWNERSHIP RESOLVED NOTHING — shared_memory dumps exist and no edge named an');
      console.log('  owner. On the box that reading would be a real finding; HERE it means the');
      console.log('  edge resolution is broken, because a WebGL upload has a known owner.');
    } else {
      const top = named.sort((a, b) => b.bytes - a.bytes)[0];
      console.log(`+ OWNERSHIP RESOLVES: ${top.owner} owns ${Math.round(top.bytes / 1048576)} MB of shared memory.`);
      console.log('  The instrument reads a real trace. What it says on Windows is still open.');
      verdict = 0;
    }
  }
} finally {
  await browser.close();
}
process.exit(verdict);
