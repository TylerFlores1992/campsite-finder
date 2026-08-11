import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { hasAutocartEntitlement } from '@/lib/auth';
import { sendAutocartNudge } from '@/lib/notifications/autocart-nudge';

// Daily nudge for someone who turned auto-cart on and never finished /connect —
// distinct from the enrollment route's nudge, which fires the moment a WORKING
// connection dies. That one is event-driven; this one exists because "never
// connected" has no event to hang off — nobody calls us to say nothing happened.
// See migration 051 and the enrollment route for the other half.
//
// "Never connected" = autocart_verified_at IS NULL. A user whose session died and
// came back would have a verified_at from the earlier success; this only ever
// matches someone who has NEVER completed the rec.gov sign-in.
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const bearer = req.headers.get('authorization');
  if (cronSecret && bearer === `Bearer ${cronSecret}`) return true;
  if (syncSecret && req.headers.get('x-sync-secret') === syncSecret) return true;
  return false;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://camphawk.app';

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // NULL autocart_enabled_at means "enabled before migration 051" — treated as
  // eligible NOW, not held back forever, same reasoning as watch_site_alerts'
  // NULL-doesn't-suppress rule. Compared as Pacific CALENDAR DATES so "the next
  // morning" means what it says regardless of what time of day someone enabled it.
  const candidates = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users
      WHERE autocart_enabled = true
        AND autocart_connected = false
        AND autocart_verified_at IS NULL
        AND autocart_nudge_sent_at IS NULL
        AND (
          autocart_enabled_at IS NULL
          OR (autocart_enabled_at AT TIME ZONE 'America/Los_Angeles')::date
             < (NOW() AT TIME ZONE 'America/Los_Angeles')::date
        )`
  );

  let sent = 0;
  const errors: string[] = [];
  for (const u of candidates) {
    try {
      if (!(await hasAutocartEntitlement(u.id))) continue; // lapsed — don't nag
      await sendAutocartNudge(u.email, APP_URL);
      await mutate('UPDATE users SET autocart_nudge_sent_at = NOW() WHERE id = $1', [u.id]);
      sent++;
    } catch (e) {
      errors.push(`${u.email}: ${(e as Error).message}`);
    }
  }

  console.log(`[cron autocart-nudge] ${sent}/${candidates.length} sent, ${errors.length} error(s)`);
  return NextResponse.json({ ok: true, candidates: candidates.length, sent, errors });
}
