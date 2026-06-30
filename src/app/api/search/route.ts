import { NextRequest, NextResponse } from 'next/server';
import { ridbSource } from '@/lib/sources/ridb';
import { hasAvailabilityInRange } from '@/lib/availability/recgov';
import type { SearchParams } from '@/lib/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const lat = parseFloat(searchParams.get('lat') ?? '');
  const lng = parseFloat(searchParams.get('lng') ?? '');
  const radiusMiles = parseFloat(searchParams.get('radius') ?? '50');

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  const startDate = searchParams.get('startDate') ?? undefined;
  const endDate = searchParams.get('endDate') ?? undefined;
  const siteType = searchParams.get('siteType') ?? undefined;
  const amenities = searchParams.get('amenities')?.split(',').filter(Boolean);
  const minNights = parseInt(searchParams.get('minNights') ?? '1', 10);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  const params: SearchParams = {
    lat,
    lng,
    radiusMiles,
    startDate,
    endDate,
    siteType,
    amenities,
    minNights,
    limit: limit * 3, // fetch extra so we can filter by availability
    offset,
  };

  try {
    const campgrounds = await ridbSource.searchByRadius(params);

    // If dates requested, check availability in parallel and annotate — but never hide results.
    // Users need to see booked campgrounds so they can set up watches.
    let results: Array<typeof campgrounds[0] & { hasAvailability?: boolean }> = campgrounds;

    if (startDate && endDate) {
      const checks = await Promise.allSettled(
        campgrounds.map((cg) => hasAvailabilityInRange(cg.id, startDate, endDate, minNights))
      );
      results = campgrounds.map((cg, i) => ({
        ...cg,
        hasAvailability: checks[i].status === 'fulfilled' ? (checks[i] as PromiseFulfilledResult<boolean>).value : undefined,
      }));
      // Sort: available first, then unknown, then fully booked
      results.sort((a, b) => {
        const score = (x: typeof a) => x.hasAvailability === true ? 0 : x.hasAvailability === undefined ? 1 : 2;
        return score(a) - score(b) || (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0);
      });
    }

    return NextResponse.json({
      campgrounds: results,
      total: results.length,
      params: { lat, lng, radiusMiles, startDate, endDate, siteType },
    });
  } catch (err) {
    console.error('[search] Error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
