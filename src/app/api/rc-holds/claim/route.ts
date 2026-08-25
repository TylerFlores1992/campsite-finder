import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { startClaim, getHold, markClaimed, declineHold } from '@/lib/rc-holds';
import { bookingLink } from '@/lib/booking-url';

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
 *
 * AND IT GOES ONE LEVEL DEEPER THAN THE PARK. This used to return `reservations_url`
 * raw — `/park/<placeId>` — while `lib/booking-url.ts` has known since 2026-07-22 how to
 * build `/park/<placeId>/<facilityId>`, the specific LOOP that opened. Every alert email
 * in the product already links the loop; the one screen where navigation is measured in
 * seconds of exposure was the one landing a level short, making the user pick their loop
 * out of a park list while the site sat free. Route it through the shared helper so this
 * link can never again be less specific than the alert that led here.
 */
async function parkFor(campgroundId: string): Promise<{ url: string; name: string | null }> {
  // ONE QUERY, TWO FACTS. The name comes from the same row as the URL deliberately: they
  // must describe the SAME division or the screen tells the user to verify against the
  // wrong thing, which is worse than not naming it at all.
  const [c] = await query<{ reservations_url: string | null; source: string | null; name: string | null }>(
    `SELECT reservations_url, source, name FROM campgrounds WHERE id = $1`,
    [campgroundId],
  ).catch(() => []);
  return {
    url:
      bookingLink({ source: c?.source, reservationsUrl: c?.reservations_url, campgroundId }) ??
      c?.reservations_url ??
      'https://www.reservecalifornia.com/',
    name: c?.name ?? null,
  };
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

  const park = await parkFor(hold.campground_id);

  return NextResponse.json({
    status: hold.status,
    stuck,
    // WHEN THE BOT GOT IT — so the claim screen can say how long is left rather than
    // implying the hold is open-ended. RC drops a cart after ~15 minutes (see
    // RC_CART_HOLD_MINUTES) and we do not extend it, so "We're holding it for you" stops
    // being true long before our own 45-minute sweep lets go.
    cartedAt: (hold as unknown as { carted_at: string | null }).carted_at,
    unitId: hold.unit_id,
    unitName: hold.unit_name,
    arrivalDate: hold.arrival_date,
    nights: hold.nights,
    // WHICH PARK, AND WHICH DIVISION OF IT. The card could name the SITE and the dates and
    // nothing else, so a user landing on ReserveCalifornia had nothing to check the page
    // against. Reported on 2026-08-16: "says site A012 but took me to 35-102 — there are
    // two sets of north end sites and we landed on the wrong one."
    //
    // The URL was right in that instance (a hold records the division that actually had the
    // opening, not the watch's representative one — see loadWatches' CROSS JOIN LATERAL).
    // But a screen that gives the user no way to VERIFY that is one they cannot trust at
    // 08:00, and a park with several similarly-named divisions is exactly where the doubt
    // is reasonable. Since migration 070 one watch can span divisions, so the name is the
    // only thing that distinguishes them.
    campgroundName: park.name,
    bookingUrl: park.url,
  });
}

/**
 * "No thanks" — decline an offer that has not been taken up.
 *
 * Authorised by the SAME hold id + manage token that authorises releasing the site, per
 * this route's own rule: never weaker than the authorisation for the more consequential
 * act on the same row.
 *
 * `declineHold` refuses anything past `offered`, and a refusal is reported as one. Saying
 * "removed" over a hold the bot is about to cart would be exactly the lie that kept this
 * control off the panel in the first place.
 */
export async function DELETE(req: NextRequest) {
  const { id, token } = await req.json().catch(() => ({}));
  const hold = await authorise(String(id ?? ''), String(token ?? ''));
  if (!hold) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const declined = await declineHold(hold.id);
  if (!declined) {
    return NextResponse.json(
      { error: 'this hold has already been acted on', status: hold.status },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
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
