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
// NO LONGER THE CLOSE SIGNAL (2026-09-01, #249). Kept as the shared token-liveness rule —
// the claim screen's deadline and the readout still need "is this token real?" — but the
// sign-in window closes on RC's own `customerId` now (`rcCloseAction`), because a live token
// is step ONE of RC's two-step sign-in and closing on it raced step two. The name is
// historical; the function answers liveness, not closeability.
export function mayCloseOnToken(detail: unknown): boolean {
  return rcTokenLiveness(detail) === 'live';
}

/** What the sign-in window should do about a report it has just received. */
export type RcCloseAction = 'close' | 'wait';

/**
 * THE WHOLE "may this sign-in window close now?" DECISION, in one testable place.
 *
 * Extracted for the reason `worker/claim.ts` and `worker/hold-line.ts` were: it lived
 * inline in an InAppBrowser `message` handler, which needs a native webview to reach, so
 * the most consequential branch in the hand-off could not be exercised by a test at all.
 * That is how `closeOnToken` shipped in #126 with nothing testing it and stayed wrong until
 * 08-24, and how the callback bug survived from #126 to 08-31 — and how the timeout that
 * replaced it survived until 09-01.
 *
 * ## THE RULE, AND WHERE IT COMES FROM (2026-09-01)
 *
 * **Close when RC's own SPA says it is signed in, and on nothing else.** RC decides that from
 * exactly one key — read out of its bundle (`index-BvrbWbr2.js`), not inferred:
 *
 *     isLoggedIn: !!localStorage.getItem("customerId")
 *
 * Its sign-in is TWO steps. Okta's callback writes `ssoAccessToken` (the JWT we capture) with
 * `isLoggedIn: false`, then awaits `GET WebAccessCustomer/SSO/GetSSOLoggedInUser` — and only
 * that response writes `customerId`, `customerName`, RC's OWN `accessToken` and
 * `customerDetail`. The header name and `isLoggedIn` come from step two. The token we were
 * closing on comes from step one.
 *
 * Worse, the first API call after the callback IS step two's request, and `rc-inject.js`
 * captures the token off that call's header — so `token captured` marks the instant step two
 * LEAVES, and every close rule built on it was a race against step two's RESPONSE. The
 * 2026-08-31 deferral (wait on `/login/callback`, then a 10s timer) was that race with a
 * longer fuse: `settled` could never fire because RC's post-login navigation is client-side,
 * so both platforms closed on `timeout`. iOS survived because its InAppBrowser `close` only
 * dismisses the view controller and the WKWebView keeps running; Android's `closeDialog`
 * navigates to `about:blank` and kills the in-flight request. That is the whole platform
 * difference, and it is in the plugin.
 *
 * The bundle now reports `rc-session { loggedIn }` — `!!customerId`, a boolean, never the
 * value — once on install and again when it flips. This closes on `true`. A token, live or
 * not, on any page, is no longer a reason to close: RC has said it is not finished.
 *
 * ## NO TIMEOUT CLOSES THE WINDOW ANY MORE, and that is deliberate
 *
 * The 2026-08-12 concern was a signed-in user stranded on RC's page with nothing telling
 * them to go back. That case now closes at once — RC boots with `customerId` already
 * present, the bundle reports `loggedIn: true` on install, and the window goes. The case a
 * timer used to "handle" is RC still finishing step two, and closing there is the defect
 * itself: a locked campsite the owner cannot reach. If step two never finishes, the bundle
 * shows a notice in the window ("when you see your name, tap Done") and the user closes it
 * — which is precisely the configuration the 08-31 hand bisect proved works.
 */
export function rcCloseAction(opts: {
  closeOnToken: boolean;
  stage: string;
  detail: unknown;
}): RcCloseAction {
  const { closeOnToken, stage, detail } = opts;
  // The cart path passes `closeOnToken: false` — there the window is the job, and closing
  // it for any reason kills the two cart POSTs it exists to make.
  if (!closeOnToken) return 'wait';
  if (stage !== 'rc-session') return 'wait';
  const d = detail as { loggedIn?: unknown } | null | undefined;
  // STRICTLY `true`. A missing field is a bundle older than this rule and must not close;
  // `false` is RC saying "not yet"; anything else is not a reading.
  return d && d.loggedIn === true ? 'close' : 'wait';
}

