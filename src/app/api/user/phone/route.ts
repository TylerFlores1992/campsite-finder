import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';

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
    await mutate('UPDATE users SET phone = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    return NextResponse.json({ ok: true, phone: null });
  }

  const normalized = normalizePhone(String(phone));
  if (!normalized) {
    return NextResponse.json({ error: 'Enter a valid US phone number' }, { status: 400 });
  }

  await mutate('UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2', [normalized, userId]);
  return NextResponse.json({ ok: true, phone: normalized });
}
