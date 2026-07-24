import type { CapacitorConfig } from '@capacitor/cli';

// CampHawk ships as a thin native shell around the live Next.js site rather than a
// bundled static export: `server.url` points the webview at production, so Clerk auth,
// Stripe, and SSR all work exactly as on the web, and a `git push` deploy reaches the
// app instantly without an app-store release. The only native surface is push
// (APNs/FCM) + the bridge in src/components/NativeBridge.tsx.
//
// Native projects (ios/, android/) are generated with `npx cap add ios|android` on a
// machine with Xcode / Android Studio — they are NOT committed (see .gitignore). See
// docs/SETUP.md → "Building the mobile app".
const config: CapacitorConfig = {
  appId: 'app.camphawk.mobile',
  appName: 'CampHawk',
  // Tag the webview's User-Agent so both the server (header) and client can detect the
  // native app and suppress the in-app subscribe/pricing UI — App/Play store billing
  // rules forbid selling a digital subscription outside their IAP. See NativeProvider
  // + the store-billing note in docs/SETUP.md.
  appendUserAgent: 'CampHawkApp',
  // `webDir` is required by the CLI even in server.url mode; this minimal folder is
  // the fallback shell shown only if the remote URL is unreachable at launch.
  webDir: 'native/shell',
  server: {
    url: 'https://camphawk.app',
    // Only allow navigation within our own origins; external booking links
    // (recreation.gov, the Stripe portal) open in the system browser via the bridge.
    allowNavigation: ['camphawk.app', '*.camphawk.app', '*.clerk.accounts.dev', 'accounts.camphawk.app'],
  },
  ios: {
    // Let taps on rec.gov / Stripe links leave the webview into Safari.
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
