/**
 * Should the bot rehearse its ReserveCalifornia login right now?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Three consecutive 08:00 holds failed, and all three failed AT LOGIN. Every one was found
 * at 07:30 with twenty minutes to act, because we kept treating the 08:00 release as the
 * test. It is not the test — it is the exam, and by then the answer costs a campsite.
 *
 * `node rc-keepwarm.mjs --test-login` has always been able to prove the login works. It was
 * never scheduled, so it only ran when somebody already suspected trouble. This is the
 * missing cadence, not a missing ability.
 *
 * ── WHY IT IS SO HEAVILY GATED ─────────────────────────────────────────────────────────
 * A login is not free. Repeated sign-ins from this address cost 12 hours of IP block on
 * 2026-08-06, and the standing rule everywhere else is ONE attempt per release. A daily
 * rehearsal roughly doubles that rate, which is worth it only if it is genuinely daily,
 * genuinely far from a hold, and genuinely skipped when it would prove nothing.
 *
 * Pure decision, no clock and no I/O of its own — see worker/rehearsal.test.mts.
 */

/** Pacific hour to rehearse at. Evening: a failure still leaves a whole night to fix it. */
export const REHEARSAL_HOUR = 20;

/**
 * Never rehearse within this many hours of a release.
 *
 * The rehearsal takes the Chromium profile lock and spends a login. Doing either near a
 * cart risks the thing it exists to protect — the same reasoning as the update guard's
 * release check, and for the same reason it is not liftable.
 */
export const REHEARSAL_MIN_HOURS_TO_RELEASE = 6;

/** One a day. The point is a daily signal, not a tighter loop on a rate-limited login. */
export const REHEARSAL_MIN_GAP_H = 20;

/**
 * @param {{ pacificHour: number, hoursToRelease: number|null, sessionLive: boolean|null,
 *           hoursSinceLastRun: number|null, hasCredentials: boolean }} s
 * @returns {{ run: boolean, why: string }}
 */
export function shouldRehearse(s) {
  const {
    pacificHour, hoursToRelease = null, sessionLive = null,
    hoursSinceLastRun = null, hasCredentials = true,
  } = s;

  // Nothing to rehearse: the manual reconnect is the only path anyway.
  if (!hasCredentials) return { run: false, why: 'no saved password' };

  if (pacificHour !== REHEARSAL_HOUR) return { run: false, why: 'not the rehearsal hour' };

  if (hoursSinceLastRun != null && hoursSinceLastRun < REHEARSAL_MIN_GAP_H) {
    return { run: false, why: `rehearsed ${Math.round(hoursSinceLastRun)}h ago` };
  }

  // A hold too close: the lock and the login both belong to the cart tonight.
  if (hoursToRelease != null && hoursToRelease >= 0 && hoursToRelease < REHEARSAL_MIN_HOURS_TO_RELEASE) {
    return { run: false, why: `a hold releases in ${hoursToRelease.toFixed(1)}h` };
  }

  // A LIVE SESSION MAKES THE REHEARSAL MEANINGLESS. `attemptLogin` short-circuits on
  // `isLive()` — by design, since that check is what stopped it reporting phantom failures
  // on 2026-08-09 — so it would return ok without exercising one line of the sign-in. That
  // is a PASS THAT PROVED NOTHING, which is worse than a skip because it reads as evidence.
  //
  // In practice this costs almost nothing: the token lasts ~60 minutes, so the session is
  // dead for roughly 23 hours a day and the evening slot is nearly always a real rehearsal.
  if (sessionLive === true) return { run: false, why: 'the session is live — a rehearsal would prove nothing' };

  return { run: true, why: 'rehearsing the sign-in' };
}

// HOW A STORED REHEARSAL IS READ lives in src/lib/health-thresholds.ts, not here.
// The two consumers — the health check and the holds readout — are both server-side
// TypeScript, and the mini-PC never reads its own results back. A copy on this side would
// be a second definition of "stale" that nothing compares against the first, which is the
// mistake `health-thresholds.ts` was created to stop.
