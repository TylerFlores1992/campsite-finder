import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import type { NotificationPayload } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

// Multi-account feed for the Pi bot. One master bearer token (AUTOCART_TOKEN)
// returns every enrolled user's recent openings, grouped by user, so the bot can
// route each to that user's browser profile. Users opt in via /api/user/autocart.
export async function GET(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const windowMin = Math.min(60, Math.max(2, Number(req.nextUrl.searchParams.get('windowMin') ?? 15)));

  // Every enrolled user, each with their recent openings (jobs may be empty —
  // the bot uses the full list to know who to set logins up for).
  const rows = await query<{
    user_id: string;
    email: string | null;
    notif_id: string | null;
    payload: NotificationPayload | null;
    source: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, n.id AS notif_id, n.payload, c.source
     FROM users u
     LEFT JOIN notifications n
       ON n.user_id = u.id AND n.channel = 'email' AND n.status = 'sent'
       AND n.created_at > now() - interval '${windowMin} minutes'
     LEFT JOIN campgrounds c ON c.id = n.campground_id
     WHERE u.autocart_enabled = true
     ORDER BY n.created_at DESC NULLS LAST
     LIMIT 200`
  );

  const byUser = new Map<string, { userId: string; email: string | null; jobs: unknown[] }>();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { userId: r.user_id, email: r.email, jobs: [] });
    if (r.notif_id && r.payload) {
      byUser.get(r.user_id)!.jobs.push({
        id: r.notif_id,
        source: r.source,
        campgroundName: r.payload.campgroundName,
        campsiteName: r.payload.campsiteName ?? null,
        bookingUrl: r.payload.bookingUrl,
        startDate: r.payload.startDate,
        endDate: r.payload.endDate,
      });
    }
  }

  return NextResponse.json({ users: [...byUser.values()] });
}
