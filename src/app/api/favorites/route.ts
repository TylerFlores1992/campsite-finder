import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';

function getUserId(request: NextRequest): string | null {
  return request.headers.get('x-user-id') ?? request.nextUrl.searchParams.get('userId') ?? null;
}

async function ensureUser(userId: string): Promise<void> {
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [userId]);
}

export async function GET(request: NextRequest) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const rows = await query<{ campground_id: string }>(
    'SELECT campground_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return NextResponse.json({ favorites: rows.map((r) => r.campground_id) });
}

export async function POST(request: NextRequest) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { campgroundId } = await request.json();
  if (!campgroundId) return NextResponse.json({ error: 'campgroundId required' }, { status: 400 });

  await ensureUser(userId);
  await mutate(
    `INSERT INTO favorites (user_id, campground_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, campgroundId]
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const campgroundId =
    request.nextUrl.searchParams.get('campgroundId') ??
    (await request.json().catch(() => ({}))).campgroundId;

  if (!campgroundId) return NextResponse.json({ error: 'campgroundId required' }, { status: 400 });

  await mutate('DELETE FROM favorites WHERE user_id = $1 AND campground_id = $2', [userId, campgroundId]);
  return NextResponse.json({ ok: true });
}
