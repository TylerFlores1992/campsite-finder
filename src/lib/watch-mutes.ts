import { mutate } from '@/lib/db/client';

/**
 * Site mutes on a watch — validation and the two statements that change them.
 *
 * ── WHY A MODULE AND NOT TWO LINES IN THE ROUTE ────────────────────────────────────────
 * Muting is now set from two places (the New watch screen at creation, and
 * `/manage/<token>` afterwards) and the bulk control means a single tap can rewrite three
 * hundred ids at once. The array SQL below has real edge cases — `array_agg` over an
 * empty set is NULL and `watches.muted_site_ids` is NOT NULL — and a route handler is
 * something a test can only assert a COPY of. Copied assertions pass against copied bugs;
 * `rc-holds-readout.test.mts` exists because of exactly that.
 *
 * ── WHAT THESE IDS ARE ─────────────────────────────────────────────────────────────────
 * The poller's own campsite ids: `campsiteId` from `getAvailabilityFromRecGov` for
 * rec.gov, and `String(unit.UnitId)` from `getRCAvailabilityForMonth` for
 * ReserveCalifornia — which is byte-for-byte what `findRCOpenUnit` and `findRCHeldUnits`
 * compare. The column is `text[]` and RC's unit ids are NUMBERS, so anything that reaches
 * here unstringified silently never matches and reads as "no mutes are set".
 */

/**
 * Ceiling on one batch. Well above any real campground (the largest we sync runs to a few
 * hundred sites) and low enough that a malformed or hostile body cannot hand Postgres a
 * megabyte array literal — `sqlit` interpolates arrays element by element.
 */
export const MAX_MUTES = 2000;

/**
 * Usable site ids from untrusted input: strings only, trimmed, non-empty, bounded,
 * deduped, capped.
 *
 * DROPS junk rather than rejecting the whole request. A bad entry must never cost the
 * user the watch they were actually creating, and on the manage screen it must never
 * cost them the ability to unmute the rest.
 */
export function cleanSiteIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (s.length === 0 || s.length > 128) continue;
    out.add(s);
    if (out.size >= MAX_MUTES) break;
  }
  return [...out];
}

/**
 * Apply a batch of mutes and/or unmutes to one watch.
 *
 * ONE statement per direction, not one per site: "mute all" on a three-hundred-site
 * campground must not be three hundred round trips from a phone on campground wifi, and
 * a partial failure halfway through leaves a state neither the user nor the screen can
 * describe.
 *
 * The set arithmetic is done IN SQL rather than read-modify-write, so two taps racing
 * each other cannot lose one — the same reason the alerting claim is a single
 * `INSERT .. ON CONFLICT .. WHERE`.
 *
 * MUTES ARE APPLIED BEFORE UNMUTES, so an id appearing in both ends up UNMUTED. That is
 * the safe direction: a site wrongly muted is an alert the user never learns they
 * missed, while a site wrongly unmuted is only noise.
 *
 * The caller is responsible for authorizing `watchId` — the manage route by its token,
 * the app routes by ownership. This function deliberately takes an id it trusts.
 */
export async function applyMutes(
  watchId: string,
  change: { mute?: string[]; unmute?: string[] },
): Promise<void> {
  const add = cleanSiteIds(change.mute);
  const remove = cleanSiteIds(change.unmute);

  if (add.length) {
    // COALESCE because array_agg over an empty set returns NULL, and the column is
    // NOT NULL — without it, muting into an empty array would fail the constraint.
    await mutate(
      `UPDATE watches
          SET muted_site_ids = COALESCE(
                (SELECT array_agg(DISTINCT x) FROM unnest(muted_site_ids || $2) AS x),
                '{}')
        WHERE id = $1`,
      [watchId, add],
    );
  }

  if (remove.length) {
    // Same COALESCE reason, and this one is the likelier to hit it: unmuting everything
    // filters the array down to nothing, which is precisely the empty-set case.
    await mutate(
      `UPDATE watches
          SET muted_site_ids = COALESCE(
                (SELECT array_agg(x) FROM unnest(muted_site_ids) AS x WHERE NOT (x = ANY($2))),
                '{}')
        WHERE id = $1`,
      [watchId, remove],
    );
  }

}
