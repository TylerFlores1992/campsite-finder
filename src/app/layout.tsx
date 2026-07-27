import type { Metadata, Viewport } from "next";
import { Sora, Inter, Geist_Mono, Fraunces, Bitter, Nunito_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import NativeBridge from "@/components/NativeBridge";
import { NativeAppProvider } from "@/lib/native/context";
import { jsonLdScript, organizationJsonLd } from "@/lib/jsonld";
import "./globals.css";

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// ---------------------------------------------------------------------------
// Redesign typefaces (phase 1 of the presentation-layer rewrite).
//
// Bitter (slab serif) + Nunito Sans are the display/body pair from
// camphawk-tokens.css. They are loaded and exposed as CSS variables here, but
// NOTHING consumes them yet — the --ch-font-* tokens in globals.css point at
// them, and only the redesigned components (built later, behind /v2) read those
// tokens. The live UI keeps Sora/Inter/Fraunces until the final route swap, so
// this commit is a no-op visually.
//
// Both are variable fonts, so no `weight` is pinned — next/font pulls the whole
// wght axis, which is what the token scale (600/700/800 display, 400/600/700
// body) needs. Sora/Fraunces/Geist Mono get removed in the phase 6 cleanup once
// the old components are gone; removing them now WOULD change the live site.
// ---------------------------------------------------------------------------
// preload:false until /v2 becomes the default UI. next/font preloads by default,
// which would make every LIVE page fetch two fonts nothing on it uses — a real
// bandwidth cost on production for a dark-launched subtree. /v2 still gets them;
// they load on demand there instead of being preloaded everywhere. Flip both to
// preload (drop the flag) as part of the final route swap.
const bitter = Bitter({
  variable: "--font-bitter",
  subsets: ["latin"],
  preload: false,
});

const nunitoSans = Nunito_Sans({
  variable: "--font-nunito-sans",
  subsets: ["latin"],
  preload: false,
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
        className={`${sora.variable} ${inter.variable} ${geistMono.variable} ${fraunces.variable} ${bitter.variable} ${nunitoSans.variable} h-full antialiased overflow-x-clip`}
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
          </NativeAppProvider>
          <Analytics />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
