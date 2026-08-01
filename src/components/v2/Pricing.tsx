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
 * SAME /api/stripe/checkout CONTRACT as before, extended with plan:
 * 'base' | 'autocart' (2026-08-01) — interval 'monthly' | 'yearly', redirect to
 * data.url. The Auto-Cart plan column renders only while the server says its
 * Stripe prices exist (autocartPlanAvailable), so a half-configured deploy can
 * never show a $10 button that 503s.
 *
 * NEVER RENDERS IN THE NATIVE APP. Apple and Google require digital
 * subscriptions to go through in-app purchase, so the app shows where to go
 * instead of a price. This is the same rule WatchCta follows, and it's the one
 * that gets an app rejected if it slips.
 *
 * A signed-OUT visitor can't check out — Stripe needs a customer — so they get
 * sign-up links instead of buttons that would bounce them through auth and lose
 * their place. A CURRENT subscriber gets nothing at all: showing prices to
 * someone already paying reads as a billing error. (Their upgrade path is
 * AutoCartSettings, which knows their entitlement.)
 */
export default function Pricing() {
  const isNative = useIsNativeApp();
  const { isLoaded, isSignedIn } = useUser();
  const { subscribed, everSubscribed, autocartPlanAvailable, loaded: subLoaded, unknown } = useSubscription();
  const [loading, setLoading] = useState<string | null>(null);

  async function subscribe(plan: "base" | "autocart", interval: "monthly" | "yearly") {
    setLoading(`${plan}:${interval}`);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval, plan }),
      });
      const data = await res.json();
      if (data.url) window.location.assign(data.url);
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
        <a href="/search" className={buttonClasses({ className: "px-5" })}>
          Start searching
        </a>
        <a href="/new" className={buttonClasses({ variant: "quiet", className: "px-5" })}>
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

  const btn = (plan: "base" | "autocart", interval: "monthly" | "yearly", label: string, primary: boolean) => (
    <button
      onClick={() => void subscribe(plan, interval)}
      disabled={!!loading}
      className={buttonClasses({ variant: primary ? "primary" : "quiet", size: "sm" })}
    >
      {loading === `${plan}:${interval}` && (
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      )}
      {label}
    </button>
  );

  // Signed in, no subscription. `unknown` means the status lookup failed — show
  // the buttons anyway rather than nothing, since checkout handles an existing
  // subscription correctly and a blank panel here is a dead end.
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-ch-input border border-ch-line bg-white/60 p-4">
          <p className="text-ch-body font-extrabold text-ch-green-deep">Alerts</p>
          <p className="mt-0.5 text-ch-fine text-ch-muted">
            Up to 6 watches, checked every 15 seconds. Text, push and email the moment a
            site opens.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {btn("base", "monthly", "$2.50 / month", false)}
            {btn("base", "yearly", "$20 / year — save 33%", true)}
          </div>
        </div>
        {autocartPlanAvailable && (
          <div className="rounded-ch-input border border-[#BFDDC9] bg-white/60 p-4">
            <p className="text-ch-body font-extrabold text-ch-green-deep">Auto-Cart</p>
            <p className="mt-0.5 text-ch-fine text-ch-muted">
              Everything in Alerts, plus we put the opening straight into your
              Recreation.gov cart — it&apos;s held while you get to your phone.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {btn("autocart", "monthly", "$10 / month", false)}
              {btn("autocart", "yearly", "$50 / year — save 58%", true)}
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-ch-fine text-ch-muted">
        {unknown
          ? "We couldn't check your current plan just now."
          : everSubscribed
            ? "Cancel any time. Launch pricing — your rate is locked in while you stay subscribed."
            : "Free for 7 days · cancel any time before you're charged. Launch pricing — your rate is locked in while you stay subscribed."}
      </p>
    </div>
  );
}
