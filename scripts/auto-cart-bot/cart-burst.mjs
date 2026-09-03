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
 * ## WHEN RC ACTUALLY LETS GO — 14 held units, and not one was early
 *
 * The lock's `availableAt` is a PREDICTION. Against the poller's own transition alerts for
 * held units we never carted (so the alert is the first sighting, not a re-alert after we
 * released):
 *
 *     #133  T+3s   #133  T+3s   #133  T+4s   #133  T+4s
 *     #L045 T+10s  #L034 T+13s  #54   T+13s  #78   T+28s
 *
 * **Zero opened BEFORE the predicted release. They open late, by 3 to 28 seconds.** So the
 * old behaviour fired once at T+0 — into a lock that had not lapsed yet — and then waited
 * TWELVE SECONDS, which is most of the window in which these sites exist. Firing EARLY is
 * not the fix and never was: RC refuses an early cart with the identical message (measured
 * 2026-08-08, a cart 85 seconds early), so it would buy nothing and cost a false signal.
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

/** Gap between attempts inside the window. Each attempt is itself ~1s of RC round trips. */
export const BURST_GAP_MS = Number(process.env.RC_BURST_GAP_MS || 500);

/**
 * Total attempts the fast lane may spend, SHARED ACROSS THE WHOLE RELEASE GROUP.
 *
 * Shared, not per-hold, and that is the difference between a burst and an incident. Carts
 * run `CART_CONCURRENCY` at a time, so a per-hold budget would multiply by the number of
 * holds — four holds each spending twenty attempts is eighty POSTs in thirty seconds from a
 * residential IP that has eaten a 12-hour block from RC's WAF before.
 */
export const BURST_BUDGET = Number(process.env.RC_BURST_BUDGET || 40);

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
 * @returns {{retry: boolean, waitMs: number, reason: string}}
 */
export function shouldRetryBurst({
  waitedForRelease, elapsedMs, budgetLeft, lastError, timedOut,
  windowMs = BURST_WINDOW_MS, gapMs = BURST_GAP_MS,
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
  return { retry: true, waitMs: gapMs, reason: 'the lock may not have lapsed yet' };
}

/**
 * One line for the log, so a morning that lost a site says what it spent trying.
 *
 * NAMES THE ELAPSED TIME, not just the count. "18 attempts" is not a finding; "18 attempts
 * across 29.4s and RC never let go" is, because it can be read against the T+3s..T+28s
 * distribution above.
 */
export function describeBurst({ attempts, elapsedMs, won, reason = '' }) {
  const t = (elapsedMs / 1000).toFixed(1);
  if (won) return `won it on attempt ${attempts} at T+${t}s`;
  return `${attempts} fast attempt(s) across ${t}s, then the slow lane — ${reason}`;
}
