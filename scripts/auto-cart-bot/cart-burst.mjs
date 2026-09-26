/**
 * SHOULD THE CART TRY AGAIN, RIGHT NOW?
 *
 * ## The loss this exists to stop, measured 2026-09-03
 *
 * `#L005` at Leo Carrillo was tapped for the 08:00 PT release and never carted. The runner
 * was healthy and tried ~100 times over the 20-minute grace; RC refused every one with
 * *"The unit is not available for the date(s) specified."*
 *
 * The owner's reading — that a human refreshing at 8am can cart one of these sites in a
 * second or two — is supported by our own numbers rather than contradicted by them:
 *
 *   our carts at quiet, arbitrary release times     T+1s  T+1s  T+2s  T+2s  T+2s  T+3s  T+4s
 *   our carts at real 08:00 PT releases             T+3s (#123)   T+6s (#94)
 *   gap between our retries, measured from the log  min 10s   MEDIAN 12s   max 24s
 *
 * And the same morning, at the same park, the poller watched `rc-542::42527` open at
 * 08:00:13 and be gone by its next 15-second cycle. Sites there are taken in seconds.
 *
 * ## WHEN RC ACTUALLY LETS GO — and why we do NOT know it is never early
 *
 * The lock's `availableAt` is a PREDICTION. Against the poller's own transition alerts for
 * held units we never carted (so the alert is a first sighting, not a re-alert after we
 * released a cart):
 *
 *     #133  T+3s   #133  T+3s   #133  T+4s   #133  T+4s
 *     #L045 T+10s  #L034 T+13s  #54   T+13s  #78   T+28s
 *
 * Every sighting is at or after T. **THAT IS NOT THE SAME AS "NEVER EARLY", AND READING IT
 * THAT WAY WAS WRONG (corrected 2026-09-03, on the owner's challenge).** The poller samples
 * every FIFTEEN SECONDS, so an alert at T+3s means only that the first sample after the flip
 * landed at T+3s — the flip itself is anywhere in (T-12s, T+3s]. Four of the eight readings
 * above are entirely consistent with the site opening BEFORE the predicted release. The
 * instrument's resolution swallows the whole question.
 *
 * Two things that would have settled it, and neither did:
 *
 *   - **We had never once asked.** The runner waits out `msUntilRelease` by design, so there
 *     was exactly ONE early-cart observation in the project's history — 2026-08-08, at 85
 *     seconds early, refused. That says 85s is too early. It said nothing about 5s.
 *   - **RC's clock is not the culprit.** Measured 2026-09-03 across five round trips:
 *     `rdapi.reservecalifornia.com`'s Date header is within ONE SECOND of ours. Gross skew
 *     is ruled out at the edge (not at the booking tier, which nothing here can see).
 *
 * **So the burst started BEFORE T, and that is how the question got answered.**
 *
 * ## IT IS ANSWERED NOW, BY TWO INSTRUMENTS, AND RC LETS GO WITHIN ~4 SECONDS OF T
 *
 * `scripts/rc-release-window.mts` polls a facility's whole grid across a release at TWO-second
 * resolution and stores the flip as a BRACKET (`rc_release_readings`, migration 076) — last
 * seen locked, first seen free, never a midpoint. Eight facility readings across three
 * mornings:
 *
 *     09-09  rc-539  (-0.9, +1.1]     09-10  rc-539  (-3.5, -1.5]   <- entirely BEFORE T
 *     09-09  rc-583  (-1.6, +0.4]     09-10  rc-542  (-2.9, -0.9]   <- entirely BEFORE T
 *     09-24  rc-357  (-1.9, +0.1]     09-10  rc-583  (-4.2, -2.2]   <- entirely BEFORE T
 *     09-24  rc-359  (-1.2, +0.8]     09-24  rc-360  (   ---, +1.4]
 *
 * And this lane's own ten bursts are the second instrument. Six wins: **T-0.9, T-0.5, T+0.1,
 * T+0.5, T+0.5, T+0.9** — two of them BEFORE the predicted release, which no amount of
 * 15-second sampling could ever have shown.
 *
 * **So the flip is within about four seconds of T on every measurement we have**: the deepest
 * "still locked" observation is T-4.2s and the latest "first free" is T+1.4s. `BURST_LEAD_MS`
 * is derived from that now rather than from the poller's cadence — see below.
 *
 * (`rc-360`'s lower bound reads +241.2s, larger than its own upper bound, so it is an artifact
 *  of a night whose lock named a different release. Quote the seven clean brackets.)
 *
 * ## Why this is a separate module
 *
 * Importing `rc-hold-runner.mjs` starts the runner, which is what made the most
 * release-critical code in the product untestable — the same reason `claim.ts`,
 * `hold-claim.ts`, `hold-line.ts` and `session-coverage.mjs` were each pulled out. Every
 * rule below is a way this could do harm, so every rule is guarded.
 */

