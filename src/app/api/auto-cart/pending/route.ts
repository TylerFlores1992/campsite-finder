import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import type { NotificationPayload } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

// Personal auto-cart feed for the owner's local bot. Authenticated with a shared
// bearer token (AUTOCART_TOKEN), NOT a Clerk session, since the bot isn't a browser.
const OWNER_EMAIL = (process.env.AUTOCART_OWNER_EMAIL ?? 'tylerflores1992@gmail.com').toLowerCase();

export async function GET(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Recent openings for the owner. One row per opening (channel='email' is always
  // dispatched, so we filter to it to avoid the SMS duplicate).
  const windowMin = Math.min(60, Math.max(2, Number(req.nextUrl.searchParams.get('windowMin') ?? 15)));
  const rows = await query<{ id: string; payload: NotificationPayload; source: string; created_at: string }>(
    `SELECT n.id, n.payload, c.source, n.created_at::text
     FROM notifications n
     JOIN users u ON u.id = n.user_id
     JOIN campgrounds c ON c.id = n.campground_id
     WHERE u.email = '${OWNER_EMAIL.replace(/'/g, "''")}'
       AND n.channel = 'email' AND n.status = 'sent'
       AND n.created_at > now() - interval '${windowMin} minutes'
     ORDER BY n.created_at DESC
     LIMIT 25`
  );

  const jobs = rows.map((r) => ({
    id: r.id,
    source: r.source, // 'ridb' | 'reservecalifornia'
    campgroundName: r.payload.campgroundName,
    campsiteName: r.payload.campsiteName ?? null,
    bookingUrl: r.payload.bookingUrl,
    startDate: r.payload.startDate,
    endDate: r.payload.endDate,
    availableDates: r.payload.availableDates,
    detectedAt: r.created_at,
  }));

  return NextResponse.json({ jobs });
}
