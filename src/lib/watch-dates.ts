import { mutate } from '@/lib/db/client';

/**
 * Changing the dates on an existing watch — the validation, and the writes that keep the
 * change from silently switching the watch off.
 *
 * ── WHY A MODULE AND NOT A CASE IN THE ROUTE ───────────────────────────────────────────
 * The same reason as `watch-mutes.ts`: the interesting part is SQL, and a test can only
 * assert a COPY of SQL that lives in a route handler. Copied assertions pass against
 * copied bugs.
 *
 * ── THE PART THAT IS NOT THE FORM ──────────────────────────────────────────────────────
 * `watch_site_alerts` is `PRIMARY KEY (watch_id, site_key)` — THE DATES ARE NOT IN THE
 * KEY. So a claim won while the watch covered Sep 4-7 still stands after the user moves
 * it to Oct 2-5, and `worker/claim.ts` re-alerts only on a TRANSITION: it needs both the
 * hour AND a `CONTINUOUS_GAP` of not having seen the site open. A site that was open under
 * the old dates and is still open reads as "nothing changed" and **stays silent**.
 *
 * That is the whole hazard. A user who edits their dates would get no alerts for exactly
 * the sites most likely to matter — the ones already being watched — with nothing wrong
 * anywhere, no error, and a screen that says the watch is active. It is the shape this
 * codebase keeps paying for: a correct component reporting a state that reads as fine.
 *
 * So a date change CLEARS this watch's claims. The cost of clearing is one duplicate
 * alert per open site, once. The cost of not clearing is silence.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ──────────────────────────────────────────────────────
 * It does not touch `active`. A watch can be inactive because the user paused it or
 * because `worker/expire-watches.ts` closed it when the dates ran out, and NOTHING
 * RECORDS WHICH — there is no column that distinguishes them. Auto-resuming would restart
 * alerts for somebody who deliberately stopped them; the manage screen already has an
 * explicit Resume beside this control, and it tells the user when the watch is paused.
 */

/** A watch cannot be stretched indefinitely. Well past any real trip, and short enough
 *  that the poller's per-watch work stays bounded. */
export const MAX_WINDOW_DAYS = 365;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `a` to `b`, both plain ISO dates.
 *
 *  PARSED AS UTC, NEVER `new Date('2026-09-04')` IN LOCAL TIME. That constructor is
 *  midnight UTC and renders as the previous day in every US timezone — the bug
 *  `formatStayDates` already exists to avoid, and a one-day error here silently changes
 *  which nights a watch covers. */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  );
}

/** True only if the string names the day it appears to name — see the caller. */
function isRealDate(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export type DateChange = { startDate: string; endDate: string };

export type DateCheck =
  | { ok: true; value: DateChange }
  | { ok: false; error: string };

/**
 * Is this a date window we can actually watch?
 *
 * `today` is injected rather than read from the clock so the boundary is testable — and
 * because "is this in the past?" is a question about the SERVER's day, which a test must
 * be able to pin.
 *
 * The nights are checked against the new window because both kinds of watch can be made
 * unmatchable by a window that is too short, and a watch that can never match is
 * indistinguishable from a broken one from the outside.
 */
export function checkDateChange(input: {
  startDate: unknown;
  endDate: unknown;
  flexNights: number | null;
  minNights: number | null;
  today: string;
}): DateCheck {
  const { startDate, endDate, flexNights, minNights, today } = input;

  if (typeof startDate !== 'string' || !ISO_DATE.test(startDate)) {
    return { ok: false, error: 'startDate must be a date like 2026-09-04' };
  }
  if (typeof endDate !== 'string' || !ISO_DATE.test(endDate)) {
    return { ok: false, error: 'endDate must be a date like 2026-09-07' };
  }
  // A regex match is not a real date, and NEITHER IS A SUCCESSFUL PARSE.
  // `Date.parse('2026-02-31T00:00:00Z')` does not fail — it ROLLS OVER and yields March
  // 3rd, and '2026-02-29' in a non-leap year yields March 1st. Accepting either would
  // move the user's watch by days, quietly, with the screen reporting success. So the
  // check is a ROUND TRIP: it is a real date only if formatting it back gives the same
  // string.
  if (!isRealDate(startDate) || !isRealDate(endDate)) {
    return { ok: false, error: 'that is not a real date' };
  }

  const span = daysBetween(startDate, endDate);
  if (span <= 0) return { ok: false, error: 'the end date must be after the start date' };
  if (span > MAX_WINDOW_DAYS) {
    return { ok: false, error: `a watch can cover at most ${MAX_WINDOW_DAYS} days` };
  }

  // END, not start: the poller's filter is `end_date > CURRENT_DATE` and
  // `expire-watches.ts` closes exactly the complement, so a window ending today or
  // earlier is switched off within the hour. Refusing it here is the difference between
  // "that date has passed" and a watch that vanishes with no explanation. A start date in
  // the past is fine and is a real case — a window that began before today can still have
  // nights left in it.
  if (daysBetween(today, endDate) <= 0) {
    return { ok: false, error: 'the end date has already passed' };
  }

  const needed = flexNights ?? minNights ?? 1;
  if (needed > span) {
    return {
      ok: false,
      error: `this watch is looking for ${needed} night${needed === 1 ? '' : 's'}, which does not fit in that window`,
    };
  }

  return { ok: true, value: { startDate, endDate } };
}

/**
 * Write the new dates and drop the state that was true only of the old ones.
 *
 * All three in ONE statement so a watch can never be left advertising new dates behind
 * old claims — that intermediate state is precisely the silent-no-alerts bug, and a
 * two-statement version would produce it for real on any failure between them.
 *
 * `rc_hold_notified_keys` and its pre-067 scalar are cleared for the same reason as the
 * alert claims: they record "we already told this user about this release", which was an
 * answer about a stay they are no longer asking for.
 *
 * `notification_sent_at` goes too, and it is NOT vestigial — the poller stopped filtering
 * on it, but `api/webhooks/campflare` still reads it as a ONE-HOUR COOLDOWN and returns
 * early. Left standing, a stamp earned under the old dates would swallow the first
 * Campflare notification for the new ones. Every column cleared here is the same shape:
 * a suppression that was true of a stay the user has stopped asking about.
 */
export async function applyWatchDates(watchId: string, dates: DateChange): Promise<void> {
  await mutate(
    `WITH cleared AS (
       DELETE FROM watch_site_alerts WHERE watch_id = $1
     )
     UPDATE watches
        SET start_date = $2,
            end_date = $3,
            rc_hold_notified_keys = NULL,
            rc_hold_notified_for = NULL,
            notification_sent_at = NULL
      WHERE id = $1`,
    [watchId, dates.startDate, dates.endDate]
  );
}