/**
 * How long the fast lane lasts, from the release moment.
 *
 * 30s covers every flip this project has ever observed (worst: T+28s) with margin. It is
 * deliberately NOT longer: past the burst the ordinary ~12s feed lane still retries for the
 * whole 20-minute grace, which is what catches the rare very-late lapse.
 */
export const BURST_WINDOW_MS = Number(process.env.RC_BURST_WINDOW_MS || 30_000);

/**
 * How far BEFORE the predicted release the fast lane opens.
 *
 * DERIVED FROM THE MEASURED FLIP, not from the poller's cadence — and that is a CHANGE, made
 * 2026-09-25 after three tapped holds in one release exhausted the shared budget before T.
 *
 * It was 15s, derived from the poller's own sampling floor: a flip up to 15s before T was
 * indistinguishable from one at T in every reading we had, so fifteen seconds was exactly the
 * uncertainty and therefore exactly the lead. **That uncertainty has since been measured
 * away.** The header above has the eight brackets and the six wins; the deepest "still
 * locked" observation on record is **T-4.2s**, so 5s starts one poll before the earliest
 * instant RC has ever been seen still holding, and the rest of that old lead was being spent
 * on a window RC has never used.
 *
 * ## AND AN EARLY ASK IS NOT FREE, WHICH IS THE HALF THAT WAS WRONG
 *
 * The old reasoning was that the cost is a handful of refusals, which the slow lane already
 * absorbs. **True at one or two holds and false at three**, because `BURST_BUDGET` is shared
 * across the release group: an attempt spent before T is an attempt not available after it.
 * Measured 2026-09-25, three tapped holds for one 08:00 release —
 *
 *     #GBOB  14 attempts, ending T-1.0s, "the burst budget is spent"
 *     #R367  14 attempts, ending T-1.6s, "the burst budget is spent"
 *     #A113  15 attempts, won at T-0.5s  <- only because RC let go early
 *
 * — 43 attempts, every one of them BEFORE the release, and the lane never reached the moment
 * the sites actually opened. At one hold the budget covers the whole span, which is why this
 * was invisible for the lane's first four releases.
 *
 * The fix is the lead and NOT the budget: 40 is what keeps thirty seconds of POSTs from a
 * residential IP looking like an attack to RC's WAF, and raising it is the trade that
 * constant exists to refuse. Shortening the lead spends the same total where the site can
 * actually be won.
 *
 * **What this buys, stated at its limit:** a better-AIMED burst, not a guaranteed win. Nobody
 * knows when `#GBOB` actually freed, so the gain is somewhere between ~1s and ~15s of reach.
 *
 * ## AND `BURST_RELEASE_RESERVE` FIXES THE SAME INCIDENT, SO BE PRECISE ABOUT WHAT IS LEFT
 *
 * The reserve (below) makes an exhausted pool impossible: a hold that reaches it before T
 * **waits for T**. So the 09-25 loss above cannot recur from the reserve's side alone, and the
 * lead's remaining job is a DIFFERENT failure the reserve leaves — **silence.** Once the
 * discretionary share is gone every hold is asleep until T and nobody asks RC at all; at the
 * old 15s lead that runs from ~T-9.8s to T, and **two of this lane's six wins (T-0.9s and
 * T-0.5s) sit inside it.**
 *
 * The two constants are therefore sized TOGETHER, with 133ms of margin: `40 - 18` = 22
 * discretionary attempts plus one uncharged first attempt per `pMap` slot is 28, i.e.
 * `(6 + 22) / 6 x 1.1s` = 5.13s of asking against this 5.0s lead — so at 5s the reserve is never
 * reached before T at any group size. **Raising `CART_CONCURRENCY` past 6 or the reserve past 18
 * eats that margin** (at 7 slots the cover is 4.6s, at reserve 19 it is 4.95s, and the silence
 * re-opens over exactly the win band), and `worker/cart-burst.test.mts` fails on either bump
 * taken alone.
 */
