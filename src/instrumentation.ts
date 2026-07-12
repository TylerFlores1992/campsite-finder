import * as Sentry from '@sentry/nextjs';

// Server + edge Sentry init. No-ops entirely until NEXT_PUBLIC_SENTRY_DSN is set
// (add it in Vercel prod env to activate error monitoring).
export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
      enabled: process.env.NODE_ENV === 'production',
    });
  }
}

// Captures errors thrown in server components / route handlers.
export const onRequestError = Sentry.captureRequestError;
