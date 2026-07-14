import { NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate } from '@/lib/db/client';
import { mintConnectToken } from '@/lib/autocart-token';

export const dynamic = 'force-dynamic';

// Mints a short-lived token that authorizes the browser to open a live rec.gov
// sign-in session streamed from the mini-PC broker (remote one-time sign-in).
// Clerk-authed: a user can only ever get a token bound to their OWN userId.
// Also flips auto-cart ON so the roster/broker know to expect this user.
export async function POST() {
  const userId = await requireAuth();
  await syncUser(userId);

  const secret = process.env.AUTOCART_TOKEN;
  const brokerUrl = process.env.BROKER_WS_URL; // e.g. wss://broker.camphawk.app
  if (!secret || !brokerUrl) {
    return NextResponse.json({ error: 'remote sign-in not configured' }, { status: 503 });
  }

  await mutate('UPDATE users SET autocart_enabled = true, updated_at = NOW() WHERE id = $1', [userId]);

  const { token, expiresAt } = mintConnectToken(userId, secret);
  return NextResponse.json({ token, brokerUrl, expiresAt });
}
