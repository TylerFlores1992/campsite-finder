"use client";

import { useCallback, useState } from "react";

import { buttonClasses } from "@/components/ui/Button";
import { useStorePurchases, type PurchaseOutcome, type StorePlanOffer } from "@/lib/native/purchases";
import type { CurrentSubscription } from "@/lib/store-plans";
import { useSubscription } from "./useSubscription";

/**
 * IN-APP PURCHASE, RENDERED ONLY WHERE IT CAN ACTUALLY WORK.
 *
 * Returns `null` unless this exact install can sell — an older app, a browser, a missing
 * key and a store with nothing published all render nothing, and the caller keeps whatever
 * it did before (`docs/STOREKIT-PLAN.md` §11a). That is the point of the capability probe
 * in `@/lib/native/purchases`: a paywall gated on `isNative` would put a Buy button that
 * throws in front of every install older than the build that added the plugin.
 *
 * ── THE SWITCH, AND WHY IT IS OFF ───────────────────────────────────────────────────
 * `STORE_PURCHASE_ENABLED` is `false`, and it is not caution for its own sake. §9b:
 *
 *   "the four PRICES were never read back from the console — the base-plan list shows
 *    duration and region but no amount. Open each base plan and read the amount before
 *    anything charges anybody."
 *
 * The same section records catching `camphawk_autocart / yearly` one click from Activate
 * reading `Draft · yearly / Type: Monthly, auto-renewing` — **a plan named `yearly`
 * billing MONTHLY at $59.99, which charges twelve times the intended price**, with nothing
 * in the console objecting. Only `camphawk_base` was verified afterwards.
 *
 * **And this screen cannot catch it.** It prints the store's own `priceString`, so a wrong
 * amount would show — but "$59.99" reads identically whether Play bills it once a year or
 * once a month. The period is invisible here and visible only on the console's Type line.
 *
 * **CHECKED AND FLIPPED 2026-08-29.** The owner read all four base plans in the console —
 * the **Type** line as well as the amount — and reported them correct against §9b's table.
 * That is a HUMAN READING OF A SCREEN NOBODY HERE CAN SEE, recorded as such: it is the only
 * kind of evidence available for a vendor console, and it is what this switch was waiting
 * for. Nothing in this repo independently verifies it, and nothing can.
 *
 * It is a web-side constant, so turning it back off is a push to master — no rebuild, no
 * store review — and reaches installed apps immediately. Same shape and same reasoning as
 * `LINKOUT_BY_STORE`.
 */
export const STORE_PURCHASE_ENABLED = true;

/** How long to wait for the webhook before saying so. The store grants the entitlement
 *  on-device instantly; OUR row is written by `/api/webhooks/revenuecat`, which is a
 *  separate network hop that can be retried. Neither number is a guess at the webhook's
 *  speed — they bound how long a person stares at a spinner. */
const POLL_INTERVAL_MS = 1500;
const POLL_ATTEMPTS = 10;

type Phase =
  | { kind: "idle" }
  | { kind: "buying"; productId: string }
  | { kind: "confirming" }
  | { kind: "done" }
  | { kind: "slow" }
  | { kind: "error"; message: string };

/**
 * Wait for our own database to catch up with the purchase.
 *
 * THE PURCHASE IS ALREADY REAL WHEN THIS STARTS. Play has taken the money and RevenueCat
 * has granted the entitlement; this only watches for `/api/subscription/status` to agree,
 * because every gate in the product reads that and not the store. So running out of
 * attempts is **not a failure and must not be reported as one** — it is "this is taking a
 * moment", and the copy says exactly that. Telling somebody a completed purchase failed is
 * how they buy it twice.
 */
async function waitForEntitlement(): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const r = await fetch("/api/subscription/status", { cache: "no-store" });
      if (r.ok && (await r.json())?.active) return true;
    } catch {
      // A failed poll is not a failed purchase. Keep waiting.
    }
  }
  return false;
}

const TIER_LABEL: Record<StorePlanOffer["tier"], string> = {
  base: "Alerts",
  autocart: "Auto-Cart",
};

export interface StorePaywallProps {
  /**
   * What the caller renders when this install cannot sell — its existing copy, verbatim.
   *
   * A `fallback` PROP RATHER THAN A `useStoreCanSell()` HOOK THE CALLER READS, and the
   * reason is not style. The surrounding sentence is "Subscriptions are managed at
   * camphawk.app", which becomes FALSE the moment a Buy button appears beside it — so the
   * copy and the button are one decision, not two that have to agree. Splitting them
   * across a hook and a component is two probes of the SDK and two chances to leave a
   * screen saying "go to the website" directly above a control that charges you here.
   */
  fallback?: React.ReactNode;
  /** What the app believes is billing them today, so a plan CHANGE replaces rather than
   *  duplicates. Omit it for a plain non-subscriber. */
  current?: CurrentSubscription;
  className?: string;
}

