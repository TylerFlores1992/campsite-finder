"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
// One direction only — StorePaywall does not import this file, so there is no cycle.
import { STORE_PURCHASE_ENABLED } from "./StorePaywall";

import { useNativePlatform } from "@/lib/native/context";

/**
 * Steering a non-subscriber in the native app to camphawk.app to subscribe.
 *
 * THIS IS LEGAL NOW, AND IT WASN'T UNTIL RECENTLY. Both stores banned exactly this
 * ("anti-steering") for years. Both were forced to stop, in the US only:
 *   - Apple, App Review Guideline 3.1.1, updated May 2025 for the Epic v. Apple
 *     contempt ruling — on the US storefront there is no prohibition on buttons,
 *     external links or other calls to action, and NO entitlement is needed.
 *   - Google Play, following the Ninth Circuit upholding the Epic v. Google
 *     injunction (Sept 2025) — Google may not stop developers linking out to
 *     transactions or communicating prices. In force until at least Nov 2027.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHARP EDGE: BOTH CARVE-OUTS ARE **US-STOREFRONT ONLY.** Everywhere else the
 * original ban still applies, and an app that shows this UI to a non-US storefront
 * is a review failure — for Apple, reportedly one that can cost the entitlement
 * outright. So this must only ever ship in a US-only app, OR behind a real
 * storefront check. Device locale is NOT a storefront check: a US-storefront user
 * travelling abroad still counts as US, and vice versa.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Hence a switch PER STORE, off by default. Flip one only once THAT store's app
 * availability is restricted to the United States.
 *
 * The switch lives in the WEB code, which is the useful part: the app is a webview
 * pointed at the live site, so turning steering off is a push to master, not an app
 * release. If the legal picture moves — and it is still moving; Google's terms run
 * to Nov 2027 and Apple's remain under appeal — you are one deploy from compliant,
 * not one store review.
 *
 * ── WHY THIS IS TWO FLAGS AND NOT ONE (2026-08-19) ──────────────────────────────────
 * It was one boolean until Apple rejected 1.0 (5) under guideline 3.1.1 — *"the app
 * accesses digital content purchased outside the app … but that content isn't available
 * to purchase using In-App Purchase"* — and named this exact remedy in the same letter.
 *
 * **The two apps do not have the same availability, so one boolean could not answer.**
 * iOS is United States only (App Store Connect, 2026-07-30). The Android closed test is
 * deliberately WORLDWIDE, because the paid tester service requires it — and because the
 * flag is web-side and shared, flipping it for Apple would have shown steering UI to
 * non-US Play testers. That is precisely the failure the paragraph above warns about,
 * and it would have been introduced BY the fix for the other store.
 *
 * So `android` stays false until Play PRODUCTION is live and US-only. Turning it on
 * while a worldwide track exists is the mistake; the closed test is not the exception.
 */
export const LINKOUT_BY_STORE = {
  // App Store availability is United States only, so every install is a US storefront.
  ios: true,
  // The closed test is worldwide. Do NOT flip this until Play production is US-only.
  android: false,
} as const;

/**
 * Is steering allowed for THIS install? False on the web (nothing to steer — the web
 * can simply sell) and false in a shell we cannot identify, which is the safe direction.
 */
export function useNativeLinkout(): boolean {
  const platform = useNativePlatform();
  return platform ? LINKOUT_BY_STORE[platform] : false;
}

/** Where the link goes. `?from=app` so the funnel is measurable — otherwise there's
 *  no way to tell whether any of this converts. */
export const SUBSCRIBE_HREF = "https://camphawk.app/?from=app";

/**
 * The link itself.
 *
 * MUST OPEN IN THE SYSTEM BROWSER, not the webview. Following it in-app would just
 * navigate the shell to our own marketing page — which renders the native, priceless
 * variant, so the user would arrive at a page that can't sell them anything. The
 * `data-native-external` marker tells NativeBridge's click handler to hand this one
 * to the system browser even though camphawk.app is normally kept in-app (auth has
 * to stay in the webview, so the host alone can't decide).
 */
