/**
 * The keep-warm's Chromium launch arguments — ONE definition, two call sites.
 *
 * WHY THIS IS A MODULE AND NOT TWO ARRAY LITERALS. `rc-keepwarm.mjs` launches Chromium in two
 * places (`withProfile` and the resident loop) and the RAMP lives on the resident one. A flag
 * added to one and not the other is the half-applied shape this repo has paid for repeatedly —
 * and worse here than usual, because the two browsers would then differ in exactly the variable
 * under test and the experiment would be uninterpretable. Importing `rc-keepwarm.mjs` STARTS the
 * keep-warm loop, so anything that wants a test has to live outside it; same reason as
 * `renewal-schedule.mjs`, `ramp-bail.mjs` and `session-coverage.mjs`.
 *
 * ── THE GPU FLAGS — RUN, ANSWERED, AND TURNED BACK OFF (2026-09-10) ────────────────────────
 *
 * **THE COMMAND-BUFFER CANDIDATE IS REFUTED. These flags are OFF by default and the module is
 * kept for the evidence, not for the behaviour.**
 *
 * The hypothesis was `MappedMemoryManager` serving RC's WebGL ArcGIS map:
 * `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is 2,097,152 bytes, exactly the region
 * walk's 2.0000 MB unit; one shared region per chunk, in the renderer, anonymous and READWRITE;
 * and `FreeUnused()` reclaims only blocks whose command-buffer tokens have passed, which a main
 * thread that never returns to its message loop cannot advance. It fit every reading taken.
 *
 * So the test was to take the command buffer away — `--disable-3d-apis` (no WebGL context at
 * all, so no command-buffer client for the map) plus `--disable-gpu` (the belt, in case the
 * buffer that mattered was the compositor's). Both shipped together on 2026-09-10 and the flags
 * were confirmed live on the running browser by an INDEPENDENT reading rather than by "the code
 * is on disk": `gpu-process` fell from a steady 80-126 MB to 20-22 MB and stayed there.
 *
 * **THE FIRST TRIAL RAMPED.** A browser launched at 05:49:51Z under both flags, and two minutes
 * later:
 *
 *     05:49:53  rc   209 MB  pid  1692  commit  7050/29035  gpu-process 20 MB
 *     05:51:53  rc  3452 MB  pid 13332  commit 44336/45513  gpu-process 20 MB
 *
 * with the region walk on that renderer reading **32,774 MB across 16,385 regions in the 2-4M
 * bucket, one allocation base each, all anonymous, all READWRITE** — 16,384 x 2 MiB = 32 GiB
 * exactly, the identical signature, and the same native spin at the same `chrome.dll` offsets.
 * The GPU process did not move at any point.
 *
 * A refutation needs ONE counterexample and this one arrived with the whole walk attached, so
 * accumulating the twenty quiet trials the bar called for would have proven nothing further —
 * that bar was for crediting a CURE, and there is no cure here to credit.
 *
 * **STATED PRECISELY, BECAUSE THE OVER-CLAIM IS TEMPTING.** What is established is that removing
 * the WebGL context does not stop the leak. `--disable-gpu` leaves a GPU process running (at
 * 20 MB, evidently idle), so a *different* command-buffer client is not excluded by arithmetic
 * alone — but the mechanism as proposed, the map's own `MappedMemoryManager`, cannot be it. The
 * 2 MiB unit is now MORE interesting, not less: something allocates 2 MiB shared sections in a
 * renderer with no WebGL context at all.
 *
 * ── WHY THEY ARE OFF RATHER THAN DELETED ───────────────────────────────────────────────────
 *
 * OFF because the justification is gone and the hazard is not. RC and Okta FINGERPRINT this
 * browser — that is why it is headful and why `--enable-automation` is stripped — and a browser
 * reporting no WebGL is itself a bot signal. The recorded cost of getting anti-bot posture wrong
 * on this address is TWELVE HOURS of IP block (2026-08-06), which takes the 08:00 cart with it.
 * A change that does not work and carries that is uncompensated risk.
 *
 * KEPT rather than deleted because the module now carries a MEASURED refutation, and deleting it
 * takes the evidence with it — the same reason a guard that pinned a bug gets inverted rather
 * than removed. Anyone who reaches for these flags again should meet this entry first.
 *
 * `RC_KEEPWARM_DISABLE_GPU=1` in the box's `.env` plus a restart re-runs the experiment with no
 * deploy, if a reason ever appears.
 */

/** `--hide-crash-restore-bubble`: the profile is routinely force-killed (update.bat,
 * rc-login.bat), so Chromium offers to restore pages on every launch — harmless, but it covers
 * the top of the very window a human is being asked to look at. Unconditional, unrelated to the
 * experiment above, and it stays whichever way the gate goes. */
const ALWAYS = ['--hide-crash-restore-bubble'];

/** Targeted first, belt second — the order the comment above explains them in. Off by default
 *  since the trial of 2026-09-10 answered the question they were added to ask. */
export const GPU_OFF_ARGS = ['--disable-3d-apis', '--disable-gpu'];

/**
 * @param {Record<string, string | undefined>} [env] injected so a test can drive the gate
 *   without touching the real process environment.
 * @returns {string[]} the launch args for BOTH keep-warm Chromium launches.
 */
export function keepwarmLaunchArgs(env = process.env) {
  // DEFAULT OFF. The experiment is over and its answer was negative, so an unset variable is
  // now the SAFE configuration rather than the experimental one — and re-running it has to be
  // asked for explicitly, since what it costs is a fingerprint change on the login path.
  const on = String(env.RC_KEEPWARM_DISABLE_GPU ?? '0').trim().toLowerCase();
  const enabled = on === '1' || on === 'true' || on === 'yes';
  return enabled ? [...ALWAYS, ...GPU_OFF_ARGS] : [...ALWAYS];
}
