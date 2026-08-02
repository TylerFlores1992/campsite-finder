// One auto-cart per (watch, site) — the decision to NOT cart a site again.
//
// EXTRACTED FROM poller.ts SO IT CAN BE TESTED, for the same reason claim.ts is:
// importing poller.ts starts the poller, so nothing inside it can be exercised by a
// test. This sits directly on the auto-cart lane, which is the paid feature.
//
// The bug this exists for (observed live 2026-08-02): Silver Lake site 84611 was
// placed in one user's cart FIVE times, once an hour, for a single watch. Two
// independent guards both let it through, and neither was wrong on its own:
//   - the alerting claim (watch_site_alerts, migration 026) has a 1-hour window, so
//     an opening that STAYS open re-claims every hour and queues a fresh cart job;
//   - the bot's own guard is a 20-minute TTL (CARTED_TTL_MS in bot.mjs), sized for
//     how long rec.gov holds a cart, so by then it has deliberately forgotten.
// Neither remembers across hours, and nothing was asking the permanent record.
//
// A cart the user has already been handed is not a second opportunity — it is the
// same one. Re-carting it churns their cart and re-fires "it's in your cart".

import { query } from '../src/lib/db/client';

/**
 * Has this watch already had this exact site carted?
 *
 * Keyed on watch_id, which is what makes "a new watch for the same campground
 * starts over" true for free: a new watch is a new id with no history. Deleting a
 * watch also drops its jobs (ON DELETE CASCADE, migration 014), so re-creating one
 * is a clean slate either way.
 *
 * cart_outcome is checked alongside resolution because a job the reconciler already
 * resolved as 'alerted' before the bot's late 'carted' report landed still ended up
 * in the user's cart. Either column saying 'carted' means it was carted.
 *
 * Fail-OPEN on a read error (false → cart it). Auto-cart is what the user pays for,
 * and a duplicate cart is a much smaller failure than a missed one.
 *
 * Index: idx_autocart_jobs_carted_site (migration 036).
 */
export async function alreadyCartedForWatch(watchId: string, campsiteId: string): Promise<boolean> {
  try {
    const rows = await query<{ one: number }>(
      `SELECT 1 AS one FROM autocart_jobs
       WHERE watch_id = $1 AND campsite_id = $2
         AND (resolution = 'carted' OR cart_outcome = 'carted')
       LIMIT 1`,
      [watchId, campsiteId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error(
      `[poller] carted-history read failed for watch ${watchId} site ${campsiteId} — carting anyway:`,
      (err as Error).message
    );
    return false;
  }
}
