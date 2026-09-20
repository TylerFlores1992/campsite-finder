/**
 * WHERE DOES THIS PERSON GO TO MANAGE THE SUBSCRIPTION THEY ARE ACTUALLY PAYING FOR?
 *
 * ── THE REPORT THIS EXISTS FOR (2026-09-19) ─────────────────────────────────────────
 * Our FIRST production store purchase — a Play subscriber, `provider='google'`,
 * `tier='autocart'`, `trialing` — reported that the Android app has no account or
 * subscription management at all. The owner confirmed it: *"Website has account
 * management but app does not."* They were both right, and the code said why in its own
 * comment: `Settings.tsx` gated the whole Subscription block on `!isNative` because
 * *"Apple and Google require digital subscriptions to go through in-app purchase, so the
 * native app never renders a price or a checkout route."*
 *
 * **THAT SENTENCE IS TRUE AND IT IS ABOUT BUYING.** It was applied to MANAGING, which is
 * a different act with the opposite rule: Apple 3.1.1 and Play's billing policy constrain
 * where a subscription may be SOLD, and both stores EXPECT an in-app-purchase subscriber
 * to be able to reach the subscription they bought. Suppressing management is not
 * compliance, it is a subscriber with no way to cancel.
 *
 * It is the same shape CLAUDE.md records under "AND THE CANCEL ROUTE IS CIRCULAR — YOU
 * CANNOT REACH `Manage` WHILE SUBSCRIBED": every purchase surface gates on `!subscribed`,
 * so the only `Manage` control in the product was the one behind a paywall a subscriber
 * never sees. That entry describes a TestFlight account. This one describes a paying
 * stranger.
 *
 * ── AND THE STRIPE PORTAL IS THE WRONG DESTINATION FOR THEM ─────────────────────────
 * Both suppressed controls pointed at `POST /api/stripe/portal`. For a store subscriber
 * that route knows nothing: there is no `stripe_customer_id` on the row, so it 404s, and
 * if it somehow did not it would open a portal describing a subscription the user does
 * not hold. So "unhide the existing button" is not the fix — the destination has to be
 * decided first.
 *
 * ── ROUTED ON THE STORED `provider`, NEVER ON THE DEVICE OS ─────────────────────────
 * `subscriptions.provider` (migration 071) is the one record of who holds the billing
 * relationship. The device is not: somebody can subscribe on camphawk.app and open the
 * Android app, or buy on Android and sign in on an iPhone, and in both cases the OS
 * answers a question nobody asked. `useNativePlatform()` is deliberately NOT consulted
 * here — this module contains no platform branch at all, which is also what keeps it out
 * of `src/lib/platform-parity.test.mts`'s registry.
 *
 * ── `unknown` MUST NOT ROUND TO "NOT SUBSCRIBED" ────────────────────────────────────
 * The house rule, applied one layer up by `useSubscription`'s `unknown` and one layer
 * down by `tierForStoreProductId` returning null. A status lookup that fails says so and
 * offers a general destination; it never tells a paying subscriber they have no
 * subscription, and it never guesses a store. An unrecognised `provider` string is the
 * same case — migration 071 deliberately puts no CHECK constraint on that column, so a
 * value we have never seen is a thing that can really arrive.
 *
 * ── PURE, IN `src/lib`, WITH ITS OWN TEST ───────────────────────────────────────────
 * A branch reachable only from inside a native webview is a branch nothing ever runs,
 * and this repo has shipped several of those (the paywall with no route to it; the
 * link-out that was live and invisible). The decision is therefore a function with a
 * test, and the components only render what it returns.
 */
import { PLAY_SUBSCRIPTION_ID } from './store-plans';

/**
 * The Android package name, which is `capacitor.config.ts`'s `appId` and
 * `codemagic.yaml`'s `PACKAGE_NAME`.
 *
 * COPIED, AND PINNED TO BOTH BY THE TEST. It cannot be imported: `capacitor.config.ts`
 * lives outside `src/` and pulling it into a browser bundle to read one string is a
 * worse trade than a constant a test proves equal. `subscription-management.test.mts`
 * reads both files and fails if this drifts from either — the same treatment
 * `store-plans.ts` gets for the tier vocabulary it re-declares rather than imports.
 */
export const ANDROID_PACKAGE_NAME = 'app.camphawk.mobile';

/** Play's own subscription screen. With no query string it lists everything the signed-in
 *  Google account pays for, which is the correct fallback when we cannot name the sku. */
export const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';

/** Apple's. There is no per-product form of this — the App Store shows the account's
 *  subscriptions and the user picks. */
export const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

/** Where "we could not tell" goes. Same-origin, in `isPublicRoute`, and price-free by
 *  design (its own header says so), so it is safe to reach from inside the shell. */
export const SUPPORT_HREF = '/support';

export type ManageKind = 'play' | 'app-store' | 'stripe-portal' | 'unknown';

export interface ManageDestination {
  kind: ManageKind;
  /**
   * Where to send them, or null for `stripe-portal` — that one is a POST that mints a
   * single-use session, so there is no URL to put in an anchor.
   */
  href: string | null;
  /** True when `href` must leave the webview rather than navigate the shell. */
  external: boolean;
  /** The control's own words. */
  label: string;
  /** The sentence above it. */
  detail: string;
}

