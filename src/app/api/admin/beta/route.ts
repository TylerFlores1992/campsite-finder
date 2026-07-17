import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { query, mutate } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'tylerflores1992@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// 404 (not 403) for non-admins so the endpoint's existence isn't revealed.
async function requireAdmin(): Promise<string | null> {
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  return email && ADMIN_EMAILS.includes(email) ? email : null;
}

const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// List every pre-approved beta email, flagged with whether that person has
// signed up yet and whether their account currently has beta access.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const testers = await query<{ email: string; added_at: string; signed_up: boolean; is_beta: boolean }>(
    `SELECT b.email, b.added_at::text AS added_at,
            (u.id IS NOT NULL) AS signed_up,
            COALESCE(u.is_beta, false) AS is_beta
     FROM beta_emails b
     LEFT JOIN users u ON lower(u.email) = b.email
     ORDER BY b.added_at DESC`
  );
  return NextResponse.json({ testers });
}

// Add a pre-approval AND flag any already-signed-up matching account immediately.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { email } = await req.json().catch(() => ({}));
  if (!isEmail(email)) return NextResponse.json({ error: 'valid email required' }, { status: 400 });
  const e = email.trim().toLowerCase();
  await mutate(`INSERT INTO beta_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [e]);
  await mutate(`UPDATE users SET is_beta = true, updated_at = NOW() WHERE lower(email) = $1`, [e]);
  return NextResponse.json({ ok: true, email: e });
}

// Remove the pre-approval AND revoke beta access from any matching account.
// (A paying subscriber keeps access via their subscription — this only drops the
// free beta bypass.)
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { email } = await req.json().catch(() => ({}));
  if (!isEmail(email)) return NextResponse.json({ error: 'valid email required' }, { status: 400 });
  const e = email.trim().toLowerCase();
  await mutate(`DELETE FROM beta_emails WHERE email = $1`, [e]);
  await mutate(`UPDATE users SET is_beta = false, updated_at = NOW() WHERE lower(email) = $1`, [e]);
  return NextResponse.json({ ok: true, email: e });
}
