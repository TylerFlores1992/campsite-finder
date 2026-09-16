/**
 * DETECT A WEDGED RESIDENT PAGE, AND RELEASE WHAT IT IS HOLDING.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * The 2 MiB shared-mapping leak is diagnosed (CLAUDE.md → "THE 32 GiB CEILING IS
 * `base::SharedMemorySecurityPolicy`"). It needs BOTH halves at once:
 *
 *   * the renderer's main thread never returns to its message loop — RC's SPA in a
 *     promise-rejection retry storm, which `VMSTACK` sampled inside
 *     `blink::RejectedPromises::HandlerAdded`; and
 *   * responses keep arriving, each getting a 2 MiB mojo data pipe that
 *     `DataPipe::Deserialize` maps ON THE IO THREAD while the drain is a POSTED TASK.
 *
 * So the mapping cannot be stopped by the wedged thread, only the release can — and the
 * mappings climb to Chromium's 32 GiB `kTotalMappedSizeLimit` (16,383 of them, the check
 * being `>=`).
 *
 * EVERY EXISTING ARM READS A SIGNAL THAT CANNOT SEE THIS IN TIME. `RAMP_STALL_MS` is 120 s AND
 * needs `.memory-latest.json`, which another process writes every TWO MINUTES; `HUNG_MS` is
 * twelve. The burst completes in <=34 s, so all of them arrive after the fact. This arm reads
 * the page directly, needs no file, and is instant.
 *
 * ── WHAT WAS MEASURED, NOT REASONED (2026-09-16, `scripts/leak-repro.mjs` + a probe) ───────
 *
 *     ACTION=close mainThread=WEDGED before=1052 after=0 took=86ms
 *
 * On a page whose main thread would not answer a 2 s evaluate, `page.close()` released 1,052
 * mappings — 2.06 GiB — in EIGHTY-SIX MILLISECONDS. Three readings come out of that run and
 * each one decides something here:
 *
 *   1. THE PROBE IS A WORKING DETECTOR. The bounded evaluate reported WEDGED on the wedged
 *      page and answers in sub-millisecond time on a healthy one, so it separates the two.
 *   2. CLOSING IS THE LEVER. 1052 -> 0. The mappings belong to the document; destroy it and
 *      the kernel takes them back, main thread or no main thread.
 *   3. RELOAD IS **NOT** THE LEVER, and this is why the cure closes rather than navigates.
 *      `page.reload({ timeout: 8000 })` on the same wedged page HUNG PAST ITS OWN TIMEOUT and
 *      had to be killed at 70 s: a navigation needs the renderer to commit, and a wedged
 *      renderer cannot. A close does not ask it for anything.
 *
 * A FOURTH READING FROM THE SAME RUN, AND IT BEARS ON THE DIAGNOSIS RATHER THAN ON THIS FIX:
 * `page.on('request')` and `ctx.on('request')` both saw ZERO of the wedged page's fetches
 * while it was demonstrably making hundreds. Playwright's request events route through the
 * page's own target, so the request counter is blind for exactly the reason every CDP
 * instrument was. That is the likeliest explanation of the "quiet ramps" the burst/leak
 * decoupling rests on — a ramp with a flat counter may simply be a ramp whose requests the
 * counter could not see. STATED AS A CANDIDATE: it is measured here, in this container, on a
 * synthetic wedge, and nobody has confirmed it against a production ramp.
 *
 * ── WHY THE ACTION IS CHEAP, AND WHY THAT IS THE WHOLE DESIGN ───────────────────────────────
 *
 * The existing arms are expensive — `reportAndBail` exits the process, which costs the RC
 * session (~11 minutes of measured recovery) and needs `supervise.ps1` to restart it. An
 * expensive action MUST be conservative, which is why it waits two minutes.
 *
 * Closing one page is cheap, so it can be aggressive. And the thing being destroyed is
 * ALREADY DEAD: a wedged resident page answers no CDP, so `checkAndReport` cannot read it,
 * `readLiveToken` cannot reach `window.__camphawkRcToken`, and the session probe cannot run.
 * There is no working state to lose. That asymmetry is the argument for acting in ~30 s here
 * where the bail properly waits for 120.
 *
 * IT ALSO UNSTICKS THE LOOP, WHICH IS A SECOND REASON TO PREFER IT. Whatever the resident loop
 * is awaiting on that page rejects with "Target closed", so it falls into its own catch and
 * the existing reopen path runs — the same path the post-Okta recycle and the size guard use.
 * Nothing new has to know how to rebuild a browser.
 *
 * AND IT MAKES THE TEARDOWN RELIABLE. `browser.close()` against a wedged renderer hung in the
 * probe above; with the page already closed the renderer is gone and `ctx.close()` in the
 * loop's `finally` has nothing to wait for.
 *
 * ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────────────────────
 *
 * IT BOUNDS THE LEAK. IT DOES NOT ELIMINATE IT. The production burst maps its 16,384 sections
 * in <=34 s, so a detector that must first OBSERVE unresponsiveness can never beat all of it;
 * acting at ~30 s catches a burst partway through. The true cure is to stop RC's SPA running
 * unattended for hours, which is a product decision `checkAndReport`'s localStorage rule has
 * already refused once. Do not write this up as the leak being fixed.
 */

