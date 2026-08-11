import { NextRequest, NextResponse } from 'next/server';
import { mutate, queryOne } from '@/lib/db/client';
import { hasAutocartEntitlement } from '@/lib/auth';
import { sendAutocartNudge } from '@/lib/notifications/autocart-nudge';

export const dynamic = 'force-dynamic';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://camphawk.app';

// Lets the bot machine update a user's auto-cart state (master bearer token).
// Partial update — send either or both:
//   enabled:   flip the app toggle (e.g. back OFF when a login isn't completed)
//   connected: record that the one-time rec.gov sign-in succeeded on the bot
export async function POST(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { userId, enabled, connected } = await req.json();
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  if (typeof enabled !== 'boolean' && typeof connected !== 'boolean') {
    return NextResponse.json({ error: 'enabled or connected required' }, { status: 400 });
  }

  // Read the PRE-update state so a connected:true→false report can be told apart from
  // a connected:false→false one — the bot calls this on every keepalive pass a dead
  // session is confirmed on, and only the first one (the actual transition) should
  // mail anyone. See migration 051.
  const before =
    connected === false
      ? await queryOne<{ autocart_connected: boolean; email: string }>(
          'SELECT autocart_connected, email FROM users WHERE id = $1',
          [userId]
        )
      : null;

  await mutate(
    `UPDATE users SET
       autocart_enabled = COALESCE($1, autocart_enabled),
       autocart_connected = COALESCE($2, autocart_connected),
       -- Stamp the freshness marker whenever the bot confirms a live session
       -- (connected=true, i.e. a sign-in or a keepalive "kept warm"). The poller
       -- treats the auto-cart lane as usable only while this stays recent, so a
       -- session that silently dies between keepalives fails open to normal alerts.
       autocart_verified_at = CASE WHEN $2 IS TRUE THEN NOW() ELSE autocart_verified_at END,
       updated_at = NOW()
     WHERE id = $3`,
    [typeof enabled === 'boolean' ? enabled : null, typeof connected === 'boolean' ? connected : null, userId]
  );

  // Fire the "finish connecting" nudge on the transition only — never on a repeat
  // "still dead" report, and never for a user who was already disconnected before
  // this request (the daily cron owns that case; see /api/cron/autocart-nudge).
  // Fire-and-forget: a slow/failed email must never hold up the bot's report, which
  // is on the hot path of every keepalive cycle.
  if (before?.autocart_connected === true && before.email) {
    hasAutocartEntitlement(userId)
      .then((entitled) => {
        if (!entitled) return; // lapsed subscriber — never nagged about a plan they don't have
        return sendAutocartNudge(before.email, APP_URL).then(() =>
          mutate('UPDATE users SET autocart_nudge_sent_at = NOW() WHERE id = $1', [userId])
        );
      })
      .catch((e) => console.error('[auto-cart/enrollment] nudge send failed:', e.message));
  }

  return NextResponse.json({ ok: true, userId });
}
