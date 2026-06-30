import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { requireAuth, syncUser } from '@/lib/auth';

export async function GET() {
  const userId = await requireAuth();

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
