/**
 * WHAT THE AUTO-CART CONTROL ON `/new` IS ALLOWED TO PROMISE.
 *
 * THE DEFECT (found 2026-09-09, from a real subscriber). The toggle was gated on
 * `supportsAutoCart(campgroundSource)` alone — "is this a Recreation.gov campground" — and on
 * nothing about the person reading it. It defaults ON and says *"We put the site in your
 * Recreation.gov cart the moment it opens"*, with a TrustPanel under it reinforcing that.
 *
 * A base-tier subscriber ($2.50, no auto-cart entitlement) created three watches on 2026-09-08
 * with that toggle left on. `hasAutocartEntitlement` will refuse at the moment it matters and
 * the poller's `isAutocartLane` will fail open to an ordinary alert — which is the SAFE
 * behaviour and the wrong PROMISE. Nothing on the screen told him.
 *
 * WHY THAT IS THE EXPENSIVE KIND OF WRONG, in this product's own words: "the cost of a miss is
 * not the failed cart — it is that a user who believes the site is handled STOPS WATCHING."
 * The same reasoning that put a BETA label above the RC hold button applies to a plan the
 * reader does not have.
 *
 * THIS IS NOT A SEVENTH ENFORCER. `hasAutocartEntitlement` has six and they all stay; a
 * client-side value can never gate a spend. This decides COPY, which is the half none of the
 * six covers.
 */

/** What the control may say. `promise` is the historic UI, unchanged. */
export type AutoCartOffer = 'promise' | 'upsell';

export interface AutoCartAudience {
  /** Auth and the subscription lookup have both resolved. */
  loaded: boolean;
  /** `hasAutocartEntitlement` — Auto-Cart tier, grandfathered, or beta. */
  autocart: boolean;
  /** The status lookup FAILED. Distinct from a confirmed "no". */
  unknown: boolean;
}

/**
 * UNKNOWN AND UNRESOLVED BOTH KEEP THE PROMISE, and that is the house rule rather than an
 * oversight. A failed status lookup is treated as "don't nag", never as "not subscribed" — the
 * rule that stops a Clerk blip telling a paying subscriber to go and subscribe. Applied here it
 * means a lookup failure shows an Auto-Cart subscriber the control they pay for, at the cost of
 * possibly showing a promise to someone who is not entitled. That trade is deliberate and it is
 * the same direction every other surface in this app takes: the failure mode of `unknown` is
 * always "behave as we did before", never "downgrade the reader".
 *
 * `!loaded` is the same call for a different reason — flashing an upsell for the few hundred
 * milliseconds before the lookup returns, at a paying customer, is the cry-wolf failure this
 * repo has fixed three times.
 */
/**
 * A SIGNED-OUT VISITOR GETS THE UPSELL, and that is a decision rather than a side effect.
 *
 * `/new` is a public route, and `useSubscription` reports a signed-out reader as
 * `{loaded: true, autocart: false, unknown: false}` — the same shape as a confirmed base-tier
 * subscriber, which is correct, because the question this control answers is "will auto-cart
 * happen for the watch I am about to create?" and for both of them the answer is no.
 *
 * It is also the better of the two for a prospect: naming the plan and linking to `/pricing`
 * is the path they want, where the promise variant would be a toggle they cannot act on above
 * a submit control `SubscribeCta` has already replaced. Pinned by a test so nobody restores
 * the promise here by widening the audience type.
 */
export function autoCartOffer(a: AutoCartAudience): AutoCartOffer {
  if (!a.loaded) return 'promise';
  if (a.unknown) return 'promise';
  return a.autocart ? 'promise' : 'upsell';
}

/**
 * Whether a watch created by this reader should record auto-cart intent.
 *
 * FALSE FOR AN UPSELL READER, deliberately, and this is the non-obvious half. The column
 * survives the watch, so leaving it `true` would mean that the day they upgrade, every watch
 * they created while being told they could not have this silently starts carting real
 * campsites. This product does not take a standing consent it was never given — the same
 * reason the RC hold is offered per release rather than as a setting.
 */
export function autoCartIntent(offer: AutoCartOffer, toggle: boolean): boolean {
  return offer === 'promise' && toggle;
}
