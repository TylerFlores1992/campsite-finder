import { NextResponse } from 'next/server';

// TEMPORARY: verifies Sentry captures server errors in production.
// Remove after confirming the test error appears in Sentry → Issues.
export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.SENTRY_CHECK !== 'off') {
    throw new Error('CampHawk Sentry verification test — safe to ignore');
  }
  return NextResponse.json({ ok: true });
}