/** How long the page gets to answer before we call it unresponsive. */
export const WEDGE_PROBE_TIMEOUT_MS = Number(process.env.RC_WEDGE_PROBE_TIMEOUT_MS || 2_000);
/** How often to ask. Cheap on a healthy page — a round trip and an integer. */
export const WEDGE_PROBE_EVERY_MS = Number(process.env.RC_WEDGE_PROBE_EVERY_MS || 10_000);
/**
 * CONSECUTIVE misses before acting. Three at a 10 s cadence is ~30 s of continuous silence.
 *
 * NOT ONE. A single miss is a GC pause, a heavy paint, or a same-site tab loading Okta on the
 * shared main thread — all of which resolve. The renewal's own trip is the case to survive:
 * it stalls the LOOP for 46-71 s (measured over 133 tab closes) while the resident renderer
 * goes on answering CDP throughout, which is how the heap trail samples it every 10 s during
 * healthy renewals. So a healthy renewal produces `alive` readings and never reaches a strike.
 */
export const WEDGE_STRIKES = Number(process.env.RC_WEDGE_STRIKES || 3);
/**
 * Recycles per browser life before giving up and letting the expensive arm have it.
 *
 * A recycle that does not cure the wedge and is simply repeated is the crash-loop shape —
 * `supervise.ps1` stops loudly after five exits in ten minutes for the same reason. If three
 * fresh pages all wedge, the fault is not the page and the bail's diagnostics are worth more
 * than a fourth attempt.
 */
export const WEDGE_MAX_RECYCLES = Number(process.env.RC_WEDGE_MAX_RECYCLES || 3);

/**
 * Ask the page whether its main thread is running. Returns one of:
 *
 *   'alive'         — it answered
 *   'wedged'        — it did not answer inside the budget
 *   'inconclusive'  — there was no page, or the call REJECTED
 *
 * THE BUDGET IS NOT OPTIONAL. `page.evaluate` has NO TIMEOUT in Playwright — this repo built
 * `evaluateWithin` on 2026-08-17 for exactly that, and the first draft of the probe that
 * produced the measurements above forgot it and hung forever. A detector that can hang is a
 * detector that takes the watchdog with it.
 *
 * A REJECTION IS NOT A WEDGE, AND KEEPING THEM APART IS THE POINT. "Target closed", "Execution
 * context was destroyed" and a navigation in flight all reject instantly — that is a page
 * CHANGING, which is the healthy case, and counting it as a strike would rack up three of them
 * during an ordinary reopen and recycle a page that was never wedged. Only silence counts.
 */
export async function probeResidentPage(page, timeoutMs = WEDGE_PROBE_TIMEOUT_MS) {
  if (!page || typeof page.evaluate !== 'function') return 'inconclusive';
  if (typeof page.isClosed === 'function' && page.isClosed()) return 'inconclusive';
  let timer = null;
  try {
    return await Promise.race([
      page.evaluate('1').then(() => 'alive', () => 'inconclusive'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('wedged'), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The decision, pure so it can be tested without a browser.
 *
 * `reading` is what `probeResidentPage` returned. Returns the NEW strike count and what to do.
 *
 * THE @typedef IS LOAD-BEARING, NOT DOCUMENTATION, and a plain `@param {object} [o]` with
 * `[o.reading]` properties does NOT do the job — measured, not assumed. TypeScript infers a
 * destructured signature from the DEFAULTS, and `reading` deliberately has none, so without a
 * named type the one property the whole decision turns on is absent from it and the ROOT
 * tsconfig rejects every caller that passes it. `npm test` is perfectly happy either way; the
 * typecheck is what sees it.
 *
 * @typedef {object} WedgeInput
 * @property {'alive'|'wedged'|'inconclusive'|null} [reading]
 * @property {number} [strikes]
 * @property {number} [strikesNeeded]
 * @property {number} [recycles]
 * @property {number} [maxRecycles]
 */
/**
 * @param {WedgeInput} [input]
 * @returns {{ strikes: number, act: 'none'|'recycle'|'escalate', why: string }}
 */
export function wedgeDecision({
  reading,
  strikes = 0,
  strikesNeeded = WEDGE_STRIKES,
  recycles = 0,
  maxRecycles = WEDGE_MAX_RECYCLES,
} = {}) {
  // A page that answered is the end of the episode, whatever came before it.
  if (reading === 'alive') return { strikes: 0, act: 'none', why: 'the page answered' };
  // We could not tell. Do NOT add a strike and do NOT clear the ones already counted: an
  // inconclusive reading is the absence of evidence in both directions, and rounding it either
  // way is the mistake this file's whole history is made of.
  if (reading !== 'wedged') return { strikes, act: 'none', why: 'we could not tell' };

  const next = strikes + 1;
  if (next < strikesNeeded) {
    return { strikes: next, act: 'none', why: `no answer (${next}/${strikesNeeded})` };
  }
  if (recycles >= maxRecycles) {
    return {
      strikes: next,
      act: 'escalate',
      why: `the page has been recycled ${recycles}x and is still wedged — handing it to the bail`,
    };
  }
  return {
    strikes: next,
    act: 'recycle',
    why: `no answer in ${strikesNeeded} consecutive probes — recycling the resident page`,
  };
}
