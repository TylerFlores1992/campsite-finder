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

/**
 * IS THIS URL STILL INSIDE THE SIGN-IN FLOW?
 *
 * The SECOND half of "may this window close now?", and the half that was missing until
 * 2026-08-31. `mayCloseOnToken` answers *"is the token real?"*; this answers *"has RC
 * finished with it?"* — and the two are not the same question.
 *
 * ## WHAT THIS FIXED
 *
 * From the hold `TEST · 43832` trace, read in order:
 *
 * ```
 * injected  href=.../login/callback     <- Okta has redirected back; RC's SPA is booting
 * token     {"ageSec":2, "expiresInSec":3598}
 * closed    {}                          <- we destroy the webview, 2s in
 * ```
 *
 * `/login/callback` is where RC's own SPA completes the OAuth exchange and bootstraps its
 * customer session. **We were killing the webview in the middle of it.** The token was
 * real — RC wrote its own copy a second earlier, and the SPA went on to make sixty-plus
 * authenticated calls — but the page that renders a NAME in the header, and lets the cart
 * be opened, never finished coming up. The user was handed a site RC then asked them to
 * log in for.
 *
 * ## WHY THIS IS THE CAUSE AND NOT A GUESS, and where the doubt actually sits
 *
 * Bisected by hand on 2026-08-31, in the app, against the ADMIN probe — which calls
 * `openRcHandoff` with **no `closeOnToken`**, so its window stays open:
 *
 *   - signed in there by hand, staying on the page   -> **TYLER** in the header, account
 *     menu with LOGOUT, cart page reachable, Your Reservations reachable.
 *   - then pressed Done and reopened it              -> **name still there.**
 *
 * So a close and a reopen are INNOCENT: the session survives both. The only variable left
 * between that working run and a failing hand-off is *when* the close happens — and the
 * trace says we do it while still on the callback.
 *
 * **The doubt that remains, stated so nobody has to rediscover it:** the manual sign-in was
 * also hand-typed rather than script-driven. That is not thought to matter — the scripted
 * sign-in produced a genuine token and RC's SPA persisted its own copy — but it has not
 * been eliminated. If a hand-off still fails with `close {reason:'settled'}` in its
 * reports, this was the wrong half and the fill is the next suspect.
 *
 * ## THE MATCH IS DELIBERATELY NARROW, AND THE FAILURE DIRECTION IS THE REASON
 *
 * Only two things count as "mid sign-in": Okta's own host, and RC's `/login/callback`.
 * Anything unrecognised is **not** mid-flow, so the window closes at once.
 *
 * That looks like the unsafe direction and is the right one. Waiting on anything we cannot
 * identify would make the ALREADY-SIGNED-IN path — no Okta, no callback, token captured on
 * RC's first API call — sit through the settle timeout on every hand-off, which is the
 * 2026-08-12 "stranded when it WORKED" bug reintroduced for every user to buy safety for a
 * rare one. Narrow keeps this change confined to the one page that is known to break.
 *
 * **The cost of narrow, named so it is not a surprise:** if RC ever moves its callback
 * path, this silently stops matching and the 08-31 bug comes back with nothing red. The
 * `close` report's `reason` is what would show it — a hand-off that reports `token` where
 * it used to report `settled` is that regression.
 *
 * Takes a possibly-empty string because the plugin's `loadstop` event is the source and it
 * is data from outside; anything unparseable is simply not a match.
 */
export function isMidSignIn(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // Okta's sign-in lives on its own SUBDOMAIN of RC. Being anywhere on it means the flow
  // has not come back yet, whatever the path.
  if (u.hostname.toLowerCase() === 'signin.reservecalifornia.com') return true;
  // And the callback is the page RC lands on afterwards to finish the exchange. Matched on
  // the PATHNAME alone: the query string carries the OAuth authorization code, which is
  // exchangeable for the session and must never be read, let alone logged (2026-08-09).
  return u.pathname.toLowerCase().startsWith('/login/callback');
}

/** What the sign-in window should do about a report it has just received. */
export type RcCloseAction = 'close' | 'arm' | 'wait';

