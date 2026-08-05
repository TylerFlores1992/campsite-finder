// Everything the setup nudges need, in ONE request.
//
// The nudges used to live inside WatchesList, which already had the phone, the
// auto-cart state and the watch list in hand. Moving them onto Explore and New watch
// (2026-08-05) meant either three fetches per page — including `/api/watches`, which
// computes a cancellation-likelihood figure per watch and is far too heavy to load on
// a page that doesn't render watches — or one endpoint that answers the actual
// question. This is that endpoint.
//
// It returns FACTS, not decisions: whether to show a banner is the component's job, so
// the copy and the thresholds stay next to each other rather than split across a
// network boundary.

import { NextResponse } from 'next/server';
import { requireAuth, hasAutocartEntitlement } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';

export async function GET() {
  const userId = await requireAuth();

  const row = await queryOne<{
    phone: string | null;
    autocart_connected: boolean;
    autocart_enabled: boolean;
    recgov_watches: number;
    live_watches: number;
  }>(
    // The watch counts use `active AND end_date > CURRENT_DATE` — the SAME definition
    // as the poller's candidate query, the watch cap and the watches list. A watch the
    // poller no longer runs must not make us nag about setting up alerting for it.
    `SELECT u.phone,
            u.autocart_connected,
            u.autocart_enabled,
            (SELECT count(*)::int FROM watches w
               JOIN campgrounds c ON c.id = w.campground_id
              WHERE w.user_id = u.id AND w.active AND w.end_date > CURRENT_DATE
                AND c.source = 'ridb') AS recgov_watches,
            (SELECT count(*)::int FROM watches w
              WHERE w.user_id = u.id AND w.active AND w.end_date > CURRENT_DATE) AS live_watches
       FROM users u
      WHERE u.id = $1`,
    [userId]
  );

  return NextResponse.json({
    hasPhone: !!row?.phone,
    autocartConnected: !!row?.autocart_connected,
    autocartEnabled: !!row?.autocart_enabled,
    // Auto-Cart tier, grandfathered pre-tier subscription, or beta — one definition,
    // shared with the toggle API, the bot roster and the poller's lane.
    autocartEntitled: await hasAutocartEntitlement(userId),
    /** Watches auto-cart could actually act on. Auto-cart is Recreation.gov ONLY. */
    recgovWatches: row?.recgov_watches ?? 0,
    liveWatches: row?.live_watches ?? 0,
  });
}
