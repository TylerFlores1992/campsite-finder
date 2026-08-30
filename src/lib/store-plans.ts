/**
 * THE PLAY PLAN GRID, AND THE DECISION THAT DECIDES WHETHER SOMEBODY IS CHARGED TWICE.
 *
 * `docs/STOREKIT-PLAN.md` §9a: **Play has no subscription groups.** Apple ranks four
 * products inside one group and works out upgrade-vs-downgrade for you. Play has two
 * unrelated subscriptions with base plans underneath, no level, no ranking, and nothing
 * that decides for you. The app states it at purchase time. **No console screen can show
 * that mistake**, which is why the whole decision lives here, pure, and is tested.
 *
 * ── THE FAILURE THAT ACTUALLY COSTS MONEY IS NOT THE PRORATION MODE ─────────────────
 * It is passing **no change info at all.** `purchasePackage` with no
 * `storeProductChangeInfo` is a request for a NEW, INDEPENDENT subscription — so a user
 * who already pays for Alerts and taps Auto-Cart ends up holding both, and Play bills
 * both, every month, until somebody notices. That is the double charge, and it is the
 * DEFAULT if this module is bypassed. `decidePurchase` exists so the change info cannot
 * be forgotten: it returns the whole instruction, not an optional extra.
 *
 * ── WHY THIS FILE IS CLIENT-SAFE ────────────────────────────────────────────────────
 * `stripe-plans.ts` is `server-only` and imports as a throwing stub in a browser bundle,
 * so the tier/interval vocabulary is re-declared here rather than imported. The two are
 * pinned equal by `worker/store-plans.test.mts` — a drift between the tier a Stripe price
 * implies and the tier a Play product implies would put a paying subscriber on the wrong
 * plan silently.
 */

export type PlanTier = 'base' | 'autocart';
export type BillingInterval = 'monthly' | 'yearly';

/**
 * `STORE_REPLACEMENT_MODE` from `@revenuecat/purchases-typescript-internal-esm`, restated
 * as a string union.
 *
 * RESTATED, NOT IMPORTED, DELIBERATELY. Importing the enum pulls the RevenueCat SDK into
 * every bundle that reads this module — including the web one, where the plugin's own web
 * implementation exists only to throw `Web not supported in this plugin`. The values are
 * the wire format Play receives, so a copy is the contract rather than a duplicate of it,
 * and the test asserts every member here exists in the SDK's enum with the same value.
 */
export type StoreReplacementMode =
  | 'WITHOUT_PRORATION'
  | 'WITH_TIME_PRORATION'
  | 'CHARGE_FULL_PRICE'
  | 'CHARGE_PRORATED_PRICE'
  | 'DEFERRED';

/** Play subscription ids (§9b). Lowercase, permanent, and a namespace of their own —
 *  they deliberately do not match Apple's or Stripe's. */
export const PLAY_SUBSCRIPTION_ID: Record<PlanTier, string> = {
  base: 'camphawk_base',
  autocart: 'camphawk_autocart',
};

/**
 * Apple product ids (§8), which are a DIFFERENT SHAPE, and that is the whole reason this
 * section exists.
 *
 *     Play    `camphawk_autocart:yearly`              <subscriptionId>:<basePlanId>
 *     Apple   `app.camphawk.mobile.autocart.yearly`   dot-separated, bundle-id prefixed
 *
 * **THE PARSERS BELOW SPLIT ON `:` AND WERE PLAY-ONLY UNTIL 2026-08-30.** Run against §8's
 * four ids they returned `tier: 'base'` for **all four** — including both Auto-Cart products
 * — and `null` from `planForProductId` for all four. Measured, not reasoned: an Apple
 * Auto-Cart subscriber paying $11.99 or $59.99 would have been written to the database as
 * tier `base` and silently denied the feature they bought.
 *
 * It failed in the deliberate "paying but treated as base, never silent free premium"
 * direction, so nobody would have got premium free — but it was wrong on **every** Apple
 * purchase, not an edge case, and nothing tested it because no test fed an Apple id to
 * either function.
 */
export const APPLE_PRODUCT_PREFIX = 'app.camphawk.mobile.';

export const APPLE_PRODUCT_ID: Record<PlanTier, Record<BillingInterval, string>> = {
  base: {
    monthly: `${APPLE_PRODUCT_PREFIX}base.monthly`,
    yearly: `${APPLE_PRODUCT_PREFIX}base.yearly`,
  },
  autocart: {
    monthly: `${APPLE_PRODUCT_PREFIX}autocart.monthly`,
    yearly: `${APPLE_PRODUCT_PREFIX}autocart.yearly`,
  },
};

