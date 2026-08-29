// RevenueCat webhook decisions, extracted so they can be tested.
//
// EXTRACTED FROM THE ROUTE for the reason `twilio-signature.ts` records: a Next route
// file pulls in `next/server` and the `@/` alias, neither of which the tsx test runner
// resolves, so anything living inside `route.ts` is untestable here. This module is the
// half that decides whether somebody is entitled, which is the half worth testing.
//
// THE PAYLOAD SHAPE IS READ, NOT RECALLED — captured from RevenueCat's own `Send test
// event` on 2026-08-28 and written up in `docs/STOREKIT-PLAN.md` §4c.

import { timingSafeEqual, createHmac } from 'crypto';
import type { PlanTier } from './stripe-plans';

/** The event, as it arrives. Nested under `event` — the envelope is `{api_version, event}`. */
export interface RcEvent {
  type?: string;
  id?: string;
  environment?: string;
  app_user_id?: string;
  product_id?: string;
  store?: string;
  period_type?: string;
  original_transaction_id?: string | null;
  transaction_id?: string | null;
  expiration_at_ms?: number | null;
}

export type RcProvider = 'google' | 'apple';

/**
 * Which tier a product id implies.
 *
 * Play ids arrive as `<product_id>:<base_plan_id>` (RevenueCat states this on the import
 * screen), so the tier is the part before the FIRST colon.
 *
 * A PREFIX TEST, NOT A LIST OF THE FOUR IDS. An exhaustive list silently mis-tiers a
 * fifth product added later; this degrades to 'base', which is the same failure
 * direction `tierForPriceId` chose — "paying but treated as base", never silent free
 * premium.
 */
export function tierForProductId(productId: string | null | undefined): PlanTier {
  if (!productId) return 'base';
  return productId.split(':')[0] === 'camphawk_autocart' ? 'autocart' : 'base';
}

/** `store` → migration 071's `provider`. Unknown stores are not ours to record. */
export function providerForStore(store: string | null | undefined): RcProvider | null {
  if (store === 'PLAY_STORE') return 'google';
  if (store === 'APP_STORE') return 'apple';
  return null;
}

/**
 * WHY THIS EVENT SHOULD BE IGNORED, or null to process it.
 *
 * `SANDBOX` IS THE DANGEROUS ONE. The integration is deliberately configured for *Both
 * Production and Sandbox* so test purchases are visible — which means the production
 * webhook receives sandbox events. Granting on one would let anyone with a test device
 * mint themselves a paid subscription. It is easy to miss precisely because SANDBOX is
 * what the only sample anyone ever looks at says.
 */
export function ignoreReason(event: RcEvent): string | null {
  if (event.type === 'TEST') return 'test event';
  if (event.environment !== 'PRODUCTION') return `environment=${event.environment ?? 'absent'}`;
  return null;
}

/**
 * The status this event implies, or null for "do not change it".
 *
 * ACCESS IS DECIDED BY `expiration_at_ms`, NEVER BY THE EVENT NAME, and that one choice
 * gets three otherwise-fiddly cases right at once:
 *
 *   CANCELLATION  a cancelled subscriber KEEPS ACCESS until the period ends. Mapping the
 *                 event name to 'canceled' would revoke what they already paid for.
 *   BILLING_ISSUE two opposite states behind one name (§5): Play's 7-day GRACE PERIOD
 *                 still entitles, its 32-day ACCOUNT HOLD does not. The expiry separates
 *                 them without us having to know which we were sent.
 *   EXPIRATION    carries an expiry in the past, so it lands on 'expired' by the same rule.
 *
 * `period_type: 'TRIAL'` is how the `intro-free-week` offer arrives, and maps to
 * 'trialing' — which `hasActiveSubscription` already accepts alongside 'active', and
 * which Stripe's path also produces. Reading only the event type would put every trial
 * subscriber on 'active' and lose the distinction the offer exists for.
 *
 * A MISSING EXPIRY NEVER REVOKES. Unknown is not "not subscribed" (§4), so without an
 * expiry we only ever grant, and only on an event that explicitly says a purchase
 * happened. Anything else returns null and leaves the row alone.
 */
const GRANTING_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED',
]);

export function statusForEvent(event: RcEvent, nowMs: number): string | null {
  const live = event.period_type === 'TRIAL' ? 'trialing' : 'active';
  const expiresAt = event.expiration_at_ms;
  if (expiresAt == null) {
    return GRANTING_TYPES.has(event.type ?? '') ? live : null;
  }
  return expiresAt > nowMs ? live : 'expired';
}

/**
 * The store's stable id for this subscription — what migration 071's unique index is on.
 *
 * `original_transaction_id` FIRST, because it survives renewals: `transaction_id` changes
 * every period, so keying on it would write a new row each month and the index would stop
 * preventing the thing it exists to prevent (one purchase claimed by two accounts).
 */
export function storeTransactionId(event: RcEvent): string | null {
  return event.original_transaction_id || event.transaction_id || null;
}

/**
 * The shared `Authorization` value, compared in constant time.
 *
 * RAW VALUE, NO `Bearer` PREFIX — read off RevenueCat's own field help: "RevenueCat will
 * send an HTTP Authorization header with this value in each POST request."
 *
 * FAILS CLOSED on a missing header or a missing secret. "We cannot verify" must never
 * mean "accept": this route is public, and an unverified POST would let anyone write a
 * row claiming they had paid.
 */
export function verifyAuthHeader(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, so the length test is required rather
  // than an optimisation.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The `X-RevenueCat-Webhook-Signature` HMAC over the raw body.
 *
 * SEPARATE FROM THE HEADER CHECK ON PURPOSE. The Authorization value is a static string:
 * anyone who ever sees it — a proxy log, a screenshot — can replay it forever. The
 * signature proves the body came from RevenueCat and was not altered.
 *
 * RETURNS null WHEN IT CANNOT JUDGE (no secret configured, or no header sent), which the
 * caller treats differently from `false`. The scheme was not verifiable from this session
 * — revenuecat.com is 403 at the agent proxy — so a mismatch must NOT reject a real event
 * until it has been seen working. `false` is reported, not enforced. Promote it to a hard
 * failure once a live event verifies.
 */
export function verifyHmac(
  rawBody: string,
  header: string | null,
  secret: string | undefined
): boolean | null {
  if (!secret || !header) return null;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
