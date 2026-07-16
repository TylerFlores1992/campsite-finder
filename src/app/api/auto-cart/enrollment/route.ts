import { NextRequest, NextResponse } from 'next/server';
import { mutate } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// Lets the bot machine update a user's auto-cart state (master bearer token).
// Partial update — send either or both:
//   enabled:   flip the app toggle (e.g. back OFF when a login isn't completed)
//   connected: record that the one-time rec.gov sign-in succeeded on the bot
export async function POST(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { userId, enabled, connected } = await req.json();
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  if (typeof enabled !== 'boolean' && typeof connected !== 'boolean') {
    return NextResponse.json({ error: 'enabled or connected required' }, { status: 400 });
  }
  await mutate(
    `UPDATE users SET
       autocart_enabled = COALESCE($1, autocart_enabled),
       autocart_connected = COALESCE($2, autocart_connected),
       updated_at = NOW()
     WHERE id = $3`,
    [typeof enabled === 'boolean' ? enabled : null, typeof connected === 'boolean' ? connected : null, userId]
  );
  return NextResponse.json({ ok: true, userId });
}
