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
 * ── IT TOOK SECONDS, AND IT USED TO TAKE ROUNDED MINUTES (2026-08-30) ──────────────────
 * `minutesUntil()` returned `Math.round(...)`, so the requirement was a SIXTY-SECOND
 * STAIRCASE while the token's remaining life is a continuous ramp. A deficit of a few
 * seconds therefore lands inside the rounding error, and the comparison is decided by where
 * in the minute the poll happens to fall rather than by the arithmetic.
 *
 * It cost a real campsite. Reconstructed from the box's own two log lines:
 *
 *     07:29:44  "the token covers this hold (50m left, needs 50m)"   ← left ∈ (3000, 3030]s
 *     07:51:58  "the session will not cover it — signing in"          ← left ≤ 1680s
 *
 * which brackets the token's expiry at 08:19:44–08:19:58 against a requirement of 08:20:00.
 * The token was between TWO AND SIXTEEN SECONDS short. Rounding read that as covered
 * twenty-two times across twenty-one minutes — the whole safe window — and then flipped at
 * T−8, when signing in is the worst move available: the Okta navigation ran into the
 * release, the keep-warm died at T−18s, and the site went to somebody else.
 *
 * In seconds the very first poll answers "not covered" (required 3016s against left ≤ 3014s)
 * and the sign-in happens at T−30 with thirty minutes of runway.
 *
 * THE PARAMETER IS SECONDS AND THE FUNCTION WAS RENAMED FOR THAT REASON. Passing minutes to
 * a seconds parameter under-requires by a factor of sixty and stands the login down — the
 * exact failure above, silently. A rename makes a stale `import { requiredTokenSeconds }`
 * a link-time error instead.
 *
 * `secsUntilRelease` is clamped at zero: past the release the remaining work is the cart plus
 * the hold, and a negative would quietly shrink the requirement below what the claim needs.
 */
export function tokenSecondsNeeded(secsUntilRelease, cartHoldMin, marginMin) {
  return Math.max(secsUntilRelease, 0) + (cartHoldMin + marginMin) * 60;
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
