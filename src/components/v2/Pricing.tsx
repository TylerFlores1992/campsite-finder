"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { useUser } from "@clerk/nextjs";
import { buttonClasses } from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * The two-plan comparison + checkout controls, in the ch-* system.
 *
 * BOTH plans render as full cards for anyone who could buy — including signed-OUT
 * visitors, who are the homepage's main audience. They get sign-up CTAs instead of
 * checkout buttons (Stripe needs a customer), but they see the same comparison;
 * before 2026-08-01 the signed-out state showed a bare sign-up link and the
 * Auto-Cart plan was effectively invisible to the funnel.
 *
 * THE COMPARISON DELIBERATELY LEANS TOWARD AUTO-CART — badge, stronger border,
 * primary CTA — because it's both the better product for sold-out campgrounds and
 * the plan priced to beat Campsite Tonight. The lean is visual; the copy stays
 * factual (what it does, not "3x better").
 *
 * SAME /api/stripe/checkout CONTRACT: {plan: 'base'|'autocart', interval}. The
 * signed-in Auto-Cart card hides if the server says its prices aren't configured
 * (autocartPlanAvailable), so a broken env can't offer a checkout that 503s; the
 * signed-out cards are static copy and stay up regardless (signed-out visitors
 * never fetch status — a gate there would blank the plan for them forever).
 *
 * NEVER RENDERS IN THE NATIVE APP — no prices, no purchase route (store rule, the
 * same one WatchCta follows). A CURRENT subscriber gets navigation instead of
 * prices: selling someone what they already pay for reads as a billing error.
 */

const BASE_FEATURES = [
  "Watch up to 6 campgrounds at once",
  "Checked every 15 seconds, around the clock",
  "Text, push and email the moment a site opens",
  "Flexible dates — any N nights in a window",
];

const AUTOCART_FEATURES = [
  "Everything in Alerts",
  "An opening goes straight into your Recreation.gov cart",
  "The site is held while you get to your phone",
  "You just sign in and check out",
];

function PlanCard({
  name,
  price,
  sub,
  features,
  highlight,
  cta,
}: {
  name: string;
  price: string;
  sub: string;
  features: string[];
  highlight?: boolean;
  cta: ReactNode;
}) {
  return (
    <div
      className={
        highlight
          ? "relative rounded-ch-card border-2 border-ch-green bg-white p-4 shadow-ch-card"
          : "rounded-ch-card border border-ch-line bg-white/70 p-4"
      }
    >
      {highlight && (
        <span className="absolute -top-2.5 left-4 rounded-ch-chip bg-ch-green px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-[.08em] text-white">
          Best chance to book
        </span>
      )}
      <p className="font-ch-display text-ch-h font-extrabold text-ch-green-deep">{name}</p>
      <p className="mt-1 text-[22px] font-extrabold tracking-[-.02em] text-ch-ink">
        {price}
        <span className="ml-1.5 align-middle text-ch-fine font-normal text-ch-muted">{sub}</span>
      </p>
      <ul className="mt-3 space-y-1.5">
        {features.map((f) => (
          <li key={f} className="flex gap-2 text-ch-fine leading-normal text-ch-ink-2">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ch-green" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3.5">{cta}</div>
    </div>
  );
}

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
    return <div className="h-[220px]" aria-hidden="true" />;
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

  const checkoutBtn = (
    plan: "base" | "autocart",
    interval: "monthly" | "yearly",
    label: string,
    primary: boolean
  ) => (
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

  const signedOut = !isSignedIn;
  const showAutocart = signedOut || autocartPlanAvailable || unknown;

  return (
    <div>
      <div className="grid gap-3 pt-2.5 sm:grid-cols-2">
        <PlanCard
          name="Alerts"
          price="$2.50/mo"
          sub="or $20/yr — save 33%"
          features={BASE_FEATURES}
          cta={
            signedOut ? (
              <a href="/sign-up" className={buttonClasses({ variant: "quiet", size: "sm" })}>
                Start 7-day free trial
              </a>
            ) : (
              <div className="flex flex-wrap gap-2">
                {checkoutBtn("base", "monthly", "$2.50 / month", false)}
                {checkoutBtn("base", "yearly", "$20 / year", false)}
              </div>
            )
          }
        />
        {showAutocart && (
          <PlanCard
            name="Auto-Cart"
            price="$10/mo"
            sub="or $50/yr — save 58%"
            features={AUTOCART_FEATURES}
            highlight
            cta={
              signedOut ? (
                <a href="/sign-up" className={buttonClasses({ size: "sm" })}>
                  Start 7-day free trial
                </a>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {checkoutBtn("autocart", "monthly", "$10 / month", true)}
                  {checkoutBtn("autocart", "yearly", "$50 / year", true)}
                </div>
              )
            }
          />
        )}
      </div>
      {/* The one persuasion line, under the cards where the comparison has just
          made it concrete. Factual: popular cancellations really are rebooked in
          minutes, and carting is exactly the step it removes. */}
      <p className="mt-3 max-w-[58ch] text-ch-fine leading-normal text-ch-muted">
        Popular sites are rebooked within minutes of a cancellation. Alerts tell you the
        moment one opens; Auto-Cart has it in your cart before you&apos;ve unlocked your
        phone.
      </p>
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