/**
 * The two segments of a store product id — tier and interval — for EITHER store, or null
 * for a segment we do not recognise.
 *
 * **THEY ARE RETURNED SEPARATELY AND MUST STAY THAT WAY.** `tierForProductId` (the webhook)
 * needs the tier alone and must NOT lose it because the interval is unfamiliar: a fifth base
 * plan under `camphawk_autocart` — say `camphawk_autocart:weekly` — is a real Auto-Cart
 * purchase, and folding the two decisions together would downgrade that subscriber to `base`.
 * That is a live regression risk, not a hypothetical: it is exactly what a tidy
 * `planForProductId(id)?.tier` would do.
 */
function segmentsOf(productId: string): { tier: string; interval: string | undefined } {
  if (productId.startsWith(APPLE_PRODUCT_PREFIX)) {
    const [tier, interval] = productId.slice(APPLE_PRODUCT_PREFIX.length).split('.');
    return { tier, interval };
  }
  const [tier, interval] = productId.split(':');
  return { tier, interval };
}

/**
 * Which tier a store product id implies, independent of its interval, or null when the id
 * is not one of ours.
 *
 * A STRUCTURAL TEST, NOT A LIST OF THE EIGHT IDS. An exhaustive list silently mis-tiers a
 * ninth product added later; this returns null, and the webhook's caller degrades that to
 * `base` — "paying but treated as base", never silent free premium.
 */
export function tierForStoreProductId(productId: string | null | undefined): PlanTier | null {
  if (!productId) return null;
  const { tier } = segmentsOf(productId);
  if (productId.startsWith(APPLE_PRODUCT_PREFIX)) {
    return tier === 'autocart' ? 'autocart' : tier === 'base' ? 'base' : null;
  }
  return tier === PLAY_SUBSCRIPTION_ID.autocart
    ? 'autocart'
    : tier === PLAY_SUBSCRIPTION_ID.base
      ? 'base'
      : null;
}

/**
 * What a store product identifier means, or null when we cannot tell.
 *
 * Play ids reach us as `<subscriptionId>:<basePlanId>` — `camphawk_autocart:yearly`.
 * Apple ids as `app.camphawk.mobile.<tier>.<interval>` (§8). Both shapes, one parser.
 *
 * NULL RATHER THAN A GUESS. An unrecognised id is "we could not tell", and every caller
 * here treats that as a reason to be careful rather than as a fact about the user. The
 * repo's standing rule: unknown never rounds to a verdict.
 */
export function planForProductId(
  productId: string | null | undefined
): { tier: PlanTier; interval: BillingInterval } | null {
  if (!productId) return null;
  const tier = tierForStoreProductId(productId);
  const { interval: segment } = segmentsOf(productId);
  const interval: BillingInterval | null =
    segment === 'monthly' ? 'monthly' : segment === 'yearly' ? 'yearly' : null;
  if (!tier || !interval) return null;
  return { tier, interval };
}

/**
 * WHICH REPLACEMENT MODE A PLAN CHANGE NEEDS. This is §9a's whole decision.
 *
 * Two axes, and only one of them is about entitlement:
 *
 *   TIER      `autocart` strictly contains `base` — RevenueCat grants the `alerts`
 *             entitlement from all four products and `autocart` from two (§4d). So a
 *             tier change is a real gain or loss of a feature.
 *   INTERVAL  monthly vs yearly is the same product bought for longer. Nothing is gained
 *             or lost; only the commitment and the rate change.
 *
 * ── UP: `WITH_TIME_PRORATION` ───────────────────────────────────────────────────────
 * Immediate access, remaining time credited against the new plan. It is RevenueCat's own
 * documented default, and — the reason it is chosen here — it **credits rather than
 * charges**, so it is structurally incapable of the double charge this file exists to
 * prevent.
 *
 * `CHARGE_PRORATED_PRICE` WAS CONSIDERED AND REJECTED, and the reason is worth keeping
 * because it looks like the more precise answer. It keeps the billing date stable and
 * charges the difference — genuinely nicer for base/monthly → autocart/monthly. But it is
 * documented "only available for subscription upgrade" AND it holds the billing cycle
 * fixed, so it cannot express a change that also switches monthly↔yearly. Using it would
 * mean two upgrade modes selected by a second condition, on the one path nobody can test
 * before it bills a real person. One mode that always credits beats two that are usually
 * exact.
 *
 * ── DOWN: `DEFERRED` ────────────────────────────────────────────────────────────────
 * The old plan runs to its end and the new price is charged then. A downgrade must never
 * be immediate: an Auto-Cart subscriber who switches to Alerts has **already paid for
 * Auto-Cart through the end of the period**, and taking the feature away the moment they
 * tap is charging them for something we then withdraw. Same for yearly → monthly: we do
 * not refund eleven months, we let the year finish.
 *
 * ── UNKNOWN: `DEFERRED` ─────────────────────────────────────────────────────────────
 * Reached when the current product cannot be parsed — a fifth product, or a shape Play
 * changes under us. Deferring is the only mode that neither charges now nor removes
 * access now, so the cost of being wrong is that a user waits until renewal for something
 * they asked for. That is the recoverable direction; every alternative spends money on a
 * guess.
 *
 * NOTE, NOT VERIFIED: Play documents restrictions on which replacement modes are legal for
 * which transitions, and none of this has been exercised against a real Play account —
 * §9a says so, and no console screen can show it. A refused mode surfaces as a rejected
 * purchase, which is loud. A wrongly-ACCEPTED mode is the silent one, which is why both
 * arms above prefer the mode that cannot take money by surprise.
 */
