/**
 * THE PER-RELEASE SIGN-IN BUDGET — the decision, separated from the file it lives in.
 *
 * `maybeAutoLogin` gets `AUTOLOGIN_MAX_ATTEMPTS` sign-ins per release and no more, because
 * repeated logins from this address are what cost the household IP twelve hours on
 * 2026-08-06. The budget was module state in `rc-keepwarm.mjs` until 2026-08-20, and
 * `supervise.ps1` restarts that process on exit — so every restart re-issued the whole thing.
 * That is the crash-loop-spends-the-login-budget shape, unbounded and invisible.
 *
 * ## The naive fix would have made 2026-08-20 worse, which is why this module exists
 *
 * That accidental refund is what saved the 08:00 cart:
 *
 *     07:30  attempt 1 -> 9.4 GB Okta ramp -> the RAM guard killed the browser
 *     07:43  the supervisor restarted the process
 *     07:48  attempt 2 -> signed in, 60m token
 *     08:00  carted at T+2s
 *
 * Persisting a plain counter would have counted attempt 1 and left one attempt of margin
 * instead of two, on the one morning any of this was measured.
 *
 * ## So: a KILLED attempt is inconclusive, and is refunded — once
 *
 * An attempt killed mid-navigation observed no credential outcome. RC was never told yes or
 * no, which is exactly `provedNothing` — the case `maybeAutoLogin` already refunds — and the
 * rule this codebase applies everywhere: **we could not ask is not the same as being told
 * no.** `hasAvailabilityInRange` returning null, `oktaSessionAlive`'s unknown, a blank RC app
 * load: same shape, same answer.
 *
 * What changes is that the refund is now made BY THE RECORD instead of by the accident of
 * process memory, so it is bounded and legible. `startedAt` is set when an attempt begins and
 * cleared when it reaches any verdict, so a file found with it still set can only mean the
 * process died mid-attempt. `killed` bounds how often that may be forgiven — without it, a
 * process that dies on every attempt refunds for ever and the budget stops existing, which is
 * the very thing being fixed.
 *
 * ## Why this is a module and not six lines in rc-keepwarm.mjs
 *
 * Importing that file STARTS the keep-warm loop, so nothing in it can be unit-tested; the
 * same reasoning already produced `session-coverage.mjs`, `renewal-schedule.mjs` and
 * `rehearsal.mjs`. This decision has one arm that only ever runs after a crash, which is
 * precisely the arm nobody will exercise by hand.
 *
 * NO FILESYSTEM HERE, deliberately. The caller owns reading and writing; this owns the rule.
 * A test that had to stub `fs` to ask "is a killed attempt refunded?" would be testing the
 * stub.
 */

/** How many kill-refunds ONE release may have. A crash loop must still run out. */
export const MAX_KILL_REFUNDS = 1;

/** A budget nothing has spent. */
export function blankBudget() {
  return { release: null, spent: 0, lastAt: 0, startedAt: 0, killed: 0 };
}

/**
 * Normalise a budget read back from disk, and settle any attempt that never finished.
 *
 * Returns `{ budget, refunded }` — `refunded` so the caller can SAY it happened. A refund
 * that is silent is indistinguishable from a budget that was never spent, and at 07:45
 * somebody reading the log needs to know an attempt was killed rather than skipped.
 *
 * ANYTHING UNREADABLE IS A FRESH BUDGET, NEVER A SPENT ONE. A box that has never run this and
 * a corrupt file both land here, and refusing to sign in because a counter would not parse
 * turns a diagnostics problem into a missed cart. The failure direction is the opposite of
 * `claimSyncJob`'s, which fails CLOSED because a doubled catalog sync is worse than a skipped
 * one; here the skipped login is the worse half.
 */
export function settleBudget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { budget: blankBudget(), refunded: false };
  }
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const budget = {
    release: typeof raw.release === 'string' ? raw.release : null,
    spent: num(raw.spent),
    lastAt: num(raw.lastAt),
    startedAt: num(raw.startedAt),
    killed: num(raw.killed),
  };

  // AN ATTEMPT THAT NEVER REACHED A VERDICT. `startedAt` is cleared on every terminal path,
  // so finding it set means the process died mid-attempt: the RAM guard, a supervisor stop,
  // a power cut. Nothing was learned from it, so give it back — within the bound.
  const refunded = budget.startedAt > 0 && budget.spent > 0 && budget.killed < MAX_KILL_REFUNDS;
  if (refunded) {
    budget.spent -= 1;
    budget.killed += 1;
  }
  // CLEARED WHETHER OR NOT IT WAS REFUNDED. Leaving it set would re-offer the same refund on
  // the next restart, turning a bounded allowance into an unbounded one by a different route.
  budget.startedAt = 0;
  return { budget, refunded };
}

/**
 * Start a fresh budget for a release we have not seen before.
 *
 * A NEW RELEASE IS A NEW BUDGET, including the kill allowance: `killed` is about surviving one
 * bad attempt for THIS cart, and carrying it forward would silently halve tomorrow's margin.
 */
export function budgetForRelease(budget, release) {
  if (budget && budget.release === release) return budget;
  return { ...blankBudget(), release };
}
