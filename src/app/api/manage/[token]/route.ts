import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { resolveManageToken } from '@/lib/notifications/actions';

export const dynamic = 'force-dynamic';

// Per-watch management, authorized by an unguessable `manage` token (the same
// magic-link model as the /w/ Stop/Mute links) so it works from a tapped SMS with
// no login. Every op is scoped to the token's watch_id — a token can only touch its
// own watch.

interface WatchRow {
  id: string;
  campground_id: string;
  campground_name: string;
  source: string;
  reservations_url: string | null;
  latitude: number | null;
  longitude: number | null;
  start_date: string;
  end_date: string;
  min_nights: number;
  flex_nights: number | null;
  flex_days: string | null;
  site_type: string | null;
  active: boolean;
  auto_cart: boolean;
  muted_site_ids: string[];
  created_at: string;
}

async function loadWatch(watchId: string): Promise<WatchRow | null> {
  const [w] = await query<WatchRow>(
    `SELECT w.id, w.campground_id, c.name AS campground_name,
            c.source, c.reservations_url,
            ST_Y(c.location::geometry) AS latitude, ST_X(c.location::geometry) AS longitude,
            w.start_date::text, w.end_date::text, w.min_nights,
            w.flex_nights, w.flex_days, w.site_type, w.active, w.auto_cart,
            w.muted_site_ids, w.created_at::text
       FROM watches w JOIN campgrounds c ON c.id = w.campground_id
      WHERE w.id = $1`,
    [watchId]
  );
  return w ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const watchId = await resolveManageToken(token);
  if (!watchId) return NextResponse.json({ error: 'invalid or expired link' }, { status: 404 });

  const watch = await loadWatch(watchId);
  if (!watch) return NextResponse.json({ error: 'watch not found' }, { status: 404 });

  // Recent alert history for this watch.
  const alerts = await query<{
    created_at: string;
    channel: string;
    status: string;
    site_name: string | null;
    dates: string[] | null;
    kind: string | null;
  }>(
    `SELECT created_at::text, channel, status,
            payload->>'campsiteName' AS site_name,
            payload->'availableDates' AS dates,
            payload->>'kind' AS kind
       FROM notifications
      WHERE watch_id = $1
      ORDER BY created_at DESC
      LIMIT 25`,
    [watchId]
  );

  // Sites this watch has been alerted about (the practical, data-grounded list) plus
  // any currently-muted site not in that set, each flagged muted or not.
  const seen = await query<{ site_id: string; site_name: string | null }>(
    `SELECT DISTINCT payload->>'campsiteId' AS site_id, payload->>'campsiteName' AS site_name
       FROM notifications
      WHERE watch_id = $1 AND payload->>'campsiteId' IS NOT NULL`,
    [watchId]
  );
  const muted = new Set(watch.muted_site_ids ?? []);
  const siteMap = new Map<string, string | null>();
  for (const s of seen) if (s.site_id) siteMap.set(s.site_id, s.site_name);
  for (const id of muted) if (!siteMap.has(id)) siteMap.set(id, null);
  const sites = [...siteMap.entries()]
    .map(([id, name]) => ({ id, name, muted: muted.has(id) }))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

  return NextResponse.json({ watch, alerts, sites });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const watchId = await resolveManageToken(token);
  if (!watchId) return NextResponse.json({ error: 'invalid or expired link' }, { status: 404 });

  const { op, siteId } = await req.json().catch(() => ({}));

  switch (op) {
    case 'remove':
      // Permanent delete (cascades action_tokens + notifications keep their SET NULL).
      await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]);
      return NextResponse.json({ ok: true, removed: true });
    case 'stop':
      await mutate(`UPDATE watches SET active = false WHERE id = $1`, [watchId]);
      break;
    case 'resume':
      await mutate(`UPDATE watches SET active = true, deadman_prompted_at = NULL WHERE id = $1`, [watchId]);
      break;
    case 'mute':
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 });
      await mutate(
        `UPDATE watches SET muted_site_ids = array_append(muted_site_ids, $2)
          WHERE id = $1 AND NOT ($2 = ANY(muted_site_ids))`,
        [watchId, siteId]
      );
      break;
    case 'unmute':
      if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 });
      await mutate(`UPDATE watches SET muted_site_ids = array_remove(muted_site_ids, $2) WHERE id = $1`, [
        watchId,
        siteId,
      ]);
      break;
    default:
      return NextResponse.json({ error: 'unknown op' }, { status: 400 });
  }

  const watch = await loadWatch(watchId);
  return NextResponse.json({ ok: true, watch });
}
