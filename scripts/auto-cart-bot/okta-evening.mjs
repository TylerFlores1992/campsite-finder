/**
 * THE EVENING SIGN-IN, AND THE UPDATE WINDOW THAT MUST NOT KILL IT — pure decisions only.
 *
 * ── THE PROBLEM THIS ANSWERS (research, 2026-09-26 — NOT YET MEASURED ON THIS BOX) ──────
 * An Okta session has a HARD cap (believed 24h) counted from the sign-in that CREATED it,
 * plus a rolling idle window our 20-minute probe keeps pushing forward. Signing in again
 * while a session exists REUSES it and does NOT reset the cap. Our sessions are created at
 * the last minute (T−30, or the 05:00 warm-up), so the cap lands the NEXT morning and every
 * release morning re-runs a fresh sign-in — and each one can draw a CAPTCHA, at an hour when
 * nobody can be paged in time.
 *
 * The candidate fix: at ~20:00 PT the evening before a release, END the existing session and
 * sign in with the password, so a fresh cap starts twelve hours before the release instead of
 * thirty minutes before it — and so a CAPTCHA, if one comes, arrives while somebody is awake.
 *
 * EVERY PART OF THAT IS UNPROVEN HERE, so it is gated behind `RC_EVENING_SIGNIN` (off unless
 * "1"/"true"). With the flag off nothing in this file changes live behaviour: the keep-warm
 * never calls the evening path, and `updateWindow` returns update-guard's own DEFAULTS.
 *
 * ── WHY IT IS TIMID ─────────────────────────────────────────────────────────────────────
 * A password sign-in from the household IP is the act that cost twelve hours of block on
 * 2026-08-06. So it runs ONLY when a hold is offered or requested for the next release AND
 * the current cap would lapse before that release is safely over. An unknown Okta reading is
 * NEVER a reason to end a session — ending one is destructive, and `unknown` never rounds to
 * a verdict in this codebase.
 */

/**
 * Truthy only for "1" or "true" (any case). Anything else — including unset — is OFF.
 * @param {Record<string, string | undefined>} [env]
 */
