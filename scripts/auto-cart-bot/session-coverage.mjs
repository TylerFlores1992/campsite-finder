/**
 * Does the RC session we have cover the hold we are about to cart?
 *
 * Two decisions, pulled out as pure functions because both were wrong in production on
 * 2026-08-15 and neither could be tested where it lived — one sat inside a Playwright call
 * chain, the other inside a loop that starts on import. Same reasoning as `relogin-retry.mjs`
 * and `rehearsal.mjs`: the part that can lose a campsite is the part that gets a test.
 *
 * THE FAILURE THESE ENCODE. At 07:30:42 PT, thirty minutes before a real release:
 *
 *     ⏰ hold releases in 30m and the session will not cover it — signing in ONCE
 *         → already signed in — nothing to do
 *       ✓ signed in unattended — the hold is covered
 *
 * `maybeAutoLogin` computed that the token would not last, called `attemptLogin` to fix it,
 * and `attemptLogin` short-circuited on "is there a session?" — a question whose answer was
 * yes and whose relevance was nil. The token had 23 minutes, needed 50, died at 07:53, and
 * the 08:00 cart failed with the one attempt already spent.
 */

/**
 * How much token life a hold needs, in seconds.
 *
 * "Covered" means alive until the release AND through the cart hold, because the bot must
 * still be able to RELEASE the unit when the user taps claim — `remove/cartentry` runs on
 * the bot's session. A token that dies at T+5 carts fine and then strands the user.
 *
 * EVALUATED WHERE WE STAND, which is the fix. `AUTOLOGIN_MIN_TOKEN_MIN` is derived for the
 * moment the lead opens (L + cart hold + margin) and was then applied at every moment inside
 * it — so at T−5 it demanded fifty minutes of token to cover twenty minutes of work, and a
 * perfectly good session read as insufficient. Rationing logins only works if the ration is
 * spent on real shortfalls.
 *
 * `minsUntilRelease` is clamped at zero: past the release the remaining work is the cart plus
 * the hold, and a negative would quietly shrink the requirement below what the claim needs.
 */
export function requiredTokenSeconds(minsUntilRelease, cartHoldMin, marginMin) {
  return (Math.max(minsUntilRelease, 0) + cartHoldMin + marginMin) * 60;
}

/**
 * May we stop here and call the session good enough?
 *
 * `live` is the old question and is still necessary — no session, nothing to accept.
 * `enough` is the new one, and its THREE-VALUED shape is the whole point:
 *
 *   true   the token covers the deadline — accept
 *   false  it does not — do the real sign-in
 *   null   we could not decode a token, so we do not know
 *
 * `null` ACCEPTS. Rejecting would force a sign-in, and a sign-in here first drops the stored
 * token — a destructive act, taken on an unknown, against a session that may have been
 * perfectly healthy. That is the rule `hasAvailabilityInRange` returning `null` exists for and
 * the rule that keeps `oktaSessionAlive`'s unknown from being reported as dead: an absent
 * reading is not a negative one. A caller that passes no opinion at all (`undefined`) is
 * saying it has no deadline — the rehearsal and `--test-login` — and gets the old behaviour.
 */
export function sessionAcceptable(live, enough) {
  if (live !== true) return false;
  return enough !== false;
}
