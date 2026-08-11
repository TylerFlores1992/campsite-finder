import { NextResponse } from 'next/server';
import { currentUserIsAdmin, currentUserEmail } from '@/lib/admin';
import { botUpdateState, requestBotUpdate } from '@/lib/bot-update';

export const dynamic = 'force-dynamic';

/**
 * "Update the mini-PC now."
 *
 * ADMIN ONLY, and it has to be: this ends the RC session and restarts every bot process on
 * a machine in someone's house. `currentUserIsAdmin` is server-only and Clerk-authed — the
 * same gate every other /api/admin route re-checks with, never a client-side email test.
 * 404 rather than 403, matching the rest of the admin surface.
 *
 * It only sets a flag. The box picks it up on its next 15-second poll and applies the same
 * release guard it always does, so "now" means "as soon as it is safe" — which is the only
 * kind of now worth offering when the alternative is losing a campsite.
 */
export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(await botUpdateState());
}

export async function POST() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await requestBotUpdate((await currentUserEmail()) ?? 'admin');
  return NextResponse.json(await botUpdateState());
}
