/**
 * "3 sites just opened at Morro Bay" — one text instead of three.
 *
 * ## What produces three texts
 *
 * Since migration 070 one watch can cover a whole park, and `loadWatches` emits one row
 * per (watch, campground). At an 08:00 ReserveCalifornia release every held site in the
 * park frees at once, so a three-division park watch finds an opening in each division IN
 * THE SAME POLLER CYCLE — three claims, three dispatches, three texts, three emails and
 * three pushes, for what the reader experiences as one event at one campground.
 *
 * ## The claim is NOT touched, and that is deliberate
 *
 * Every site still wins or loses its own `(watch, campground::site)` claim exactly as
 * before. The batching happens strictly AFTER all the claims are decided, at dispatch.
 *
 * This is the single most important property here. The 2026-08-24 storm — 26 texts in an
 * hour — was caused by changing what the claim key means, and the entry recording it says
 * the direction matters more than the size: the old failure cost a user one missed
 * heads-up, the new one cost them their trust in every alert. A batcher that merged claims
 * would be that mistake again, in a feature whose whole purpose is fewer messages.
 *
 * `claimNotification` also doubles as the "still open" observation and must be called on
 * every cycle a site is open, so the row loop is unchanged; only the sending moves.
 *
 * ## What this does NOT merge, stated so nobody assumes otherwise
 *
 * - **Openings in different cycles.** Sites that free at 08:00:00 and 08:00:20 are two
 *   cycles and stay two messages. Merging them needs a hold-back window, which buys fewer
 *   texts with LATENCY on the most latency-critical path in the product — a real trade
 *   that is the owner's to make, not one to slip in behind a tidy-up.
 * - **Two open sites in one division.** `findRCOpenUnit` returns the FIRST match, so a
 *   division reports one site per cycle whatever else is free in it.
 * - **Two separate watches on the same park.** Different watches are different stay
 *   windows and different rows the user manages independently; collapsing them would make
 *   a pause or a mute apply to a message covering something else.
 */

/** The bits of a queued alert the grouping reads. */
export interface Groupable {
  watchId: string;
}

/**
 * Openings that belong in one message, in the order they were found.
 *
 * KEYED ON THE WATCH, NOT THE USER OR THE PARK. A watch is one stay window that the user
 * manages as a unit — pause it, mute a site in it — so it is the largest thing a single
 * message can honestly speak for. Two watches on one park have different dates.
 *
 * Insertion order is preserved on purpose: the first opening found becomes the one the
 * message leads with, which keeps the batched alert's deep link and its dates the same as
 * the un-batched alert would have had.
 */
export function groupByWatch<T extends Groupable>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const g = groups.get(item.watchId);
    if (g) g.push(item);
    else groups.set(item.watchId, [item]);
  }
  return [...groups.values()];
}

/** One of the other sites that opened for the same watch in the same cycle. */
export interface AlsoSite {
  campgroundName: string;
  campsiteName: string | null;
  campsiteId: string | null;
  bookingUrl: string;
}

/** The fields a queued alert contributes to a batch. Structural rather than the whole
 *  `NotificationPayload`, so this module stays pure and testable on its own. */
export interface BatchablePayload {
  campgroundName: string;
  campsiteName?: string | null;
  campsiteId?: string | null;
  bookingUrl: string;
}

/**
 * Turn the openings BEHIND the lead into the `alsoSites` the channels render.
 *
 * ## Every site keeps its OWN booking URL
 *
 * That is the whole reason this is a function and not an inline `.map` in the poller. A
 * deep link is per site AND per division — `bookingLink` turns `/park/680` into
 * `/park/680/583` — so handing the lead's link to a sibling sends the reader to a loop the
 * site is not in. That is the 2026-08-16 report ("says site A012 but took me to 35-102")
 * arriving by a third route, and it is the kind of substitution that reads as tidy in a
 * diff. Written inline it was invisible to every test; here a mutation that swaps in the
 * lead's URL fails immediately.
 */
export function alsoSitesFrom(rest: readonly BatchablePayload[]): AlsoSite[] {
  return rest.map((r) => ({
    campgroundName: r.campgroundName,
    campsiteName: r.campsiteName ?? null,
    campsiteId: r.campsiteId ?? null,
    bookingUrl: r.bookingUrl,
  }));
}
