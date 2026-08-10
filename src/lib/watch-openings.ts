import { query } from '@/lib/db/client';

/**
 * "Which sites on this watch are open right now, and what's releasing tomorrow?"
 *
 * ## Where the data comes from, and why nothing is fetched
 *
 * NOTHING here talks to a reservation provider. `watch_site_alerts.last_seen_open_at` is
 * stamped by the poller on EVERY cycle it finds a site open (migration 039 — it exists so
 * a re-alert can require the site to have actually gone away and come back), which makes
 * it a free, continuously-maintained record of what is open per (watch, site). Asking
 * rec.gov or RC again on a page load would duplicate the poller, add seconds to the
 * watches list, and spend the per-IP budget that keeps detection at 15s.
 *
 * ## Why a freshness window, and why this one
 *
 * `last_seen_open_at` means "we saw it open THEN", never "it is open now". A site can be
 * taken between a poll and a page load, so the window has to be short enough that the
 * claim is still roughly true, and long enough to survive the slowest poll cadence a
 * watch can be on. Since the tiering split, a far-out watch may only be checked every
 * five minutes, so anything under that would blink the badge off and on for a site that
 * never closed. Fifteen minutes is three of the slowest cycles.
 *
 * The UI honours the same distinction: the card says how many, the manage screen says how
 * long ago, and neither promises the site is still there.
 */
export const OPEN_WINDOW_MS = 15 * 60_000;

export interface OpenSite {
  /** Provider site id, as the alert recorded it. */
  id: string;
  /** Human label if we have ever alerted on it — see the name note below. */
  name: string | null;
  /** Seconds since the poller last saw this site open. */
  seenSecondsAgo: number;
}

export interface PendingHold {
  unitId: string;
  unitName: string | null;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
  /** 'offered' = we can hold it, one tap away. 'requested' = you already asked. */
  status: 'offered' | 'requested';
  /** One-tap hold link. Only minted where it is rendered — see watchOpenings. */
  holdUrl?: string | null;
}

export interface WatchOpenings {
  open: OpenSite[];
  /** Every site releasing on a schedule, soonest first. */
  holds: PendingHold[];
}

/**
 * For a set of watch ids. Batched deliberately: the watches list renders every watch at
 * once, and a per-watch round trip would be N queries on the one page a user opens most.
 *
 * Best-effort by construction — a failure here must render the list without badges rather
 * than fail the page. This is decoration on top of the watch, not the watch.
 */
export async function watchOpenings(watchIds: string[]): Promise<Map<string, WatchOpenings>> {
  const out = new Map<string, WatchOpenings>();
  if (!watchIds.length) return out;
  for (const id of watchIds) out.set(id, { open: [], holds: [] });

  // SITE NAMES COME FROM THE ALERT HISTORY, exactly as /api/manage/[token] resolves them:
  // `watch_site_alerts` stores only a site_key, and the human label ("Campsite #38") lives
  // in the notification payload we already sent. A site open for the first time therefore
  // has no name yet and renders as its id — the same honest gap the mute list has, rather
  // than inventing a label.
  const openRows = await query<{ watch_id: string; site_key: string; name: string | null; age: number }>(
    `SELECT a.watch_id, a.site_key,
            (SELECT n.payload->>'campsiteName'
               FROM notifications n
              WHERE n.watch_id = a.watch_id AND n.payload->>'campsiteId' = a.site_key
              ORDER BY n.created_at DESC LIMIT 1) AS name,
            EXTRACT(EPOCH FROM (NOW() - a.last_seen_open_at))::int AS age
       FROM watch_site_alerts a
      WHERE a.watch_id = ANY($1)
        AND a.last_seen_open_at IS NOT NULL
        AND a.last_seen_open_at > NOW() - ($2 || ' milliseconds')::interval
        -- The '*' sentinel is what sources with no per-site id collapse onto
        -- (ReserveAmerica, GoingToCamp, TN/SC). Counting it as "1 site open" would be a
        -- number we made up: it means "something on this campground", not one site.
        AND a.site_key <> '*'
      ORDER BY a.last_seen_open_at DESC`,
    [watchIds, String(OPEN_WINDOW_MS)],
  ).catch(() => []);

  for (const r of openRows) {
    out.get(r.watch_id)?.open.push({ id: r.site_key, name: r.name, seenSecondsAgo: Number(r.age) });
  }

  // EVERY site releasing on a schedule, not just the soonest — the watch page lists them
  // and each gets its own hold link. Deliberately NOT `carted` and beyond: once it is
  // actually held the claim flow owns the story, and a second place to read it would be
  // the staler one.
  const holdRows = await query<{
    watch_id: string; unit_id: string; unit_name: string | null;
    arrival_date: string; nights: number; release_at: string; status: 'offered' | 'requested';
  }>(
    `SELECT watch_id, unit_id, unit_name, arrival_date::text AS arrival_date, nights, release_at, status
       FROM rc_hold_requests
      WHERE watch_id = ANY($1)
        AND status IN ('offered', 'requested')
        AND release_at >= to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
      ORDER BY release_at ASC, unit_name ASC`,
    [watchIds],
  ).catch(() => []);

  for (const r of holdRows) {
    out.get(r.watch_id)?.holds.push({
      unitId: r.unit_id,
      unitName: r.unit_name,
      arrivalDate: r.arrival_date,
      nights: Number(r.nights) || 1,
      releaseAt: r.release_at,
      status: r.status,
    });
  }

  return out;
}

/**
 * Attach a one-tap hold link to each OFFERED hold.
 *
 * Separate from `watchOpenings` and called only where the links are rendered, because
 * minting writes a row. `mintActionToken` is idempotent per (watch, action, site) — it
 * returns the token that already exists — so this hands back the very same link the alert
 * sent rather than a second one competing with it.
 *
 * `requested` holds get no link on purpose: the user has already answered, and a button
 * offering to do the thing they asked for reads as though the first tap failed.
 */
export async function withHoldLinks(holds: PendingHold[], watchId: string): Promise<PendingHold[]> {
  const { actionUrlFor } = await import('@/lib/notifications/actions');
  return Promise.all(
    holds.map(async (h) =>
      h.status === 'offered'
        ? { ...h, holdUrl: await actionUrlFor(watchId, 'hold', h.unitId).catch(() => null) }
        : h,
    ),
  );
}
