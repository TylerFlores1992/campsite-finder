import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';
import { setUserPhone, clearUserPhone } from '@/lib/sms-consent';

/** Normalize US numbers to E.164 (+1XXXXXXXXXX). Returns null if unusable. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

export async function GET() {
  const userId = await requireAuth();
  const row = await queryOne<{ phone: string | null }>(
    'SELECT phone FROM users WHERE id = $1',
    [userId]
  );
  return NextResponse.json({ phone: row?.phone ?? null });
}

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  const { phone } = await req.json();

  if (phone === null || phone === '') {
    await clearUserPhone(userId);
    return NextResponse.json({ ok: true, phone: null });
  }

  const normalized = normalizePhone(String(phone));
  if (!normalized) {
    return NextResponse.json({ error: 'Enter a valid US phone number' }, { status: 400 });
  }

  // Consent is stamped by the write itself — see `lib/sms-consent`. Migration 034 added the
  // column and backfilled it once on 2026-08-01; nothing wrote it in the five weeks since, so
  // ten of the seventeen accounts holding a number had no consent record while receiving SMS.
  await setUserPhone(userId, normalized);
  return NextResponse.json({ ok: true, phone: normalized });
}
