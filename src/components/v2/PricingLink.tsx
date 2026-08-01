"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * The marketing block at the foot of all three app tabs (Explore, Watches, New
 * watch). TWO audiences, two messages:
 *
 *   - Not subscribed (incl. signed out): "Explore plan options" → /pricing, the
 *     dedicated plans page. These are the funnel.
 *   - Subscribed WITHOUT auto-cart (the Alerts plan): an upgrade nudge →
 *     /settings, where AutoCartSettings does the in-place prorated upgrade with a
 *     two-step confirm. Deliberately NOT /pricing — its checkout buttons would
 *     mint a second subscription next to their first (double-billing), which is
 *     exactly what /api/stripe/plan exists to avoid.
 *
 * Self-hiding, so callers mount it unconditionally:
 *   - subscribers who already have auto-cart see nothing (never sell someone what
 *     they own — it reads as a billing failure),
 *   - `unknown` (failed status lookup) hides everything: the reader may be a
 *     premium subscriber and either message would be wrong,
 *   - the native app sees nothing (both destinations carry prices — the
 *     store-review trap WatchCta exists to prevent),
 *   - nothing renders while auth resolves, so it can't flash at a subscriber.
 */
export default function PricingLink({ className = "" }: { className?: string }) {
  const isNative = useIsNativeApp();
  const { loaded, subscribed, autocart, unknown } = useSubscription();
  if (isNative || !loaded || unknown || (subscribed && autocart)) return null;

  if (subscribed) {
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

  return (
    <div className={className}>
      <p className="text-ch-fine text-ch-muted">
        Plans from $2.50 a month — Auto-Cart puts openings straight in your cart.
      </p>
      <Link
        href="/pricing"
        className={buttonClasses({ variant: "quiet", size: "sm", className: "mt-2" })}
      >
        Explore plan options
      </Link>
    </div>
  );
}
