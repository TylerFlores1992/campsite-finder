"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useIsNativeApp } from "@/lib/native/context";
import {
  manageDestination,
  type BillingReading,
  type ManageDestination,
} from "@/lib/subscription-management";

/**
 * THE REACT HALF OF "MANAGE MY SUBSCRIPTION". The decision is in
 * `@/lib/subscription-management`; this file only carries it out.
 *
 * ── WHY THE OPENING IS PROGRAMMATIC AND NOT AN ANCHOR ───────────────────────────────
 * The repo's proven way out of the webview is `<a data-native-external="true">`, which
 * `NativeBridge`'s delegated click handler hands to `@capacitor/browser`. That works for
 * Settings and NOT for the account menu: Clerk's `UserButton.Action` renders a BUTTON and
 * takes an `onClick`, so there is no anchor to mark. Two mechanisms for one destination is
 * two things to forget, and the one nobody exercises is the one that breaks — so both
 * surfaces call `open()` here and there is a single path.
 *
 * It does what the bridge does, for the same reasons the bridge's own header gives: a
 * store or checkout URL rendered INSIDE the shell reads as in-app purchasing to a
 * reviewer, and `capacitor.config.ts`'s `allowNavigation` does not list play.google.com,
 * apps.apple.com or Stripe anyway — so a plain `location.assign` in the shell is at best
 * Capacitor's own fallback and at worst a blocked navigation.
 *
 * ── WHAT IS NOT ESTABLISHED, STATED HERE RATHER THAN DISCOVERED LATER ───────────────
 * `Browser.open` is a Custom Tab on Android and `SFSafariViewController` on iOS. Whether
 * either hands `play.google.com/store/account/subscriptions` or
 * `apps.apple.com/account/subscriptions` on to the STORE APP, rather than rendering the
 * web page inside the tab, **has not been tested on a device from here** — no session in
 * this repo can open one. Both URLs are correct and useful either way: the web versions of
 * both screens let a signed-in user cancel. If a device check later shows the tab keeps
 * them, the fix is an `AppLauncher`/`itms-apps:` hand-off, and it is a change to this file
 * alone — `manageDestination` would not move.
 */

/** Hand a URL to the system browser, or to the store app if the platform routes it there. */
async function openExternal(url: string, isNative: boolean): Promise<void> {
  if (!isNative) {
    // A new tab, not a navigation: the web user is mid-settings and should come back to
    // where they were. Called straight out of a click handler with nothing awaited
    // before it, so no popup blocker has grounds to refuse.
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch {
    // Capacitor's own default for a URL outside `allowNavigation` is to hand it to the
    // system browser, so this is a worse version of the same outcome rather than a dead
    // tap — the same trade `NativeBridge` makes in its own catch.
    window.location.assign(url);
  }
}

/**
 * Stripe's portal, which is a POST that mints a single-use session.
 *
 * LIFTED OUT OF `V2Nav` AND `Settings`, WHICH HAD DIFFERENT COPIES. V2Nav's said
 * something on failure; Settings' swallowed every error, so a click did nothing at all.
 * Its header records why the silence was wrong and the two never got reconciled. One
 * copy now, and it is the one that speaks.
 */
async function openStripePortal(isNative: boolean): Promise<void> {
  try {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (data.url) {
      // On the web this stays a same-tab navigation, which is what it has always been —
      // Stripe returns the user to us at the end. In the shell it has to leave the
      // webview: billing.stripe.com is not in `allowNavigation`, and a checkout-looking
      // page rendered inside the app is the thing both stores actually police.
      if (isNative) await openExternal(data.url, true);
      else window.location.href = data.url;
      return;
    }
    // 409: the stored customer is gone (e.g. a test-mode leftover). The route already
    // tells us to send them to re-subscribe, so do that rather than dead-ending.
    if (data.error === "billing_profile_missing") {
      window.location.href = "/?resubscribe=1";
      return;
    }
    window.alert("We couldn't open the billing portal just now. Please try again shortly.");
  } catch {
    window.alert("We couldn't reach billing just now. Please check your connection and try again.");
  }
}

export interface ManageSubscription {
  /** What the control should say and where it goes. Never null — there is always an
   *  honest destination, including when the lookup failed. */
  destination: ManageDestination;
  /** Act on it. Safe to call from a plain `onClick`. */
  open: () => void;
}

/**
 * Turn the stored provider into a control.
 *
 * IT TAKES THE READING RATHER THAN FETCHING ONE, and that is not a style choice.
 * `useSubscription` is a plain hook with its own state and its own effect, so every call
 * is another GET of `/api/subscription/status` — and that route runs `syncUser`, the
 * entitlement query and now the billing query. Calling it here as well would have doubled
 * that on every surface holding a manage control, for an answer the caller already has.
 * So the caller passes `billing` in from the `useSubscription()` it was already making.
 */
export function useManageSubscription(billing: BillingReading): ManageSubscription {
  const isNative = useIsNativeApp();
  const router = useRouter();
  const destination = manageDestination(billing);

  const open = useCallback(() => {
    if (destination.kind === "stripe-portal") {
      void openStripePortal(isNative);
      return;
    }
    if (!destination.href) return;
    if (destination.external) {
      void openExternal(destination.href, isNative);
      return;
    }
    // Our own page (the unknown arm's `/support`). It stays in the webview — it is in
    // `isPublicRoute` and carries no prices, which its own header explains.
    router.push(destination.href);
  }, [destination.kind, destination.href, destination.external, isNative, router]);

  return { destination, open };
}
