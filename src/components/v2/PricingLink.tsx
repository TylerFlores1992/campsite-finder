"use client";

import Link from "next/link";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * The quiet marketing link back to the pricing comparison (/#pricing), rendered at
 * the foot of all three app tabs — Explore, Watches, New watch.
 *
 * Self-hiding, so callers can mount it unconditionally:
 *   - subscribers never see it (a subscriber is never sold to — house rule),
 *   - `unknown` (a failed status lookup) hides it too, for the same reason the
 *     watch gate treats unknown as "don't nag": the reader may well be paying,
 *   - the native app never sees it (it points at a price-bearing page, which is
 *     the store-review failure WatchCta exists to prevent),
 *   - nothing renders while auth resolves, so it can't flash at a subscriber.
 *
 * Signed-out visitors DO see it — they're the funnel this link exists for.
 */
export default function PricingLink({ className = "" }: { className?: string }) {
  const isNative = useIsNativeApp();
  const { loaded, subscribed, unknown } = useSubscription();
  if (isNative || !loaded || subscribed || unknown) return null;
  return (
    <p className={`text-ch-fine text-ch-muted ${className}`}>
      Plans from $2.50 a month — Auto-Cart puts openings straight in your cart.{" "}
      <Link href="/#pricing" className="font-bold text-ch-green hover:text-ch-green-deep">
        Compare plans →
      </Link>
    </p>
  );
}
