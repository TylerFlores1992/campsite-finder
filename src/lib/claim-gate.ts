/**
 * What the claim screen may DO, given what this client can do — the sibling of
 * `lib/claim-copy`, which decides what it may SAY.
 *
 * ## The bug this exists for
 *
 * The precart runs INSIDE our own in-app webview, and that webview has its own cookie jar
 * (WKWebsiteDataStore on iOS, a separate CookieManager on Android). So it needs an RC
 * session established in THAT webview and nowhere else. Establishing one is step one of the
 * claim — `prepareRc` — and it was wired into the pre-release screen only.
 *
 * In the ordinary 08:00 flow that is invisible: the user signs in, then presses "hand it
 * over", then gets redirected. **On a REVISIT it is not.** Reopening the hand-off from the
 * Watches panel (reachable since 2026-08-13) lands on the RELEASED screen, where the user
 * has never run step one in this webview — so "Finish on ReserveCalifornia" fired the
 * precart against a signed-out webview. `content-rc.js` then spends its twelve-second token
 * wait on "Reading your session…" and can only end by asking the user to sign in on RC's own
 * page, which RC scrolls past its own sign-in control. The site is already released by then,
 * so that is the whole window spent on a step we could have taken first.
 *
 * ## Why it is a function and not two `&&`s in the JSX
 *
 * Because the rule is not obvious and its edges are the interesting part — in particular
 * that `unconfirmed` proceeds. A copy of it written inline on a third screen would get the
 * edges wrong, quietly, and the failure only shows up on a morning somebody is holding a
 * phone.
 */

/**
 * What the claim screen knows about an RC session in its own webview.
 *
 * `unconfirmed` is NOT "signed out": the webview closed without the injected script
 * announcing a token, which can equally mean we never got to look. Same distinction as
 * `hasAvailabilityInRange` returning null rather than "fully booked", and as an `unknown`
 * keep-warm verdict never being reported as a dead session.
 */
export type RcCheck = 'idle' | 'opening' | 'verified' | 'unconfirmed';

/** The one live control on the released screen. */
export type HandoffStep = 'sign-in' | 'waiting' | 'finish';

/**
 * Which step is next after the release, for a client that may or may not be able to inject.
 *
 * @param canInject Does THIS binary have an injectable in-app webview? A runtime probe, never
 *   inferred from the platform or the user agent.
 * @param rcCheck   What the report channel has said about a session in that webview.
 */
export function rcHandoffStep(canInject: boolean, rcCheck: RcCheck): HandoffStep {
  // NOTHING TO SIGN INTO. Without an injectable webview the hand-off opens the SYSTEM
  // browser, which carries the user's own real RC session — the reason the manual flow works
  // at all. Asking them to "sign in" here would open that browser, navigate away from this
  // screen, and report nothing back, so the gate could never lift.
  if (!canInject) return 'finish';
  if (rcCheck === 'opening') return 'waiting';
  // VERIFIED IS THE FAST PATH; UNCONFIRMED IS NOT A BLOCKER. A confirmed token is the exact
  // fact the precart needs, so it goes straight through. But "we could not confirm a session"
  // and "there is no session" are different facts, and only the second would justify standing
  // between a user and a site that is already theirs to take — the precart's own sign-in
  // state is a better place to land than a button they cannot get past.
  if (rcCheck === 'verified' || rcCheck === 'unconfirmed') return 'finish';
  return 'sign-in';
}
