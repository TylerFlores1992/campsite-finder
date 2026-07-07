import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';

/** Campground name suggestions for the search bar autocomplete. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json({ campgrounds: [] });

  const rows = await query<{
    id: string;
    name: string;
    city: string | null;
    state: string | null;
    latitude: number;
    longitude: number;
  }>(
    `SELECT id, name,
            address->>'city' AS city, address->>'state' AS state,
            ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude
     FROM campgrounds
     WHERE name ILIKE '%' || $1 || '%'
     ORDER BY (name ILIKE $1 || '%') DESC, length(name)
     LIMIT 6`,
    [q]
  );

  return NextResponse.json({ campgrounds: rows });
}
