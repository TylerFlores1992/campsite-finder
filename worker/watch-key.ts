/**
 * The identity of a row in the poller's watch list — which stopped being the watch id.
 *
 * ## What changed underneath everything
 *
 * Migration 070 gave one watch many campgrounds ("one watch can cover a whole park"), and
 * `loadWatches` now emits **one row per (watch, campground)** through a `CROSS JOIN
 * LATERAL`. Every row of a park watch carries the SAME `w.id`. Everything written before
 * that keyed per-watch state on `w.id` alone, which was correct when a watch was a
 * campground and silently became a collision when it stopped being one.
 *
 * ## The two live faults this fixes, on real watches
 *
 * Both watches in the 2026-08-24 alert storm are multi-division park watches — `336d742c`
 * (Morro Bay: rc-582, rc-2185, rc-583) and `eb886697` (rc-583, rc-582).
 *
 * 1. **`DueTracker` skipped divisions, permanently.** It stamps `last[id] = now` for the
 *    first row it admits, so the second and third rows of the same watch are tested in the
 *    same call against a `prev` of *now* — `now - prev` is 0. For a HOT watch the interval
 *    is 0 and `0 >= 0` lets them through; for anything past `HOT_LEAD_DAYS` the interval is
 *    60s and they are refused, on that cycle and on every cycle after, because the first
 *    row keeps re-stamping the shared key. Two of Melinda's three Morro Bay divisions were
 *    never polled for availability at all. **A silent alerting outage with no error
 *    anywhere**, which is the failure shape this project fears most.
 *
 * 2. **The result maps overwrote each other.** `rcResults`, `rcHeld`, `raResults`,
 *    `gtcResults` and `tnscResults` are all `Map<watchId, …>`, written from a fan-out over
 *    (watch, campground) rows. Last writer wins, and then EVERY row of that watch reads
 *    the survivor back — so N divisions each claim under their own campground namespace and
 *    alert about ONE site, while the other divisions' genuine openings are discarded. That
 *    is N texts for one opening, attributed to the wrong division: the 2026-08-16 report
 *    ("says site A012 but took me to 35-102") arriving by a second route.
 *
 * ## Why a module for one template literal
 *
 * Because the bug is that two files disagreed about what identifies a row, and a second
 * copy is how they would disagree again. `poll-cadence.ts` and `poller.ts` both import
 * this one.
 */

/** The minimum a poller row must carry to be identified. */
export interface WatchRowKey {
  id: string;
  campground_id: string;
}

/**
 * `<watchId>|<campgroundId>` — one row of the poller's expanded watch list.
 *
 * `|` cannot appear in either half: watch ids are UUIDs and campground ids are source-
 * prefixed slugs (`rc-583`, a rec.gov facility number). So this cannot be made ambiguous
 * by a campground id that happens to end in a watch id, which a bare concatenation could.
 */
export function watchKey(w: WatchRowKey): string {
  return `${w.id}|${w.campground_id}`;
}
