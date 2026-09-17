/*
 * THE WEDGE CURE, END TO END, ON ONE PAGE IN ONE RUN.
 *
 *   node scripts/cure-end-to-end.mjs
 *
 * The cure's production case has never occurred, so the transfer argument is what carries it —
 * and until this script that argument had three legs measured on three different pages:
 *
 *   - `scripts/leak-repro.mjs` proved a wedged page maps 2 MiB shared regions and gives them
 *     back on `page.close`.
 *   - `scripts/cdp-thread-probe.mjs` proved a wedged page answers `Performance.getMetrics` and
 *     NOT `Runtime.evaluate` — which is production's own signature, corroborated on Windows/149
 *     by `alloc trail [resident]: EMPTY — that renderer answered no CDP call at all` over a
 *     whole 165-second browser life while the heap trail kept sampling.
 *   - ~2,400 healthy probes on the box, zero false positives.
 *
 * The first two use the SAME wedge construction and the joint claim followed "by construction",
 * which is the reasoning this repo has been burned by more than once. So: one page, one run,
 * all three facts — the CDP signature, the mappings, and the release — plus the control arm
 * that matters most.
 *
 * IT REFUSES A VERDICT IT HAS NOT EARNED, four ways, and the first is the one that caught a real
 * defect in this script's own first version:
 *   - the HEALTHY page must accrue NO strike. `probeResidentPage` takes a NUMBER; the first
 *     version passed `{ timeoutMs: 2000 }`, which coerced to ~0, so every probe timed out
 *     instantly and read `wedged` — on a healthy page too. The run "passed" and proved nothing
 *     about the detector. A probe nobody has seen REFUSE is a probe that proves nothing.
 *   - the page must really be wedged (`evaluate` silent), or it was never in the state.
 *   - the cure's own decision must reach `recycle` through the SHIPPED exports.
 *   - the mapping count must CLIMB, or releasing it says nothing.
 *
 * THE MAPPINGS ARE COUNTED FROM OUTSIDE THE PROCESS, through `/proc/<pid>/maps` — never CDP.
 * That is the one property every instrument that went silent on this leak lacked, and it is why
 * the count survives the wedge it is measuring.
 *
 * PLATFORM, STATED BECAUSE IT IS THE RECORDED TRAP: this is Chromium 141 on Linux, where the
 * regions are memfd-backed; the box runs 149 on Windows, where they are pagefile-backed
 * sections. What transfers is the MECHANISM — `kTotalMappedSizeLimit` and
 * `kLargerDataPipeAllocationSize` are both cross-platform, and which PROCESS services a CDP
 * domain is architectural. Do not quote a byte count from here as a production figure.
 *
 * IT LIVES IN `scripts/`, NOT `scripts/auto-cart-bot/`, and that is deliberate:
 * `CH_BOT_CODE_AT` is `git log -1 -- scripts/auto-cart-bot`, so a file there makes
 * `autocart.bot_version` report the box as missing bot-side code — and the honest response to
 * that warn is a box update, which ends the RC session.
 */
import { chromium } from 'playwright-core';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { probeResidentPage, wedgeDecision, WEDGE_STRIKES } from './auto-cart-bot/page-wedge.mjs';

const TWO_MIB = 2 * 1024 * 1024;
const PROBE_MS = Number(process.env.CURE_PROBE_MS ?? 2000);
const WEDGE_SECS = Number(process.env.CURE_WEDGE_SECS ?? 25);

const srv = http.createServer((q, r) => {
  // `/body` is the response that costs a data pipe; everything else is the page itself. Serving
  // octet-stream at `/` makes Playwright treat the navigation as a download and the run dies
  // before it starts.
  if (q.url.startsWith('/body')) { r.writeHead(200, { 'content-type': 'application/octet-stream' }); r.end(Buffer.alloc(4096)); return; }
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end('<!doctype html><meta charset=utf-8><title>cure-end-to-end</title><body>cure-end-to-end');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const renderers = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer'); } catch { return false; }
});
const twoMib = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n').filter((l) => {
      const m = /^([0-9a-f]+)-([0-9a-f]+) (....)/.exec(l);
      if (!m || m[3][3] !== 's') return false;   // 's' = SHARED; a private 2 MiB region is not this
      return parseInt(m[2], 16) - parseInt(m[1], 16) === TWO_MIB;
    }).length;
  } catch { return 0; }
};
const total = () => renderers().reduce((a, p) => a + twoMib(p), 0);
const raced = (p, ms) => Promise.race([
  p.then(() => 'answered', () => 'threw'),
  new Promise((r) => setTimeout(() => r(`SILENT >${ms}ms`), ms)),
]);

