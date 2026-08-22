/**
 * PAY FOR THE EXPENSIVE OKTA TRIP WHEN NOTHING IS AT RISK.
 *
 * A ReserveCalifornia sign-in comes in two wildly different sizes, and which one you get is
 * decided entirely by whether an Okta session already exists. Measured on this box five days
 * apart:
 *
 *     okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB
 *     okta=GONE    full password form             12 minutes,  +9,434 MB
 *
 * `maybeAutoLogin` is the only thing that establishes a session before a release, and it acts
 * ONLY inside `AUTOLOGIN_LEAD_MIN` (30m). So the twelve-minute, nine-gigabyte variant is
 * STRUCTURALLY PINNED to the release-critical window — it can happen at no other time. That
 * is the defect this module removes, and it is not a hypothetical:
 *
 *     07:29  12%   rc   300 MB  pid 6360    flat
 *     07:31  64%   rc 2,811 MB  pid 6452    the auto-login's Okta navigation
 *     07:41  76%   rc 9,434 MB  pid 6452
 *     07:43  12%   rc   230 MB  pid 7560    the RAM guard killed it
 *
 * ── WHY THE TIMING IS THE WHOLE POINT ─────────────────────────────────────────────────────
 * A RAM-guard kill leaves the Chromium profile lock reading HELD for `STALE_MS` (10 min), and
 * only a living holder renews it — so nothing can preempt it cooperatively, because nothing
 * is left to read `.camphawk-profile-wanted`. **A kill at 07:33 clears by 07:43 and is
 * harmless. A kill at 07:53 holds the lock past 08:00 and the hold runner cannot take the
 * profile to cart.** On 08-20 the cart survived only because `supervise.ps1` happened to
 * restart the process in time — which the budget module records as luck, not design.
 *
 * Run the same trip at T−3h and every one of those failure modes is free: the lock clears
 * hours before the cart, a supervisor restart has all the time it needs, and the RAM guard
 * firing costs nothing anyone will notice.
 *
 * ── WHAT THIS DOES *NOT* CLAIM ────────────────────────────────────────────────────────────
 * It does NOT make the expensive trip cheaper, and it does not fix the leak. The 9.4 GB is
 * still allocated; it is MOVED to a moment where losing the browser is survivable. The
 * throwaway tab (2026-08-20) is the change that might reclaim it, and that remains unproven
 * at this size. Two independent mitigations for one hazard, deliberately not conflated —
 * crediting a repair to the wrong mechanism has cost this project three times.
 *
 * ── IT DOES NOT ADD A PASSWORD SIGN-IN, IT MOVES ONE ──────────────────────────────────────
 * The obvious objection is the strongest one: repeated logins from this address cost the
 * household IP twelve hours on 2026-08-06, and an extra sign-in per release is exactly that
 * risk. It is not what happens. The warm-up fires ONLY when Okta is gone — i.e. only when the
 * T−30 login was going to be a full password form anyway. Afterwards Okta is alive, so the
 * T−30 login is answered from the `idx` cookie with **no credential submitted at all**. Net
 * password submissions per release: one, exactly as today. What changes is when.
 *
 * That is also why the token's ~60-minute life is not an objection. The warm-up cannot cover
 * the release — `AUTOLOGIN_MIN_TOKEN_MIN`'s arithmetic (a login at T−L must still be alive at
 * T+15, so L ≤ 45) rules that out and always did. The warm-up is not trying to. It leaves an
 * OKTA SESSION behind, and that is what the T−30 login spends.
 *
 * ── UNKNOWN STANDS DOWN, WHICH IS THE RULE THAT MAKES THIS SAFE ───────────────────────────
 * `oktaSessionAlive` returns unknown for a busy profile, a 403 from RC's edge and a network
 * blip alike. Acting on that would submit a password on a guess, from the address that has
 * been blocked before, to fix a problem that may not exist. So `null` stands down and says
 * so — the same rule as `hasAvailabilityInRange` returning null, an unknown Okta probe never
 * being reported as dead, and `unknown` never rounding to `signed-out`. The failure direction
 * is always "we did nothing", which is precisely the status quo this improves on.
 *
 * ── WHY A MODULE ──────────────────────────────────────────────────────────────────────────
 * Importing `rc-keepwarm.mjs` STARTS the keep-warm loop, so nothing in it can be unit-tested.
 * Same reasoning as `session-coverage.mjs`, `renewal-schedule.mjs`, `rehearsal.mjs` and
 * `autologin-budget.mjs` — and this decision has arms (Okta unknown, budget spent) that will
 * never be exercised by hand.
 *
 * NO CLOCK AND NO NETWORK HERE. The caller supplies the minutes and the reading; this owns
 * the rule. A test that had to stub a browser to ask "does an unknown stand down?" would be
 * testing the stub.
 */

