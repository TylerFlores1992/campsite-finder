"use client";

import Link from "next/link";
import Pricing from "./Pricing";
import { buttonClasses } from "@/components/ui/Button";
import { SubscribeLink, subscribeSentence } from "./nativeSubscribe";
import { useSubscription } from "./useSubscription";
import { useIsNativeApp } from "@/lib/native/context";
import { WATCH_LIMIT } from "@/lib/limits";

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
  const { subscribed, autocart } = useSubscription();

  // ALREADY PAYING? Then this block has no selling left to do, and doing it anyway is
  // worse than neutral: a subscriber who reads "Searching is free. Watching is $2.50 a
  // month" and "Subscribe now and you keep the rate you signed up at" is being pitched
  // a thing they already bought, which reads as a billing failure. Launch-pricing
  // urgency aimed at an existing customer is just noise.
  //
  // What replaces it is the useful version of the same information — what the
  // subscription lets them do and where to go do it. Deliberately no price, and in the
  // app deliberately no route to billing either: managing a subscription from inside
  // the app is the kind of steering the store rules are strict about, and the account
  // menu on the web already handles it.
  if (subscribed) {
    return (
      <div className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-5 sm:p-6">
        <h2 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em] text-ch-green-deep">
          You&apos;re all set — here&apos;s what you can do
        </h2>
        <ul className="mt-2.5 max-w-[58ch] space-y-1.5 text-ch-body leading-relaxed text-ch-green-deep">
          <li>
            Watch up to {WATCH_LIMIT} campgrounds at once. We check each one every 15
            seconds, around the clock.
          </li>
          <li>
            Add your number in Settings so alerts reach you by text as well as email — a
            text is what actually wakes you at 6am.
          </li>
          <li>
            {autocart ? (
              <>
                On Recreation.gov, connect auto-cart once and an opening goes straight into
                your cart while you get to your phone.
              </>
            ) : (
              // A base-plan subscriber. Deliberately no price here — this block also
              // renders in the native app, where a figure is a store-review failure;
              // Settings (AutoCartSettings) handles the web/native split properly.
              <>
                With the Auto-Cart plan, an opening goes straight into your Recreation.gov
                cart while you get to your phone — add it in Settings.
              </>
            )}
          </li>
          <li>Any alert lets you pause the watch, reopen it, or mute a site you don&apos;t want.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Link href="/new" className={buttonClasses({ variant: "primary" })}>
            New watch
          </Link>
          <Link href="/settings" className={buttonClasses({ variant: "quiet" })}>
            Alert settings
          </Link>
        </div>
      </div>
    );
  }

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
          A subscription covers up to {WATCH_LIMIT} watches at once with push, text and
          email alerts; the Auto-Cart plan adds automatic carting on Recreation.gov. Live
          search keeps working either way.
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
        {/* NOT gated on autocartPlanAvailable: signed-out visitors never fetch
            subscription status (useSubscription only runs signed-in), so a gate here
            would hide the Auto-Cart plan from the homepage's main audience forever.
            The plan exists in Stripe as of 2026-08-01; the gate stays on the
            INTERACTIVE plan cards in Pricing.tsx, where a mis-config would otherwise
            sell a checkout that 503s. */}
        One subscription covers up to {WATCH_LIMIT} watches at once with text, push and
        email alerts; the Auto-Cart plan adds automatic carting on Recreation.gov — the
        site is held in your cart while you get to your phone. Cancel any time — and live
        search keeps working either way.
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
