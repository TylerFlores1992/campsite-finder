import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { hasAutocartEntitlement } from '@/lib/auth';
import { sendAutocartNudge } from '@/lib/notifications/autocart-nudge';

// Daily sweep for auto-cart that is switched on and not actually working.
//
// TWO SHAPES, ONE EMAIL. The enrollment route fires the moment a WORKING connection
// dies — event-driven, and it covers the common case well. This sweep exists for the
// states no event will ever announce:
//
//   1. NEVER CONNECTED (autocart_verified_at IS NULL). Nobody calls us to say nothing
//      happened, so there is no event to hang off.
//   2. ALREADY LAPSED, and this is the one that mattered. A user whose connection died
//      BEFORE the enrollment nudge existed — or whose `connected:false` report was
//      simply lost — has no future transition to fire on, because the transition
//      already happened unobserved. Found live on 2026-08-11:
//      iamtylerflores12345@yahoo.com, verified 2026-07-29, connected=false, THIRTEEN
//      DAYS, and both of the other paths excluded them. The account the nudge was
//      written for was the one account it could never reach.
//
// (2) is also the backstop for (1)'s failure mode: `reportConnected` in bot.mjs is
// fire-and-forget with `.catch(() => {})`, so one network blip on the mini-PC loses the
// only signal forever. An event with no reconciling sweep is the same trap as
// `notifications.status = 'sent'` — it records that we tried, not that it landed.
export const dynamic = 'force-dynamic';

/**
 * How long a dead connection must stay dead before we mail about it.
 *
 * Not zero: the keepalive runs every 30 minutes and can now repair the session from a
 * saved password by itself, so a blip that self-heals within the hour must not generate
 * an email telling someone to go and fix a thing that is already fixed. Two days means
 * "this has been broken across several keepalive passes and several repair attempts,
 * and nothing recovered it".
 */
const LAPSED_HOURS = Number(process.env.AUTOCART_LAPSED_HOURS || 48);

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

  // NULL autocart_enabled_at means "enabled before migration 052" — treated as
  // eligible NOW, not held back forever, same reasoning as watch_site_alerts'
  // NULL-doesn't-suppress rule. Compared as Pacific CALENDAR DATES so "the next
  // morning" means what it says regardless of what time of day someone enabled it.
  const candidates = await query<{ id: string; email: string; shape: string }>(
    `SELECT id, email,
            CASE WHEN autocart_verified_at IS NULL THEN 'never-connected' ELSE 'lapsed' END AS shape
       FROM users
      WHERE autocart_enabled = true
        AND autocart_connected = false
        AND autocart_nudge_sent_at IS NULL
        AND (
          -- 1. Never connected: wait for the next Pacific calendar day, so "the morning
          --    after" means what it says whatever time of day they enabled it.
          (autocart_verified_at IS NULL AND (
             autocart_enabled_at IS NULL
             OR (autocart_enabled_at AT TIME ZONE 'America/Los_Angeles')::date
                < (NOW() AT TIME ZONE 'America/Los_Angeles')::date
          ))
          -- 2. Connected once, dead ever since. autocart_verified_at is stamped by every
          --    successful keepalive, so this reads "nothing has worked for two days".
          OR (autocart_verified_at IS NOT NULL
              AND autocart_verified_at < NOW() - ($1 || ' hours')::interval)
        )`,
    [String(LAPSED_HOURS)],
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

  // Report the two shapes separately. They are different faults — "never finished
  // signing up" is onboarding, "was working and stopped" is a broken connection — and a
  // single total would have hidden thirteen days of the second behind zero of the first.
  const byShape = { 'never-connected': 0, lapsed: 0 } as Record<string, number>;
  for (const c of candidates) byShape[c.shape] = (byShape[c.shape] ?? 0) + 1;
  console.log(
    `[cron autocart-nudge] ${sent}/${candidates.length} sent ` +
    `(${byShape['never-connected']} never-connected, ${byShape.lapsed} lapsed), ${errors.length} error(s)`,
  );
  return NextResponse.json({ ok: true, candidates: candidates.length, byShape, sent, errors });
}
