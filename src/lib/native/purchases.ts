/**
 * IN-APP PURCHASE, REACHED FROM A REMOTE WEBVIEW.
 *
 * `docs/STOREKIT-PLAN.md` §11a: the app is a thin native shell around the live site
 * (`server.url` in `capacitor.config.ts`), so this module is served fresh on every push
 * while the plugin behind it lives in a binary somebody has to install. **They will be
 * out of step, on purpose, for as long as it takes users to update.**
 *
 * ── DETECT THE CAPABILITY, NOT THE PLATFORM ─────────────────────────────────────────
 * `isNative` (`@/lib/native/context`) is a User-Agent marker. It says the shell is
 * CampHawk; it says nothing about whether that shell can buy anything. Every CampHawk
 * Android install before build 13 has the identical User-Agent and no billing library at
 * all. A paywall gated on `isNative` shows those users a Buy button that throws.
 *
 * **AND `Capacitor.isPluginAvailable('Purchases')` IS A FALSE POSITIVE — read out of
 * `@capacitor/core`, not assumed.** It returns true if a JS implementation is registered
 * for the current platform *or* a native one exists, and `@revenuecat/purchases-capacitor`
 * registers a web implementation whose every method throws `Web not supported in this
 * plugin`. So it answers yes in a desktop browser. Presence is not liveness — the same
 * shape as `status = 'sent'` meaning only "Twilio returned 2xx".
 *
 * What actually distinguishes a binary that can buy is `Capacitor.PluginHeaders`, the list
 * the NATIVE bridge publishes of plugins compiled into this build. It is absent on the web
 * entirely and carries no `Purchases` entry in an older app. That is the test.
 *
 * ── EVERY FAILURE IS `unavailable`, NEVER "NOT SUBSCRIBED" ──────────────────────────
 * §4's rule one layer down. A missing plugin, a missing key, an SDK that will not
 * configure, an offering that has not been published yet — all of them mean "we cannot
 * sell here", and callers fall back to whatever they did before this file existed. None
 * of them is evidence about what the user has paid for.
 *
 * ── THE SDK IS DYNAMIC-IMPORTED, ALWAYS ─────────────────────────────────────────────
 * Same discipline as `NativeBridge.tsx`: a static import puts the RevenueCat SDK in the
 * browser bundle for every web visitor, who can never use it.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import type { STORE_REPLACEMENT_MODE } from '@revenuecat/purchases-typescript-internal-esm';

import {
  decidePurchase,
  planForProductId,
  type BillingInterval,
  type CurrentSubscription,
  type PlanTier,
  type StoreReplacementMode,
} from '@/lib/store-plans';

/** The RevenueCat plugin's registered name — `registerPlugin('Purchases', …)`. */
const PLUGIN_NAME = 'Purchases';

/**
 * The public SDK key, inlined at BUILD time because it is `NEXT_PUBLIC_*`.
 *
 * Read through a named constant rather than inline so the "absent" case has one place to
 * be reasoned about: an unset variable is not an error, it is `unavailable`, and a deploy
 * that loses it de-lists in-app purchase rather than shipping a button that cannot work.
 * Same posture as `autocartPlanConfigured()`.
 */
const ANDROID_KEY = process.env.NEXT_PUBLIC_REVENUECAT_ANDROID_KEY;
const IOS_KEY = process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY;

/** Minimal shapes, so this file does not depend on the SDK's types at build time. */
type RcPackage = { identifier: string; product: { identifier: string } };
type RcCustomerInfo = { activeSubscriptions?: string[] };

export type StorePurchaseState =
  /** Still working it out. Render nothing — never flash a paywall at a subscriber. */
  | { status: 'probing' }
  /** This install cannot buy. Callers fall back (link-out, or the web checkout). */
  | { status: 'unavailable'; reason: string }
  /** Ready to sell. `plans` is what the store actually offers, not what we hoped for. */
  | { status: 'ready'; plans: StorePlanOffer[] };

export interface StorePlanOffer {
  tier: PlanTier;
  interval: BillingInterval;
  /** The store's own localised price string. NEVER a figure of ours — the store owns the
   *  number the user is charged, and printing our own would be the §9b period-dropdown
   *  trap from the other end. */
  priceString: string;
  productId: string;
  packageId: string;
}

