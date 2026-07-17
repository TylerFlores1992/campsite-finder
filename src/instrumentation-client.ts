import * as Sentry from '@sentry/nextjs';

// Client-side Sentry init. No-ops until NEXT_PUBLIC_SENTRY_DSN is set.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    enabled: process.env.NODE_ENV === 'production',
    // Drop transient client-side network noise we can't act on: a fetch that
    // fails because the phone lost signal, the tab was backgrounded, or the user
    // navigated away mid-request. iOS/Safari reports these as "Load failed",
    // Chrome as "Failed to fetch"; Clerk's SDK surfaces them when it pings its
    // session endpoint. Real Clerk/API outages show up as 4xx/5xx, not these.
    ignoreErrors: [
      'Load failed',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      'ClerkJS: Network error',
      'The network connection was lost',
      'cancelled',
    ],
  });
}

// Instruments client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
