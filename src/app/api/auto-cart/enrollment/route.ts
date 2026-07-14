import { NextRequest, NextResponse } from 'next/server';
import { mutate } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// Lets the bot flip a user's auto-cart enrollment (master bearer token). Used to
// turn auto-cart back OFF when a one-time login isn't completed, so the app toggle
// reflects reality and the user re-toggles to retry.
export async function POST(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { userId, enabled } = await req.json();
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  await mutate('UPDATE users SET autocart_enabled = $1, updated_at = NOW() WHERE id = $2', [
    !!enabled,
    userId,
  ]);
  return NextResponse.json({ ok: true, userId, enabled: !!enabled });
}
