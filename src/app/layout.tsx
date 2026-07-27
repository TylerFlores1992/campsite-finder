import type { Metadata, Viewport } from "next";
import { Sora, Inter, Geist_Mono, Fraunces, Bitter, Nunito_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import NativeBridge from "@/components/NativeBridge";
import { NativeAppProvider } from "@/lib/native/context";
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

export const metadata: Metadata = {
  metadataBase: new URL("https://camphawk.app"),
  title: "CampHawk — Get notified the instant a campsite opens up",
  description:
    "Search real-time campsite availability across US public lands and state parks in California, Texas, Arizona, Florida, New York, Oregon, Utah, North Carolina, Minnesota, Missouri, Kentucky, Iowa, Indiana, Georgia, Nebraska, Pennsylvania, New Hampshire, Montana, Rhode Island, New Mexico, Nevada, Ohio, Wyoming, Illinois, Virginia, Alaska, Connecticut, Delaware, Washington, Michigan, Wisconsin, Mississippi, Tennessee & South Carolina. Watch booked campgrounds and get alerted within seconds of a cancellation.",
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
