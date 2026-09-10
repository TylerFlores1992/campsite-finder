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
 * ── THE GPU FLAGS (2026-09-09) — A HYPOTHESIS, GATED, NOT A PROVEN FIX ──────────────────────
 *
 * VMSTACK read a real ramp on 2026-09-09 21:26 and put the spinning main thread in NATIVE code:
 * 42 of 48 samples inside `chrome.dll`, the hot addresses spanning 59 bytes. That closed the JIT
 * branch — RC's own page script is not the loop — and left the leading candidate untouched:
 * `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is 2,097,152 bytes, exactly the walk's
 * 2.0000 MB unit; `MappedMemoryManager` holds one shared region per chunk, in the renderer,
 * anonymous and READWRITE; and `FreeUnused()` reclaims only blocks whose command-buffer tokens
 * have passed, which a main thread that never returns to its message loop cannot advance.
 *
 * The keep-warm's browser exists to HOLD A SESSION. It does not need to render RC's WebGL ArcGIS
 * map. So the cheapest test of that candidate is to take the command buffer away.
 *
 *   --disable-3d-apis   the TARGETED one: no WebGL/WebGPU context, so no command-buffer client
 *                       for the map at all.
 *   --disable-gpu       the belt: compositing moves in-process too, in case the buffer that
 *                       matters is the compositor's rather than WebGL's. We do not know which,
 *                       and the reading cannot tell them apart, so both go on together.
 *
 * ── THE HAZARD, STATED BECAUSE IT IS REAL AND IT IS NOT THE MEMORY ─────────────────────────
 *
 * RC and Okta FINGERPRINT this browser. That is why it is headful (`HEADLESS` is false by
 * design) and why `--enable-automation` is stripped — `navigator.webdriver` is read by reCAPTCHA.
 * A browser with no WebGL, or one reporting SwiftShader, is itself a bot signal. The recorded
 * cost of getting anti-bot posture wrong on this address is TWELVE HOURS of IP block
 * (2026-08-06), and an unattended login path that stops working takes the 08:00 cart with it.
 *
 * So this is **gated and reversible without a deploy**: `RC_KEEPWARM_DISABLE_GPU=0` in the box's
 * `.env` plus a restart puts it back. The canaries that would catch a broken sign-in already
 * exist and are watched — the nightly login rehearsal (`autocart.rc_login`), `rc-test-login` on
 * demand, and `autocart.rc_session`. **If the rehearsal starts failing or a CAPTCHA appears,
 * turn this off first and ask questions second.**
 *
 * ── HOW TO READ THE RESULT, AND THE BAR IT HAS TO CLEAR ────────────────────────────────────
 *
 * `restart-rc` replaces the browser on demand and a replacement ramps about **10% of the time**
 * (11 of 110, measured over ten days). So a handful of quiet restarts proves NOTHING: three in a
 * row is what you would expect roughly three quarters of the time from a change that does
 * nothing at all. **Roughly twenty clean restarts is the bar**, and natural ramps count toward
 * it too. Crediting a repair to the wrong mechanism has cost this file three separate times —
 * the age recycle, the throttling flags and the containment arm — so the number is written down
 * here BEFORE the experiment rather than argued about after it.
 *
 * A ramp that still arrives with these flags on refutes the command-buffer candidate outright,
 * which is worth as much as a cure and arrives faster.
 */

/** `--hide-crash-restore-bubble`: the profile is routinely force-killed (update.bat,
 * rc-login.bat), so Chromium offers to restore pages on every launch — harmless, but it covers
 * the top of the very window a human is being asked to look at. Unconditional, unrelated to the
 * experiment above, and it must stay whichever way the gate goes. */
const ALWAYS = ['--hide-crash-restore-bubble'];

/** Targeted first, belt second — the order the comment above explains them in. */
export const GPU_OFF_ARGS = ['--disable-3d-apis', '--disable-gpu'];

/**
 * @param {Record<string, string | undefined>} [env] injected so a test can drive the gate
 *   without touching the real process environment.
 * @returns {string[]} the launch args for BOTH keep-warm Chromium launches.
 */
export function keepwarmLaunchArgs(env = process.env) {
  // DEFAULT ON, because the experiment is the point of shipping it — but read as a STRING and
  // compared explicitly, so the only way to get the old behaviour is to ask for it. An unset
  // variable is the experiment, not a silent revert.
  const off = String(env.RC_KEEPWARM_DISABLE_GPU ?? '1').trim().toLowerCase();
  const disabled = off === '0' || off === 'false' || off === 'no';
  return disabled ? [...ALWAYS] : [...ALWAYS, ...GPU_OFF_ARGS];
}