export const BURST_LEAD_MS = Number(process.env.RC_BURST_LEAD_MS || 5_000);

/** Gap between attempts inside the window. Each attempt is itself ~1s of RC round trips. */
export const BURST_GAP_MS = Number(process.env.RC_BURST_GAP_MS || 500);

/**
 * Total attempts the fast lane may spend, SHARED ACROSS THE WHOLE RELEASE GROUP.
 *
 * Shared, not per-hold, and that is the difference between a burst and an incident. Carts
 * run `CART_CONCURRENCY` at a time, so a per-hold budget would multiply by the number of
 * holds — six holds each spending twenty attempts is 120 POSTs in thirty seconds from a
 * residential IP that has eaten a 12-hour block from RC's WAF before.
 */
export const BURST_BUDGET = Number(process.env.RC_BURST_BUDGET || 40);

/**
 * How much of the shared pool only the release moment may spend.
 *
 * ## The loss, measured 2026-09-25
 *
 * Three holds shared one release. Each opened the lane at T-15s and retried about once a
 * second, so the pool of 40 went in thirteen seconds: `#GBOB` 14 attempts ending T-1.0s,
 * `#R367` 14 ending T-1.6s, `#A113` 15 ending T-0.5s (14 + 14 + 15 = 43, because a hold's
 * FIRST attempt is not charged). Every site at that release freed between T+0.1s and T+1.4s
 * (09-24's release-window instrument), so the burst was spent entirely on the part of the lane
 * that has never once caught a site. `#GBOB` was caught 17 seconds later by the slow lane,
 * which was luck; `#R367` never carted.
 *
 * One hold never trips this: at the 5s lead it spends ~5 before T and keeps 35. It is the SHARED pool that
 * makes the pre-T lead scale with the number of holds, while the release moment is the one
 * instant every hold needs at once.
 *
 * ## Why a reserve and not a bigger or per-hold budget
 *
 * Both of those raise the POSTs from a residential IP RC's WAF has blocked for twelve hours.
 * This raises nothing: the total is still `BURST_BUDGET`. It only refuses to let the
 * speculative half of the lane (before T) spend the part the productive half (T onwards)
 * needs. A hold that reaches the reserve early WAITS for T rather than dropping to the slow
 * lane, which is the whole point: it arrives at the release with attempts in hand.
 */
export const BURST_RELEASE_RESERVE = Number(process.env.RC_BURST_RELEASE_RESERVE || 18);

/**
 * Is this refusal the one that means "the lock has not lapsed yet"?
 *
 * CONSERVATIVE BY CONSTRUCTION: anything we do not positively recognise stops the burst.
 * The dangerous direction is retrying fast into a fault that fast retries make worse — a
 * WAF 403, a rate limit, a dead session, a wedged browser. Those must fall back to the slow
 * lane, where a human still has twenty minutes of ordinary retries.
 *
 * `already added` is deliberately NOT here: it means the site is in a cart we hold, which
 * the caller's read-back resolves. `maximum reservations` is a capacity refusal — retrying
 * cannot change it.
 */
