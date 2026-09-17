/**
 * WHICH CDP CALLS STILL ANSWER WHEN THE MAIN THREAD IS WEDGED?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * This repo has retired three instruments for being blind to the event they were built for,
 * and the ramp arm's condition A was a fourth: it read "CDP silence" off the heap trail's
 * `Performance.getMetrics`, and on 2026-09-05 a ramp ran to 8,879 MB while the renderer
 * "kept answering `Performance.getMetrics` all the way up" — so the arm never fired and the
 * twelve-minute `HUNG_MS` bail ended the ramp instead. The signal was changed to the loop's
 * own stall. WHY the old one was blind was never established, and it matters twice over:
 *
 *   * it is the one apparent production counter-example to the page-wedge cure firing (if the
 *     renderer really was answering, `probeResidentPage` would have read `alive`), and
 *   * the next CDP-based instrument somebody builds will pick a method, and picking one that
 *     is serviced OFF the main thread makes it structurally unable to see a wedge.
 *
 * ── THE ANSWER, MEASURED 2026-09-17 (Chromium 141, Linux, with a control) ───────────────────
 *
 *     CONTROL: healthy page          WEDGED: main thread in a microtask loop
 *       page.evaluate(1)     answered      page.evaluate(1)       SILENT >2000ms
 *       Performance.getMetrics answered    Performance.getMetrics ANSWERED
 *       Runtime.getHeapUsage answered      Runtime.getHeapUsage   SILENT >3000ms
 *       Memory.getDOMCounters answered     Memory.getDOMCounters  SILENT >3000ms
 *
 * `Performance.getMetrics` DOES NOT NEED THE MAIN THREAD. So the 09-05 reading is not
 * evidence that the main thread was running, and it is NOT a counter-example to the cure —
 * it is an explanation of why the old condition A was blind.
 *
 * AND IT VALIDATES THE CURE'S CHOICE OF PROBE. `page.evaluate` is `Runtime.evaluate`: it runs
 * JavaScript, so it is main-thread-bound by construction and cannot answer through a wedge.
 * Of the four asked here it is the only one that is both main-thread-bound and cheap.
 *
 * ── HOW TO READ A RUN ──────────────────────────────────────────────────────────────────────
 *
 * THE CONTROL IS CHECKED FIRST AND THE PROBE REFUSES A VERDICT WITHOUT IT. A method that is
 * silent on a HEALTHY page tells you nothing about wedges — it tells you the call was wrong,
 * the domain was not enabled, or the build does not have it. `rc-probe.mjs --concurrent-mint`
 * published a race that never raced by skipping exactly this.
 *
 * PLATFORM CAVEAT, STATED BECAUSE IT HAS BURNED THIS REPO TWICE: this is Chromium 141 on
 * Linux and the box runs 149 on Windows. What transfers is the THREADING of a CDP domain,
 * which is architectural; what does not is anything about memory behaviour. Do not read a
 * byte count out of this probe.
 *
 * USAGE:  node scripts/cdp-thread-probe.mjs
 */
import { chromium } from 'playwright-core';

/** A microtask chain that never yields to the task queue — the recorded production shape. */
const WEDGE = `(function(){ (function spin(){ const p = Promise.reject(new Error('x'));
  queueMicrotask(() => { p.catch(() => {}); spin(); }); })(); })();`;

const EVALUATE = 'page.evaluate(1)';
/** Bounded, always. `page.evaluate` has NO timeout, and a probe that can hang is not a probe. */
const BUDGET_MS = 3_000;

async function bounded(run, ms) {
  let timer = null;
  try {
    return await Promise.race([
      run().then(() => 'answered', (e) => `rejected: ${String(e).slice(0, 50)}`),
      new Promise((r) => { timer = setTimeout(() => r(`SILENT >${ms}ms`), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('data:text/html,<h1>cdp-thread-probe</h1>');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable').catch(() => {});

  const methods = [EVALUATE, 'Performance.getMetrics', 'Runtime.getHeapUsage', 'Memory.getDOMCounters'];
  const ask = async () => {
    const out = {};
    await Promise.all(methods.map(async (m) => {
      out[m] = await bounded(
        () => (m === EVALUATE ? page.evaluate('1') : cdp.send(m)),
        m === EVALUATE ? 2_000 : BUDGET_MS,
      );
    }));
    return out;
  };

  const control = await ask();
  console.log('--- CONTROL: healthy page ---');
  for (const m of methods) console.log(`   ${m.padEnd(24)} ${control[m]}`);

  const mute = methods.filter((m) => control[m] !== 'answered');
  if (mute.length) {
    console.log('\nx THE QUESTION WAS NEVER REACHED — these were already silent on a HEALTHY');
    console.log(`  page, so a silence under load would mean nothing: ${mute.join(', ')}.`);
    console.log('  Check the domain is enabled and the method name is right for this build.');
    await browser.close().catch(() => {});
    process.exitCode = 1;
    return;
  }

  page.evaluate(WEDGE).catch(() => {});   // never resolves — that is the point
  await new Promise((r) => setTimeout(r, 1_500));
  const wedged = await ask();
  console.log('\n--- WEDGED: main thread spinning in a microtask loop ---');
  for (const m of methods) console.log(`   ${m.padEnd(24)} ${wedged[m]}`);

  if (wedged[EVALUATE] === 'answered') {
    console.log('\nx THE QUESTION WAS NEVER REACHED — the page answered `evaluate` while it was');
    console.log('  supposed to be wedged, so the wedge did not take and nothing here is a reading.');
    await browser.close().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const survivors = methods.filter((m) => m !== EVALUATE && wedged[m] === 'answered');
  console.log('\n=== VERDICT ===');
  console.log(`  MAIN-THREAD-BOUND (can see a wedge): ${EVALUATE}`
    + methods.filter((m) => m !== EVALUATE && wedged[m] !== 'answered').map((m) => `, ${m}`).join(''));
  console.log(survivors.length
    ? `  SERVICED OFF THE MAIN THREAD (blind to a wedge): ${survivors.join(', ')}\n`
      + '  An instrument built on one of these cannot tell a wedged renderer from a healthy one.'
    : '  Every method asked here needs the main thread — no blind instrument among them.');
  await browser.close().catch(() => {});
}

await main();
