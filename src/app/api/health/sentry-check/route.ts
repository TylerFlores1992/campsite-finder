import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

// TEMPORARY diagnostic: reports whether the Sentry DSN is present at runtime
// and whether an event flushes. Remove after confirming.
export const dynamic = 'force-dynamic';

export async function GET() {
  const hasDsn = !!process.env.NEXT_PUBLIC_SENTRY_DSN;
  Sentry.captureException(new Error('CampHawk Sentry verification test — safe to ignore'));
  const flushed = await Sentry.flush(3000);
  return NextResponse.json({ hasDsn, flushed });
}
