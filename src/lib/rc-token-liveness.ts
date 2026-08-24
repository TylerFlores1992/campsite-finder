/**
 * IS THIS `token` REPORT EVIDENCE OF A USABLE RC SESSION?
 *
 * The classification only. **The two consumers apply DIFFERENT policies to it, and that is
 * correct** — which is why this module exports a three-valued fact rather than a boolean
 * anybody could share:
 *
 *   src/lib/native/rc-handoff.ts   `closeOnToken`  closes on `live` ONLY.
 *   src/components/v2/ClaimFlow    the claim GATE  verifies on `live` AND on `unknown`.
 *
 * The gate's `unknown` behaviour is deliberate and is guarded by
 * `worker/claim-release-truth.test.mts`: a bundle older than migration 058 sends no
 * `expiresInSec` at all, so refusing unknowns would take the fast path from every such
 * client at once. "We could not tell, so we do not NEWLY refuse."
 *
 * `closeOnToken` cannot afford the same generosity, because closing is an irreversible
 * assertion made while the user is still trying to sign in — see below.
 *
 * ## WHAT THIS FIXED (2026-08-24)
 *
 * `closeOnToken` tested `captured` ALONE. With a stale token in RC's SPA — the ordinary
 * state here, since the stale token comes from the SERVER and no local clear reaches it
 * (2026-08-22) — `rc-inject.js` broadcast it on RC's first API call, the window closed in
 * under a second, and that read to the owner as *"it opened RC for less than a second as if
 * auto login worked"*. **The credentials were never typed:** Okta's flow is several page
 * loads and cannot complete in under a second. They then handed the site over against no
 * session at all.
 *
 * The gate had learned this on 2026-08-21 (#152) after `closeOnToken` shipped in #126.
 * Nothing carried it across, because nothing tested `closeOnToken` at all.
 *
 * ## THREE VALUES, BECAUSE "EXPIRED" AND "COULD NOT TELL" ARE DIFFERENT FACTS
 *
 *  - `live`    — decodable, and still has time on it. Positive evidence of a session.
 *  - `expired` — decodable, and already dead. Positive evidence of NO session.
 *  - `unknown` — not captured, undecodable, or carrying no expiry. **We could not tell.**
 *
 * ## A REBROADCAST IS `unknown`, AND THAT IS NOT A GAP HERE
 *
 * `rc-precart-script` puts the timing facts on the FIRST sighting of each distinct token
 * only; `rc-inject.js` replays the token on every RC API call and those repeats carry
 * `{ captured, length }` and nothing else, so the duplicate collapse can fold ~20 of them
 * instead of burying the cart's own status at 08:00:00.
 *
 * This is also why the OLD `closeOnToken` check was robust in the WRONG direction: a
 * `captured`-only test fires on every replay, so even a token whose first sighting was
 * expired would close the window on the next rebroadcast.
 *
 * **KNOWN, NOT FIXED, AND NOT THIS MODULE'S TO FIX:** the same property means a replay
 * arriving after a correct `expired` verdict re-enters the gate's `unknown` branch and
 * clears the warning. The honest remedy is to make `expired` sticky for the run, not to
 * refuse unknowns — refusing is what would lock out older bundles. Recorded in CLAUDE.md.
 */

export type RcTokenLiveness = 'live' | 'expired' | 'unknown';

/**
 * Judge a `token` report's `detail`. Takes `unknown` because both call sites receive it
 * off a `postMessage` from inside a webview — it is data from another context and there
 * is no type to trust, only a shape to check.
 */
export function rcTokenLiveness(detail: unknown): RcTokenLiveness {
  const d = detail as { captured?: unknown; expiresInSec?: unknown } | null | undefined;
  // Not a capture at all: no claim either way.
  if (!d || d.captured !== true) return 'unknown';
  // `typeof` rather than a truthiness test — `expiresInSec: 0` is a real reading (a token
  // expiring this second, which is dead) and `0` is falsy. Reading it as "absent" would
  // send exactly the boundary case to `unknown`.
  const secs = typeof d.expiresInSec === 'number' && Number.isFinite(d.expiresInSec)
    ? d.expiresInSec
    : null;
  if (secs === null) return 'unknown';
  return secs > 0 ? 'live' : 'expired';
}

/**
 * MAY THIS SIGN-IN WINDOW CLOSE ON ITS OWN?
 *
 * Closing is an assertion — "we got what we came for" — so it is allowed on `live` and
 * nothing else, which makes it agree with the gate by construction: the window closes
 * exactly when the gate would flip to `verified`.
 *
 * **`expired` must NOT close**, and that is the whole point of this module: the window has
 * to stay open so the sign-in it was opened for can actually run.
 *
 * **`unknown` must not close either.** The cost of being wrong is asymmetric. Closing on
 * an unknown reproduces the 08-24 failure whenever a token is undecodable — a hold handed
 * over against nothing. Not closing leaves a signed-in user looking at RC's page with a
 * Done button, which is the 2026-08-12 "stranded when it worked" annoyance: real, but
 * recoverable in one tap, and it does not lose a campsite.
 */
export function mayCloseOnToken(detail: unknown): boolean {
  return rcTokenLiveness(detail) === 'live';
}
