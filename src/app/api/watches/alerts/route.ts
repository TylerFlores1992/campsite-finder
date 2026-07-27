import { NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { requireAuth } from '@/lib/auth';

/**
 * Alert history for the signed-in user, across all their watches.
 *
 * Until now alerts were only readable per-watch through /api/manage/[token],
 * which is token-scoped and meant for the no-login path from an SMS. The Watches
 * page needs the same information for the whole account.
 *
 * NO OUTCOMES. Rows say what we sent and when — deliberately not "you booked it"
 * or "you missed it". Checkout happens on the provider's site and we never see
 * it, so any outcome here would be invented. `autocart_jobs.cart_outcome` proves
 * a site reached a cart, which is not the same claim.
 *
 * Failed sends are included on purpose: "we tried to text you and your carrier
 * bounced it" is exactly what a user needs when they think we missed something.
 */

const MAX_ROWS = 40;

interface AlertRow {
  id: string;
  created_at: string;
  channel: string;
  status: string;
  watch_id: string | null;
  campground_name: string | null;
  site_name: string | null;
  site_id: string | null;
}

export async function GET() {
  const userId = await requireAuth();

  const rows = await query<AlertRow>(
    `SELECT n.id,
            n.created_at,
            n.channel,
            n.status,
            n.watch_id,
            c.name                        AS campground_name,
            n.payload->>'campsiteName'    AS site_name,
            n.payload->>'campsiteId'      AS site_id
       FROM notifications n
       LEFT JOIN campgrounds c ON c.id = n.campground_id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [userId, MAX_ROWS],
  );

  return NextResponse.json({
    alerts: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      channel: r.channel,
      status: r.status,
      watchId: r.watch_id,
      campgroundName: r.campground_name,
      siteName: r.site_name ?? r.site_id,
    })),
  });
}
