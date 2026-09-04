/**
 * Which holds go in the watch card, and which stay at the top of the page.
 *
 * ## The ask, 2026-09-04
 *
 *   "We also show all holds at the top of the watch screen. Can we move the available
 *    holds and queued holds to the box all the other watch info is in on the watch page."
 *
 * ## What moves and what deliberately does NOT
 *
 * `offered` and `requested` are about TOMORROW MORNING. There is nothing to do about
 * either right now — an offer wants a decision before 08:00, a queued hold wants nothing at
 * all — so they belong beside the watch they came from, where somebody looking at that
 * campground will find them.
 *
 * `carted`, `claiming` and `released` are a real campsite in a real ReserveCalifornia cart
 * with roughly fifteen minutes on it. Those STAY at the top of the page, above the outage
 * banner and above both of `WatchesList`'s early exits, for the reason the panel was built:
 * at 08:00 nothing else on that page matters, and burying a fifteen-minute fuse two taps
 * inside a collapsed section on one card is how somebody loses the site.
 *
 * ## The orphan rule is the load-bearing half
 *
 * `panelHolds` does not ask "is this urgent?" — it asks **"will a card show this?"** and
 * keeps everything else. That one rule covers the live-fuse holds AND the case that would
 * otherwise be silent: an `offered` row whose watch is not on the page. That happens when
 * the watch was deleted (a hold outlives its watch — `WatchesList` renders the panel in its
 * "no watches yet" branch precisely for this) and when `/api/watches` fails while
 * `/api/rc-holds/mine` succeeds, which is the state the panel's own header calls out as the
 * reason it sits above the error branch.
 *
 * Written as "not claimed by a card" rather than "urgent, plus orphans" so the two can
 * never disagree: a status this file has not heard of shows up in the panel rather than
 * vanishing, which is the same direction as `byUrgency` sorting an unknown status last
 * instead of promoting it.
 *
 * A pure module, for the reason `hold-ordering.ts` is one: this decides what a user sees at
 * 08:00, and a structural guard reading a component's source can only ever assert that some
 * text is present — which this project has watched go vacuous more than twenty times.
 */

/** The fields placement reads. Structural on purpose, so a test need not build a whole
 *  `MyHold` to ask a question about two of its fields. */
export interface PlaceableHold {
  status: string;
  watchId: string;
}

/** The two statuses that have a home on a watch card. */
export const CARD_STATUSES: readonly string[] = ['offered', 'requested'];

/**
 * True when a watch card will render this hold, so the page-level panel must not.
 *
 * Both halves are required: the status has to be one a card has a section for, AND that
 * card has to actually be on the page.
 */
export function belongsOnCard(h: PlaceableHold, watchIdsOnPage: ReadonlySet<string>): boolean {
  return CARD_STATUSES.includes(h.status) && watchIdsOnPage.has(h.watchId);
}

/** Everything no card will show. See the header — this is deliberately the complement of
 *  `belongsOnCard`, not an urgency test, so nothing can fall between the two. */
export function panelHolds<T extends PlaceableHold>(
  holds: readonly T[],
  watchIdsOnPage: ReadonlySet<string>,
): T[] {
  return holds.filter((h) => !belongsOnCard(h, watchIdsOnPage));
}

/** One watch's two lists, in the order the card renders them. */
export function cardHolds<T extends PlaceableHold>(
  holds: readonly T[],
  watchId: string,
): { offered: T[]; requested: T[] } {
  return {
    offered: holds.filter((h) => h.watchId === watchId && h.status === 'offered'),
    requested: holds.filter((h) => h.watchId === watchId && h.status === 'requested'),
  };
}
