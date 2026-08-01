"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

/**
 * Signed-in + subscribed state, in one place.
 *
 * Watch creation is the paid feature, and the gate has to read the SAME on every
 * surface that offers it. Duplicating this check per component is how a "Start a
 * watch" button ends up live for someone who can't create one — they click, hit
 * a 402 they can't interpret, and blame the product.
 *
 * NOTE the deliberately careful failure handling. The old UI does
 * `r.ok ? await r.json() : { active: false }`, which renders a 500 identically to
 * a genuine non-subscriber — that masking is exactly how a Clerk misconfiguration
 * once looked like "all my watches vanished". Here a failed lookup is tracked as
 * `unknown`, so callers can choose to stay quiet rather than tell a paying
 * subscriber to subscribe.
 */
export interface SubscriptionState {
  /** Auth and subscription have both resolved. */
  loaded: boolean;
  signedIn: boolean;
  /** True only on a confirmed active subscription. */
  subscribed: boolean;
  /** Has subscribed before — returning users are not offered a new trial. */
  everSubscribed: boolean;
  /** May use auto-cart: Auto-Cart tier, grandfathered pre-tier sub, or beta. */
  autocart: boolean;
  /** The Auto-Cart plan is purchasable (its Stripe prices are configured). */
  autocartPlanAvailable: boolean;
  /** The status lookup failed. Distinct from a confirmed "no". */
  unknown: boolean;
}

export function useSubscription(): SubscriptionState {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const [state, setState] = useState<Omit<SubscriptionState, "loaded" | "signedIn">>({
    subscribed: false,
    everSubscribed: false,
    autocart: false,
    autocartPlanAvailable: false,
    unknown: false,
  });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Signed-out needs no lookup, and must not setState synchronously here —
    // `loaded` derives that case below instead.
    if (!authLoaded || !isSignedIn) return;
    let cancelled = false;
    fetch("/api/subscription/status")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j: { active?: boolean; everSubscribed?: boolean; autocart?: boolean; autocartPlanAvailable?: boolean }) => {
        if (cancelled) return;
        setState({
          subscribed: !!j.active,
          everSubscribed: !!j.everSubscribed,
          autocart: !!j.autocart,
          autocartPlanAvailable: !!j.autocartPlanAvailable,
          unknown: false,
        });
      })
      .catch(() => {
        // Couldn't tell. Say so rather than asserting "not subscribed".
        if (!cancelled)
          setState({
            subscribed: false,
            everSubscribed: false,
            autocart: false,
            autocartPlanAvailable: false,
            unknown: true,
          });
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoaded, isSignedIn]);

  return {
    loaded: authLoaded && (!isSignedIn || checked),
    signedIn: !!isSignedIn,
    ...state,
  };
}