/**
 * THE WHOLE "may this sign-in window close now?" DECISION, in one testable place.
 *
 * Extracted for the reason `worker/claim.ts` and `worker/hold-line.ts` were: it lived
 * inline in an InAppBrowser `message` handler, which needs a native webview to reach, so
 * the most consequential branch in the hand-off could not be exercised by a test at all.
 * That is how `closeOnToken` shipped in #126 with nothing testing it and stayed wrong until
 * 08-24, and how the callback bug survived from #126 to 08-31.
 *
 *  - `close` — take it down now.
 *  - `arm`   — a live token, but RC has not finished; start the settle timer.
 *  - `wait`  — nothing to do (not a token, not live, or the timer is already running).
 *
 * **`arm` IS RETURNED ONCE, and that is load-bearing.** The token is rebroadcast on every
 * RC API call — sixty-plus during a bootstrap — so a version that re-armed per report would
 * push the deadline out on each one and the timeout could never fire. The caller passes
 * `timerArmed` back in rather than this deciding from state it cannot see.
 */
export function rcCloseAction(opts: {
  closeOnToken: boolean;
  stage: string;
  detail: unknown;
  currentUrl: string;
  timerArmed: boolean;
}): RcCloseAction {
  const { closeOnToken, stage, detail, currentUrl, timerArmed } = opts;
  // The cart path passes `closeOnToken: false` — there the token is the MIDDLE of the job
  // and closing on it kills the webview before the two cart POSTs it exists to make.
  if (!closeOnToken) return 'wait';
  if (stage !== 'token') return 'wait';
  if (!mayCloseOnToken(detail)) return 'wait';
  if (!isMidSignIn(currentUrl)) return 'close';
  return timerArmed ? 'wait' : 'arm';
}

/**
 * WHAT A `close` REPORT'S REASON ACTUALLY TELLS YOU.
 *
 * The sibling of `rcCloseAction`: that decides what the window does, this decides what a
 * human reading the trace afterwards should conclude. Extracted for the reason the decision
 * itself was — it lived inline in `scripts/rc-holds-readout.mts`, where the one branch that
 * says "the bug is back" could not be exercised without a real hand-off in the database, so
 * the block that matters most would have shipped having never once run.
 *
 * ## `token` IS AMBIGUOUS AND EVERYTHING ELSE IS NOT
 *
 * `settled` and `timeout` mean exactly one thing each. `token` means two, and they are
 * opposites:
 *
 *  - with NO sign-in in the run, the user was already signed in, the token arrived on RC's
 *    first API call from a page that is not the callback, and closing at once is the correct
 *    unchanged behaviour — the 2026-08-12 "stranded when it WORKED" fix doing its job.
 *  - AFTER a real sign-in, it means `isMidSignIn` did not match the page we were on. RC has
 *    moved its callback path, the deferral silently stopped applying, and the 08-31 bug is
 *    back **with nothing else red**. `isMidSignIn`'s own header names this as the cost of
 *    matching narrowly; this is the thing that would show it.
 *
 * So the reason alone cannot be read, and a readout that printed it bare would leave the
 * next person to derive the distinction at 08:15 on a morning something is wrong.
 *
 * `level` is `warn` for exactly that one case and `info` for everything else — including
 * `timeout`, which is a real finding but not a regression, and must not be dressed as one.
 * Crying wolf on an ordinary reading is the failure this repo has fixed three times.
 */
export type CloseReading = { level: 'info' | 'warn'; text: string };

/**
 * @param reason      the `close` report's reason, as reported.
 * @param signedInRun did a sign-in actually happen in this run? Taken from the STAGES, not
 *   guessed from the reason — that is the whole discriminator.
 */
export function closeReasonReading(reason: string, signedInRun: boolean): CloseReading {
  if (reason === 'settled') {
    return {
      level: 'info',
      text: 'RC left the sign-in flow under its own steam — the deferred close working',
    };
  }
  if (reason === 'timeout') {
    return {
      level: 'info',
      text: 'RC never left the sign-in flow in time — the backstop fired, and that is a finding',
    };
  }
  if (reason === 'token') {
    return signedInRun
      ? {
        level: 'warn',
        text: 'closed IMMEDIATELY after a real sign-in — isMidSignIn is no longer matching, so'
          + ' RC has moved its callback path and the 08-31 bug is back',
      }
      : {
        level: 'info',
        text: 'closed at once with no sign-in in this run — the already-signed-in path, unchanged',
      };
  }
  // AN UNRECOGNISED REASON IS REPORTED AS ITSELF, never folded into one of the three above.
  // A bundle older than #240 sends no reason at all, and a future one may send a fourth;
  // guessing which of the known cases it resembles is how an absent reading becomes a
  // negative — the shape this file records more often than any other.
  return { level: 'info', text: `unrecognised close reason — reported as sent, not interpreted` };
}
