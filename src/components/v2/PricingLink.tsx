"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * The Auto-Cart upgrade nudge at the foot of the three app tabs (Explore, Watches,
 * New watch) — shown ONLY to a subscriber on the Alerts plan.
 *
 * It points at /settings, never /pricing: the settings upgrade swaps the price on
 * their live subscription (prorated, `/api/stripe/plan`), while the pricing page's
 * checkout would mint a SECOND subscription beside the first and double-bill them.
 *
 * NON-SUBSCRIBERS ARE NOT HANDLED HERE ANY MORE (2026-08-01). Their route to the
 * plans is the "Plan options" button sitting between Start free trial and Sign in
 * on each of those three screens (`SubscribeCta.PlanOptionsButton`) — a peer choice
 * in the button stack rather than a footnote under the fold.
 *
 * Self-hiding, so callers mount it unconditionally:
 *   - subscribers who already have auto-cart see nothing (never sell someone what
 *     they own — it reads as a billing failure),
 *   - signed-out and non-subscribed visitors see nothing (the button covers them),
 *   - `unknown` (failed status lookup) hides it: the reader may be a premium
 *     subscriber and the nudge would be wrong,
 *   - the native app sees nothing (it names a price — the store-review trap),
 *   - nothing renders while auth resolves, so it can't flash at a subscriber.
 */
export default function PricingLink({ className = "" }: { className?: string }) {
  const isNative = useIsNativeApp();
  const { loaded, subscribed, autocart, unknown } = useSubscription();
  if (isNative || !loaded || unknown || !subscribed || autocart) return null;

  return (
    <div className={`rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-4 ${className}`}>
      <p className="text-ch-body font-bold text-ch-green-deep">
        Alerts race you to the site. Auto-Cart wins the race for you.
      </p>
      <p className="mt-1 max-w-[58ch] text-ch-fine leading-normal text-ch-green-deep">
        Add Auto-Cart and an opening goes straight into your Recreation.gov cart — held
        while you get to your phone. $10/mo or $50/yr, prorated on your current billing.
      </p>
      <Link href="/settings" className={buttonClasses({ size: "sm", className: "mt-2.5" })}>
        Upgrade to Auto-Cart
      </Link>
    </div>
  );
}
