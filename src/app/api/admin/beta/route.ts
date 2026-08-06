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
  const testers = await query<{ email: string; added_at: string; invited_at: string | null; signed_up: boolean; is_beta: boolean }>(
    `SELECT b.email, b.added_at::text AS added_at, b.invited_at::text AS invited_at,
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
  const { email, resend } = await req.json().catch(() => ({}));
  if (!isEmail(email)) return NextResponse.json({ error: 'valid email required' }, { status: 400 });
  const e = email.trim().toLowerCase();

  // Deliberate re-send to someone already on the list. The insert-gated path below
  // exists so a fat-fingered re-add can't spam a tester, but it left no way to mail
  // the people added BEFORE the invite shipped (2026-07-28) — nine of whom, added
  // 07-17 to 07-24, were never told anything, and not one has signed up since. This
  // is that door, and it is explicit rather than a side effect of re-adding.
  if (resend === true) {
    const listed = await query<{ email: string }>(
      `SELECT email FROM beta_emails WHERE email = $1`,
      [e]
    );
    if (listed.length === 0) {
      return NextResponse.json({ error: 'not on the beta list' }, { status: 404 });
    }
    try {
      await sendBetaInvite(e, process.env.NEXT_PUBLIC_APP_URL ?? 'https://camphawk.app');
      // RECORD IT. Sends used to go to Resend and leave no trace here, so "was this
      // person ever invited?" could only be answered from Resend's dashboard — and
      // when it was actually asked, it couldn't be answered at all.
      await mutate(`UPDATE beta_emails SET invited_at = NOW() WHERE email = $1`, [e]);
      return NextResponse.json({ ok: true, email: e, invited: true, resent: true });
    } catch (err) {
      console.error('[admin/beta] resend failed for', e, err);
      return NextResponse.json({ error: 'send failed' }, { status: 502 });
    }
  }

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
      await mutate(`UPDATE beta_emails SET invited_at = NOW() WHERE email = $1`, [e]);
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
