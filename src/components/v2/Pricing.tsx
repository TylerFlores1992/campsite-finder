"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useUser } from "@clerk/nextjs";
import { buttonClasses } from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * The checkout controls, in the ch-* system.
 *
 * SAME /api/stripe/checkout CONTRACT as the old PricingButtons — interval
 * 'monthly' | 'yearly', redirect to data.url. Nothing about billing changed.
 *
 * NEVER RENDERS IN THE NATIVE APP. Apple and Google require digital
 * subscriptions to go through in-app purchase, so the app shows where to go
 * instead of a price. This is the same rule WatchCta follows, and it's the one
 * that gets an app rejected if it slips.
 *
 * A signed-OUT visitor can't check out — Stripe needs a customer — so they get
 * sign-up links instead of buttons that would bounce them through auth and lose
 * their place. A CURRENT subscriber gets nothing at all: showing prices to
 * someone already paying reads as a billing error.
 */
export default function Pricing() {
  const isNative = useIsNativeApp();
  const { isLoaded, isSignedIn } = useUser();
  const { subscribed, everSubscribed, loaded: subLoaded, unknown } = useSubscription();
  const [loading, setLoading] = useState<"monthly" | "yearly" | null>(null);

  async function subscribe(interval: "monthly" | "yearly") {
    setLoading(interval);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setLoading(null);
    } catch {
      setLoading(null);
    }
  }

  if (isNative) {
    return (
      <p className="text-ch-body text-ch-muted">
        Subscriptions are managed at camphawk.app. Searching is free here either way.
      </p>
    );
  }

  // Hold the space rather than flashing prices at a subscriber while auth
  // resolves — same reasoning as WatchCta.
  if (!isLoaded || !subLoaded) {
    return <div className="h-[52px]" aria-hidden="true" />;
  }

  if (subscribed) {
    return (
      <div className="flex flex-wrap gap-2">
        <a href="/v2/search" className={buttonClasses({ className: "px-5" })}>
          Start searching
        </a>
        <a href="/v2/new" className={buttonClasses({ variant: "quiet", className: "px-5" })}>
          Create a watch
        </a>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a href="/sign-up" className={buttonClasses({ className: "px-5" })}>
          Start 7-day free trial
        </a>
        <a href="/sign-in" className={buttonClasses({ variant: "quiet", className: "px-5" })}>
          Sign in
        </a>
      </div>
    );
  }

  // Signed in, no subscription. `unknown` means the status lookup failed — show
  // the buttons anyway rather than nothing, since checkout handles an existing
  // subscription correctly and a blank panel here is a dead end.
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void subscribe("monthly")}
          disabled={!!loading}
          className={buttonClasses({ variant: "quiet", className: "px-5" })}
        >
          {loading === "monthly" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          $2.50 / month
        </button>
        <button
          onClick={() => void subscribe("yearly")}
          disabled={!!loading}
          className={buttonClasses({ className: "px-5" })}
        >
          {loading === "yearly" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          $20 / year — save 33%
        </button>
      </div>
      <p className="mt-2 text-ch-fine text-ch-muted">
        {unknown
          ? "We couldn't check your current plan just now."
          : everSubscribed
            ? "Cancel any time."
            : "Free for 7 days · cancel any time before you're charged."}
      </p>
    </div>
  );
}
