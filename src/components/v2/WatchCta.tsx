"use client";

import Link from "next/link";
import { NATIVE_LINKOUT, SUBSCRIBE_HREF } from "./nativeSubscribe";
import { useIsNativeApp } from "@/lib/native/context";
import { buttonClasses, type ButtonVariant } from "@/components/ui/Button";
import { useSubscription } from "./useSubscription";

/**
 * "Start a watch" — the one control that offers the paid feature.
 *
 * SINGLE SOURCE FOR THE GATE. Every surface that offers watch creation mounts
 * this, so the rule can't drift per screen. Four states, each sending the user
 * somewhere they can actually act:
 *
 *   subscribed   -> the New watch screen, pre-filled with this campground/dates
 *   signed in    -> subscribe (returning users get "Resubscribe", not a trial
 *                   they won't receive)
 *   signed out   -> sign up
 *   unknown      -> the neutral label. If the status lookup failed we do NOT
 *                   tell a paying subscriber to subscribe; the New watch screen
 *                   handles a real 402 with a message that fits.
 *
 * NATIVE APP: never renders a price or a checkout route. Apple and Google
 * require digital subscriptions to go through in-app purchase, so the app points
 * at the web instead. A non-subscriber in the app gets told where to go, not a
 * buy button.
 */
export interface WatchCtaProps {
  /** Omitted on the Watches page, where the New watch screen picks the campground. */
  campgroundId?: string;
  startDate?: string;
  endDate?: string;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  className?: string;
  /** Override the subscribed-state label. */
  label?: string;
}

export default function WatchCta({
  campgroundId,
  startDate,
  endDate,
  variant = "primary",
  fullWidth = true,
  className,
  label = "Start a watch",
}: WatchCtaProps) {
  const { loaded, signedIn, subscribed, everSubscribed, unknown } = useSubscription();
  const isNative = useIsNativeApp();

  const cls = buttonClasses({ variant, fullWidth, className });

  // Hold the space rather than flashing the wrong call to action while auth
  // resolves — a subscriber briefly seeing "Start free trial" reads as a billing
  // problem.
  if (!loaded) {
    return (
      <span aria-hidden="true" className={`${cls} pointer-events-none opacity-0`}>
        {label}
      </span>
    );
  }

  if (subscribed || unknown) {
    return (
      <Link
        href={{
          pathname: "/new",
          query: {
            ...(campgroundId ? { campground: campgroundId } : {}),
            ...(startDate ? { start: startDate } : {}),
            ...(endDate ? { end: endDate } : {}),
          },
        }}
        className={cls}
      >
        {label}
      </Link>
    );
  }

  // THE HIGHEST-INTENT MOMENT IN THE APP: they just tried to watch something
  // specific. When steering is switched on this becomes a real tap; until then it
  // stays the inert label it has always been.
  if (isNative) {
    if (NATIVE_LINKOUT) {
      return (
        <a href={SUBSCRIBE_HREF} data-native-external="true" className={cls}>
          Subscribe to watch
        </a>
      );
    }
    return (
      <span className={`${cls} pointer-events-none opacity-90`}>Manage your plan at camphawk.app</span>
    );
  }

  if (!signedIn) {
    return (
      <Link href="/sign-up" className={cls}>
        Sign up to watch
      </Link>
    );
  }

  return (
    <Link href="/" className={cls}>
      {everSubscribed ? "Resubscribe to watch" : "Start free trial to watch"}
    </Link>
  );
}