/**
 * WHAT A `close` REPORT'S REASON ACTUALLY TELLS YOU.
 *
 * The sibling of `rcCloseAction`: that decides what the window does, this decides what a
 * human reading the trace afterwards should conclude. Extracted for the reason the decision
 * itself was — inline in `scripts/rc-holds-readout.mts` the branch that says "this is the
 * old defect" could not be exercised without a real hand-off in the database.
 *
 * Since #249 there is ONE ordinary reason, `session`. Every other reason is a host that
 * predates the rule, and each is named for what it was rather than folded in — a
 * `timeout` close from an old cached host is exactly the 09-01 race, and reading it as
 * anything else would send the next person hunting a new bug.
 */
export type CloseReading = { level: 'info' | 'warn'; text: string };

/**
 * @param reason      the `close` report's reason, as reported.
 * @param signedInRun did a sign-in actually happen in this run? Taken from the STAGES, not
 *   guessed from the reason — that is the whole discriminator.
 */
export function closeReasonReading(reason: string, signedInRun: boolean): CloseReading {
  if (reason === 'session') {
    return {
      level: 'info',
      text: "RC's own SPA reported signed in (customerId written) — the ordinary close since #249",
    };
  }
  // EVERYTHING BELOW IS A PRE-#249 HOST. The bundle is served, so it updates on a push; the
  // host that names the close reason is part of the app's web bundle too, but a webview
  // that cached the old one can still send these. They are read as what they are — the
  // race this rule replaced — and not folded into the new close.
  if (reason === 'timeout' || reason === 'settled') {
    return {
      level: 'warn',
      text: `closed on '${reason}' — a pre-#249 host racing RC's step two. If the header was`
        + ' empty afterwards this is the 09-01 defect, not a new one',
    };
  }
  if (reason === 'token') {
    return signedInRun
      ? {
        level: 'warn',
        text: 'closed on the TOKEN after a real sign-in — a pre-#240 host; step two was cut off',
      }
      : {
        level: 'info',
        text: 'closed on the token with no sign-in in this run — a pre-#249 host on the'
          + ' already-signed-in path, which happened to be safe',
      };
  }
  // AN UNRECOGNISED REASON IS REPORTED AS ITSELF, never folded into one of the cases above.
  // A future host may send a fifth; guessing which known case it resembles is how an absent
  // reading becomes a negative — the shape this file records more often than any other.
  return { level: 'info', text: `unrecognised close reason — reported as sent, not interpreted` };
}

/**
 * WHAT THE `rc-session` / census READING SAYS ABOUT RC'S OWN LOGIN STATE.
 *
 * Pure for the reason its siblings are. `rcLoggedIn` is `!!localStorage.customerId`, read on
 * RC's origin — the exact expression RC's SPA boots `isLoggedIn` from. Beside it,
 * `ssoToken` is the Okta JWT (step one) and `rcToken` is RC's own `accessToken` (step two).
 * The split those three make:
 *
 *   sso jwt · rc none · loggedIn false   -> step two never finished: THE 09-01 DEFECT
 *   sso jwt · rc jwt  · loggedIn true    -> signed in; a signed-out-looking page is not this
 *   sso none · loggedIn false            -> plainly signed out — nothing was cut off
 */
export type RcSessionReading = { level: 'info' | 'warn'; text: string };

export function rcSessionReading(d: {
  rcLoggedIn?: boolean; ssoToken?: string; rcToken?: string;
}): RcSessionReading | null {
  // A census older than #249 carries none of these; say nothing rather than invent a state.
  if (typeof d.rcLoggedIn !== 'boolean') return null;
  if (d.rcLoggedIn) {
    return { level: 'info', text: "RC login: customerId PRESENT — RC's SPA renders signed in; the header shows the name" };
  }
  if (d.ssoToken === 'jwt') {
    return {
      level: 'warn',
      text: 'RC login: customerId ABSENT beside an Okta token — step two (GetSSOLoggedInUser) never'
        + ' finished, so RC renders signed out and the cart page will ask to log in',
    };
  }
  return { level: 'info', text: 'RC login: customerId ABSENT and no Okta token — plainly signed out' };
}

