// The alerting claim — who is allowed to notify, for which watch, for which site.
//
// EXTRACTED FROM poller.ts SO IT CAN BE TESTED. poller.ts starts the poller as a
// side effect of being imported, so nothing inside it could ever be exercised by a
// test; the alerting decision — the part where a wrong answer means a user misses a
// campsite — was therefore the least testable code in the repo. See claim.test.mts.
//
// This is the file the 2026-07-30 bug lived in. The cooldown was one timestamp per
// WATCH, so the first site to open silenced every other site on that watch for an
// hour, including the auto-cart lane. Migration 026 moved it to (watch, site).

import { mutate } from '../src/lib/db/client';

/** Re-notify only if the last alert for THIS PAIR is older than this. A floor, not a
 *  schedule — passing it is necessary but no longer sufficient (see CONTINUOUS_GAP). */
export const RENOTIFY_WINDOW = "interval '1 hour'";

/**
 * How long a site must go UNSEEN before re-opening counts as news.
 *
 * The window above used to be the whole rule, so a site that never closed re-alerted
 * every hour forever — 16 identical alerts for one Silver Lake opening on 2026-08-05.
 * A cancellation is an event; we should say so once. Re-alerting is only meaningful
 * when the site actually went away and came back.
 *
 * Ten minutes, and the size matters in one direction much more than the other. The
 * poller sees a site every 15s when hot and every ~60s when lead-time-tiered, so
 * anything above a couple of minutes distinguishes "still open" from "gone and back".
 * Going LOWER risks re-alerting for a site that never closed — the bug this fixes —
 * because our own blind spots (an open rec.gov breaker, a budget-denied refresh, a
 * worker redeploy) look exactly like a site disappearing. Ten minutes clears all of
 * those comfortably. Going HIGHER only delays a genuine re-open, which is the
 * cheaper mistake.
 */
export const CONTINUOUS_GAP = "interval '10 minutes'";

/**
 * How long a site must stay open before we send ONE follow-up.
 *
 * Alerting on the transition (039) removed the hourly repeat — and with it something
 * real, because that repeat was incidentally a retry for a first alert that never
 * landed. Six hours later, if the site is somehow STILL open, it is worth one more
 * message: either the first was missed, or the user has been handed an unusually long
 * window to act on.
 *
 * ONE. `nudged_at` is what enforces that, and it is the whole difference between this
 * and the bug it replaces — a six-hour repeat is just a slower drumbeat.
 */
export const NUDGE_AFTER = "interval '6 hours'";

/**
 * Sources that report campground-level availability with no site id
 * (ReserveAmerica, GoingToCamp, TN/SC) collapse onto this one key, and so keep the
 * old per-watch behaviour — which is the honest reading of what they tell us.
 * Deliberately not a value any provider could produce as a real campsite id.
 */
export const WHOLE_CAMPGROUND_SITE_KEY = '*';

/**
 * Atomically claim the right to notify for this watch AND THIS SITE. True if we won.
 *
 * CALL THIS ON EVERY CYCLE THE SITE IS OPEN, not only when you intend to alert — it
 * doubles as the "still open" observation. A cycle that skips it looks identical to
 * the site vanishing, and ten minutes of that turns into a duplicate alert.
 *
 * Two conditions must BOTH hold to re-alert an existing pair:
 *   1. the last alert is outside RENOTIFY_WINDOW — the floor, unchanged; and
 *   2. we lost sight of the site for at least CONTINUOUS_GAP — i.e. it closed and
 *      re-opened, rather than never having closed at all.
 * A NULL `last_seen_open_at` (any row predating migration 039) fails no test: it is
 * treated as a gap, so those rows keep the old behaviour until the first stamp lands.
 *
 * Atomicity is the single statement. `last_seen_open_at` is stamped unconditionally,
 * while `last_alert_at` only moves when we win, so the observation is recorded even by
 * the cycles that stay quiet. NOW() is the transaction timestamp and therefore constant
 * across the statement, which is what makes `last_alert_at = NOW()` a sound test of
 * "did this call win?" — two cycles racing the same pair still cannot both win.
 */
/**
 * Why we are allowed to speak — the caller needs this, not just permission.
 *
 * A `nudge` must not be worded like a fresh opening. Six hours on, an alert identical
 * to the first one reads exactly like the hourly-repeat bug we just removed, and the
 * user cannot tell "it opened again" from "it never closed". The reason travels with
 * the claim so the message can say which it is.
 */
