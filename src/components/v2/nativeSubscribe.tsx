"use client";

import { ExternalLink } from "lucide-react";

/**
 * Steering a non-subscriber in the native app to camphawk.app to subscribe.
 *
 * THIS IS LEGAL NOW, AND IT WASN'T UNTIL RECENTLY. Both stores banned exactly this
 * ("anti-steering") for years. Both were forced to stop, in the US only:
 *   - Apple, App Review Guideline 3.1.1, updated May 2025 for the Epic v. Apple
 *     contempt ruling — on the US storefront there is no prohibition on buttons,
 *     external links or other calls to action, and NO entitlement is needed.
 *   - Google Play, following the Ninth Circuit upholding the Epic v. Google
 *     injunction (Sept 2025) — Google may not stop developers linking out to
 *     transactions or communicating prices. In force until at least Nov 2027.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHARP EDGE: BOTH CARVE-OUTS ARE **US-STOREFRONT ONLY.** Everywhere else the
 * original ban still applies, and an app that shows this UI to a non-US storefront
 * is a review failure — for Apple, reportedly one that can cost the entitlement
 * outright. So this must only ever ship in a US-only app, OR behind a real
 * storefront check. Device locale is NOT a storefront check: a US-storefront user
 * travelling abroad still counts as US, and vice versa.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Hence ONE switch, off by default. Flip it only once app availability is
 * restricted to the United States in App Store Connect and Play Console.
 *
 * The switch lives in the WEB code, which is the useful part: the app is a webview
 * pointed at the live site, so turning steering off is a push to master, not an app
 * release. If the legal picture moves — and it is still moving; Google's terms run
 * to Nov 2027 and Apple's remain under appeal — you are one deploy from compliant,
 * not one store review.
 */
export const NATIVE_LINKOUT = false;

/** Where the link goes. `?from=app` so the funnel is measurable — otherwise there's
 *  no way to tell whether any of this converts. */
export const SUBSCRIBE_HREF = "https://camphawk.app/?from=app";

/**
 * The link itself.
 *
 * MUST OPEN IN THE SYSTEM BROWSER, not the webview. Following it in-app would just
 * navigate the shell to our own marketing page — which renders the native, priceless
 * variant, so the user would arrive at a page that can't sell them anything. The
 * `data-native-external` marker tells NativeBridge's click handler to hand this one
 * to the system browser even though camphawk.app is normally kept in-app (auth has
 * to stay in the webview, so the host alone can't decide).
 */
export function SubscribeLink({
  label = "Subscribe at camphawk.app",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  if (!NATIVE_LINKOUT) return null;
  return (
    <a
      href={SUBSCRIBE_HREF}
      data-native-external="true"
      className={`inline-flex items-center gap-1.5 font-bold underline underline-offset-2 ${className}`}
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/**
 * One sentence for the surfaces that just need a line of copy, so the wording is
 * defined once rather than drifting across five screens. Returns the no-link
 * version when steering is off, which is what ships today.
 */
export function subscribeSentence(): string {
  return NATIVE_LINKOUT
    ? "Subscriptions are set up at camphawk.app — it takes a minute, and everything works here straight after."
    : "Subscriptions are managed at camphawk.app.";
}
