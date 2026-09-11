// Reproduce the Chromium 2 MiB shared-mapping leak, locally, in seconds.
//
// WHAT IT REPRODUCES.  On the mini-PC an RC renderer maps ~16,383 two-megabyte anonymous
// pagefile-backed shared sections in a burst and never releases them.  CLAUDE.md has the
// full account; the two facts this script rests on are that the ceiling is
// `base::SharedMemorySecurityPolicy::kTotalMappedSizeLimit` (32 GiB, so 16,383 pure-2 MiB
// mappings, the check being `>=`) and that the sections are `base::SharedMemoryMapping`s —
// which is what stopping at exactly that number proves.
//
// THE MECHANISM, and it needs BOTH halves:
//   * `network::URLLoader::ContinueOnResponseStarted` makes a 2 MiB response-body data pipe
//     per response (`kLargerDataPipeAllocationSize`), and
//   * `DataPipe::Deserialize` maps the consumer end ON THE IO THREAD the moment it arrives,
//     while the drain runs as a POSTED TASK on the main thread.
//   So a main thread that never returns to its message loop cannot stop the mapping — only
//   the release.  Wedge it and keep answering requests and the mappings accumulate.
//
// IT READS `/proc/<pid>/maps` FROM OUTSIDE THE PROCESS.  That is the whole point: three CDP
// instruments in a row got silence from a ramping renderer because CDP is serviced on the
// main thread, which is the thread that is wedged.  A /proc read asks the kernel.
//
// PREDICT THE READING BEFORE BUILDING THE INSTRUMENT (this repo's rule): the idle control and
// the pure promise-wedge both read ZERO, and a reproduction reads a count climbing linearly.
// Both controls ARE flat, measured — which is what makes this a controlled comparison rather
// than an observation.  Do not drop them.
//
// NOT `scripts/auto-cart-bot/` DELIBERATELY.  `CH_BOT_CODE_AT` is
// `git log -1 --format=%cI -- scripts/auto-cart-bot`, so a file there makes
// `autocart.bot_version` report the box as "MISSING bot-side changes" — and the honest
// response to that warn is a box update, which ends the RC session.  This probe can never run
// on the box (it drives a local Chromium against a local HTTP server, touches no credential
// and no RC endpoint), so arming that warn would buy a destructive remedy for nothing.
// `worker/rc-mem-dump.test.mts` covers it anyway; the guard takes a path, not a bare name.
//
// USAGE:  node scripts/leak-repro.mjs <candidate> [seconds]
//         node scripts/leak-repro.mjs wedge-and-fetch 30
//
// WATCH THE CONTAINER.  The retained `Response` objects — NOT the mappings, which are never
// touched — are what grows the renderer's heap; a long run will take the box to swap long
// before the 16,383 ceiling is reached.  The ceiling is proved from source and matched against
// six production walks; it has never been observed directly here, and saying otherwise would
// be claiming a reading nobody took.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';

const CAND = process.argv[2] ?? 'control-idle';
const SECS = Number(process.argv[3] ?? 20);

