import { NextRequest, NextResponse } from 'next/server';
import { ridbSource } from '@/lib/sources/ridb';
import { hasAvailabilityInRange } from '@/lib/availability/recgov';
import { hasRCAvailabilityInRange } from '@/lib/availability/reservecalifornia';
import { hasReserveAmericaAvailabilityInRange } from '@/lib/availability/reserveamerica';
import { isUseDirectSource } from '@/lib/sources/reservecalifornia/providers';
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
  const rvLengthRaw = parseInt(searchParams.get('rvLength') ?? '', 10);
  const rvLength = Number.isFinite(rvLengthRaw) && rvLengthRaw > 0 ? rvLengthRaw : undefined;
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
    rvLength,
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
      // "Available" means one campsite can host the WHOLE stay: every night
      // from check-in up to (not including) check-out, consecutively.
      const stayNights = Math.max(
        1,
        Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000)
      );
      const requiredNights = Math.max(minNights, stayNights);

      const checks = await Promise.allSettled(
        campgrounds.map((cg) =>
          cg.source === 'reserveamerica'
            ? hasReserveAmericaAvailabilityInRange(cg.id, startDate, endDate, requiredNights)
            : isUseDirectSource(cg.source)
              ? hasRCAvailabilityInRange(cg.id, startDate, endDate, requiredNights)
              : hasAvailabilityInRange(cg.id, startDate, endDate, requiredNights)
        )
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