/**
 * What the client knows about who is billing this user.
 *
 * A UNION AND NOT AN OPTIONAL FLAG, deliberately. `{ known: false }` carries no provider
 * at all, so there is no way to read a stale or absent `provider` as a fact about the
 * user — the mistake that turns a failed lookup into "not subscribed".
 */
export type BillingReading =
  | { known: false }
  | {
      known: true;
      /** `subscriptions.provider`, verbatim. Null when the user has no subscription row. */
      provider: string | null;
      /** `subscriptions.tier`, verbatim. Null when unknown; only used to deep-link Play. */
      tier: string | null;
    };

/** The Play subscription id for a tier, or null for a tier we do not recognize.
 *  Derived from `store-plans.ts`, which owns the product ids — never a second copy. */
export function playSkuForTier(tier: string | null | undefined): string | null {
  if (tier !== 'base' && tier !== 'autocart') return null;
  return PLAY_SUBSCRIPTION_ID[tier];
}

/**
 * Play's subscription screen, deep-linked to this product where we can name it.
 *
 * `sku` is the SUBSCRIPTION id (`camphawk_autocart`), not the base plan
 * (`camphawk_autocart:yearly`) — Play's deep link takes the parent. We store `tier`, not
 * a product id, so the base plan is not ours to lose here.
 *
 * AN UNKNOWN TIER DEGRADES TO THE PLAIN SCREEN rather than guessing a sku. A wrong `sku`
 * is worse than none: Play answers a deep link it cannot resolve with an error page, so
 * a guess would take a subscriber from "one extra tap" to "this app is broken".
 */
export function playSubscriptionUrl(tier: string | null | undefined): string {
  const sku = playSkuForTier(tier);
  if (!sku) return PLAY_SUBSCRIPTIONS_URL;
  const q = new URLSearchParams({ sku, package: ANDROID_PACKAGE_NAME });
  return `${PLAY_SUBSCRIPTIONS_URL}?${q.toString()}`;
}

/**
 * THE DECISION. Who is billing them decides where the control goes.
 *
 *   provider          destination
 *   ───────────────   ─────────────────────────────────────────────────────────
 *   'google'          Play's subscription screen, deep-linked where possible
 *   'apple'           the App Store's subscriptions screen
 *   'stripe' | null   the Stripe billing portal (null = no store row, i.e. the web)
 *   anything else     unknown — say so, offer support, claim nothing
 *   lookup failed     the same unknown arm
 *
 * CASE AND WHITESPACE ARE NORMALIZED, WHICH IS NOT THE SAME AS GUESSING. `providerForStore`
 * writes these lowercase today; trimming and lowercasing costs nothing and cannot turn a
 * store we do not know into one we do. Every other unrecognized value still lands on
 * `unknown`.
 */
export function manageDestination(reading: BillingReading): ManageDestination {
  if (!reading.known) return unknownDestination();

  const provider = reading.provider?.trim().toLowerCase() ?? null;

  if (provider === 'google') {
    return {
      kind: 'play',
      href: playSubscriptionUrl(reading.tier),
      external: true,
      label: 'Manage on Google Play',
      detail:
        'Google Play bills this subscription. Change your plan or cancel it there — ' +
        'anything you change applies to CampHawk right away.',
    };
  }

  if (provider === 'apple') {
    return {
      kind: 'app-store',
      href: APPLE_SUBSCRIPTIONS_URL,
      external: true,
      label: 'Manage in the App Store',
      detail:
        'Apple bills this subscription. Change your plan or cancel it from your App ' +
        'Store account — anything you change applies to CampHawk right away.',
    };
  }

  // 'stripe' is what migration 071 backfilled every pre-store row with, and null is a
  // user with no subscription row at all. Both are the web's billing relationship.
  //
  // AN EMPTY STRING IS NOT EITHER OF THOSE and falls through to `unknown`. The column is
  // NOT NULL DEFAULT 'stripe', so '' can only be corrupt data — and corrupt data is a
  // thing we cannot read, which is exactly what the unknown arm is for.
  if (provider === 'stripe' || provider === null) {
    return {
      kind: 'stripe-portal',
      href: null,
      external: true,
      label: 'Manage billing',
      detail:
        'CampHawk bills this subscription directly. Update your payment method or ' +
        'cancel in the billing portal.',
    };
  }

  return unknownDestination();
}

/**
 * THE ARM THAT MATTERS MOST, AND THE ONE NOTHING WILL EVER EXERCISE BY ACCIDENT.
 *
 * It says we could not check. It does NOT say there is no subscription, does not name a
 * store, and does not offer the Stripe portal — which would 404 for the store subscriber
 * this arm most likely belongs to, and a 404 reads as "your subscription is gone".
 */
function unknownDestination(): ManageDestination {
  return {
    kind: 'unknown',
    href: SUPPORT_HREF,
    external: false,
    label: 'Get help with your subscription',
    detail:
      "We couldn't check your subscription just now, so we can't say where it's " +
      'billed. If you subscribed inside the app, manage it from your Google Play or ' +
      'App Store account; if you subscribed on camphawk.app, manage it in the billing ' +
      'portal.',
  };
}
