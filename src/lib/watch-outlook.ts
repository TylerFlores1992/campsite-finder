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
 * ── THE TIMING CLAIM, AND WHERE IT COMES FROM (2026-09-04) ────────────────────────
 *
 * The copy says most cancellations come in the last week or two before a trip. **That
 * claim rests on EXTERNAL data, not ours**, and the distinction matters because an
 * earlier version of this file asserted the opposite from our own numbers and was
 * wrong to.
 *
 * WHAT SUPPORTS IT:
 *   · Campsite Tonight (Mike Lee) analysed ~32,000 Yosemite reservations, 2023-24,
 *     and reports a **27% spike in cancellations in the seven days before check-in**.
 *     That is a year of a six-month-window campground — exactly the population this
 *     note is shown for. (Read via SF Chronicle's coverage and search excerpts; the
 *     blog itself is egress-blocked from this environment.)
 *   · The Dyrt's 2023 camper survey found only **42.7% of campers used every
 *     reservation they made**, driven by deliberate over-booking — which is the
 *     mechanism: people book at six months, decide near the date, and drop the rest.
 *   · Refund cliffs concentrate it. **ReserveCalifornia, since 2026-07-01, refunds in
 *     full only 7+ days out**, takes the first night at 2-6 days and everything inside
 *     2 days — and most live CampHawk watches are RC. Recreation.gov's only cliff is
 *     at 1-2 days. A deadline is a reason to cancel ON a particular day.
 *   · Campnab and CampCancel both say it in prose (CampCancel names two to six weeks);
 *     Outdoorithm describes three waves at 10-14, 7 and 1-3 days from 233 cancellations
 *     of their own. Consistent direction, no published distribution behind any of them.
 *
 * ── WHAT OUR OWN DATA DOES AND DOES NOT COVER ────────────────────────────────────
 *
 * Measured against `availability_observations`, counting TRANSITIONS — an observation
 * whose predecessor for the same (campground, arrival, nights) was fully booked, i.e.
 * an opening actually appearing, never a stay that was simply never sold out:
 *
 *   ROSTER (502 campgrounds, hourly, frozen 2026-07-30)
 *     lead  0-13d      8 /   1,073 checks   0.75%   <- ESSENTIALLY UNSAMPLED
 *     lead 14-20d    418 /  62,747          0.67%
 *     lead 42-55d    636 /  58,686          1.08%
 *
 * **THE TWO WELL-POWERED BANDS ARE 2-3 WEEKS AND 6-8 WEEKS, AND THE FAR ONE IS
 * BUSIER.** That is a real finding and it is not what this note claims — the note is
 * about the LAST week or two, and the roster put 1,073 checks there against 121,433
 * in the two bands it did sample. **It could not see the window the claim is about.**
 * An earlier version of this header read that gap as a refutation of the premise; it
 * is an absence of evidence, which is the shape this repo keeps mistaking for a
 * negative reading.
 *
 * The thin short-lead data we do have leans the other way, and is quoted only as a
 * lean: roster 4-13 days is 7 / 565 (1.24%), the highest rate of any band bar one of
 * 470 checks. The watch-driven recorder shows 34 openings inside 13 days against 7
 * beyond — but **32 of those 34 are ONE campground (234330, Silver Lake at June
 * Lake)**, so it is one park's behaviour wearing a population's clothes and settles
 * nothing on its own.
 *
 * WHAT WOULD SETTLE IT: short-lead coverage on booked-out six-month-window parks —
 * either waiting on the watch-driven recorder (free, but only ~13 campgrounds) or
 * seeding a SMALL roster at leads of 3/7/10/14 days. The 07-30 stop was about cost
 * (~15,700 Vercel invocations/day across 502 proxied targets); rec.gov targets are
 * fetched directly by the worker against its own budget, so a small rec.gov-only
 * roster is a different cost question. **Not taken — it is the owner's call.**
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
 * The lead gate is about how long THIS PERSON is about to wait. A stay inside a
 * fortnight is already in the window the copy points at, so the note would be telling
 * them to wait for a period that has started — noise, not reassurance.
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
 * The words. Kept here rather than in the component so the guards can assert both what
 * is said and what is not: the timing claim is EXTERNAL evidence (see the header) and
 * must stay qualitative, because the only thing that could creep back in is a number
 * nothing licenses.
 */
export const OUTLOOK_HEADING = "You're watching a stay that's fully booked";

export function outlookBody(leadDays: number): string {
  const weeks = Math.round(leadDays / 7);
  const when = weeks >= 2 ? `about ${weeks} weeks away` : `${leadDays} days away`;
  return (
    `Every site for these dates is taken right now, and your trip is ${when}. An opening ` +
    `only happens when somebody else cancels — and most cancellations come in the last ` +
    `week or two before a trip, as plans firm up and refund deadlines pass. So expect it ` +
    `to be quiet until then. We re-check every 15 seconds and alert you the moment a ` +
    `site frees up.`
  );
}
