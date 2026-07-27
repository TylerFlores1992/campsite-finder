import type { Metadata, Viewport } from "next";
import { Inter, Bitter, Nunito_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import NativeBridge from "@/components/NativeBridge";
import NativeOffline from "@/components/NativeOffline";
import { NativeAppProvider } from "@/lib/native/context";
import { jsonLdScript, organizationJsonLd } from "@/lib/jsonld";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// ---------------------------------------------------------------------------
// Bitter (slab serif) + Nunito Sans are the display/body pair the whole app now
// renders in. Both are variable fonts, so no `weight` is pinned — next/font
// pulls the whole wght axis, which is what the token scale needs.
//
// Sora, Fraunces and Geist Mono were dropped at the route swap: the pages that
// used them are gone, so loading them cost every visitor two unused downloads.
// Inter stays for the handful of pages outside the app shell.
// ---------------------------------------------------------------------------
// Both preload now. They were preload:false during the dark launch, when they
// would have made every live page fetch two fonts nothing on it used; now they
// ARE the site's type, so preloading is what stops a flash of fallback text.
const bitter = Bitter({
  variable: "--font-bitter",
  subsets: ["latin"],
});

const nunitoSans = Nunito_Sans({
  variable: "--font-nunito-sans",
  subsets: ["latin"],
});

/**
 * Site-wide metadata defaults. Pages override title/description; this is what a
 * page without its own gets, and it is what the homepage ships.
 *
 * THE DESCRIPTION USED TO LIST 34 STATES BY NAME. That is keyword stuffing, and
 * it was working against us three ways: Google truncates the description around
 * 160 characters so most of it was never displayed, a comma-separated state
 * dump is a pattern spam classifiers were built to catch, and the sentence a
 * human actually saw in the results was a list of place names rather than a
 * reason to click. The states are covered properly now by /camping/<state>
 * landing pages, which is where per-state intent belongs — one page per state,
 * each with the campgrounds in it, instead of 34 names crammed into one tag.
 *
 * NO `keywords` FIELD. Google stopped using the keywords meta tag in 2009 and
 * has said so publicly; adding one would be pure cargo cult.
 *
 * The TITLE names the category ("campsite availability", "cancellation alerts")
 * because a search result has to tell a stranger what the site is. The OG title
 * keeps the benefit line — social is a curiosity medium, not a keyword one, and
 * the two are optimised for different readers.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://camphawk.app"),
  title: "CampHawk — Campsite availability and cancellation alerts",
  description:
    "Live campsite availability at 8,000+ campgrounds nationwide. See what's open tonight, and get alerted within seconds when a booked site is cancelled.",
  openGraph: {
    title: "CampHawk — Get notified the instant a campsite opens up",
    description:
      "Watch booked campgrounds and get alerted within seconds of a cancellation.",
    images: ["/logo-full.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CampHawk",
    description:
      "Get notified the instant a campsite opens up.",
    images: ["/logo-full.png"],
  },
};

// Explicit mobile viewport — without this a stray bit of horizontal overflow makes
// phones render the page wider than the screen (opens zoomed in, content off-center).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Required for CSS env(safe-area-inset-*) to be non-zero — lets the native app's
  // header clear the status bar / notch under Android 15+ edge-to-edge (see the
  // safe-area padding on <header> in page.tsx). No effect in normal browsers.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // NOTE: keep this layout NON-async / free of request-time APIs (headers/cookies).
  // Under this Next build's Cache Components model, a dynamic API in the root layout
  // without a Suspense boundary throws at request time and 500s every page. Native-app
  // detection is done client-side in NativeAppProvider instead.
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${inter.variable} ${bitter.variable} ${nunitoSans.variable} h-full antialiased overflow-x-clip`}
      >
        <body className="min-h-full flex flex-col overflow-x-clip">
          {/* Site identity for search engines. A static object built from
              constants — NO request-time API, no data fetch, nothing async.
              That matters here specifically: a request-time API in this ROOT
              layout throws under Cache Components and 500s every page, which
              is what took the site down in July. See lib/jsonld.ts. */}
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: jsonLdScript(organizationJsonLd()) }}
          />
          <NativeAppProvider>
            {children}
            <NativeBridge />
            <NativeOffline />
          </NativeAppProvider>
          <Analytics />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