export function SubscribeLink({
  label = "Subscribe at camphawk.app",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  const linkout = useNativeLinkout();
  if (!linkout) return null;
  return (
    <a
      href={SUBSCRIBE_HREF}
      data-native-external="true"
      className={`inline-flex items-center gap-1.5 font-bold underline underline-offset-2 ${className}`}
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/**
 * One sentence for the surfaces that just need a line of copy, so the wording is
 * defined once rather than drifting across five screens. Returns the no-link
 * version when steering is off, which is what ships today.
 */
export function useSubscribeSentence(): string {
  return useNativeLinkout()
    ? "Subscriptions are set up at camphawk.app — it takes a minute, and everything works here straight after."
    : "Subscriptions are managed at camphawk.app.";
}

/**
 * The sentence as a COMPONENT, which is what the five surfaces render.
 *
 * A COMPONENT AND NOT A BARE HOOK CALL, DELIBERATELY. Every one of those call sites sits
 * inside a conditional branch — `{needsSubscription && …}`, the `subscribed` arm of
 * `PricingSection`, and so on. `{useSubscribeSentence()}` there would be a hook called
 * conditionally, which is a Rules-of-Hooks violation that happens to work until the
 * branch flips on a re-render and the hook order changes under React. A component can be
 * rendered conditionally all day; only its own body has to be unconditional.
 */
export function SubscribeSentence() {
  return <>{useSubscribeSentence()}</>;
}

/**
 * WHICH STORE CAN SELL INSIDE THE APP.
 *
 * ── WHY THIS EXISTS AT ALL (2026-08-30) ─────────────────────────────────────────────
 * Play in-app purchase went live on 2026-08-29 — `STORE_PURCHASE_ENABLED = true`, the SDK
 * configured, offerings fetched, `StorePaywall` mounted in `PricingSection`'s native
 * branch — and **no route in the app reached it.** Every path to `/pricing` and `/` is
 * suppressed in the shell: the nav lists Watches, New watch and Explore; its logo goes to
 * `/search`; `PricingLink` and `PlanOptionsButton` both `return null` when native; and
 * `NewWatch`'s subscription gate renders *"Manage your plan at camphawk.app"* as PLAIN
 * TEXT. So the feature was switched on and nobody could buy.
 *
 * **NONE OF THOSE SUPPRESSIONS WAS A MISTAKE.** Every one is a correct fix from the era
 * before IAP, when a price or a steer to web checkout inside the app was the thing both
 * stores forbade — `NewWatch`'s own comment says so. In-app purchase inverts that: showing
 * prices in the app is now exactly what the stores want. **The guard outlived its reason**,
 * which is the same shape as the `divisions.length <= 1` gate that hid site muting once a
 * park became one watch, and the fix-present-and-inert family at feature scale.
 *
 * ── A SECOND MAP RATHER THAN THE COMPLEMENT OF `LINKOUT_BY_STORE` ───────────────────
 * Deriving this as `!LINKOUT_BY_STORE[platform]` reads tidier and is wrong about the
 * future. **They are not opposites.** US rules let an app do both, and once Apple's
 * products exist iOS should carry the paywall AND keep the §2c link-out that the 08-22
 * resubmission argues. Two booleans that may both be true, each with its own reason.
 */
export const IN_APP_PURCHASE_BY_STORE = {
  // No products in App Store Connect and no NEXT_PUBLIC_REVENUECAT_IOS_KEY — verified
  // absent in the deployed bundle, twice. Flip when §8's four products are live; the
  // paywall's own probe still decides whether anything renders.
  ios: false,
  // Live since build 13 (the billing permission) plus four Active products, US-only.
  android: true,
} as const;

/**
 * Can THIS install buy in the app?
 *
 * FALSE ON THE WEB, which is not a technicality: the web has its own pricing page in its
 * own nav and sells through Stripe. This hook answers a question only the shell has.
 *
 * IT DELIBERATELY DOES NOT PROBE THE STORE. `useStorePurchases` calls
 * `Purchases.configure()` and `getOfferings()`, so asking it here would fire that once per
 * surface rendering a link. The single probe stays in `StorePaywall`, and a shell that
 * turns out not to be able to sell lands on `/pricing`'s fallback — which is the copy the
 * user would have been shown in place anyway, plus what the subscription includes.
 */
export function useStoreCanSell(): boolean {
  const platform = useNativePlatform();
  return !!platform && STORE_PURCHASE_ENABLED && IN_APP_PURCHASE_BY_STORE[platform];
}

/**
 * The route to the paywall. Renders nothing where the shell cannot sell, so it is safe to
 * place beside `SubscribeLink` — on any given store exactly one of the two appears.
 *
 * "See plans" AND NOT "Subscribe", because this link is honest in both outcomes: the page
 * shows four purchasable plans where the store is ready and what the subscription includes
 * where it is not. A button promising a purchase it cannot always deliver is the claim-copy
 * rule this repo has applied since 2026-08-09.
 */
export function StorePlansLink({
  label = "See plans",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  const canSell = useStoreCanSell();
  if (!canSell) return null;
  return (
    <Link href="/pricing" className={`font-bold underline underline-offset-2 ${className}`}>
      {label}
    </Link>
  );
}
