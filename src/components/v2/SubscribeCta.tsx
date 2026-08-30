"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { StorePlansLink, SubscribeLink, SubscribeSentence, useStoreCanSell } from "./nativeSubscribe";
import { useIsNativeApp } from "@/lib/native/context";
import { buttonClasses } from "@/components/ui/Button";
import { useSubscription } from "./useSubscription";

/**
 * The account-state call to action, for surfaces that are NOT the "Start a watch"
 * button. (That one is `WatchCta` — same rules, different shape.)
 *
 * Why this exists: three screens were each telling a signed-out visitor to press a
 * control that cannot work for them. `/new` rendered "Start watching" to everyone
 * and only explained the problem after the submit failed; Explore's guest box
 * described the paywall without offering a way through it. The fix is the same
 * decision in one place rather than three sets of copy that drift.
 *
 *   loading   -> nothing. Never flash "Start free trial" at a paying subscriber.
 *   ready     -> nothing; the caller renders its normal control.
 *   signedOut -> start the trial, or sign in.
 *   needsSub  -> subscribe (or resubscribe — a returning customer gets no new
 *                trial, and Stripe would not give them one anyway).
 *
 * `ready` deliberately includes `unknown`. If the status lookup failed we assume the
 * user is fine rather than telling a subscriber to subscribe — the same call
 * `WatchCta` makes, and the reason `useSubscription` tracks `unknown` separately at
 * all.
 */
export type AccountGate = "loading" | "ready" | "signedOut" | "needsSub";

export function useAccountGate(): { gate: AccountGate; everSubscribed: boolean } {
  const { loaded, signedIn, subscribed, everSubscribed, unknown } = useSubscription();
  if (!loaded) return { gate: "loading", everSubscribed: false };
  if (subscribed || unknown) return { gate: "ready", everSubscribed };
  if (!signedIn) return { gate: "signedOut", everSubscribed: false };
  return { gate: "needsSub", everSubscribed };
}

/**
 * Where to come back to after auth.
 *
 * Read from the live URL rather than a prop, because both callers keep their state
 * in the query string (Explore via `history.replaceState`, `/new` via its
 * campground/start/end params) — so whatever the user has set up is already encoded
 * there. Resolved in an effect so the server and first client render agree.
 *
 * NOTE the limit: `/new` accepts campground, start and end, so a round trip through
 * sign-in preserves those and loses the flexible-nights, filter and auto-cart
 * choices. Anyone who would rather keep everything can still press the main control
 * and use the in-place "sign in and press it again" message, which navigates
 * nowhere. That path is why `/new` is in `isPublicRoute` and it stays.
 */
function useReturnTo(fallback: string): string {
  // useSyncExternalStore, not an effect: it gives the server and the client
  // different snapshots by design, which is exactly the shape of this problem, and
  // avoids the cascading render that setState-in-an-effect causes. Same mechanism
  // `src/lib/native/context.tsx` uses to read the user agent. There is no
  // subscription because nothing needs to re-render when the URL changes — the
  // value is only read to build an href, and Explore rewrites the URL with
  // `history.replaceState`, which emits no event to subscribe to anyway.
  return useSyncExternalStore(
    () => () => {},
    () => window.location.pathname + window.location.search,
    () => fallback,
  );
}

export interface SubscribeCtaProps {
  /** Used until the live URL resolves on the client. */
  fallbackReturnTo: string;
  /** Stack full-width buttons (the `/new` rail) rather than sitting them inline. */
  fullWidth?: boolean;
  className?: string;
}