export function eveningSigninEnabled(env = process.env) {
  const v = String(env?.RC_EVENING_SIGNIN ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Pacific hour the evening sign-in runs in. The rehearsal's hour, deliberately — see below. */
export const EVENING_SIGNIN_HOUR = 20;

/**
 * The believed Okta hard cap, in hours. A research figure, not a measurement — which is why
 * it is a parameter everywhere it is used and the decision is flag-gated.
 */
export const OKTA_SESSION_CAP_H = 24;

/** The cap must still be standing this long AFTER the release: the cart, the hand-off. */
export const CAP_MARGIN_AFTER_RELEASE_H = 1;

/**
 * Only for a release inside this band. Below the lower bound the rehearsal's own rule
 * applies (a login within six hours of a cart belongs to the cart); above the upper one the
 * release is not "tomorrow morning" and a cap minted tonight would not reach it anyway.
 */
export const EVENING_MIN_HOURS_TO_RELEASE = 6;
export const EVENING_MAX_HOURS_TO_RELEASE = 20;

/**
 * Should the keep-warm run the evening sign-in right now?
 *
 * `hoursToRelease` is to the NEXT release with a hold OFFERED OR REQUESTED on it — offered
 * counts, because an offer is tapped in the morning and the session it needs is the one we
 * mint tonight. `okta` is `oktaSessionAlive`'s reading plus the session's `createdAt`.
 *
 * @returns {{ run: boolean, endSession: boolean, why: string }}
 */
export function shouldEveningSignin(s) {
  const {
    enabled = false, pacificHour, hoursToRelease = null, hasCredentials = true,
    doneTonight = false, minutesSinceAbnormalExit = null,
    okta = null, now = new Date(), capHours = OKTA_SESSION_CAP_H,
  } = s;
  const no = (why) => ({ run: false, endSession: false, why });

  if (!enabled) return no('RC_EVENING_SIGNIN is off');
  if (!hasCredentials) return no('no saved password');
  if (pacificHour !== EVENING_SIGNIN_HOUR) return no('not the evening sign-in hour');
  if (doneTonight) return no('already ran tonight');
  if (minutesSinceAbnormalExit != null && minutesSinceAbnormalExit < 5) {
    return no('the browser was just restarted after an abnormal exit');
  }
  if (hoursToRelease == null) return no('no hold is offered or requested for a coming release');
  if (hoursToRelease < EVENING_MIN_HOURS_TO_RELEASE) {
    return no(`the release is ${hoursToRelease.toFixed(1)}h away — too close, the morning sign-in owns it`);
  }
  if (hoursToRelease > EVENING_MAX_HOURS_TO_RELEASE) {
    return no(`the release is ${hoursToRelease.toFixed(1)}h away — not tomorrow morning`);
  }

  const alive = okta?.alive ?? null;
  // UNKNOWN IS NOT GONE. Ending a session we could not read is destructive on a guess.
  if (alive === null) return no('could not read the Okta session — not ending it on a guess');

  // GONE: nothing to end. A sign-in now creates the session, and its cap starts tonight.
  if (alive === false) return { run: true, endSession: false, why: 'Okta session is gone — signing in tonight starts a fresh cap' };

  // ALIVE: only worth ending if its cap lapses before the release is safely over.
  const created = okta?.createdAt ? Date.parse(okta.createdAt) : NaN;
  if (!Number.isFinite(created)) return no('Okta session is alive but its creation time is unknown — not ending it on a guess');
  const capAt = created + capHours * 3_600_000;
  const needUntil = now.getTime() + (hoursToRelease + CAP_MARGIN_AFTER_RELEASE_H) * 3_600_000;
  if (capAt >= needUntil) {
    return no(`the current Okta cap (${((capAt - now.getTime()) / 3_600_000).toFixed(1)}h left) already covers the release`);
  }
  return {
    run: true,
    endSession: true,
    why: `the Okta cap lapses ${((capAt - now.getTime()) / 3_600_000).toFixed(1)}h from now, before the release `
      + `(${hoursToRelease.toFixed(1)}h) + ${CAP_MARGIN_AFTER_RELEASE_H}h — ending it and signing in fresh`,
  };
}

/**
 * The Pacific date that identifies tonight's evening slot, for the once-a-night stamp.
 * A DATE, not an hour — an hour latches (see rehearsal.mjs `rehearsalSlot`).
 */
export function eveningSlot(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// ── PIECE 3: THE UNREQUESTED UPDATE WINDOW ──────────────────────────────────────────────

/** The window with the flag ON: ends BEFORE the evening sign-in, so an update cannot land
 *  between the fresh session and the release. 18:00-18:59 PT; an update started at 18:59
 *  has the whole hour before 20:00 to finish. */
export const EVENING_UPDATE_WINDOW = { windowStart: 18, windowEnd: 19 };

/**
 * Which Pacific hours an UNREQUESTED update may run in.
 *
 * Flag off → exactly the `defaults` passed in (update-guard's DEFAULTS, 02:00-05:00), so the
 * guard's behaviour is byte-identical to today. Flag on → `EVENING_UPDATE_WINDOW`.
 *
 * This moves the SCHEDULE only. A REQUESTED update still bypasses the window, and the
 * six-hour release refusal still applies to everything — neither is touched here.
 */
export function updateWindow({ eveningSignin = false, defaults }) {
  if (!eveningSignin) return { windowStart: defaults.windowStart, windowEnd: defaults.windowEnd };
  return { ...EVENING_UPDATE_WINDOW };
}

/**
 * Does any hour of `[windowStart, windowEnd)` fall inside `[signinHour, releaseHour)`, which
 * wraps midnight? Used by the tests, and exported so the invariant has one definition.
 */
export function windowOverlapsSession({ windowStart, windowEnd }, signinHour = EVENING_SIGNIN_HOUR, releaseHour = 8) {
  const inSession = (h) => (signinHour <= releaseHour
    ? h >= signinHour && h < releaseHour
    : h >= signinHour || h < releaseHour);
  for (let h = windowStart; h < windowEnd; h++) if (inSession(h % 24)) return true;
  return false;
}
