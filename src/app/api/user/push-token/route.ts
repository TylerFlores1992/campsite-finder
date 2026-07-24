import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate } from '@/lib/db/client';

// Device push-token registration for the native app (Capacitor + FCM). The app shell
// requests notification permission, gets an FCM token, and POSTs it here after login.
// Authenticated the normal way (Clerk) — NOT public, so no isPublicRoute entry needed.

function isValidPlatform(p: unknown): p is 'ios' | 'android' {
  return p === 'ios' || p === 'android';
}

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  const { token, platform } = await req.json().catch(() => ({}));

  if (!token || typeof token !== 'string' || !isValidPlatform(platform)) {
    return NextResponse.json({ error: 'token and platform (ios|android) required' }, { status: 400 });
  }

  // Upsert on the unique token: a device that re-registers (or moved to a new account)
  // gets re-pointed at the current user and its last_seen_at refreshed.
  await mutate(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform,
       last_seen_at = NOW()`,
    [userId, token, platform]
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await requireAuth();
  const { token } = await req.json().catch(() => ({}));

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'token required' }, { status: 400 });
  }

  // Scope the delete to the caller so one user can't unregister another's device.
  await mutate('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, userId]);
  return NextResponse.json({ ok: true });
}