/**
 * Bring the SDK up, bound to this user, and read what it can sell.
 *
 * `appUserID` IS THE CLERK ID AND IS REQUIRED. The webhook keys on `app_user_id` and
 * refuses anything it cannot resolve to a `users` row — so a purchase made while the SDK
 * holds a RevenueCat anonymous id (`$RCAnonymousID:…`) is logged as `ignored: unknown
 * user` and the payer gets nothing. That is money taken for no entitlement, so this
 * refuses to configure at all without a signed-in id rather than configuring anonymously
 * and hoping an alias lands later.
 */
async function bringUp(
  userId: string
): Promise<{ ok: true; plans: StorePlanOffer[] } | { ok: false; reason: string }> {
  const { Capacitor } = await import('@capacitor/core');
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') return { ok: false, reason: 'web' };

  // THE NATIVE-PLUGIN TEST. See the header for why `isPluginAvailable` cannot do this.
  // `PluginHeaders` is not in @capacitor/core's public types, so it is read defensively;
  // an unexpected shape reads as "no plugin", which is the safe direction.
  const headers = (
    globalThis as unknown as { Capacitor?: { PluginHeaders?: Array<{ name?: string }> } }
  ).Capacitor?.PluginHeaders;
  if (!Array.isArray(headers) || !headers.some((h) => h?.name === PLUGIN_NAME)) {
    return { ok: false, reason: 'no purchases plugin in this build' };
  }

  const apiKey = platform === 'android' ? ANDROID_KEY : IOS_KEY;
  if (!apiKey) return { ok: false, reason: `no ${platform} api key` };

  const { Purchases } = await import('@revenuecat/purchases-capacitor');
  await Purchases.configure({ apiKey, appUserID: userId });

  const offerings = await Purchases.getOfferings();
  const packages: RcPackage[] = offerings?.current?.availablePackages ?? [];
  // NO OFFERING IS `unavailable`, NOT AN ERROR. It is exactly what iOS reports today —
  // Apple's four products do not exist yet (§8), so the SDK configures fine and has
  // nothing to sell. Falling back leaves the iOS link-out (§2c) doing its job untouched.
  if (packages.length === 0) return { ok: false, reason: 'no packages offered' };

  const plans: StorePlanOffer[] = [];
  for (const p of packages) {
    const productId = p?.product?.identifier;
    const plan = planForProductId(productId);
    // An id we cannot classify is skipped rather than guessed at. Selling a package
    // whose tier we had to assume is how somebody pays for Auto-Cart and is granted
    // Alerts.
    if (!plan) continue;
    plans.push({
      ...plan,
      productId,
      packageId: p.identifier,
      priceString:
        (p.product as { priceString?: string }).priceString ?? '',
    });
  }
  if (plans.length === 0) return { ok: false, reason: 'no recognised products' };
  return { ok: true, plans };
}

/**
 * What the store thinks this user is currently paying for, read from the SDK rather than
 * from our own database.
 *
 * THE STORE IS AUTHORITATIVE FOR THE STORE. Our `subscriptions` row is written by a
 * webhook that can be late, retried, or out of order (a known open item in §5's write-up),
 * and the value being fetched here is fed straight back to Play as the thing to replace.
 * Asking the SDK removes a whole class of "we thought they were on monthly" from the one
 * decision that must not be wrong.
 *
 * A FAILED READ RETURNS null, WHICH `decidePurchase` TREATS AS "no store subscription"
 * AND THEREFORE AS A PLAIN BUY. That is the one place in this file where the safe
 * direction is genuinely debatable, so it is stated: the alternative is refusing to sell
 * to somebody who may well have nothing, and a purchase made without change info is
 * recoverable through the store's own management screen while a permanently dead button
 * is not. Callers that already know the user is subscribed must not reach here at all —
 * every surface gates on `!subscribed` (§4).
 */
async function readCurrentStoreProduct(): Promise<string | null> {
  try {
    const { Purchases } = await import('@revenuecat/purchases-capacitor');
    const info = (await Purchases.getCustomerInfo()) as { customerInfo?: RcCustomerInfo };
    const active = info?.customerInfo?.activeSubscriptions;
    return Array.isArray(active) && active.length > 0 ? active[0] : null;
  } catch {
    return null;
  }
}

