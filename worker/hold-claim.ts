/**
 * The coming-soon claim — may we announce this release, and how many times?
 *
 * EXTRACTED FROM poller.ts SO IT CAN BE TESTED, for exactly the reason `claim.ts` was:
 * importing poller.ts STARTS the poller, so the decision that governs how many texts a
 * user receives was unreachable from a test. The bug below shipped because of that.
 *
 * THE 2026-08-24 STORM. Migration 070's park watches made this write a CAMPGROUND-
 * NAMESPACED value into `rc_hold_notified_for` so two divisions of one park would not
 * silence each other. That column holds ONE value, so N divisions each claiming a
 * different key for the same release hour overwrote one another in turn and the
 * `IS DISTINCT FROM` guard was true on every call. The dedup was not weakened — it was
 * defeated outright: one alert per division per poll cycle, unbounded.
 *
 * Measured on production: watch 336d742c (Morro Bay SP) sent 26 texts and 26 emails
 * between 11:40 and 12:42 PT, alternating rc-2185 / rc-583, every one for the SAME
 * physical campsite (unit 43191, "#96") and the same 08:00 release.
 */
import { mutate } from '../src/lib/db/client';

export async function claimHoldNotification(
  watchId: string,
  releaseAt: string,
  unitId?: string | number | null
): Promise<boolean> {
  const bucket = new Date(releaseAt);
  const hour = Number.isFinite(bucket.getTime())
    ? `${bucket.getFullYear()}-${bucket.getMonth() + 1}-${bucket.getDate()}T${bucket.getHours()}`
    : releaseAt;
  /**
   * A SET, BECAUSE A SINGLE COLUMN CANNOT HOLD N CLAIMS (2026-08-24).
   *
   * This used to write a CAMPGROUND-NAMESPACED value into `rc_hold_notified_for` so two
   * divisions of one park would not silence each other. One column holds one value, so N
   * divisions each claiming a different key for the same release hour simply overwrote one
   * another and `IS DISTINCT FROM` was true on EVERY call. The dedup was not weakened, it
   * was completely defeated — an alert per division per cycle, for ever.
   *
   * Measured: Melinda Flores, watch 336d742c, Morro Bay SP — 26 texts and 26 emails in one
   * hour, alternating rc-2185 / rc-583, all for the SAME campsite (unit 43191, "#96") and
   * the same 08:00 release. Thirteen cycles x two divisions, dead even.
   *
   * THE KEY IS THE UNIT, NOT THE CAMPGROUND, and that is what collapses the duplicate. RC
   * lists one physical campsite under more than one facility — "Morro Lottery sites" and
   * "Upper Section (sites 86-140)" are both park 680 and both carry unit 43191 — so a
   * campground-scoped key guaranteed two alerts for one campsite even after the storm was
   * fixed. Keying on the unit gives the user one text for one site, which is what they
   * asked for, while the SET keeps two genuinely different units in the same hour apart.
   *
   * `*` for a unit-less hold: those sources cannot tell two holds apart anyway, so they
   * collapse onto one claim per hour, which is the behaviour they have always had.
   */
  const key = `${hour}|${unitId ?? '*'}`;
  /**
   * ONE STATEMENT, so two shards racing cannot both win — the same reason the alert claim
   * is a single `INSERT .. ON CONFLICT`. The wildcard term is the deploy guard: migration
   * 067 backfills a live legacy claim as `<hour>|*`, and without checking it here every
   * watch mid-claim would send one more alert the moment this ships.
   */
  const rows = await mutate<{ id: string }>(
    `UPDATE watches
        SET rc_hold_notified_keys = array_append(COALESCE(rc_hold_notified_keys, '{}'), $2)
      WHERE id = $1 AND active = true
        AND NOT (COALESCE(rc_hold_notified_keys, '{}') @> ARRAY[$2]::text[])
        AND NOT (COALESCE(rc_hold_notified_keys, '{}') @> ARRAY[$3]::text[])
      RETURNING id`,
    [watchId, key, `${hour}|*`]
  );
  return rows.length > 0;
}

/**
 * A held site went live: drop THIS UNIT'S claims so a future cancellation of the same
 * site can be announced again.
 *
 * Scoped to the unit to match the claim. A blanket clear would let one site going live
 * re-open the claim for every OTHER site releasing in the same hour, and they would all
 * re-announce on the next cycle — the storm arriving by another door. A unit-less source
 * clears its one wildcard claim, which is the behaviour it has always had.
 */
export async function releaseHoldClaims(
  watchId: string,
  unitId?: string | number | null,
): Promise<void> {
  await mutate(
    `UPDATE watches
        SET rc_hold_notified_keys = (
              SELECT COALESCE(array_agg(k), '{}')
                FROM unnest(COALESCE(rc_hold_notified_keys, '{}')) AS k
               WHERE k NOT LIKE '%|' || $2)
      WHERE id = $1`,
    [watchId, String(unitId ?? '*')],
  );
}
