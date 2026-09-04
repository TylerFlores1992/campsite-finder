/**
 * "Nothing is going to happen for a while, and that is not a fault" — the one-shot
 * note a new watcher sees after creating a watch on a stay that is a long way off.
 *
 * WHY IT EXISTS. A watch on a fully-booked stay six weeks out is silent for weeks,
 * and silence from an alerting product reads as a broken alerting product. The first
 * thing a new subscriber concludes is that we are not working — when in fact nothing
 * has been cancelled, which is not something we can do anything about. This says so
 * once, at the moment they would otherwise start wondering.
 *
 * ── WHAT THE DATA ACTUALLY SAYS, AND WHAT IT DOES NOT ─────────────────────────────
 *
 * The ask this was built from was "tell them cancellations are unlikely until about
 * two weeks out". **OUR OWN DATA DOES NOT SUPPORT THAT, and one reading of it says
 * the opposite** — so the copy here makes no claim about lead time at all. Measured
 * 2026-09-04 against `availability_observations` (13,261 watch-driven rows and the
 * 137k frozen Feature E roster rows, 2026-07-22 → 2026-09-04), counting TRANSITIONS
 * — an observation whose predecessor for the same (campground, arrival, nights) was
 * fully booked, i.e. an actual opening appearing, not a stay that was never sold out:
 *
 *   ROSTER (502 campgrounds, hourly, the only well-powered windows we have)
 *     lead 14-20d   418 openings / 62,747 checks   0.67%
 *     lead 42-48d   378 openings / 36,360 checks   1.04%
 *     lead 49-55d   258 openings / 22,326 checks   1.16%
 *
 * A fully-booked stay six to eight weeks out opened on ~1.6x MORE checks than one two
 * to three weeks out. Whatever governs cancellations here, "they start about two weeks
 * out" is not it.
 *
 * THE REAL-WATCH POPULATION CANNOT RESCUE THE PREMISE EITHER, AND THE REASON IS THE
 * INTERESTING PART. Restricted to the campgrounds our users actually watch, the split
 * looks spectacular — 26 openings in 2,666 checks inside 14 days against 1 in 5,503
 * beyond it, on the same 11 stays observed as they counted down. **Then check where
 * the events came from: 32 of those 34 openings are ONE campground (234330).** Every
 * other watched campground recorded zero in both bands. So that 50x is one park's
 * behaviour wearing a population's clothes — the confound this repo keeps paying for,
 * and it is why the number is not in the copy.
 *
 * WHAT IS SUPPORTED, and it is all the notice needs: on a stay that is already fully
 * booked, an opening is a rare per-check event at every lead time we can measure, so a
 * long wait is the ordinary case rather than a symptom.
 *
 * ── THE GATES ────────────────────────────────────────────────────────────────────
 *
 * `available === true` → SILENT. Telling somebody to settle in for a long wait while
 * sites are sitting there bookable is worse than saying nothing: they would go and
 * wait instead of going and booking.
 *
 * `available === null` → SILENT. Null is "we never found out" — a throttled portal, an
 * open breaker, a source with no availability adapter. Reading it as "nothing is free"
 * is the lie that rendered fifteen live Moab campgrounds as booked solid on
 * 2026-07-31, and here it would tell someone to be patient about a stay they could
 * have booked in the next thirty seconds. Three states, always.
 *
 * The lead gate is NOT a claim about when cancellations happen — see above. It is a
 * claim about how long this person is about to wait, which is the only thing the
 * notice is for. A stay inside a fortnight resolves either way soon enough that the
 * note would be noise.
 */

/** Lead time beyond which a silent watch is long enough to need explaining. */
export const OUTLOOK_QUIET_LEAD_DAYS = 14;

export interface WatchOutlookFacts {
  /** Days from today to the first wanted night. */
  leadDays: number;
  /** Is a bookable whole stay available right now? `null` = we never found out. */
  available: boolean | null;
}

export type OutlookSilence = 'already-available' | 'availability-unknown' | 'arriving-soon';

export interface WatchOutlook {
  show: boolean;
  /** Why we said nothing. `null` when we did. */
  silent: OutlookSilence | null;
}

export function watchOutlook({ leadDays, available }: WatchOutlookFacts): WatchOutlook {
  if (available === true) return { show: false, silent: 'already-available' };
  if (available == null) return { show: false, silent: 'availability-unknown' };
  if (leadDays <= OUTLOOK_QUIET_LEAD_DAYS) return { show: false, silent: 'arriving-soon' };
  return { show: true, silent: null };
}

/**
 * The words. Kept here rather than in the component so the guards can assert what is
 * NOT said — specifically that no lead-time cliff is promised, because the copy is the
 * only place the unsupported claim could come back.
 */
export const OUTLOOK_HEADING = "You're watching a stay that's fully booked";

export function outlookBody(leadDays: number): string {
  const weeks = Math.round(leadDays / 7);
  const when = weeks >= 2 ? `about ${weeks} weeks away` : `${leadDays} days away`;
  return (
    `Every site for these dates is taken right now, and your trip is ${when} — so it may be ` +
    `a long quiet stretch before anything changes. That's normal: an opening only happens ` +
    `when somebody else cancels, and on a booked-out stay that's rare on any given day. ` +
    `We re-check every 15 seconds and alert you the moment one appears, however long that takes.`
  );
}
