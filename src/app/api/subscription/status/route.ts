import { NextResponse } from 'next/server';
import { requireAuth, hasActiveSubscription } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await requireAuth();
  const active = await hasActiveSubscription(userId);
  // everSubscribed drives trial vs "resubscribe" copy (returning users get no new trial).
  const prior = await queryOne<{ id: string }>(
    'SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return NextResponse.json({ active, everSubscribed: !!prior });
}