export default function StorePaywall({ fallback = null, current, className = "" }: StorePaywallProps) {
  const store = useStorePurchases(STORE_PURCHASE_ENABLED);
  const { unknown } = useSubscription();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const onBuy = useCallback(
    async (plan: StorePlanOffer) => {
      setPhase({ kind: "buying", productId: plan.productId });
      let outcome: PurchaseOutcome;
      try {
        outcome = await store.purchase(plan, current ?? { provider: null, storeProductId: null });
      } catch (err) {
        console.error("[paywall] purchase threw", err);
        setPhase({ kind: "error", message: "Something went wrong. Nothing has been charged." });
        return;
      }
      // BACKING OUT IS NOT AN ERROR. Straight back to idle with no banner — anything else
      // tells somebody who changed their mind that the app is broken.
      if (outcome.result === "cancelled") return setPhase({ kind: "idle" });
      if (outcome.result !== "purchased")
        return setPhase({ kind: "error", message: outcome.message });

      setPhase({ kind: "confirming" });
      setPhase((await waitForEntitlement()) ? { kind: "done" } : { kind: "slow" });
    },
    [store, current]
  );

  // EVERY "cannot sell" PATH RENDERS THE CALLER'S OWN COPY. The switch, an older binary, a
  // browser, a missing key, a store with nothing published — all of them leave the screen
  // exactly as it was before this component existed.
  //
  // KEPT DELIBERATELY, THOUGH THE HOOK NOW HONOURS THE FLAG TOO. With `enabled` false the
  // hook reports `unavailable` and the check below would catch it anyway — so this reads
  // as redundant, and it is the line a reader looks for when asking "can this thing sell?".
  // It is also the enforcer that survives somebody changing the hook's signature. Two
  // enforcers for one flag, in the same shape as the entitlement's six.
  if (!STORE_PURCHASE_ENABLED) return <>{fallback}</>;

  // A FAILED STATUS LOOKUP NEVER SELLS. `useSubscription` reports `subscribed: false`
  // alongside `unknown: true` when the lookup fails, so a caller testing `!subscribed` —
  // which is all five of them — treats a Clerk or database blip as a non-subscriber. That
  // is survivable for a sentence pointing at the website. It is NOT survivable for a Buy
  // button: a paying subscriber whose status call blipped would be sold a SECOND
  // subscription, billed in parallel by a different provider, with nothing in either
  // console showing the other. The rule that "unknown means don't nag" (§4) becomes
  // "unknown means don't charge" here, and it lives inside the component so a sixth
  // call site cannot forget it.
  if (unknown) return <>{fallback}</>;
  // `probing` shows the fallback too, rather than a skeleton: it resolves in a beat, and
  // flashing a spinner where a sentence was is worse than the sentence staying put.
  if (store.status !== "ready") return <>{fallback}</>;

  if (phase.kind === "done" || phase.kind === "slow") {
    return (
      <div className={className}>
        <p className="text-ch-body text-ch-ink-2">
          {phase.kind === "done"
            ? "You're all set — your subscription is active."
            : "Thanks — your payment went through. It can take a moment to show up here; " +
              "pull to refresh if it hasn't in a minute."}
        </p>
      </div>
    );
  }

  const busy = phase.kind === "buying" || phase.kind === "confirming";

  return (
    <div className={className}>
      <div className="grid gap-2">
        {store.plans.map((plan) => (
          <button
            key={plan.productId}
            type="button"
            disabled={busy}
            onClick={() => void onBuy(plan)}
            className={buttonClasses({
              variant: plan.tier === "autocart" ? "quiet" : "primary",
              fullWidth: true,
            })}
          >
            {phase.kind === "buying" && phase.productId === plan.productId
              ? "Opening…"
              : /* The STORE's price string, never one of ours. The store owns the number
                   the user is charged, and a figure hard-coded here could disagree with
                   the console without anything failing. */
                `${TIER_LABEL[plan.tier]} — ${plan.priceString}/${
                  plan.interval === "yearly" ? "year" : "month"
                }`}
          </button>
        ))}
      </div>
      {phase.kind === "confirming" && (
        <p className="mt-2 text-ch-fine text-ch-ink-2">Confirming your subscription…</p>
      )}
      {phase.kind === "error" && (
        <p className="mt-2 text-ch-fine text-ch-alert" role="alert">
          {phase.message}
        </p>
      )}
    </div>
  );
}