export type PurchaseOutcome =
  | { result: 'purchased' }
  /** The user backed out. NOT an error, and must never be shown as one. */
  | { result: 'cancelled' }
  | { result: 'refused'; message: string }
  | { result: 'failed'; message: string };

/**
 * Buy, or change plan. The §9a decision is made in `store-plans.ts`; this only carries it.
 *
 * `storeProductChangeInfo` IS NOT OPTIONAL WHEN A SUBSCRIPTION EXISTS. Omitting it asks
 * Play for a second, independent subscription and the user is billed for both — see
 * `store-plans.ts`. It is threaded from `decidePurchase` rather than assembled here so
 * there is no branch in which it can be forgotten.
 */
async function buy(
  target: StorePlanOffer,
  current: CurrentSubscription
): Promise<PurchaseOutcome> {
  const decision = decidePurchase(current, { tier: target.tier, interval: target.interval });
  if (decision.action === 'refuse') {
    console.warn(`[purchases] refused: ${decision.reason}`);
    return { result: 'refused', message: decision.message };
  }

  const { Purchases } = await import('@revenuecat/purchases-capacitor');
  const offerings = await Purchases.getOfferings();
  const aPackage = offerings?.current?.availablePackages?.find(
    (p) => p.identifier === target.packageId
  );
  if (!aPackage) return { result: 'failed', message: 'That plan is no longer available.' };

  try {
    await Purchases.purchasePackage({
      aPackage,
      ...(decision.action === 'change'
        ? {
            storeProductChangeInfo: {
              oldProductIdentifier: decision.oldProductIdentifier,
              // The SDK types this as the STORE_REPLACEMENT_MODE enum; our union holds
              // its string VALUES, which is what crosses the bridge. The cast is the
              // seam, and `store-plans.test.mts` asserts member-for-member that the two
              // agree — so a value renamed upstream fails a test rather than becoming a
              // silently ignored proration mode.
              replacementMode: decision.replacementMode as STORE_REPLACEMENT_MODE,
            },
          }
        : {}),
    });
    return { result: 'purchased' };
  } catch (err) {
    // `userCancelled` IS THE ONLY FIELD WORTH BRANCHING ON, and it is the difference
    // between an error banner and no banner at all. Somebody who taps the system back
    // button has not hit a problem; telling them they have is how a paywall reads as
    // broken.
    if ((err as { userCancelled?: boolean })?.userCancelled) return { result: 'cancelled' };
    const message = (err as { message?: string })?.message;
    console.error('[purchases] purchase failed', err);
    return {
      result: 'failed',
      message: message || 'The purchase could not be completed. Nothing has been charged.',
    };
  }
}

/**
 * The hook the paywall mounts.
 *
 * Probes once per signed-in session. Signed out is `unavailable` rather than an error:
 * there is no Clerk id to bind the purchase to (see `bringUp`), and the surfaces already
 * send a signed-out visitor to sign up.
 */
export function useStorePurchases(): StorePurchaseState & {
  purchase: (plan: StorePlanOffer, current: CurrentSubscription) => Promise<PurchaseOutcome>;
} {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [state, setState] = useState<StorePurchaseState>({ status: 'probing' });

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !userId) {
      setState({ status: 'unavailable', reason: 'signed out' });
      return;
    }
    let cancelled = false;
    bringUp(userId)
      .then((r) => {
        if (cancelled) return;
        setState(
          r.ok ? { status: 'ready', plans: r.plans } : { status: 'unavailable', reason: r.reason }
        );
      })
      .catch((err) => {
        // An SDK that will not come up is a shell that cannot sell. Logged, because the
        // difference between "old build" and "the SDK threw" matters when somebody asks
        // why nobody is buying, and neither is visible from the store console.
        console.warn('[purchases] unavailable', err);
        if (!cancelled) setState({ status: 'unavailable', reason: 'sdk error' });
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId]);

  const purchase = useCallback(
    async (plan: StorePlanOffer, current: CurrentSubscription): Promise<PurchaseOutcome> => {
      // The store's own view of what is live, taken at purchase time rather than at probe
      // time — a plan can change in another tab, or in the Play app, between the two.
      const storeProductId = current.storeProductId ?? (await readCurrentStoreProduct());
      return buy(plan, { ...current, storeProductId });
    },
    []
  );

  return { ...state, purchase };
}

export type { StoreReplacementMode };
