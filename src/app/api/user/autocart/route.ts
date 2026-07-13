import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';

export async function GET() {
  const userId = await requireAuth();
  const row = await queryOne<{ autocart_enabled: boolean }>(
    'SELECT autocart_enabled FROM users WHERE id = $1',
    [userId]
  );
  return NextResponse.json({ enabled: !!row?.autocart_enabled });
}

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  const { enabled } = await req.json();
  await mutate('UPDATE users SET autocart_enabled = $1, updated_at = NOW() WHERE id = $2', [
    !!enabled,
    userId,
  ]);
  return NextResponse.json({ ok: true, enabled: !!enabled });
}
