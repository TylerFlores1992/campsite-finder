import type { Metadata, Viewport } from "next";
import { Sora, Inter, Geist_Mono, Fraunces } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { headers } from "next/headers";
import NativeBridge from "@/components/NativeBridge";
import { NativeAppProvider, isNativeUserAgent } from "@/lib/native/context";
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
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Detect the native shell from the request User-Agent so pricing UI is suppressed
  // in the very first server render (no flash of Stripe buttons before hydration) —
  // which matters because that UI must never appear in the store build (IAP rules).
  // Reading headers() here opts the tree into dynamic rendering; that's required for
  // flash-free detection on the pricing pages (/ and /campground/[id]) and only costs
  // per-request rendering of a few trivial static pages (/privacy, /terms). See
  // NativeAppProvider + the store-billing note in docs/SETUP.md.
  const isNativeApp = isNativeUserAgent((await headers()).get("user-agent"));

  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${sora.variable} ${inter.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased overflow-x-clip`}
      >
        <body className="min-h-full flex flex-col overflow-x-clip">
          <NativeAppProvider isNativeApp={isNativeApp}>
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
