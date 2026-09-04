/**
 * CLOSE A THROWAWAY TAB WITH A DEADLINE, AND SAY HOW LONG IT TOOK.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 * The throwaway-tab cure (PR #142, then the auto-login and the warm-up) ends every Okta trip
 * with `await tab.close().catch(() => {})` in a `finally`. That await is UNBOUNDED. A
 * `page.close()` asks the browser to tear the target down, and the browser asks the renderer
 * to run its unload handlers first — and Playwright launches Chromium with the hang monitor
 * OFF, so a renderer that is not answering is never force-killed on our behalf. A renderer
 * eating the machine at ~450 MB/min is exactly a renderer that may not answer.
 *
 * From the memory series (2026-09-01 → 09-04, eleven ramps): every ramp's renderer is a NEW
 * pid at the onset — the tab's own — and it goes on growing for ten to twelve minutes after
 * the trip's own work should have ended, until the browser is replaced. The series cannot
 * say whether those minutes are the renewal's body timing out step by step or this one await
 * never returning. They look identical from outside and they have different fixes.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────────────────────
 * 1. Bounds the close. Past `TAB_CLOSE_MS` it stops waiting. The tab is then a renderer
 *    nobody owns, so it ALSO asks the resident loop to recycle the browser (`takePendingRecycle`
 *    at the top of the loop, the same place `oktaTrip` is read), which is the one mechanism
 *    ever observed to hand this profile's memory back.
 * 2. Reports both numbers — how long the trip took and how long the close took — as a
 *    `tab-close` bot event, on every close, hung or not. The healthy baseline is the thing
 *    that makes a bad number readable; a report only on failure is `status = 'sent'` again.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────
 * It does not kill the renderer itself. The keep-warm has no per-tab kill that does not go
 * through the same unresponsive browser, and the reopen path already exists and is proven
 * (every one of the twenty-plus recorded ramps ended with it). Asking for it is enough.
 *
 * A pure module for the reason `renewal-schedule.mjs` and `session-coverage.mjs` are:
 * importing `rc-keepwarm.mjs` starts the keep-warm loop, and this decision has a branch that
 * only runs when a browser is not answering.
 */

/**
 * How long a close may take before it is given up on. A healthy close is milliseconds; the
 * renewal's own steps are bounded at 20-45s each, so a close that takes longer than a step
 * is already the anomaly this exists to catch. Not shorter: a busy-but-answering renderer
 * on a slow morning should not be recycled for being slow.
 */
export const TAB_CLOSE_MS = Number(process.env.RC_TAB_CLOSE_MS || 30_000);

/** Set when a close is given up on; the resident loop reads and clears it at its top. */
let pendingRecycle = null;

/**
 * The reason a recycle is owed, or null. CLEARS on read, so one hung close produces one
 * recycle and not one per iteration for the life of the process.
 */
export function takePendingRecycle() {
  const r = pendingRecycle;
  pendingRecycle = null;
  return r;
}

/**
 * @param {{ close: () => Promise<unknown> } | null} tab
 * @param {{
 *   label: 'renewal' | 'auto-login' | 'warmup',
 *   startedAt: number,
 *   ramMb?: number | null,
 *   log?: (line: string) => void,
 *   report?: (kind: string, detail: Record<string, unknown>) => Promise<unknown> | unknown,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<{ closeMs: number, tripMs: number, hung: boolean }>}
 */
export async function closeTabBounded(tab, {
  label, startedAt, ramMb = null, log = () => {}, report = null,
  timeoutMs = TAB_CLOSE_MS, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const t0 = now();
  const tripMs = startedAt ? Math.max(0, t0 - startedAt) : null;
  let hung = false;
  if (tab) {
    // The race, not a Playwright option: `page.close()` has no timeout of its own, and a
    // rejected close is already swallowed — the only failure that matters is the one that
    // never resolves at all.
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), timeoutMs); });
    const outcome = await Promise.race([
      Promise.resolve().then(() => tab.close()).then(() => 'closed', () => 'closed'),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    hung = outcome === 'hung';
  }
  const closeMs = now() - t0;
  if (hung) {
    pendingRecycle = `the ${label} tab would not close within ${Math.round(timeoutMs / 1000)}s`;
    log(`  ✗ ${label} tab did not close in ${Math.round(timeoutMs / 1000)}s — its renderer is not answering; the browser will be recycled`);
  }
  // REPORTED ON EVERY CLOSE, not only the hung ones. See the header: a hung close and a slow
  // trip body are the same shape in the memory series, and the healthy baseline is what makes
  // either number mean anything. Fire-and-forget: a report that fails must not delay the
  // recycle it is describing.
  if (report) {
    try {
      await Promise.resolve(report('tab-close', { label, tripMs, closeMs, hung, ramMb, timeoutMs }))
        .catch((e) => log(`  (could not report the tab close: ${e?.message ?? e})`));
    } catch (e) {
      log(`  (could not report the tab close: ${e?.message ?? e})`);
    }
  }
  // A close that was given up on is still running in the browser. Yield once so a resolved
  // close that was merely slow can settle its own bookkeeping before the caller moves on.
  if (hung) await sleep(0);
  return { closeMs, tripMs, hung };
}
