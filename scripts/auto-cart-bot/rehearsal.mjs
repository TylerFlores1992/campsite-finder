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
 * The identity of tonight's rehearsal window — a Pacific date — or null outside the hour.
 *
 * ── WHY THIS EXISTS (2026-08-12) ───────────────────────────────────────────────────────
 * The caller keeps ONE variable so a skip is written down once a night instead of on every
 * poll through the hour. That variable held the HOUR NUMBER and was never reset, so it
 * latched at 20 for the life of the process: the first night the hour was reached recorded
 * its outcome, and **every night after it was silent**.
 *
 * The cost is not a missing log line. `rc_login_rehearsal` holds one row, and on 2026-08-12
 * the rehearsal did not run and left NOTHING behind — the row still read 08-11. So "the
 * gates stood it down, and here is which one" and "the process never reached 20:00 at all"
 * produced the identical evidence: silence. Those are different faults with different
 * fixes, and telling them apart is the entire job of an instrument that exists to warn
 * somebody the evening BEFORE a cart.
 *
 * That is this codebase's oldest failure shape — `notifications.status = 'sent'` meaning
 * only "Twilio returned 2xx", `claimBotCommands` returning `[]` for both "nobody asked" and
 * "the query threw". Here it had eaten the watchdog's own watchdog.
 *
 * A DATE CANNOT LATCH: tomorrow's window has a different key, so the skip is recorded again
 * — once — every night, for as long as the process lives.
 */
export function rehearsalSlot(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  // `hour12: false` yields '24' for midnight in some ICU builds; % 24 normalises it. It can
  // never equal REHEARSAL_HOUR either way, but a bare Number() would leave a 24 in play.
  if (Number(p.hour) % 24 !== REHEARSAL_HOUR) return null;
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * @param {{ pacificHour: number, hoursToRelease: number|null, sessionLive: boolean|null,
 *           hoursSinceLastRun: number|null, hasCredentials: boolean }} s
 * @returns {{ run: boolean, why: string }}
 */
/**
 * How long after an abnormal exit the rehearsal stays out of the way.
 *
 * WHY: on 2026-08-18 the runaway guard killed a browser at 03:00:24; the supervisor restarted
 * the process; and the rehearsal fired **24 seconds later**, against a browser that had just
 * come up on a box still recovering from 71% COMMIT. RC answered *"We're having trouble
 * loading the application"*, and `autocart.rc_login` went **FAIL — "1 hold(s) ahead will fail
 * unless a human signs in"** with a real hold twelve hours out.
 *
 * The session was healthy again minutes later, so that verdict was almost certainly false —
 * and it is expensive in two ways at once: it spends the once-per-20h budget, and it points a
 * human at the box over a system that is working. That is the cry-wolf failure this codebase
 * has fixed three times, and this time OUR OWN containment created it.
 *
 * Five minutes is longer than the restart plus RC's app load and far shorter than the
 * rehearsal hour, so a genuine rehearsal still happens the same evening.
 */
export const REHEARSAL_QUIET_AFTER_RESTART_MIN = 5;

export function shouldRehearse(s) {
  const {
    pacificHour, hoursToRelease = null, sessionLive = null,
    hoursSinceLastRun = null, hasCredentials = true,
    minutesSinceAbnormalExit = null,
  } = s;

  // Nothing to rehearse: the manual reconnect is the only path anyway.
  if (!hasCredentials) return { run: false, why: 'no saved password' };

  // A BROWSER THAT JUST CAME UP AFTER A RUNAWAY IS NOT A FAIR TEST. See the constant above.
  // `null` means "no abnormal exit on record", which is the ordinary case and must not gate
  // anything — the same rule as `unknown` never rounding to a verdict.
  if (minutesSinceAbnormalExit != null && minutesSinceAbnormalExit < REHEARSAL_QUIET_AFTER_RESTART_MIN) {
    return {
      run: false,
      why: `the browser was killed ${Math.round(minutesSinceAbnormalExit)}m ago — a rehearsal now `
         + 'would test the restart, not the login',
    };
  }

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
