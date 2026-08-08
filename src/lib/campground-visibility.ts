/**
 * "Is this row actually a campground?" — the search-visibility filter.
 *
 * Reservation portals list everything they take bookings for, which includes picnic
 * shelters, day-use parking spaces, golf courses, visitor centres and park headquarters.
 * Those are real bookable things; they are not campsites, and a campsite finder that
 * returns them is wrong in a way that is invisible until somebody watches one.
 *
 * ## Designed against the data, not from intuition
 *
 * The GoingToCamp sync has had a `NON_CAMPGROUND` regex since it was written, and the
 * obvious move was to apply it everywhere. Running it across all 8,025 rows first is what
 * stopped that: it matched 189, and its `\btrail\b` term was almost entirely WRONG outside
 * GoingToCamp's naming —
 *   SHEEP TRAIL CAMPGROUND · Trail Creek Bridge Campground · EAST TOTTEN TRAIL CAMPGROUND
 *   Lincoln Trail State Park — Lakeside Campground · Scioto Trail State Park — Caldwell
 *   Lake Campground · Suwannee River Wilderness Trail — Holton Creek (paddle-in campsites)
 * — so `trail` is not in this rule at all. A false positive here deletes a real campground
 * from search, which is strictly worse than leaving a picnic shelter in it.
 *
 * ## The lodging exception is load-bearing
 *
 * Portals routinely name a COMBINED facility after both halves, and the campground half is
 * the one we care about:
 *   KYEN CAMPGROUND AND OAK GROVE DAY USE AREA · Starrigavan Campground and Day Use
 *   Egin Lakes Campground/Day Use Area · Pike Lake Cabins and Day Use Shelters
 *   Salton Sea SRA — Headquarters Hookup (sites 2-15)   ← a real campground loop
 *   KENTUCKY CAMP CABIN AND HEADQUARTERS BUILDING · FISH LAKE REMOUNT DEPOT CABINS
 * Every one of those matches a day-use or headquarters term and every one is bookable
 * lodging. So any mention of lodging WINS, unconditionally.
 *
 * ## This hides; it never deletes
 *
 * Applied at READ time against a `hidden` column, never as a sync-time filter and never as
 * a `DELETE`. Two reasons, both learned here: a filter yields `[]` rather than an error, so
 * a mistake is silent (that is how 35 parks were deleted for lacking coordinates on
 * 2026-08-04), and a read-time rule can be corrected with a deploy instead of a re-sync of
 * eight thousand rows.
 *
 * **The poller does NOT consult this.** Hiding affects DISCOVERY only. If someone already
 * watches one of these, their alerts must keep working — silently switching off a paying
 * subscriber's watch because we reclassified their campground is the one outcome worse
 * than listing a picnic shelter.
 */

/**
 * Any mention of somewhere you can sleep. Beats every rule below.
 *
 * MIND THE PLURALS. This read `camp` rather than `camps?` on the first pass and would have
 * hidden **`Tar Hollow Non Electric Shelter Camps`** — Ohio's shelter camps are bookable
 * overnight, and the word that says so is the plural. Found by grepping the would-hide
 * list for any form of "camp" and demanding the result be empty; that check is the test
 * below, not a one-off.
 */
const LODGING =
  /\b(campgrounds?|campsites?|camping|camps?|cabins?|yurts?|lodges?|lodging|cottages?|rv|hookups?|tents?|sites?)\b/i;

/**
 * Facilities that are definitively not places to sleep.
 *
 * Every term here was verified against a real match in the catalog, and terms that
 * produced false positives were dropped rather than special-cased. `museum` came out for
 * `Southwest Virginia Museum State Park — Cottage`; `trail` came out for two dozen real
 * campgrounds; `ic` is anchored to the END of the name because it is only ever safe as
 * GoingToCamp's "information centre" suffix (`Ginkgo IC`) and would otherwise match inside
 * ordinary words.
 */
const NOT_LODGING: RegExp[] = [
  /\bday[\s-]?use\b/i,                                    // 100+ rows, every portal
  /\bshelters?\b/i,                                       // picnic shelters
  /\b(headquarters|hq)\b/i,                               // HEADQUARTERS · Monadnock Hq
  /\b(visitors?|information|interpretive)\s*cent(er|re)\b/i, // Heron Lake Visitor Center Great Room
  /\bgolf\s*course\b/i,                                   // Frank Holten SRA — Golf Course Side
  /\bparking\s*space\b/i,                                 // Sand Harbor — Day Use Parking Space
  /\bfront\s*desk\b/i,
  /\s\bic\b\s*$/i,                                        // Ginkgo IC — suffix only, see above
];

/** Why this row is hidden, or null if it is a campground as far as we can tell. */
export function nonCampgroundReason(name: string): string | null {
  if (!name) return null;
  // Lodging wins outright — see the combined-facility list in the header.
  if (LODGING.test(name)) return null;
  for (const re of NOT_LODGING) {
    const m = name.match(re);
    if (m) return m[0].trim().toLowerCase();
  }
  return null;
}

export function isNonCampground(name: string): boolean {
  return nonCampgroundReason(name) !== null;
}