/**
 * What a `keep-signed-in` report means.
 *
 * ## WHY THIS EXISTS (2026-09-01)
 *
 * Two hand-offs eleven minutes apart — iOS worked, Android did not, and the owner saw RC's
 * header carry his name on one phone and "please sign in" on the other. Their traces were
 * IDENTICAL on every field we record: `✓ Added to cart`, `cart read back: 1 entry`,
 * `close: timeout`, and the same okta-store census. So the instruments did not measure the
 * thing that differed, which is the failure this whole file exists to stop repeating.
 *
 * The one place the two runs diverged was upstream, in the stages:
 *
 *     iOS      signin-missing → email → password → submitted
 *     Android  signin-open    →         password → submitted
 *
 * Android never saw Okta's IDENTIFIER page, because `chFind(CH_PW_SELS)` already matched a
 * password field and the caller skips the email step entirely in that case. Okta renders
 * "Keep me signed in" on the identifier step — so on that path there was no box in the DOM,
 * and `chKeepSignedIn` silently found nothing.
 *
 * THAT MATTERS BECAUSE OF A MEASUREMENT THIS REPO ALREADY HAS. 2026-08-09: the ported login
 * calls `keepSignedIn()` and the hand-rolled one never did, and "every previous session was
 * established without 'Keep me signed in', so of course Okta issued nothing persistent" —
 * `okta=GONE(404)` before, a ~12-hour Okta session after. The `idx` cookie comes from that
 * box. A run without it can still complete the OAuth exchange and mint a perfectly good
 * access token — which is why the cart POSTs succeed — while leaving no session for RC's
 * SPA to render a name from.
 *
 * IT IS A CANDIDATE, NOT A FINDING, and the wording keeps it that way. What is established
 * is only that the tick did not happen; that this is WHY the header is empty is inference,
 * and three mechanisms guessed at in this area have each cost a test. What settles it is the
 * next pair of runs: a hand-off reporting `ticked` whose header still shows nothing refutes
 * it outright.
 */
export type KeepSignedInReading = { level: 'info' | 'warn'; text: string };

/**
 * WHICH SIGN-IN PATH A RUN TOOK — the line that would have saved 2026-09-01.
 *
 * Okta has two entry points and the device's password manager decides which you get. Both
 * end in a valid token, so every OUTCOME field matches; they differ four stages earlier, and
 * on 09-01 two traces were compared field by field before anybody noticed:
 *
 *     identifier-first   signin-missing → email → password → submitted
 *     password-first     signin-open    →         password → submitted
 *
 * The second skips Okta's identifier page, which is the only page carrying "Keep me signed
 * in" — see `keepSignedInReading`. So this is not decoration: it names the precondition for
 * the failure directly above, and it is derived from stages we already record.
 *
 * DERIVED FROM `email`, NOT FROM THE PLATFORM. The path is a property of the run, not of the
 * device — iOS takes the password-first route whenever Okta remembers the account. Keying it
 * on platform would encode the very confusion this exists to end.
 */
export function signInPathReading(stages: string[]): string | null {
  const signedIn = stages.some((s) => s === 'password' || s === 'submitted');
  // NO SIGN-IN, NO READING. An already-signed-in hand-off never visits Okta at all, and
  // reporting "password-first" over it would invent a path nobody took — the absent-reading
  // -as-a-negative shape this file records more than any other.
  if (!signedIn) return null;
  return stages.includes('email')
    ? "sign-in path: IDENTIFIER-FIRST — Okta asked for the address, so the "
      + '"Keep me signed in" box was on screen'
    : "sign-in path: PASSWORD-FIRST — Okta remembered the account and skipped its identifier "
      + 'page, which is the only page carrying "Keep me signed in"';
}

export function keepSignedInReading(d: {
  ticked?: boolean; boxes?: number; matched?: boolean; at?: string;
}): KeepSignedInReading {
  const where = d.at ? ` on the ${d.at} step` : '';
  if (d.ticked) {
    return { level: 'info', text: `"Keep me signed in" was ticked${where} — Okta should issue a persistent session` };
  }
  // ZERO BOXES AND SOME BOXES ARE DIFFERENT FINDINGS AND MUST NOT COLLAPSE. Zero means the
  // page never offered the option — the skipped-identifier path above, which is the whole
  // reason this reading exists. A non-zero count means the box was there and the match
  // missed it, i.e. Okta reworded an attribute and the selector needs widening. One is a
  // flow problem and one is a selector problem, and they have nothing to do with each other.
  if ((d.boxes ?? 0) === 0) {
    return {
      level: 'warn',
      text: `"Keep me signed in" was NOT ticked${where}: no checkbox on the page at all.`
        + ' Okta renders it on the identifier step, which this run skipped — so this sign-in'
        + ' likely left NO persistent session, and RC will render signed out',
    };
  }
  return {
    level: 'warn',
    text: `"Keep me signed in" was NOT ticked${where}: ${d.boxes} checkbox(es) on the page and`
      + ' none matched — the selector needs widening, not the flow',
  };
}
