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
export async function claimNotification(
  watchId: string,
  campsiteId?: string | null
): Promise<boolean> {
  const siteKey = campsiteId ?? WHOLE_CAMPGROUND_SITE_KEY;
  const rows = await mutate<{ won: boolean }>(
    `INSERT INTO watch_site_alerts (watch_id, site_key, last_alert_at, last_seen_open_at)
     SELECT $1, $2, NOW(), NOW() FROM watches w WHERE w.id = $1 AND w.active = true
     ON CONFLICT (watch_id, site_key) DO UPDATE SET
       last_seen_open_at = NOW(),
       last_alert_at = CASE
         WHEN watch_site_alerts.last_alert_at < NOW() - ${RENOTIFY_WINDOW}
          AND COALESCE(watch_site_alerts.last_seen_open_at, '-infinity'::timestamptz)
              < NOW() - ${CONTINUOUS_GAP}
         THEN NOW()
         ELSE watch_site_alerts.last_alert_at
       END
     RETURNING (last_alert_at = NOW()) AS won`,
    [watchId, siteKey]
  );
  // No row at all means the watch is gone or inactive; a row with won=false means we
  // observed the site but are deliberately staying quiet.
  if (rows.length === 0 || !rows[0].won) return false;

  // Keep the watch-level stamp current. It no longer gates a notification, but
  // WatchCard renders "last alerted" from it and the Campflare webhook still dedupes
  // on it, so letting it go stale would misreport both.
  await mutate('UPDATE watches SET notification_sent_at = NOW() WHERE id = $1', [watchId]).catch(
    (e) => console.error('[poller] notification_sent_at stamp failed (non-fatal):', e)
  );
  return true;
}
