import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { startClaim, getHold, markClaimed } from '@/lib/rc-holds';

export const dynamic = 'force-dynamic';

/**
 * The user's side of the claim handshake.
 *
 * Authenticated by the hold's own id plus the watch's `manage` token — no login. That
 * matters: the claim happens on a phone at 8am from an email link, and requiring a
 * sign-in first would spend the very seconds the hold exists to save. The id is a UUID
 * and the token is unguessable, so possession of both is the authorisation, exactly like
 * /manage/<token>. Both are `noindex` territory: they authorise, so they must not leak.
 *
 * POST — "let it go, I'm taking it." Flips the hold to `claiming`; the bot's fast lane
 *        picks it up within ~1s and releases.
 * GET  — poll until `released`, which is the starting gun for the recapture.
 */
/**
 * Where to send the user the instant the bot lets go.
 *
 * THIS IS THE HAND-OFF, and it was landing on reservecalifornia.com's HOMEPAGE. The
 * `#camphawk-rc=` fragment is only understood by the desktop browser extension; on a
 * phone — which is the whole point of a claim link at 8am — nothing consumes it, so the
 * user arrived at RC's front page and had to search for the park, find the unit and pick
 * the dates, all while the site sat unheld and free to anyone. That spends the entire
 * ~2.5s window the design exists to protect.
 *
 * `campgrounds.reservations_url` is the park's own booking page, already stored and
 * already used by every alert. Falling back to the root only when a campground has none.
 */
async function bookingUrlFor(campgroundId: string): Promise<string> {
  const [c] = await query<{ reservations_url: string | null }>(
    `SELECT reservations_url FROM campgrounds WHERE id = $1`,
    [campgroundId],
  ).catch(() => []);
  return c?.reservations_url ?? 'https://www.reservecalifornia.com/';
}

async function authorise(holdId: string, token: string) {
  if (!holdId || !token) return null;
  const hold = await getHold(holdId);
  if (!hold) return null;
  const [row] = await query<{ watch_id: string }>(
    `SELECT watch_id FROM action_tokens
      WHERE token = $1 AND action = 'manage' AND watch_id = $2 AND expires_at > NOW()`,
    [token, hold.watch_id],
  );
  return row ? hold : null;
}

export async function POST(req: NextRequest) {
  const { id, token } = await req.json().catch(() => ({}));
  const hold = await authorise(String(id ?? ''), String(token ?? ''));
  if (!hold) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const after = await startClaim(hold.id);
  if (!after) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ status: after.status, unitName: after.unit_name, unitId: after.unit_id });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const hold = await authorise(id, token);
  if (!hold) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // If the bot never picked the claim up, say so instead of spinning forever. A runner
  // that is down is a fixable operational fact; an endless spinner is just a mystery.
  const stuck =
    hold.status === 'claiming' &&
    hold.claim_started_at != null &&
    Date.now() - new Date(hold.claim_started_at).getTime() > 30_000;

  return NextResponse.json({
    status: hold.status,
    stuck,
    unitId: hold.unit_id,
    unitName: hold.unit_name,
    arrivalDate: hold.arrival_date,
    nights: hold.nights,
    bookingUrl: await bookingUrlFor(hold.campground_id),
  });
}

/** The user's own session took it. Recorded so an abandoned hand-off is distinguishable
 *  from a completed one — without this, `released` would be the last word either way. */
export async function PATCH(req: NextRequest) {
  const { id, token } = await req.json().catch(() => ({}));
  const hold = await authorise(String(id ?? ''), String(token ?? ''));
  if (!hold) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await markClaimed(hold.id);
  return NextResponse.json({ ok: true });
}
