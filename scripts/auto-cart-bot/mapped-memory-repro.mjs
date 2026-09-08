/**
 * DOES GPU MAPPED MEMORY ACCUMULATE IN 2 MB CHUNKS? — the first off-box test of the leak.
 *
 *   node scripts/auto-cart-bot/mapped-memory-repro.mjs
 *
 * ## Why this exists at all
 *
 * Every reading about this leak so far has cost a RAMP: they arrive 5-28 hours apart, each
 * one tests roughly one hypothesis, and four consecutive ramps went on debugging the memory
 * dump's TRIGGER rather than the leak. A hypothesis that can be tested in a container in
 * thirty seconds is worth more than a better instrument on the box.
 *
 * ## The candidate, and why the size is the whole reason to believe it
 *
 * The committed-region walk measured the ramping renderer holding **16,387 regions of
 * exactly 2.0 MB** (32,778 MB / 16,387), `commit/mapped`, one allocation base each, all
 * anonymous, all READWRITE. Chromium's `gpu::SharedMemoryLimits::mapped_memory_chunk_size`
 * is **2,097,152 bytes** — not "about 2 MB", the same number — and `MappedMemoryManager`
 * holds one `gpu::Buffer` (one shared region, one MapViewOfFile) per chunk, in the RENDERER,
 * as pagefile-backed anonymous shared memory. Every column of the walk matches.
 *
 * And its free path is the interesting half: `FreeUnused()` reclaims blocks **whose tokens
 * have passed**. A ramp is by definition a renderer whose loop has stopped advancing, and
 * `max_allocated_bytes` defaults to `kNoLimit`. So "tokens stop advancing while work keeps
 * arriving" predicts chunks accumulating with no ceiling — which is the event.
 *
 * RC's resident page renders a WebGL ArcGIS map, so there is a command buffer under load,
 * and 2026-09-04 established the ramp is in the RESIDENT page's renderer and not the trip's.
 *
 * ## What a pass and a failure each mean — they are NOT symmetric
 *
 * GROWTH IN THE 2-4M BUCKET ATTRIBUTED TO A `gpu/` OWNER SUPPORTS THE CANDIDATE. It does not
 * prove the box's event, because this is Linux with a software rasteriser and the box is
 * Windows with an AMD driver.
 *
 * FLAT IS MUCH WEAKER THAN A REFUTATION, and must not be written up as one. SwiftShader,
 * a different GPU stack and a synthetic load are three reasons the mechanism could be real
 * on the box and absent here. It says "this load did not reproduce it", nothing more.
 *
 * NO `gpu` ALLOCATOR DUMPS AT ALL is neither — the question was never reached, and this
 * refuses a verdict then, like every other probe here.
 *
 * ## It imports playwright-core, like its two siblings, and that is deliberate
 *
 * This runs in the dev sandbox and never on the mini-PC. Do not "fix" the import to match
 * the modules around it; it would stop running in the one place it is useful.
 */
import { chromium } from 'playwright-core';
import { takeMemoryDump, renderMemDump } from './rc-mem-dump.mjs';

const EXECUTABLE = process.env.MAPPED_REPRO_CHROMIUM || undefined;
/** Upload rounds. BOUNDED HARD: the box reaches 32 GB and this must never try to. */
const ROUNDS = Number(process.env.MAPPED_REPRO_ROUNDS || 40);
/** Stop early if the container is clearly filling — a probe that OOMs its own host is useless. */
const STOP_AT_MB = Number(process.env.MAPPED_REPRO_STOP_MB || 1500);

const mb = (b) => Math.round((b || 0) / 1048576);

