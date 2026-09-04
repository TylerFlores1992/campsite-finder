import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { query } from '@/lib/db/client';
import { manageTokenFor, mintActionToken } from '@/lib/notifications/actions';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user's live ReserveCalifornia holds.
 *
 * ## Why this exists
 *
 * Until now the ONLY way to a hold was the alert that announced it — an email or a push
 * notification, tapped once, on one device. Miss it, clear it, read it on the wrong phone,
 * and there was no route back to a site CampHawk was physically holding in a cart. The
 * claim URL carries a token, so it could not be guessed or reconstructed, and nothing in
 * the app listed it.
 *
 * That is a bad shape for the single most time-critical object in the product. The Watches
 * tab is where somebody looks when they think "what is happening with my sites", so the
 * holds belong there.
 *
 * ## The token, and why minting it here is not a leak
 *
 * `/claim/<id>?t=<token>` is authorised by possession of the hold id plus the watch's
 * `manage` token — deliberately not by a login, because the claim happens on a phone at 8am
 * from an email link and a sign-in wall would spend the seconds the hold exists to save.
 *
 * This route is the other door: the caller has already proved who they are to Clerk, so the
 * token is minted for THEIR OWN watches and handed back over an authenticated response. It
 * is the same stable token the alert already emailed them (`mintActionToken` reuses the row
 * on conflict), not a new capability — and every row is scoped `user_id = $1`, so the id
 * being a UUID is not what is doing the work.
 *
 * ## Which holds count as live
 *
 * Anything the bot is holding or has just let go of (`carted`, `claiming`, `released`) is
 * actionable NOW regardless of when its release was — that is exactly the 2026-08-13 leak,
 * where two carted holds sat unclaimed until a sweep expired them. Everything else only
 * matters while its release is still ahead: an offer nobody answered before 08:00 is a
 * moment that has passed, not a task.
 *
 * Terminal states are excluded. `claimed`/`expired`/`failed` have nothing left to do, and a
 * list that keeps them is a list nobody reads.
 */
export interface MyHold {
  id: string;
  /**
   * Which watch this belongs to, so the watches page can file it under that card.
   *
   * ADDED 2026-09-04, when the offered/queued lists moved off the top of the page and into
   * the box with the rest of a watch's information. It is not a leak: every row here is
   * already scoped `user_id = $1`, so the caller owns the watch this names.
   */
  watchId: string;
  status: string;
  /** What to call the site on screen — RC's human `#L006`, never its internal key. */
  unitLabel: string;
  campgroundName: string | null;
  arrivalDate: string;
  nights: number;
  /** RC's zone-less Pacific wall-clock. Never parse this with `new Date`. */
  releaseAt: string;
  cartedAt: string | null;
  /** The hand-off screen. Present once there is something to hand over. */
  claimUrl?: string;
  /** "Hold it for me" — the same confirm page the coming-soon alert links to. */
  holdUrl?: string;
  /** When the row last changed. For a `released` hold that is the moment we let go, which
   *  is what decides whether it is still worth shouting about. */
  updatedAt: string | null;
  /**
   * Authorises removing this row — the watch's manage token, the SAME one that authorises
   * releasing the site. Present only where a remove is HONEST, which is three of the five
   * statuses:
   *
   *   `offered`   declining genuinely retracts the offer and frees its capacity seat and
   *               its position in the line.
   *   `requested` CANCELS it (added 2026-09-04 on the owner's ask). A different act from
   *               declining and it carries a timing rule — see `cancelHold` — but the row
   *               really does stop the bot carting, so the control is not a lie.
   *   `released`  the hand-off is finished and the row is only history.
   *
   * Never on `carted`/`claiming`, where marking a row terminal would take a real campsite
   * off the market and delete the last thing on screen pointing at it.
   */
  dismissToken?: string;
}

export async function GET() {
  // THE SECOND GATE, and it is not a duplicate. Clerk's middleware already refuses this
  // route (with a 404, not a 401 — `auth.protect()` hides the existence of what it
  // guards), so in normal operation nothing signed-out reaches here. This is what holds if
  // the matcher is ever widened back to `/api/rc-holds/(.*)`, which is exactly the edit
  // that would silently expose it. A plain 401 rather than `requireAuth`'s throw because
  // the Watches panel polls every 20 seconds and treats any non-2xx as "nothing to show".
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await query<{
    id: string; watch_id: string; status: string; unit_id: string; unit_name: string | null;
    arrival_date: string; nights: number; release_at: string; carted_at: string | null;
    updated_at: string | null; campground_name: string | null;
  }>(
    `SELECT h.id, h.watch_id, h.status, h.unit_id, h.unit_name,
            h.arrival_date::text AS arrival_date, h.nights, h.release_at,
            h.carted_at::text AS carted_at, h.updated_at::text AS updated_at,
            c.name AS campground_name
       FROM rc_hold_requests h
       LEFT JOIN campgrounds c ON c.id = h.campground_id
      WHERE h.user_id = $1
        AND h.status IN ('offered', 'requested', 'carted', 'claiming', 'released')
        AND (
          h.status IN ('carted', 'claiming', 'released')
          OR h.release_at >= to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
        )
      ORDER BY h.release_at ASC
      LIMIT 20`,
    [userId],
  ).catch((e) => {
    console.error('[rc-holds/mine] query failed:', (e as Error).message);
    return [];
  });

  const holds: MyHold[] = [];
  for (const r of rows) {
    const base: MyHold = {
      id: r.id,
      watchId: r.watch_id,
      status: r.status,
      unitLabel: r.unit_name ?? r.unit_id,
      campgroundName: r.campground_name,
      arrivalDate: r.arrival_date,
      nights: Number(r.nights),
      releaseAt: r.release_at,
      cartedAt: r.carted_at,
      updatedAt: r.updated_at,
    };
    // A LINK IS ONLY OFFERED WHERE IT LEADS SOMEWHERE. The claim screen tells a user with
    // an `offered` hold that "nothing is being held for you right now", which is true and
    // reads as a fault; the hold confirm page is the one that can act on it.
    if (r.status === 'offered') {
      const t = await mintActionToken(r.watch_id, 'hold', r.unit_id);
      if (t) base.holdUrl = `/w/${t}`;
      // The offer can now be DECLINED, so it needs the authorisation to do it. Handed over
      // an authenticated response for the caller's own watches — the same token the alert
      // already emailed them, not a new capability.
      const m = await manageTokenFor(r.watch_id);
      if (m) base.dismissToken = m;
    } else if (r.status === 'requested') {
      // NO CLAIM URL — there is nothing to hand over until the bot has carted, and the
      // claim screen tells a `requested` user that nothing is being held for them, which is
      // true and reads as a fault. What it gets is the authorisation to CALL IT OFF.
      const m = await manageTokenFor(r.watch_id);
      if (m) base.dismissToken = m;
    } else {
      const t = await manageTokenFor(r.watch_id);
      if (t) {
        base.claimUrl = `/claim/${r.id}?t=${encodeURIComponent(t)}`;
        if (r.status === 'released') base.dismissToken = t;
      }
    }
    holds.push(base);
  }

  return NextResponse.json({ holds });
}
