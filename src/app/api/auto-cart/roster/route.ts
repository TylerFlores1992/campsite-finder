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

  // Every enrolled user, each with their PENDING auto-cart jobs (a rec.gov site
  // opened and hasn't been resolved yet). The bot carts each and reports back to
  // /api/auto-cart/result; once resolved (carted / alerted / silent) the job drops
  // out of this feed. Users with no pending jobs still appear (empty jobs list) so
  // the bot knows who to set up logins for.
  const rows = await query<{
    user_id: string;
    email: string | null;
    job_id: string | null;
    payload: NotificationPayload | null;
    source: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, j.id AS job_id, j.payload, c.source
     FROM users u
     LEFT JOIN autocart_jobs j
       ON j.user_id = u.id AND j.resolution IS NULL
       AND j.detected_at > now() - interval '${windowMin} minutes'
     LEFT JOIN campgrounds c ON c.id = j.campground_id
     WHERE u.autocart_enabled = true
     ORDER BY j.detected_at DESC NULLS LAST
     LIMIT 200`
  );

  const byUser = new Map<string, { userId: string; email: string | null; jobs: unknown[] }>();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { userId: r.user_id, email: r.email, jobs: [] });
    if (r.job_id && r.payload) {
      byUser.get(r.user_id)!.jobs.push({
        id: r.job_id,
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
