/**
 * What goes at the top of the Holds panel — extracted so it can be tested.
 *
 * THE BUG THIS FIXES, reported with a screenshot: "Open the hand-off again" sat at the top
 * of the Watches tab for ever, above "Hold it for me", which is the one with a deadline on
 * it. `/api/rc-holds/mine` orders by `release_at`, so a hand-off from an EARLIER release
 * always outranked a live offer for a later one. The ordering was backwards on the one
 * panel whose job is to get somebody to a campsite inside fifteen minutes.
 *
 * A pure module rather than three helpers inside the component, for the reason `claim.ts`
 * and `hold-line.ts` are modules: a rule that decides what a user sees at 08:00 should be
 * reachable from a test, and a structural guard reading the component's source can only
 * ever assert that some text is present.
 */

/** The fields the ordering reads. Deliberately structural, so the test does not have to
 *  build a whole `MyHold` to ask a question about two of its fields. */
export interface OrderableHold {
  status: string;
  releaseAt: string;
  updatedAt: string | null;
}

/**
 * How long a finished hand-off keeps its place before it is filed away.
 *
 * The owner's reasoning, and it is the right test: somebody who has not opened the
 * hand-off within an hour almost certainly is not going to. Before that it is still the
 * most urgent thing on the page, so this must never be shortened into "released means
 * done" — a hand-off five minutes old is a campsite waiting to be booked.
 */
export const FINISHED_AFTER_MS = 60 * 60 * 1000;

/**
 * A `released` hold nobody came back for within the hour.
 *
 * UNKNOWN AGE COUNTS AS FRESH. A missing or unparseable timestamp is not evidence that
 * something is stale, and the failure direction has to be "still visible": hiding a row
 * that may still matter costs a campsite, showing one an hour too long costs some space.
 * Same rule as `unknown` never being rounded to "not subscribed".
 */
export function isFinishedHandoff(h: OrderableHold, now = Date.now()): boolean {
  if (h.status !== 'released') return false;
  const t = h.updatedAt ? Date.parse(h.updatedAt) : NaN;
  return Number.isFinite(t) && now - t > FINISHED_AFTER_MS;
}

/**
 * Rank by HOW URGENT THE ROW IS, then by release time within a rank.
 *
 * `carted`/`claiming` is a real campsite in a real ReserveCalifornia cart with about
 * fifteen minutes on it, so it goes first whatever else is on screen. A `requested` hold
 * is real and important and there is nothing for its owner to do until 08:00, so it goes
 * last — giving it the urgency of a site sitting in a cart is what teaches people to
 * ignore the urgency.
 *
 * An UNKNOWN status sorts last rather than first. A status this file has not heard of is
 * one that arrived after it was written, and promoting it above a cart on that basis
 * would be the panel guessing.
 */
const URGENCY: Record<string, number> = {
  carted: 0,
  claiming: 0,
  released: 1,
  offered: 2,
  requested: 3,
};

export function byUrgency(a: OrderableHold, b: OrderableHold): number {
  const ra = URGENCY[a.status] ?? 9;
  const rb = URGENCY[b.status] ?? 9;
  if (ra !== rb) return ra - rb;
  return a.releaseAt < b.releaseAt ? -1 : a.releaseAt > b.releaseAt ? 1 : 0;
}