export type ClaimReason = 'new' | 'reopened' | 'nudge';
export interface ClaimResult {
  won: boolean;
  reason: ClaimReason | null;
}

/**
 * Where this opening was seen. Only supplied by callers that can be watching SEVERAL
 * campgrounds under one watch (migration 070).
 */
export interface ClaimScope {
  campgroundId?: string | null;
  /** Does the watch cover more than one campground? */
  multi?: boolean;
}

/**
 * Namespace the site key by campground — but ONLY for a watch that covers more than one.
 *
 * `campsiteId ?? '*'` was the whole key, and that sentinel is PER WATCH. Sources with no
 * per-site id (ReserveAmerica, GoingToCamp, TN/SC) therefore collapse every campground of
 * a multi-campground watch onto `(watch_id, '*')`, so the first division to open would
 * silence the others for an hour. That is exactly the bug migration 026 fixed at the
 * site level, reappearing one level up.
 *
 * It is scoped to `multi` on purpose. Namespacing unconditionally would change the stored
 * key for every existing row, and each currently-open site would re-alert once on deploy —
 * a real cost for no benefit to watches that only ever had one campground. Single-campground
 * watches keep byte-identical keys.
 *
 * Campsite ids were MEASURED unique within a park (10,757 sampled across ReserveCalifornia,
 * Ohio and Minnesota multi-division parks, zero collisions), so this is belt-and-braces for
 * the id path and load-bearing for the sentinel path.
 */
export function siteKeyFor(campsiteId: string | null | undefined, scope?: ClaimScope): string {
  const base = campsiteId ?? WHOLE_CAMPGROUND_SITE_KEY;
  if (!scope?.multi || !scope.campgroundId) return base;
  return `${scope.campgroundId}::${base}`;
}

export async function claimNotification(
  watchId: string,
  campsiteId?: string | null,
  scope?: ClaimScope
): Promise<ClaimResult> {
  const siteKey = siteKeyFor(campsiteId, scope);
  // Named once, used three times — the two paths to a claim, and the reason we report.
  const REOPENED = `watch_site_alerts.last_alert_at < NOW() - ${RENOTIFY_WINDOW}
      AND COALESCE(watch_site_alerts.last_seen_open_at, '-infinity'::timestamptz)
          < NOW() - ${CONTINUOUS_GAP}`;
  const NUDGE = `watch_site_alerts.nudged_at IS NULL
      AND watch_site_alerts.last_alert_at < NOW() - ${NUDGE_AFTER}`;

  const rows = await mutate<{ won: boolean; reason: ClaimReason | null }>(
    `INSERT INTO watch_site_alerts (watch_id, site_key, last_alert_at, last_seen_open_at)
     SELECT $1, $2, NOW(), NOW() FROM watches w WHERE w.id = $1 AND w.active = true
     ON CONFLICT (watch_id, site_key) DO UPDATE SET
       last_seen_open_at = NOW(),
       last_alert_at = CASE
         WHEN ${REOPENED} OR ${NUDGE} THEN NOW()
         ELSE watch_site_alerts.last_alert_at
       END,
       -- A genuine re-open is a NEW opening, so it gets its own second chance: clear
       -- the nudge. Without this reset the follow-up would fire once per (watch, site)
       -- for the life of the watch and then go silent for every later stay.
       nudged_at = CASE
         WHEN ${REOPENED} THEN NULL
         WHEN ${NUDGE} THEN NOW()
         ELSE watch_site_alerts.nudged_at
       END
     RETURNING (last_alert_at = NOW()) AS won,
               CASE WHEN last_alert_at = NOW()
                    THEN CASE WHEN nudged_at = NOW() THEN 'nudge' ELSE 'reopened' END
               END AS reason`,
    [watchId, siteKey]
  );
  // No row at all means the watch is gone or inactive; won=false means we observed the
  // site but are deliberately staying quiet.
  if (rows.length === 0 || !rows[0].won) return { won: false, reason: null };
  // The INSERT path returns no reason (there is no conflicting row to compare against),
  // and it is always a first alert.
  const reason: ClaimReason = rows[0].reason ?? 'new';

  // Keep the watch-level stamp current. It no longer gates a notification, but
  // WatchCard renders "last alerted" from it and the Campflare webhook still dedupes
  // on it, so letting it go stale would misreport both.
  await mutate('UPDATE watches SET notification_sent_at = NOW() WHERE id = $1', [watchId]).catch(
    (e) => console.error('[poller] notification_sent_at stamp failed (non-fatal):', e)
  );
  return { won: true, reason };
}
