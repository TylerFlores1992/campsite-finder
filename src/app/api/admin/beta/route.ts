import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { currentUserEmail, isAdminEmail } from '@/lib/admin';
import { sendBetaInvite } from '@/lib/notifications/beta-invite';

export const dynamic = 'force-dynamic';


// 404 (not 403) for non-admins so the endpoint's existence isn't revealed.
async function requireAdmin(): Promise<string | null> {
  const email = await currentUserEmail();
  return isAdminEmail(email) ? email : null;
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
  // RETURNING tells us whether this was a NEW pre-approval or a re-add of one that
  // already existed, which is what decides whether to email. Re-adding an existing
  // tester must not spam them a second invite.
  // mutate(), NOT query() — query() goes through exec_select, which rejects an
  // INSERT outright, so every add 500'd. mutate() already returns rows when the
  // statement has RETURNING (it detects the keyword and asks for a result set).
  const inserted = await mutate<{ email: string }>(
    `INSERT INTO beta_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING email`,
    [e]
  );
  await mutate(`UPDATE users SET is_beta = true, updated_at = NOW() WHERE lower(email) = $1`, [e]);

  // Tell them. Being added used to be silent, so a tester either never signed up or
  // signed up and saw no difference. Best-effort: a mail failure must not fail the
  // add, or the admin retries and the row is already there — so the outcome is
  // reported back instead and the panel can show it.
  let invited = false;
  if (inserted.length > 0) {
    try {
      await sendBetaInvite(e, process.env.NEXT_PUBLIC_APP_URL ?? 'https://camphawk.app');
      invited = true;
    } catch (err) {
      console.error('[admin/beta] invite email failed for', e, err);
    }
  }

  return NextResponse.json({ ok: true, email: e, invited, alreadyListed: inserted.length === 0 });
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
