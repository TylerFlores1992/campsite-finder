"use client";

import Pricing from "./Pricing";
import { SubscribeLink, subscribeSentence } from "./nativeSubscribe";
import { useSubscription } from "./useSubscription";
import { useIsNativeApp } from "@/lib/native/context";

/**
 * The pricing block on the marketing home — INCLUDING the copy around the buttons.
 *
 * THE BUG THIS FIXES. `Pricing` gated itself on native and swapped its buy buttons
 * for "manage at camphawk.app", which read as compliant. But the buttons were the
 * only gated part: the "$2.50 a month, or $20 a year" headline, the LAUNCH PRICING
 * chip and the "subscribe now and you keep the rate" line lived in the server
 * component around it, ungated, so the native app rendered a full pricing panel with
 * the buy buttons quietly removed from the bottom of it. That is worse than either
 * extreme — it's the price display Apple and Google forbid, attached to nothing the
 * user can act on.
 *
 * The lesson generalises: gating the CHECKOUT CONTROL is not gating the PRICE. What
 * store review objects to is the price and the steer to an outside purchase, not the
 * button. Any new copy naming a figure belongs inside a native check, on either side
 * of this boundary.
 *
 * It's a client component purely so it can read the native flag — the flag must be
 * read client-side (a request-time API in the root layout 500'd production on
 * 2026-07-24; see src/lib/native/context.tsx). Everything else on the page stays
 * server-rendered, so the SEO case is untouched.
 */
export default function PricingSection() {
  const isNative = useIsNativeApp();
  const { subscribed } = useSubscription();

  // In the app: what the subscription includes, no figure and no route to buy.
  // Still worth a block — someone who subscribed on the web needs to know the app
  // is where the alerts land, and someone who hasn't needs to know the feature
  // exists at all.
  if (isNative) {
    return (
      <div className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-5 sm:p-6">
        <h2 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em] text-ch-green-deep">
          Searching is free. Watching needs a subscription.
        </h2>
        <p className="mt-2 max-w-[58ch] text-ch-body leading-relaxed text-ch-green-deep">
          A subscription covers up to 10 watches at once, push, text and email alerts, and
          auto-cart on Recreation.gov. Live search keeps working either way.
        </p>
        <p className="mt-2 max-w-[58ch] text-ch-meta leading-normal text-ch-green-deep">
          {subscribeSentence()} Once yours is active, everything works here.
        </p>
        {/* Renders nothing while NATIVE_LINKOUT is off. See nativeSubscribe.tsx —
            steering out is US-storefront-only, so it stays dark until app
            availability is restricted to the US. Never shown to a subscriber:
            prompting someone who already pays reads as a billing failure. */}
        {!subscribed && <SubscribeLink className="mt-3 text-ch-body text-ch-green-deep" />}
      </div>
    );
  }

  return (
    <div className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-5 sm:p-6">
      {/* LAUNCH PRICING IS A PROMISE ABOUT THE FUTURE, so it says "while we're new"
          rather than putting a countdown on it. Manufactured urgency — a deadline
          that never arrives, or a "was" price that was never charged — is the thing
          that makes pricing copy untrustworthy, and this is the screen where trust
          converts. If the price does go up, this line is already true; if it never
          does, nobody was lied to. */}
      <span className="inline-block rounded-ch-chip bg-white px-3 py-1 text-ch-label font-bold tracking-[.1em] text-ch-green-deep uppercase">
        Launch pricing
      </span>
      <h2 className="mt-2.5 font-ch-display text-ch-title font-extrabold tracking-[-.03em] text-ch-green-deep">
        Searching is free. Watching is $2.50 a month, or $20 a year.
      </h2>
      <p className="mt-2 max-w-[58ch] text-ch-body leading-relaxed text-ch-green-deep">
        One subscription covers up to 10 watches at once, text and email alerts, and auto-cart
        on Recreation.gov. Cancel any time — and live search keeps working either way.
      </p>
      <p className="mt-2 max-w-[58ch] text-ch-meta leading-normal text-ch-green-deep">
        This is introductory pricing while we&apos;re new, and it will go up as we add
        campgrounds and states. Subscribe now and you keep the rate you signed up at for as long
        as your subscription runs.
      </p>
      <div className="mt-4">
        <Pricing />
      </div>
    </div>
  );
}
