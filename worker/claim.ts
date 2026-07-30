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

/** Re-notify only if the last alert for THIS PAIR is older than this. */
export const RENOTIFY_WINDOW = "interval '1 hour'";

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
 * Atomicity is the single statement: a brand-new pair INSERTs, an existing pair only
 * UPDATEs when it is outside the window, and RETURNING is empty otherwise — so two
 * cycles racing the same pair cannot both win.
 */
export async function claimNotification(
  watchId: string,
  campsiteId?: string | null
): Promise<boolean> {
  const siteKey = campsiteId ?? WHOLE_CAMPGROUND_SITE_KEY;
  const rows = await mutate<{ watch_id: string }>(
    `INSERT INTO watch_site_alerts (watch_id, site_key, last_alert_at)
     SELECT $1, $2, NOW() FROM watches w WHERE w.id = $1 AND w.active = true
     ON CONFLICT (watch_id, site_key) DO UPDATE SET last_alert_at = NOW()
       WHERE watch_site_alerts.last_alert_at < NOW() - ${RENOTIFY_WINDOW}
     RETURNING watch_id`,
    [watchId, siteKey]
  );
  if (rows.length === 0) return false;

  // Keep the watch-level stamp current. It no longer gates a notification, but
  // WatchCard renders "last alerted" from it and the Campflare webhook still dedupes
  // on it, so letting it go stale would misreport both.
  await mutate('UPDATE watches SET notification_sent_at = NOW() WHERE id = $1', [watchId]).catch(
    (e) => console.error('[poller] notification_sent_at stamp failed (non-fatal):', e)
  );
  return true;
}