export default function SubscribeCta({
  fallbackReturnTo,
  fullWidth = false,
  className = "",
}: SubscribeCtaProps) {
  const { gate, everSubscribed } = useAccountGate();
  const isNative = useIsNativeApp();
  const canSell = useStoreCanSell();
  const returnTo = useReturnTo(fallbackReturnTo);

  if (gate === "loading" || gate === "ready") return null;

  const back = encodeURIComponent(returnTo);
  const signUpHref = `/sign-up?redirect_url=${back}`;
  const signInHref = `/sign-in?redirect_url=${back}`;
  const row = fullWidth ? "grid gap-2" : "flex flex-wrap items-center gap-2";

  if (isNative) {
    // IN THE APP: no price, and no route into Stripe. Signing in or creating an
    // account is not a purchase, so those buttons are fine and genuinely useful —
    // what Apple and Google forbid is the price and the steer to an outside
    // checkout. A non-subscriber therefore gets the plain fact and, once steering
    // is switched on, a link out; never a buy button. See ./nativeSubscribe.
    if (gate === "signedOut") {
      return (
        <div className={`${row} ${className}`}>
          <Link href={signInHref} className={buttonClasses({ fullWidth })}>
            Sign in
          </Link>
          <Link href={signUpHref} className={buttonClasses({ variant: "quiet", fullWidth })}>
            Create account
          </Link>
        </div>
      );
    }
    // EXACTLY ONE OF THE TWO LINKS RENDERS, and neither is a price. `SubscribeLink` is
    // the US-storefront steer out (iOS today); `StorePlansLink` is the route to the
    // in-app paywall (Android today). Before 2026-08-30 only the first existed, so on
    // Android — where steering is deliberately off — this paragraph was a statement with
    // no way to act on it, in front of a purchase flow that was switched on and working.
    // WHERE THE APP CAN SELL, THIS IS A BUTTON — because it is standing in the exact
    // position `/new`'s "Start watching" submit occupies, and the WEB branch below
    // replaces that control with a full-width `Button`. A paragraph of grey `text-ch-fine`
    // in a primary control's slot is why the owner read `/new` twice and said "there is
    // no start watch". They were right: the control was there and did not look like one.
    if (canSell) {
      return (
        <div className={`${row} ${className}`}>
          <StorePlansLink variant="button" fullWidth={fullWidth} />
        </div>
      );
    }
    // NO ROUTE TO SELL: the sentence is the honest shape, because there is genuinely
    // nothing to press. `SubscribeLink` is the US-storefront steer out (iOS today) and
    // renders nothing where steering is off — which on Android, before 2026-08-30, left
    // this paragraph a statement with no way to act on it.
    return (
      <p className={`text-ch-fine leading-normal text-ch-ink-2 ${className}`}>
        <SubscribeSentence /> <SubscribeLink />
      </p>
    );
  }

  if (gate === "signedOut") {
    return (
      <div className={`${row} ${className}`}>
        <Link href={signUpHref} className={buttonClasses({ fullWidth })}>
          Start free trial
        </Link>
        {/* Between the trial and Sign in, deliberately: someone who isn't ready to
            commit and isn't a returning user is exactly who needs to see what the
            plans are. Same size/shape as its siblings — it is a peer choice, not a
            footnote. Web only; /pricing carries prices (store rule). */}
        <PlanOptionsButton fullWidth={fullWidth} />
        <Link href={signInHref} className={buttonClasses({ variant: "quiet", fullWidth })}>
          Sign in
        </Link>
      </div>
    );
  }

  // Signed in, no subscription. Checkout lives on `/`, same destination WatchCta
  // uses — one place that sells, so the pricing copy can't disagree with itself.
  return (
    <div className={`${row} ${className}`}>
      <Link href="/" className={buttonClasses({ fullWidth })}>
        {everSubscribed ? "Resubscribe" : "Start free trial"}
      </Link>
      <PlanOptionsButton fullWidth={fullWidth} />
    </div>
  );
}

/**
 * "Plan options" → /pricing. Rendered beside the trial/sign-in buttons rather than
 * as a footer link, so it reads as one of the choices on offer.
 *
 * NEVER in the native app: /pricing is a price-bearing page and steering someone
 * there from inside the app is the store-review failure this file's siblings all
 * guard against. Exported so WatchesList's account wall renders the identical
 * control rather than a hand-copied lookalike.
 */
export function PlanOptionsButton({ fullWidth = false }: { fullWidth?: boolean }) {
  const isNative = useIsNativeApp();
  if (isNative) return null;
  return (
    <Link href="/pricing" className={buttonClasses({ variant: "quiet", fullWidth })}>
      Plan options
    </Link>
  );
}