const exe = process.env.CURE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const br = await chromium.launch({ headless: true, executablePath: exe });
const ctx = await br.newContext();
const page = await ctx.newPage();
await page.goto(`${base}/`);
const cdp = await ctx.newCDPSession(page);

console.log('--- CONTROL: the same page, before it is wedged ---');
console.log('  Runtime.evaluate       :', await raced(page.evaluate('1'), PROBE_MS));
console.log('  Performance.getMetrics :', await raced(cdp.send('Performance.getMetrics'), 3000));

// THE CONTROL ARM THAT MATTERS: a healthy page must accrue NO strike. A cure that fires on a
// responsive page costs an RC page load every thirty seconds, for ever, and would read in the
// event stream exactly like the cure working.
let ctlStrikes = 0;
const ctlReadings = [];
for (let i = 0; i < WEDGE_STRIKES; i++) {
  const reading = await probeResidentPage(page, PROBE_MS);
  ctlReadings.push(reading);
  ctlStrikes = wedgeDecision({ reading, strikes: ctlStrikes, recycles: 0 }).strikes;
}
console.log(`  probeResidentPage x${WEDGE_STRIKES}   : ${ctlReadings.join(', ')} -> strikes=${ctlStrikes}`);
const before = total();
console.log('  2 MiB shared mappings  :', before);

// The wedge `leak-repro.mjs` uses: a microtask chain that rejects and handles a promise each
// turn, so the queue never empties and the main thread never reaches the task queue — with a
// fetch per turn, because it is the RESPONSE that costs a pipe.
page.evaluate(`(function(){ let n=0; (function spin(){ try{ fetch('${base}/body?'+(n++)).catch(()=>{}); }catch(e){} const p=Promise.reject(new Error('x')); queueMicrotask(()=>{ p.catch(()=>{}); spin(); }); })(); })();`).catch(() => {});
await new Promise((r) => setTimeout(r, WEDGE_SECS * 1000));

console.log(`\n--- WEDGED: the same page, ${WEDGE_SECS}s later ---`);
const ev = await raced(page.evaluate('1'), PROBE_MS);
const pm = await raced(cdp.send('Performance.getMetrics'), 3000);
console.log('  Runtime.evaluate       :', ev);
console.log('  Performance.getMetrics :', pm);

let strikes = 0;
let act = null;
for (let i = 0; i < WEDGE_STRIKES; i++) {
  const reading = await probeResidentPage(page, PROBE_MS);
  const d = wedgeDecision({ reading, strikes, recycles: 0 });
  strikes = d.strikes; act = d.act;
  console.log(`  probe ${i + 1}: ${reading} -> strikes=${strikes} act=${act}`);
}
const peak = total();
console.log('  2 MiB shared mappings  :', peak);

// The SHIPPED close, with the shipped options. `runBeforeUnload: false` is load-bearing: an
// unload handler runs on the thread that is wedged, so asking for one is how the close inherits
// the hang it exists to end.
const t0 = Date.now();
await page.close({ runBeforeUnload: false }).catch(() => {});
let after = total();
let waited = 0;
while (after > 0 && waited < 5000) { await new Promise((r) => setTimeout(r, 100)); waited += 100; after = total(); }
const ms = Date.now() - t0;

console.log('\n--- VERDICT ---');
let ok = false;
if (ctlStrikes !== 0) {
  console.log(`x THE QUESTION WAS NEVER REACHED: the HEALTHY page accrued ${ctlStrikes} strike(s) (${ctlReadings.join(', ')}).`);
  console.log('  The probe is not discriminating, so a wedged reading from it means nothing.');
} else if (ev !== `SILENT >${PROBE_MS}ms`) {
  console.log(`x THE QUESTION WAS NEVER REACHED: the page answered \`evaluate\` (${ev}), so it was never wedged.`);
} else if (act !== 'recycle') {
  console.log(`x THE QUESTION WAS NEVER REACHED: the cure did not reach 'recycle' (act=${act}).`);
} else if (peak <= before) {
  console.log(`x THE QUESTION WAS NEVER REACHED: mappings did not climb (${before} -> ${peak}); releasing nothing proves nothing.`);
} else {
  ok = true;
  console.log('+ ONE PAGE, ALL THREE, WITH ITS CONTROL:');
  console.log(`    healthy  : evaluate answered, probe ${ctlReadings.join('/')}, strikes ${ctlStrikes}, ${before} mappings`);
  console.log(`    wedged   : evaluate ${ev}, getMetrics ${pm}  <- production's signature`);
  console.log(`    the cure : ${WEDGE_STRIKES} strikes -> recycle, ${peak} -> ${after} mappings in ${ms}ms`);
}
await br.close();
srv.close();
process.exit(ok ? 0 : 1);
