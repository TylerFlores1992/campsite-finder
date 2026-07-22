import { NextRequest, NextResponse } from 'next/server';
import { campgroundBuckets } from '@/lib/likelihood';

/**
 * Cancellation-likelihood ladder for one campground (feature E): the opening rate per
 * lead-time bucket over recent history, for the detail page. Public (no auth) and
 * read-only. Buckets with too few samples come back with `enough: false` so the UI
 * can render them as "still learning" rather than a misleading number.
 */
export async function GET(request: NextRequest) {
  const campgroundId = request.nextUrl.searchParams.get('campgroundId')?.trim();
  if (!campgroundId) {
    return NextResponse.json({ error: 'campgroundId required' }, { status: 400 });
  }
  try {
    const buckets = await campgroundBuckets(campgroundId);
    return NextResponse.json({ buckets });
  } catch (err) {
    console.error('[likelihood] failed:', (err as Error).message);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