export function replacementModeFor(
  from: { tier: PlanTier; interval: BillingInterval } | null,
  to: { tier: PlanTier; interval: BillingInterval }
): StoreReplacementMode {
  if (!from) return 'DEFERRED';
  if (from.tier !== to.tier) {
    return to.tier === 'autocart' ? 'WITH_TIME_PRORATION' : 'DEFERRED';
  }
  if (from.interval !== to.interval) {
    return to.interval === 'yearly' ? 'WITH_TIME_PRORATION' : 'DEFERRED';
  }
  // Same tier, same interval: not a change at all. `decidePurchase` refuses before
  // reaching here; the mode is the harmless one in case a caller does not.
  return 'DEFERRED';
}

/** What the app currently believes about this user's subscription, from whichever source
 *  saw it. `storeProductId` is passed through to Play VERBATIM — see `decidePurchase`. */
export interface CurrentSubscription {
  /** Who is billing them today. `null` when nobody is. */
  provider: 'google' | 'apple' | 'stripe' | null;
  /** The store's own identifier for the active subscription, exactly as the store
   *  reported it. Null when there is no store subscription. */
  storeProductId: string | null;
}

export type PurchaseDecision =
  /** No existing store subscription — a plain new purchase. */
  | { action: 'buy' }
  /** Replace an existing store subscription. Both fields go to Play. */
  | { action: 'change'; oldProductIdentifier: string; replacementMode: StoreReplacementMode }
  /** Do not send anything to the store. `reason` is for the log, `message` for the user. */
  | { action: 'refuse'; reason: string; message: string };

/**
 * THE ONE ENTRY POINT. Everything a caller needs to hand Play, or a refusal.
 *
 * `oldProductIdentifier` IS THE STORE'S OWN STRING, PASSED THROUGH UNCHANGED — never
 * rebuilt from the parsed tier and interval. What Play expects here (`camphawk_base`
 * versus `camphawk_base:monthly`) is a detail of RevenueCat's bridge that this session
 * could not verify against a live account, so the code declines to have an opinion:
 * whatever `customerInfo.activeSubscriptions` reports is what goes back. Reconstructing
 * it would be writing a Play identifier from memory, which is how an RC URL shape was
 * invented twice and answered with a 404 both times.
 *
 * A STRIPE SUBSCRIBER IS REFUSED OUTRIGHT, and this is the check most likely to look
 * redundant. All five surfaces gate on `!subscribed`, so in principle a paying web
 * subscriber never reaches a store buy button. But Play cannot replace a Stripe
 * subscription — there is no `oldProductIdentifier` for it — so a purchase that slipped
 * through would open a SECOND live subscription with a different provider, and the two
 * would bill in parallel with nothing in either console showing the other. Entitlement is
 * checked where it would be spent; so is this.
 */
export function decidePurchase(
  current: CurrentSubscription,
  target: { tier: PlanTier; interval: BillingInterval }
): PurchaseDecision {
  if (current.provider === 'stripe') {
    return {
      action: 'refuse',
      reason: 'active stripe subscription',
      message:
        'Your subscription is billed through camphawk.app. Change your plan there — buying ' +
        'here would start a second subscription alongside it.',
    };
  }

  if (!current.storeProductId) return { action: 'buy' };

  const from = planForProductId(current.storeProductId);
  if (from && from.tier === target.tier && from.interval === target.interval) {
    return {
      action: 'refuse',
      reason: 'already on this plan',
      message: "You're already on this plan.",
    };
  }

  return {
    action: 'change',
    oldProductIdentifier: current.storeProductId,
    replacementMode: replacementModeFor(from, target),
  };
}
