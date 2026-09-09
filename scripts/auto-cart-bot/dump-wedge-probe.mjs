/**
 * CAN A WEDGED RENDERER BE READ AT ALL? — the question three instruments died on.
 *
 *   node scripts/auto-cart-bot/dump-wedge-probe.mjs
 *
 * ## Why this exists
 *
 * The committed-region walk names the CLASS of the leak from outside the process: ~16.4k
 * pagefile-backed sections of exactly 2.0 MB, `commit/mapped`, ~32,773 MB, one allocation
 * base each, anonymous, READWRITE, in the ramping renderer. What it cannot name is the
 * CREATOR, and the only party that knows is Chromium — so `rc-mem-dump.mjs` asks it.
 *
 * On 2026-09-08 21:43 PT the ramp dump finally reached the right browser generation: all
 * seven of its pids are in the same scan's own `CHROME` list. The one process missing was
 * pid 7644 — the ramping renderer, the walk's TARGET, 4,366 MB and 17,306 handles. It spent
 * the full 20,000 ms budget in silence against a 194 ms baseline on the healthy replacement.
 * That is the THIRD instrument to hit this on a THIRD different CDP call: `newCDPSession`
 * (2026-08-18), `Performance.getMetrics` (08-18 and 08-19), `Tracing.requestMemoryDump` now.
 *
 * Two fixes suggest themselves and both were already costed: firing earlier buys almost no
 * window (at 21:40:54 the browser did not exist; by 21:42:54 its renderer held 2,297 MB with
 * the ~35 GB commit step already complete), and raising the timeout was closed on 08-18 —
 * "the reading cannot be taken at the trip at all, and no timeout worth spending changes it".
 * What had never been tried is asking for LESS: `Tracing.requestMemoryDump` takes a
 * `levelOfDetail`, and `background` and `light` skip most of the dump providers that a
 * `detailed` dump has to run on the renderer's main thread.
 *
 * This probe answers that off-box, in seconds, against a real Chromium — instead of spending
 * a ramp (they arrive every 5-28 hours) on the guess.
 *
 * ## The answer, and it is a mechanism rather than a shrug
 *
 * Chromium's memory-infra coordinator has its OWN timeout — measured at ~15,050 ms, the same
 * at all three levels. When a child does not answer within it the coordinator gives up,
 * returns `success: false`, and emits a process dump for that child ANYWAY: one event
 * carrying **zero allocator dumps**. No roots, no `shared_memory`, nothing. Its healthy peers
 * contribute normally in the same trace.
 *
 * So the wedged renderer is not missing from the dump — it is PRESENT AND EMPTY, and our fold
 * drops a process with no dumps, which is why it reads as absent. That makes the two obvious
 * fixes provably worthless rather than merely costed: a longer timeout buys an empty dump 5 s
 * sooner, and a cheaper level buys the same empty dump. There is no allocator data to be had
 * from a renderer that never emitted any.
 *
 * READ THAT AS THE REASON, NOT AS "IT TIMED OUT". Three earlier runs of this probe said "no
 * level answers" and one said "background works", and all four were artifacts — the first
 * three because a previous arm had left tracing started so nothing ever asked, the fourth
 * because a timed-out `detailed` arm's late data arrived during the `background` arm and was
 * counted as its own. Both are why the arms now run one per browser and why `startFailed` and
 * the allocator COUNT exist.
 *
 * ## What it does
 *
 * A CONTROL first: a healthy `detailed` dump that must name the renderer. Without it a
 * failure below proves nothing — it would just as easily mean this Chromium cannot trace at
 * all, which is the false elimination every probe in this directory is built to refuse.
 * Then it wedges the renderer's main thread with a busy loop and asks at all three levels.
 *
 * A busy main thread is the production shape as far as anything can tell: the keep-warm's own
 * bail reports `Stalled in: reporting session health`, which drives the resident page, and the
 * alloc trail reports `[resident]: EMPTY — that renderer answered no CDP call at all` for a
 * whole browser life. What this probe cannot claim is that the production wedge has the same
 * CAUSE as a `while(true)`; what it establishes is that a renderer whose main thread does not
 * return to its message loop cannot be read by any dump level, which is the property the
 * instrument depends on.
 *
 * ## It also exercises the tracing-stuck recovery
 *
 * A dump that times out leaves tracing neither started nor stopped, and the NEXT
 * `Tracing.start` is refused — observed on the mini-PC as `Tracing was stopped before start
 * has been completed` (2026-09-09 11:29:54, which cost that ramp its dump) and reproduced
 * here as `Tracing has already been started`. The ramp dump is by construction the second
 * dump of a browser life and by construction follows a browser that is not answering, so this
 * is the case rather than an edge case. The last arm takes two dumps back to back against the
 * wedged renderer and fails if the second one dies of the first one's leftovers.
 *
 * IT RUNS IN THE DEV SANDBOX, NOT ON THE MINI-PC, which is why it imports `playwright-core`
 * where the production modules import `playwright` — the same deliberate exception
 * `alloc-trail-probe.mjs` and `mem-dump-probe.mjs` document. Do not "fix" that import.
 */
