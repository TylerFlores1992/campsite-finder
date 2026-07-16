import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';

export async function GET() {
  const userId = await requireAuth();
  const row = await queryOne<{ autocart_enabled: boolean; autocart_connected: boolean }>(
    'SELECT autocart_enabled, autocart_connected FROM users WHERE id = $1',
    [userId]
  );
  // connected = the one-time rec.gov sign-in finished on the bot machine.
  return NextResponse.json({
    enabled: !!row?.autocart_enabled,
    connected: !!row?.autocart_connected,
  });
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
