import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';

/**
 * Per-channel alert preferences (migration 034). Currently just email — the phone
 * number and its SMS consent stay on `/api/user/phone`, because that path is what
 * the A2P-approved `SmsAlerts` form posts to and splitting consent across two
 * endpoints is how the record of it gets muddled.
 *
 * `onboarded` is stamped when the welcome step is finished OR skipped: the step is
 * a one-time thing, and a user who deliberately skipped it must not be shown it
 * again on every sign-in.
 */
export async function GET() {
  const userId = await requireAuth();
  const row = await queryOne<{
    email: string | null;
    email_alerts_opt_in: boolean;
    phone: string | null;
    onboarded_at: string | null;
  }>(
    'SELECT email, email_alerts_opt_in, phone, onboarded_at::text FROM users WHERE id = $1',
    [userId]
  );
  return NextResponse.json({
    email: row?.email ?? null,
    emailAlerts: row?.email_alerts_opt_in ?? true,
    hasPhone: !!row?.phone,
    onboarded: !!row?.onboarded_at,
  });
}

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  const body = (await req.json().catch(() => ({}))) as {
    emailAlerts?: unknown;
    onboarded?: unknown;
  };

  if (typeof body.emailAlerts === 'boolean') {
    await mutate(
      'UPDATE users SET email_alerts_opt_in = $1, updated_at = NOW() WHERE id = $2',
      [body.emailAlerts, userId]
    );
  }
  // Idempotent and never un-stamped: finishing the step twice is harmless, and
  // there is no path that should make an onboarded user un-onboarded.
  if (body.onboarded === true) {
    await mutate(
      'UPDATE users SET onboarded_at = COALESCE(onboarded_at, NOW()), updated_at = NOW() WHERE id = $1',
      [userId]
    );
  }

  return NextResponse.json({ ok: true });
}
