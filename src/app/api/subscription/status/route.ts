import { NextResponse } from 'next/server';
import { requireAuth, hasActiveSubscription } from '@/lib/auth';

export async function GET() {
  const userId = await requireAuth();
  const active = await hasActiveSubscription(userId);
  return NextResponse.json({ active });
}