/** The 2-4M bucket across every process, which is the walk's own bucket. */
function twoToFour(folded) {
  let n = 0; let bytes = 0;
  for (const p of folded.processes) {
    for (const b of p.buckets || []) if (b.bucket === '2-4M') { n += b.n; bytes += b.bytes; }
  }
  return { n, bytes };
}
/** Every owner whose name mentions the GPU, summed. */
function gpuOwners(folded) {
  const out = new Map();
  for (const p of folded.processes) {
    for (const o of p.owners || []) {
      if (!/gpu|mapped/i.test(o.owner)) continue;
      const cur = out.get(o.owner) || { n: 0, bytes: 0 };
      cur.n += o.n; cur.bytes += o.bytes;
      out.set(o.owner, cur);
    }
  }
  return [...out].map(([owner, v]) => ({ owner, ...v })).sort((a, b) => b.bytes - a.bytes);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: EXECUTABLE,
  // The box runs headful with a real GPU; this is the nearest a container gets. Without a
  // GPU process there is no command buffer and the question is not reached at all.
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--enable-webgl'],
});
let verdict = 1;
try {
  const page = await browser.newPage();
  await page.goto('data:text/html,<canvas id=c width=2048 height=2048></canvas>');
  const cdp = await browser.newBrowserCDPSession();

  const ok = await page.evaluate(() => {
    const ctx = document.getElementById('c').getContext('webgl2');
    if (!ctx) return false;
    globalThis.__gl = ctx;
    globalThis.__keep = [];
    return true;
  });
  if (!ok) {
    console.log('x THE QUESTION WAS NEVER REACHED — no WebGL2 in this Chromium, so there is');
    console.log('  no command buffer under load and nothing here is evidence either way.');
    process.exit(1);
  }

  const before = await takeMemoryDump(cdp);
  if (!before.ok) {
    console.log(`x THE QUESTION WAS NEVER REACHED — the baseline dump did not run: ${before.why}`);
    process.exit(1);
  }
  const b0 = twoToFour(before.folded);
  console.log(`baseline: 2-4M bucket ${b0.n} mapping(s) / ${mb(b0.bytes)} MB`);
  for (const o of gpuOwners(before.folded)) console.log(`  baseline owner ${o.owner} — ${mb(o.bytes)} MB across ${o.n}`);

  // HAMMER THE COMMAND BUFFER WITH **SMALL** ALLOCATIONS AND NEVER LET THE TOKEN CATCH UP.
  //
  // THE SIZE OF THE LOAD IS THE WHOLE EXPERIMENT, and the first version got it backwards.
  // Uploading 16 MB textures made `MappedMemoryManager` allocate ONE 16 MB chunk — chunk size
  // is `max(mapped_memory_chunk_size, the request)`, so a big request produces a big chunk and
  // the 2 MB signature never appears. The box's 16,387 regions are all EXACTLY 2.0 MB, i.e.
  // the DEFAULT chunk size, which means many allocations each comfortably under 2 MB. So the
  // load has to be small and numerous, not large.
  //
  // `finish()` is what makes the client wait for the GPU and lets `FreeUnused` reclaim, and
  // `readPixels` would force the same sync — both are omitted deliberately. That is the
  // closest a synthetic load gets to "work keeps arriving while tokens stop advancing", which
  // is what a stalled renderer is.
  let rounds = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const grew = await page.evaluate(() => {
      const ctx = globalThis.__gl;
      for (let k = 0; k < 400; k++) {
        const buf = ctx.createBuffer();
        ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
        // 64 KB — far under the 2 MB default chunk, so each allocation is served from a chunk
        // rather than forcing an outsized one.
        ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array(16 * 1024), ctx.DYNAMIC_DRAW);
        ctx.bufferSubData(ctx.ARRAY_BUFFER, 0, new Float32Array(8 * 1024));
        globalThis.__keep.push(buf);
      }
      ctx.flush();
      return globalThis.__keep.length;
    });
    rounds++;
    if (i % 10 === 9) {
      const mid = await takeMemoryDump(cdp);
      if (mid.ok) {
        const m = twoToFour(mid.folded);
        console.log(`  round ${i + 1}: 2-4M ${m.n} mapping(s) / ${mb(m.bytes)} MB (kept ${grew} objects)`);
        if (m.bytes / 1048576 > STOP_AT_MB) { console.log('  stopping early — the bucket is already large enough to read.'); break; }
      }
    }
  }

  // ── PHASE 2: THE RENDERER BUSY, DUMPED FROM THE BROWSER PROCESS ──────────────────────────
  //
  // Phase 1 lets `page.evaluate` RETURN between rounds, and every return is a chance for the
  // GPU channel to drain and `FreeUnused` to reclaim — so it is not the condition at all. On
  // the box a ramp is a renderer whose main thread never yields back to us for two minutes.
  //
  // This fires an evaluate that does not return and dumps WHILE IT RUNS, over the browser's
  // own CDP session, which is a different process and keeps answering. That is as close as a
  // container gets to the real event. It is bounded in the page, so a hung evaluate cannot
  // outlive the probe.
  console.log('\nphase 2: renderer busy for ~20s, dumping from the browser process...');
  const busy = page.evaluate(() => new Promise((done) => {
    const ctx = globalThis.__gl;
    const until = Date.now() + 20_000;
    (function spin() {
      for (let k = 0; k < 200; k++) {
        const buf = ctx.createBuffer();
        ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
        ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array(16 * 1024), ctx.DYNAMIC_DRAW);
        globalThis.__keep.push(buf);
      }
      ctx.flush();
      if (Date.now() < until) setTimeout(spin, 0); else done(globalThis.__keep.length);
    })();
  })).catch(() => null);
  for (let s = 0; s < 4; s++) {
    await new Promise((r) => setTimeout(r, 5000));
    const d = await takeMemoryDump(cdp);
    if (d.ok) {
      const t = twoToFour(d.folded);
      const g = gpuOwners(d.folded).map((o) => `${o.owner}=${mb(o.bytes)}MB/${o.n}`).join(' ');
      console.log(`  +${(s + 1) * 5}s: 2-4M ${t.n} mapping(s) / ${mb(t.bytes)} MB  ${g || '(no gpu owner)'}`);
    } else {
      console.log(`  +${(s + 1) * 5}s: dump did not run: ${d.why}`);
    }
  }
  await busy;

  const after = await takeMemoryDump(cdp);
  if (!after.ok) {
    console.log(`x THE QUESTION WAS NEVER REACHED — the final dump did not run: ${after.why}`);
    process.exit(1);
  }
  const b1 = twoToFour(after.folded);
  const owners = gpuOwners(after.folded);
  console.log(`\nafter ${rounds} round(s): 2-4M bucket ${b1.n} mapping(s) / ${mb(b1.bytes)} MB`);
  for (const o of owners) console.log(`  owner ${o.owner} — ${mb(o.bytes)} MB across ${o.n}`);
  console.log(`\n${renderMemDump(after.folded)}\n`);

  const anyRoots = after.folded.processes.some((p) => p.roots.length > 0);
  const grewN = b1.n - b0.n;
  if (!anyRoots) {
    console.log('x THE QUESTION WAS NEVER REACHED — no allocator dumps at all.');
  } else if (grewN >= 8) {
    console.log(`+ THE 2-4M BUCKET GREW BY ${grewN} MAPPING(S) UNDER COMMAND-BUFFER LOAD.`);
    console.log('  That is the walk\'s own bucket and the walk\'s own shape. SUPPORTS the');
    console.log('  mapped_memory_chunk_size candidate — it does NOT prove the box\'s event,');
    console.log('  which is Windows with an AMD driver against this software rasteriser.');
    verdict = 0;
  } else {
    console.log(`- FLAT: the 2-4M bucket moved by ${grewN} mapping(s).`);
    console.log('  THIS IS NOT A REFUTATION and must not be written up as one. SwiftShader, a');
    console.log('  different GPU stack and a synthetic load are three reasons the mechanism');
    console.log('  could be real on the box and absent here. It says only that THIS load did');
    console.log('  not reproduce it.');
  }
} finally {
  await browser.close();
}
process.exit(verdict);
