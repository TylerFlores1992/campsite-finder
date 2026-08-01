import 'server-only';

/**
 * The two plans, mapped to Stripe prices — in ONE place, because three routes need
 * the same answer: checkout (which price to sell), upgrade (which price to swap to),
 * and the webhook (which tier a price implies).
 *
 * Prices are referenced by env id, not looked up by lookup_key: the live Stripe key
 * is a RESTRICTED key without product/price read permission (verified 2026-08-01 —
 * prices.retrieve 403s), and checkout/subscription writes only need the id. The four
 * env vars live on Vercel; the two Auto-Cart ones are created with the plan.
 *
 * The tier column in `subscriptions` is DERIVED from these ids on every webhook
 * event. An unrecognised price maps to 'base' — the failure mode is then "paying
 * premium, treated as base", which surfaces immediately as a complaint we can fix,
 * rather than "free premium", which never surfaces at all. Grandfathered pre-tier
 * subscriptions get their auto-cart from `subscriptions.grandfathered`, never from
 * tier, so this derivation can't take it away from them (migration 032).
 */
export type PlanTier = 'base' | 'autocart';
export type BillingInterval = 'monthly' | 'yearly';

const PRICE_IDS: Record<PlanTier, Record<BillingInterval, string | undefined>> = {
  base: {
    monthly: process.env.STRIPE_PRICE_ID_MONTHLY,
    yearly: process.env.STRIPE_PRICE_ID_YEARLY,
  },
  autocart: {
    monthly: process.env.STRIPE_PRICE_ID_AUTOCART_MONTHLY,
    yearly: process.env.STRIPE_PRICE_ID_AUTOCART_YEARLY,
  },
};

export function priceIdFor(tier: PlanTier, interval: BillingInterval): string | undefined {
  return PRICE_IDS[tier]?.[interval];
}

/** Which tier a Stripe price id implies. Unknown ids are 'base' (see above). */
export function tierForPriceId(priceId: string | null | undefined): PlanTier {
  if (!priceId) return 'base';
  return priceId === PRICE_IDS.autocart.monthly || priceId === PRICE_IDS.autocart.yearly
    ? 'autocart'
    : 'base';
}

/** False until the Auto-Cart price ids are configured — the UI hides the plan and
 *  checkout refuses it, so a half-configured deploy can't sell a tier that doesn't
 *  exist in Stripe yet. */
export function autocartPlanConfigured(): boolean {
  return !!(PRICE_IDS.autocart.monthly && PRICE_IDS.autocart.yearly);
}

export function isPlanTier(v: unknown): v is PlanTier {
  return v === 'base' || v === 'autocart';
}

export function isBillingInterval(v: unknown): v is BillingInterval {
  return v === 'monthly' || v === 'yearly';
}
