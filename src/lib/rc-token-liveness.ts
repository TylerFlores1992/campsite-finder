/**
 * IS THIS `token` REPORT EVIDENCE OF A USABLE RC SESSION?
 *
 * ONE definition, because there are TWO consumers of the identical report and until
 * 2026-08-24 only one of them had learned the rule.
 *
 *   src/components/v2/ClaimFlow.tsx   the claim GATE      — fixed 2026-08-21 (#152)
 *   src/lib/native/rc-handoff.ts      `closeOnToken`      — NOT fixed, until this module
 *
 * The gate's own header records the incident that taught it:
 *
 *     token { captured: true, decodable: true, expiresInSec: -82599 }
 *
 * a token that had expired twenty-three hours earlier, reported as "verified". The user
 * released a real hold against a dead session and the site went back on the open market
 * having been carted for nobody. `expiresInSec` had been in the report since migration
 * 058 — whose own note says **"Never presence, always liveness"** — and the gate ignored it.
 *
 * ## THE SAME BUG SURVIVED NEXT DOOR, AND IT COST THE 2026-08-24 TEST
 *
 * `closeOnToken` closed the sign-in webview on `captured` ALONE. So with a stale token in
 * RC's SPA — the ordinary state here, since the stale token comes from the SERVER and no
 * local clear can reach it (2026-08-22) — `rc-inject.js` broadcast it on RC's first API
 * call, the window closed in under a second, and that read to the owner as *"it opened RC
 * for less than a second as if auto login worked"*. **The credentials were never typed:**
 * Okta's flow is several page loads and cannot complete in under a second, whatever else
 * happened. They then handed the site over against no session at all.
 *
 * A fix applied to one consumer of a shared fact and not its sibling is the most repeated
 * shape in this repository. The remedy is not a second copy of the comparison — it is
 * having only one comparison to keep in step.
 *
 * ## THREE VALUES, BECAUSE "EXPIRED" AND "COULD NOT TELL" ARE DIFFERENT FACTS
 *
 *  - `live`    — decodable, and still has time on it. Positive evidence of a session.
 *  - `expired` — decodable, and already dead. Positive evidence of NO session; the user
 *                can be told so, which is actionable in a way silence is not.
 *  - `unknown` — not captured, undecodable, or carrying no expiry. **We could not tell.**
 *
 * `unknown` must never round to a verdict in either direction — the rule that keeps
 * `hasAvailabilityInRange`'s null from reading as "fully booked" and an unreachable Okta
 * probe from reading as "signed out". Here it means: do not claim a session, and do not
 * deny one either.
 *
 * ## A REBROADCAST IS DELIBERATELY `unknown`, AND THAT IS NOT A GAP
 *
 * `rc-precart-script` puts the timing facts on the FIRST sighting of each distinct token
 * only; `rc-inject.js` replays the token on every RC API call and those repeats carry
 * `{ captured, length }` and nothing else, so the duplicate collapse can fold ~20 of them
 * instead of burying the cart's own status at 08:00:00. So a repeat reads `unknown` here,
 * which is correct twice over: it is genuinely no new information, and the first sighting
 * has already been judged. Note this is also why the OLD check was robust in the wrong
 * direction — a `captured`-only test fires on every replay, so even a token whose first
 * sighting was expired would close the window on the next rebroadcast.
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