export function isNotAvailable(err) {
  const s = String(err ?? '').toLowerCase();
  if (!s.includes('not available')) return false;
  return !s.includes('maximum') && !s.includes('already added');
}

/**
 * @param waitedForRelease did THIS pass sleep until the release moment? The single most
 *   important input. A pass twelve minutes later is an ordinary retry and must never burst:
 *   without this the runner would fire a fresh burst on every feed poll for the whole
 *   20-minute grace — roughly a hundred bursts, thousands of POSTs, which is not a fast
 *   lane but a denial-of-service against the site we are trying to book from.
 * @param elapsedMs since the release moment.
 * @param budgetLeft attempts remaining in the group's shared pool.
 * @param lastError RC's own words from the attempt that just failed, or null.
 * @param timedOut the precart gave up on an unresponsive page — ours, not RC's.
 * @param reserve attempts that only T onwards may spend (see BURST_RELEASE_RESERVE).
 * @returns {{retry: boolean, waitMs: number, reason: string, spend: boolean}} `spend: false`
 *   means the caller must NOT charge the pool for this wait, because no attempt was made
 *   early on its behalf. The caller's own attempt at T is charged as usual.
 */
export function shouldRetryBurst({
  waitedForRelease, elapsedMs, budgetLeft, lastError, timedOut,
  windowMs = BURST_WINDOW_MS, gapMs = BURST_GAP_MS, reserve = BURST_RELEASE_RESERVE,
}) {
  if (!waitedForRelease) return { retry: false, waitMs: 0, reason: 'not the release pass' };
  // OURS, NOT RC'S. A page that would not answer is a browser fault; hammering it makes the
  // wedge worse and tells us nothing. Same distinction the failure note already draws.
  if (timedOut) return { retry: false, waitMs: 0, reason: 'the page did not answer' };
  if (!isNotAvailable(lastError)) {
    return { retry: false, waitMs: 0, reason: `RC said something else: ${String(lastError ?? 'nothing').slice(0, 60)}` };
  }
  if (budgetLeft <= 0) return { retry: false, waitMs: 0, reason: 'the burst budget is spent' };
  if (elapsedMs >= windowMs) {
    return { retry: false, waitMs: 0, reason: `${Math.round(windowMs / 1000)}s window closed` };
  }
  // BEFORE T, THE RESERVE IS NOT OURS TO SPEND. Wait for the release instead of either
  // retrying into the reserve or giving up: a hold that stops here would fall to the ~12s slow
  // lane at exactly the moment sites free, which is the 2026-09-25 loss.
  if (elapsedMs < 0 && budgetLeft <= reserve) {
    return { retry: true, waitMs: Math.max(gapMs, -elapsedMs), reason: 'saving the burst for the release', spend: false };
  }
  return { retry: true, waitMs: gapMs, reason: 'the lock may not have lapsed yet', spend: true };
}

/**
 * One line for the log, so a morning that lost a site says what it spent trying.
 *
 * NAMES THE ELAPSED TIME, not just the count. "18 attempts" is not a finding; "18 attempts
 * across 29.4s and RC never let go" is, because it can be read against the T+3s..T+28s
 * distribution above.
 */
export function describeBurst({ attempts, elapsedMs, won, reason = '' }) {
  // SIGNED, because a negative one is the finding. `T-4.2s` means RC let go BEFORE its own
  // predicted release — the thing 15-second sampling can never show and this lane can.
  const t = `${elapsedMs < 0 ? '-' : '+'}${(Math.abs(elapsedMs) / 1000).toFixed(1)}`;
  if (won) return `won it on attempt ${attempts} at T${t}s`;
  return `${attempts} fast attempt(s) ending T${t}s, then the slow lane — ${reason}`;
}