const PAGE = `<!doctype html><meta charset=utf-8><title>leak-repro</title><body>leak-repro`;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/body')) {
    // A small body on purpose: production's sections are UNTOUCHED apart from ~4-5 KB each
    // (73 MB of pagefile against 31.7 GB charged), which is one page per 2 MiB pipe.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(4096));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const CANDIDATES = {
  // ── controls ────────────────────────────────────────────────────────────────────────────
  'control-idle': `void 0;`,
  // The recorded control: an infinite microtask chain that rejects and handles a promise each
  // turn. It wedges the main thread and drives blink::RejectedPromises::HandlerAdded, which is
  // where VMSTACK samples the production spin. On its own it allocates NOTHING.
  'wedge-only': `(function spin(){ const p=Promise.reject(new Error('x')); queueMicrotask(()=>{ p.catch(()=>{}); spin(); }); })();`,
  // Requests with no responses: the pipe is made in ContinueOnResponseStarted, so these cost
  // nothing. This is why the 09-08 event's 69,060 answer-less asks produced no mappings.
  'fetch-fail': `(async()=>{ for(let i=0;i<500000;i++){ try{ await fetch('http://127.0.0.1:1/x'); }catch(e){} } })();`,
  // Fetch and DRAIN: the main thread runs, so every pipe is released.
  'fetch-ok': `(async()=>{ for(let i=0;i<500000;i++){ try{ const r=await fetch('/body?'+i); await r.arrayBuffer(); }catch(e){} } })();`,

  // ── the reproduction ────────────────────────────────────────────────────────────────────
  // Retaining the Response without reading the body holds the pipe, but the main thread still
  // runs, so this only climbs as fast as it can round-trip.
  'fetch-nodrain': `(async()=>{ const keep=[]; for(let i=0;i<500000;i++){ try{ keep.push(await fetch('/body?'+i)); }catch(e){} } })();`,
  // THE PRODUCTION SHAPE. An infinite MICROTASK loop that issues fetches: microtasks run, so
  // fetch() keeps being called and responses keep arriving; posted TASKS never run, so
  // OnReceiveResponse is never dispatched and no pipe is ever drained or closed.
  'wedge-and-fetch': `(function(){ let n=0; (function spin(){ try{ fetch('/body?'+(n++)).catch(()=>{}); }catch(e){} const p=Promise.reject(new Error('x')); queueMicrotask(()=>{ p.catch(()=>{}); spin(); }); })(); })();`,
  'wedge-and-fetch-fast': `(function(){ let n=0; (function spin(){ for(let k=0;k<24;k++){ try{ fetch('/body?'+(n++)).catch(()=>{}); }catch(e){} } const p=Promise.reject(new Error('x')); queueMicrotask(()=>{ p.catch(()=>{}); spin(); }); })(); })();`,
};
if (!CANDIDATES[CAND]) {
  console.error(`unknown candidate ${CAND}\n  ${Object.keys(CANDIDATES).join('\n  ')}`);
  process.exit(2);
}

const TWO_MIB = 2 * 1024 * 1024;

function chromeProcesses() {
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cl = '';
    try { cl = readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (!cl.includes('/chrome')) continue;
    const m = /--type=([a-z-]+)/.exec(cl.replace(/\0/g, ' '));
    out.push([Number(d), m ? m[1] : 'browser']);
  }
  return out;
}

function count2MiBShared(pid) {
  let maps = '';
  try { maps = readFileSync(`/proc/${pid}/maps`, 'utf8'); } catch { return null; }
  let n = 0;
  let otherShared = 0;
  for (const line of maps.split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) (....) /.exec(line);
    if (!m) continue;
    if (m[3][3] !== 's') continue; // shared mappings only
    if (parseInt(m[2], 16) - parseInt(m[1], 16) === TWO_MIB) n++;
    else otherShared++;
  }
  return { n, mb: n * 2, otherShared };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  console.log(`candidate=${CAND}`);

  // Fire and forget: the main thread may never return, so this promise may never settle.
  page.evaluate(CANDIDATES[CAND]).catch(() => {});

  const series = [];
  for (let t = 2; t <= SECS; t += 2) {
    await new Promise((r) => setTimeout(r, 2000));
    const top = Math.max(0, ...chromeProcesses().map(([p]) => count2MiBShared(p)?.n ?? 0));
    series.push(`${t}s:${top}`);
  }
  console.log('  series:', series.join(' '));
  console.log('  per process:');
  let peak = 0;
  for (const [p, ty] of chromeProcesses()) {
    const c = count2MiBShared(p);
    if (!c) continue;
    peak = Math.max(peak, c.n);
    if (c.n > 0 || ty === 'browser' || ty === 'utility') {
      console.log(`    pid=${p} type=${ty} 2MiB=${c.n} (${(c.n * 2 / 1024).toFixed(2)} GiB) otherShared=${c.otherShared}`);
    }
  }
  peak = Math.max(peak, ...series.map((s) => Number(s.split(':')[1])));
  // A verdict it has not earned is worse than none: "climbing" is the finding, a handful of
  // in-flight pipes is the healthy state, and zero is a real result for the controls.
  console.log(`  VERDICT: peak 2 MiB shared mappings in any renderer = ${peak}` +
    (peak >= 200 ? '  <<< CLIMBING — reproduces'
      : peak > 0 ? '  (a handful — in-flight pipes, not the shape)'
        : '  FLAT'));
} finally {
  await browser.close().catch(() => {});
  srv.close();
}
process.exit(0);
