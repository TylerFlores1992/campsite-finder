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
// `store-plans.ts` is a pure leaf with no imports of its own — importing it here does
// not drag `server-only` or the SDK into the webhook or into tsx's test runner.
import { tierForStoreProductId } from './store-plans';

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
 * **THIS SPLIT ON `:` AND WAS PLAY-ONLY UNTIL 2026-08-30**, which made it wrong for every
 * Apple id in §8: `app.camphawk.mobile.autocart.yearly` has no colon, so the whole string
 * failed the `=== 'camphawk_autocart'` test and **both Auto-Cart products returned `base`**.
 * Measured against the real function, not reasoned about. The shape rule now lives once, in
 * `store-plans.ts`, so a third store cannot be taught to one caller and not the other.
 *
 * THE DEGRADATION IS UNCHANGED AND IS THE POINT OF THE `?? 'base'`. An id we do not
 * recognise is not an error and does not throw — it becomes `base`, the same failure
 * direction `tierForPriceId` chose: "paying but treated as base", never silent free premium.
 *
 * **AND IT DELIBERATELY DOES NOT ASK FOR THE INTERVAL.** `planForProductId(id)?.tier` reads
 * as the tidy one-liner and is a real downgrade bug: a new base plan under an existing
 * subscription — `camphawk_autocart:weekly` — is a genuine Auto-Cart purchase, and that
 * expression returns null for it because the INTERVAL is unfamiliar, costing the subscriber
 * the feature they bought. `tierForStoreProductId` answers the tier alone for that reason.
 */
export function tierForProductId(productId: string | null | undefined): PlanTier {
  return tierForStoreProductId(productId) ?? 'base';
}

/** `store` → migration 071's `provider`. Unknown stores are not ours to record. */
export function providerForStore(store: string | null | undefined): RcProvider | null {
  if (store === 'PLAY_STORE') return 'google';
  if (store === 'APP_STORE') return 'apple';
  return null;
}

/**
 * Clerk user ids that may grant on a SANDBOX event — `REVENUECAT_SANDBOX_USER_IDS`,
 * comma-separated, read by the route and passed in so this module stays env-free.
 *
 * CLOSED BY DEFAULT AND CLOSED ON EVERY MALFORMED INPUT. Absent, empty, whitespace and a
 * bare `,` all produce an allowlist nobody is on; entries are trimmed, because a value
 * pasted with a space after the comma is how `TWILIO_ACCOUNT_SID` failed every send in
 * August and named the *username* while doing it.
 *
 * EMPTY ENTRIES ARE FILTERED, and that is not tidiness. `'user_a,'.split(',')` yields a
 * trailing `''`; without the filter an event whose `app_user_id` was also empty would
 * match it, so one stray comma would grant to an event carrying no user at all.
 *
 * **IT IS ALSO UNREACHABLE TODAY, AND DELIBERATELY KEPT — measured, not assumed.**
 * `sandboxGranted`'s `if (!user)` rejects the only key that could ever hit an empty entry,
 * so removing EITHER of them changes no behaviour and no behavioural test can see it go
 * (verified by mutation: each alone survives the suite, both together fail it). Two
 * enforcers for one hazard, in the same shape as `StorePaywall`'s flag check surviving
 * beneath a hook that already honours it. `the empty-entry pair is BOTH present` pins them
 * structurally, because that is the only thing that can.
 */
function sandboxAllowlist(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * May this SANDBOX event grant a real entitlement?
 *
 * EXPORTED SO THE ROUTE CAN LOG IT WITHOUT RE-DERIVING IT. A route that re-tested the
 * condition to decide what to print is two copies of one decision, and the copy is the
 * one that drifts — the shape this file already records for the tier parser being taught
 * to one caller and not the other.
 *
 * `SANDBOX` EXACTLY, NEVER "not production". An event with no `environment` field is an
 * absent reading, not a sandbox one, and absent must not round to a verdict that grants —
 * the same rule that keeps `unknown` from rounding to `signed-out`.
 */
export function sandboxGranted(event: RcEvent, rawAllowlist: string | null | undefined): boolean {
  if (event.environment !== 'SANDBOX') return false;
  const user = event.app_user_id;
  if (!user) return false;
  // A Set, so the match is the WHOLE id. `raw.includes(user)` reads as equivalent and lets
  // `user_3IS` grant for `user_3IS7IGiz…` — a prefix of a real id is trivially guessable.
  return sandboxAllowlist(rawAllowlist).has(user);
}

/**
 * WHY THIS EVENT SHOULD BE IGNORED, or null to process it.
 *
 * `SANDBOX` IS THE DANGEROUS ONE. The integration is deliberately configured for *Both
 * Production and Sandbox* so test purchases are visible — which means the production
 * webhook receives sandbox events. Granting on one would let anyone with a test device
 * mint themselves a paid subscription. It is easy to miss precisely because SANDBOX is
 * what the only sample anyone ever looks at says.
 *
 * **AND THAT GUARD IS WHY THE WHOLE CHAIN HAS NEVER ONCE RUN.** Measured 2026-09-14: two
 * real Apple purchases on `iamtylerflores12345@yahoo.com` — a Base Monthly trial and a
 * change to Auto-Cart Monthly, both present in RevenueCat's customer history — produced
 * **zero rows in `subscriptions`**, so the app went on showing "See plans" afterwards.
 * The same was true of the Play licence-tester purchase on 2026-08-30. Webhook → row →
 * `hasActiveSubscription` is unexercised on both stores.
 *
 * **IT IS ALSO A REJECTION WAITING TO HAPPEN, WHICH IS WHAT THE ALLOWLIST IS FOR.** App
 * Review buys in the sandbox. With the guard closed to everybody, the reviewer completes a
 * purchase, the app unlocks nothing, and "the in-app purchase did not unlock content" is
 * an ordinary 2.1 rejection — the sixth on an app rejected five times already, and the
 * third in the family where the artefact is correct and what the reviewer SEES is not.
 *
 * SO THE EXCEPTION IS PER-USER RATHER THAN PER-ENVIRONMENT. Opening SANDBOX generally
 * would restore exactly the hole the paragraph above describes: TestFlight purchases run
 * in the sandbox, so anyone holding a build could mint themselves a paid subscription.
 * Naming the accounts keeps the blast radius at the accounts we own.
 *
 * **CLEAR `REVENUECAT_SANDBOX_USER_IDS` ONCE THE APP IS APPROVED.** Nothing here expires
 * it, and a listed account can take free subscriptions from any sandbox purchase for as
 * long as it is set. The route logs a line on every sandbox grant so the cost is visible
 * rather than silent.
 */
export function ignoreReason(event: RcEvent, rawSandboxAllowlist?: string | null): string | null {
  // FIRST, so an allowlisted user cannot be handed a TEST event. RevenueCat's "Send test
  // event" button carries `environment: SANDBOX` and a real-looking product, and it is
  // reachable by anyone with dashboard access.
  if (event.type === 'TEST') return 'test event';
  if (event.environment === 'PRODUCTION') return null;
  if (sandboxGranted(event, rawSandboxAllowlist)) return null;
  return `environment=${event.environment ?? 'absent'}`;
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
