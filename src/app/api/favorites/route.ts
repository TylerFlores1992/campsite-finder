import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { requireAuth, syncUser, hasActiveSubscription } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const userId = await requireAuth();

  // `?details=1` returns full campground rows for the Favorites panel — a
  // subscriber-only view. The default (bare) response returns just the id list,
  // which the search page uses to render the filled/empty heart on cards for ANY
  // signed-in user, so that path stays ungated.
  if (request.nextUrl.searchParams.get('details') === '1') {
    if (!(await hasActiveSubscription(userId))) {
      return NextResponse.json({ error: 'subscription required' }, { status: 403 });
    }
    const rows = await query<{
      id: string;
      name: string;
      city: string | null;
      state: string | null;
      latitude: number;
      longitude: number;
      source: string;
      reservations_url: string | null;
    }>(
      `SELECT f.campground_id AS id, c.name,
              c.address->>'city' AS city, c.address->>'state' AS state,
              ST_Y(c.location::geometry) AS latitude, ST_X(c.location::geometry) AS longitude,
              c.source, c.reservations_url
         FROM favorites f
         JOIN campgrounds c ON c.id = f.campground_id
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC`,
      [userId]
    );
    return NextResponse.json({ favorites: rows });
  }

  const rows = await query<{ campground_id: string }>(
    'SELECT campground_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return NextResponse.json({ favorites: rows.map((r) => r.campground_id) });
}

export async function POST(request: NextRequest) {
  const userId = await requireAuth();
  const { campgroundId } = await request.json();
  if (!campgroundId) return NextResponse.json({ error: 'campgroundId required' }, { status: 400 });

  await syncUser(userId);
  await mutate(
    `INSERT INTO favorites (user_id, campground_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, campgroundId]
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireAuth();

  const campgroundId =
    request.nextUrl.searchParams.get('campgroundId') ??
    (await request.json().catch(() => ({}))).campgroundId;

  if (!campgroundId) return NextResponse.json({ error: 'campgroundId required' }, { status: 400 });

  await mutate('DELETE FROM favorites WHERE user_id = $1 AND campground_id = $2', [userId, campgroundId]);
  return NextResponse.json({ ok: true });
}