/**
 * How far ahead of a release the warm-up may run, in minutes.
 *
 * THREE HOURS IS BOUNDED FROM BOTH SIDES, and both bounds are measured rather than chosen.
 *
 * It must be far enough out that the failure modes are free: a RAM-guard kill holds the
 * profile lock for 10 minutes and a supervisor restart takes seconds, so anything past ~30
 * minutes already clears. Three hours is six times that margin.
 *
 * It must be near enough that the Okta session it establishes is still there at T−30. Okta's
 * window is a rolling ~12h idle timer that our own unconditional probe keeps refreshing
 * (12-for-12, 2026-08-18) — but there is an ABSOLUTE cap behind it (2026-08-19), and what
 * that cap is measured from is NOT established. So the honest move is to stay far inside any
 * plausible bound rather than reason about one nobody has pinned down: three hours needs the
 * session to survive 2.5 hours, and the shortest cap ever observed is many times that.
 *
 * DO NOT RAISE THIS TO "the night before" without measuring the cap first. That is the
 * version that looks obviously better — pay the cost at 20:00, sleep on it — and it is the
 * version the one cap observation says may quietly stop working.
 */
export const WARMUP_LEAD_MIN = Number(process.env.RC_AUTOLOGIN_WARMUP_LEAD_MIN || 180);

/**
 * ONE attempt per release, and no retry gap, because there is nothing to retry into.
 *
 * If the warm-up fails we are exactly where we would have been without it: `maybeAutoLogin`
 * still has its full budget at T−30 and still does the expensive trip. So a second attempt
 * buys a second password submission against the same address for no change in outcome. The
 * failure mode of this whole module is "the status quo", and it must stay that way.
 */
export const WARMUP_MAX_ATTEMPTS = 1;

/**
 * Is this a moment the warm-up could act at all, ignoring Okta and the budget?
 *
 * SPLIT OUT SO THE CALLER CAN AVOID PROBING OKTA ON EVERY TICK. `oktaSessionAlive` hits
 * `/api/v1/sessions/me`, and `checkAndReport` already calls it unconditionally every poll —
 * a second unconditional call would double our traffic to that endpoint from an address both
 * providers have blocked before, to answer a question that is irrelevant for all but a few
 * minutes a month.
 *
 * It is exported and `warmupPlan` calls it, so there is ONE definition of the window rather
 * than a copy in the caller that can drift. A second copy is how `content-rc.js` spent months
 * telling users to click a cart icon while `rc-cart.mjs` did the right thing.
 *
 * @returns {{open: boolean, why: string}}
 */
export function warmupWindowOpen(o) {
  const critical = o.criticalLeadMin;
  const lead = o.warmupLeadMin ?? WARMUP_LEAD_MIN;
  const mins = o.minutesUntilRelease;

  if (mins == null) return { open: false, why: 'could not read the release time' };
  if (mins > lead) {
    return { open: false, why: `the release is ${Math.round(mins)}m away, outside the ${lead}m warm-up window` };
  }
  /**
   * THE DISJOINTNESS IS LOAD-BEARING, NOT TIDINESS.
   *
   * Two sign-in drivers on one Chromium profile is worse than either alone: they would
   * contend for the profile lock, and a warm-up navigating to Okta at T−20 is precisely the
   * twelve-minute trip landing back inside the window this module exists to clear. `<=` and
   * not `<` so the boundary minute belongs to the release-critical caller, which is the one
   * that can lose a campsite.
   */
  if (mins <= critical) {
    return { open: false, why: `the release is ${Math.round(mins)}m away — inside the ${critical}m lead, where the auto-login owns this` };
  }
  return { open: true, why: `the release is ${Math.round(mins)}m away` };
}

/**
 * Should the warm-up sign in now?
 *
 * @param {object} o
 * @param {number|null} o.minutesUntilRelease  Minutes to the next real release, or null if it
 *   could not be read. Null is "we cannot tell" and stands down.
 * @param {boolean|null} o.oktaAlive  The last reading from `oktaSessionAlive`. `false` is the
 *   only value that acts; `null` (unknown) stands down deliberately.
 * @param {number} o.criticalLeadMin  `AUTOLOGIN_LEAD_MIN`. Inside this, `maybeAutoLogin` owns
 *   the profile and this must not act — see the disjointness note below.
 * @param {number} [o.warmupLeadMin]
 * @param {number} [o.spent]  Attempts already made for THIS release.
 * @param {number} [o.maxAttempts]
 * @returns {{go: boolean, why: string}} `why` is always a full sentence, because a silent
 *   gate is indistinguishable from a gate that never ran — the failure this project has
 *   fixed in the watchdog, the rehearsal and five auto-login gates.
 */
export function warmupPlan(o) {
  const critical = o.criticalLeadMin;
  const spent = o.spent ?? 0;
  const max = o.maxAttempts ?? WARMUP_MAX_ATTEMPTS;

  // ONE definition of the window — the caller gates its Okta probe on this same function.
  const win = warmupWindowOpen(o);
  if (!win.open) return { go: false, why: win.why };

  if (o.oktaAlive === true) {
    return { go: false, why: 'the Okta session is alive, so the sign-in at T-' + critical + ' will be answered from the cookie' };
  }
  if (o.oktaAlive == null) {
    // Never spend a password on a guess. See the header.
    return { go: false, why: 'the Okta session state is UNKNOWN — not signing in on a guess' };
  }
  if (spent >= max) {
    return { go: false, why: `the warm-up has already had its ${max} turn for this release` };
  }
  return {
    go: true,
    why: `${win.why} and Okta is GONE — signing in now, while a failed or guard-killed `
      + 'attempt still costs nothing',
  };
}