import { chromium } from 'playwright-core';
import { takeMemoryDump, stopTracing, TRACING_STUCK } from './rc-mem-dump.mjs';

const EXECUTABLE = process.env.MEM_DUMP_PROBE_CHROMIUM || undefined;
const LEVELS = ['detailed', 'background', 'light'];
/**
 * MUST EXCEED CHROMIUM'S OWN COORDINATOR TIMEOUT (~15,050 ms, measured). Below it every arm
 * times out before the coordinator gives up, so nothing is learned about what the renderer
 * would have contributed — the arm reads "no answer" for the probe's own impatience.
 */
const ARM_TIMEOUT_MS = 25_000;

/**
 * A raw dump at one level. `takeMemoryDump` hardcodes `detailed` on purpose — that is the only
 * level that carries the ownership graph, which is the whole point on the box — so the level
 * sweep is done here rather than by widening the production module for a question it has now
 * answered.
 */
async function dumpAt(cdp, level, timeoutMs) {
  // PRESENCE IS NOT AN ANSWER. A child the coordinator gave up on still emits one event with
  // no allocator dumps in it, so counting events would score a wedged renderer as answering.
  // The allocator COUNT is the reading.
  const pids = new Map();
  const onData = ({ value }) => {
    for (const e of value || []) {
      if (e.name !== 'periodic_interval' || !e.pid) continue;
      const n = Object.keys(e.args?.dumps?.allocators || {}).length;
      pids.set(e.pid, (pids.get(e.pid) ?? 0) + n);
    }
  };
  cdp.on('Tracing.dataCollected', onData);
  const t0 = Date.now();
  let why = null;
  // A LEVEL THAT NEVER GOT TO ASK IS NOT A LEVEL THAT WAS REFUSED. An earlier arm can leave
  // tracing started, and then every level here fails at `Tracing.start` in two milliseconds
  // and the sweep reports "no level answers" having asked nothing — a verdict that inspects
  // nothing while reading as proof. Caught by this probe failing that way on its own first
  // run; the flag is what makes the sweep refuse instead.
  let startFailed = false;
  try {
    const work = (async () => {
      const complete = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.start', {
        traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'] },
        transferMode: 'ReportEvents',
      });
      const res = await cdp.send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: level });
      await cdp.send('Tracing.end');
      await complete;
      return res;
    })();
    const raced = await Promise.race([work, new Promise((r) => setTimeout(() => r({ __t: true }), timeoutMs))]);
    if (raced?.__t) why = `no answer in ${timeoutMs}ms`;
    else if (raced?.success === false) why = 'Chromium refused the dump (success: false)';
  } catch (e) {
    why = `${e?.message ?? e}`.split('\n')[0];
    startFailed = /Tracing\.start/.test(why);
  } finally {
    cdp.off('Tracing.dataCollected', onData);
    await stopTracing(cdp, 3000);
  }
  return { ms: Date.now() - t0, why, pids, startFailed };
}

const browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
let verdict = 1;
try {
  const page = await browser.newPage();
  await page.goto('data:text/html,<h1>wedge probe</h1>');
  // Give the renderer something to report so a zero reading cannot be "nothing was allocated".
  await page.evaluate(() => { globalThis.keep = []; for (let i = 0; i < 20; i++) globalThis.keep.push(new ArrayBuffer(1 << 20)); });
  const cdp = await browser.newBrowserCDPSession();

  // ── THE CONTROL ────────────────────────────────────────────────────────────────────────
  const healthy = await takeMemoryDump(cdp, { timeoutMs: ARM_TIMEOUT_MS });
  const procs = healthy.ok ? healthy.folded.processes : [];
  const renderer = procs.find((p) => p.mainThread === 'CrRendererMain');
  console.log(`control: ok=${healthy.ok} ms=${healthy.ms} processes=${procs.length} rendererPid=${renderer?.pid ?? 'none'}`);
  if (!healthy.ok || !renderer) {
    console.log('x THE QUESTION WAS NEVER REACHED — a HEALTHY dump did not name a renderer, so');
    console.log('  a failure under the wedge below would say nothing about wedging. Either this');
    console.log('  Chromium cannot trace or the fold is wrong; those need opposite fixes.');
    process.exit(1);
  }

  // ── THE WEDGE ──────────────────────────────────────────────────────────────────────────
  page.evaluate(() => { const t = Date.now(); while (Date.now() - t < 600_000) { /* wedge */ } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const still = await Promise.race([
    page.evaluate(() => 1).then(() => 'ANSWERED').catch(() => 'threw'),
    new Promise((r) => setTimeout(() => r('SILENT'), 3000)),
  ]);
  console.log(`wedged renderer pid=${renderer.pid}: page.evaluate -> ${still}`);
  if (still === 'ANSWERED') {
    console.log('x THE QUESTION WAS NEVER REACHED — the renderer is still answering, so it is');
    console.log('  not wedged and nothing below is a reading about a wedged renderer.');
    process.exit(1);
  }

  const answered = [];
  const neverAsked = [];
  await stopTracing(cdp, 3000);
  for (const level of LEVELS) {
    const d = await dumpAt(cdp, level, ARM_TIMEOUT_MS);
    const allocs = d.pids.get(renderer.pid) ?? null;
    const got = (allocs ?? 0) > 0;
    const peers = [...d.pids.entries()].filter(([pid, n]) => pid !== renderer.pid && n > 0).length;
    console.log(`  ${level.padEnd(10)} ms=${String(d.ms).padStart(6)} why=${d.why ?? 'ok'} peersWithData=${peers} wedgedRenderer=${allocs === null ? 'absent' : `${allocs} allocator dump(s)`}`);
    if (got) answered.push(level);
    if (d.startFailed) neverAsked.push(level);
  }

  // ── THE RECOVERY, ON ITS OWN BROWSER ───────────────────────────────────────────────────
  // A SECOND BROWSER, because tracing state is per-browser and this arm deliberately wrecks
  // it: whatever it leaves behind must not reach the sweep above, which is the arm that
  // matters. (The first version shared one browser and its leftovers made all three levels
  // fail at `Tracing.start` — the sweep then reported "no level answers" having asked
  // nothing. That is why `startFailed` exists.)
  //
  // AND IT ABANDONS THE WAY PRODUCTION DOES. A 1 ms budget cuts `Tracing.start` itself and
  // leaves a limbo that end/start cannot clear — more pathological than anything the box
  // produces, where the budget is 20 s and the start completed long before. A healthy dump
  // costs 130-350 ms, so half of that abandons the DUMP with tracing properly started, which
  // is the real shape.
  const b2 = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
  let recoveryHeld = false;
  let recoveryRan = false;
  try {
    const p2 = await b2.newPage();
    await p2.goto('data:text/html,<h1>recovery</h1>');
    const c2 = await b2.newBrowserCDPSession();
    const abandoned = await takeMemoryDump(c2, { timeoutMs: Math.max(40, Math.round(healthy.ms / 2)) });
    const after = await takeMemoryDump(c2, { timeoutMs: ARM_TIMEOUT_MS });
    recoveryRan = after.recovered === true;
    const stuckAgain = !after.ok && TRACING_STUCK.test(String(after.why ?? ''));
    // Chromium legitimately refuses a dump overlapping one still in flight (`success: false`);
    // that is not leftover state, so let the in-flight one drain and ask once more.
    await new Promise((r) => setTimeout(r, 1500));
    const settled = after.ok ? after : await takeMemoryDump(c2, { timeoutMs: ARM_TIMEOUT_MS });
    recoveryHeld = !stuckAgain && settled.ok === true;
    console.log(`recovery: abandoned=${abandoned.why ?? 'ok (nothing to recover from)'} | next ok=${after.ok} recovered=${recoveryRan} | settled ok=${settled.ok} why=${settled.why ?? '-'}`);
  } finally {
    await b2.close().catch(() => {});
  }

  if (neverAsked.length > 0 && answered.length === 0) {
    console.log(`\nx THE QUESTION WAS NEVER REACHED at level(s): ${neverAsked.join(', ')} — the dump`);
    console.log('  never started, so nothing here is evidence about a wedged renderer. Read the');
    console.log('  `why` above: a Tracing.start failure is leftover state, not a refusal.');
  } else if (answered.length > 0) {
    console.log(`\n+ A WEDGED RENDERER CAN BE READ at level(s): ${answered.join(', ')}.`);
    console.log('  That reopens the ramp dump — wire the level that answered into takeMemoryDump.');
    verdict = 0;
  } else if (recoveryRan && !recoveryHeld) {
    console.log('\nx THE TRACING-STUCK RECOVERY DID NOT HOLD — a dump on a HEALTHY browser still');
    console.log('  died of the previous attempt\'s leftovers. That is');
    console.log('  the 2026-09-09 11:29:54 failure, which cost that ramp its dump.');
  } else {
    console.log('\n+ CONFIRMED, WITH THE MECHANISM: a wedged renderer contributes ZERO allocator');
    console.log('  dumps at every level. Chromium\'s coordinator gives up on it (~15 s) and emits');
    console.log('  an EMPTY process dump; its healthy peers contribute normally in the same trace.');
    console.log('  So a longer timeout buys an empty dump sooner and a cheaper level buys the same');
    console.log('  empty dump — there is no allocator data to be had. Chromium cannot be asked who');
    console.log('  owns the 32 GB once the renderer stops answering.');
    console.log('  The reading has to come from OUTSIDE the process — see ramp-scan.mjs VMTHREAD.');
    console.log(`  Tracing-stuck recovery: ${recoveryRan ? 'exercised and held' : 'not exercised in this run'}.`);
    verdict = 0;
  }
} finally {
  await browser.close().catch(() => {});
}
process.exit(verdict);
