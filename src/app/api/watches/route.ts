import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, mutate } from '@/lib/db/client';
import { requireAuth, syncUser, hasActiveSubscription } from '@/lib/auth';
import { createAlert, cancelAlert } from '@/lib/campflare/client';
import type { CampflareDateRange } from '@/lib/campflare/types';

function buildDateRanges(startDate: string, endDate: string, minNights: number): CampflareDateRange[] {
  const ranges: CampflareDateRange[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const cursor = new Date(start);
  while (cursor < end && ranges.length < 60) {
    ranges.push({ starting_date: cursor.toISOString().slice(0, 10), nights: minNights });
    cursor.setDate(cursor.getDate() + 1);
  }
  return ranges.length > 0 ? ranges : [{ starting_date: startDate, nights: minNights }];
}

export async function GET() {
  const userId = await requireAuth();

  const rows = await query<Record<string, unknown>>(
    `SELECT w.*, c.name AS campground_name
     FROM watches w
     JOIN campgrounds c ON c.id = w.campground_id
     WHERE w.user_id = $1 AND w.active = true
       AND w.end_date >= CURRENT_DATE
     ORDER BY w.created_at DESC`,
    [userId]
  );

  return NextResponse.json({ watches: rows });
}

export async function POST(request: NextRequest) {
  const userId = await requireAuth();

  // Ensure the users row exists BEFORE the subscription gate — beta flagging
  // and Stripe webhooks both need the row to be present.
  await syncUser(userId);

  // Require an active subscription (or beta flag) to create watches
  const subscribed = await hasActiveSubscription(userId);
  if (!subscribed) {
    return NextResponse.json(
      { error: 'subscription_required', message: 'An active subscription is required to set up campsite watches.' },
      { status: 402 }
    );
  }

  const body = await request.json();
  const { campgroundId, startDate, endDate, minNights = 1, siteType } = body;

  if (!campgroundId || !startDate || !endDate) {
    return NextResponse.json({ error: 'campgroundId, startDate, endDate required' }, { status: 400 });
  }

  const existing = await queryOne<{ id: string; campflare_sub_id: string | null }>(
    `SELECT id, campflare_sub_id FROM watches
     WHERE user_id = $1 AND campground_id = $2 AND start_date = $3 AND end_date = $4 AND active = true`,
    [userId, campgroundId, startDate, endDate]
  );

  if (existing) {
    if (existing.campflare_sub_id) {
      await cancelAlert(existing.campflare_sub_id).catch((err) =>
        console.warn('[watches] Failed to cancel old Campflare alert:', err.message)
      );
    }
    await mutate(`UPDATE watches SET active = false WHERE id = $1`, [existing.id]);
  }

  const [row] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, site_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [userId, campgroundId, startDate, endDate, minNights, siteType ?? null]
  );

  const webhookBase = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  // Campflare only monitors recreation.gov — non-RIDB campgrounds (e.g. ReserveCalifornia)
  // are covered exclusively by our own Fly.io poller.
  const cgSource = await queryOne<{ source: string }>(
    `SELECT source FROM campgrounds WHERE id = $1`,
    [campgroundId]
  );

  if (cgSource?.source === 'ridb' && webhookBase && process.env.CAMPFLARE_API_KEY) {
    try {
      const alert = await createAlert({
        campground_ids: [campgroundId],
        parameters: {
          date_ranges: buildDateRanges(startDate, endDate, minNights),
          campsite_kinds: siteType ? [siteType] : undefined,
        },
        webhook_override_url: `${webhookBase}/api/webhooks/campflare`,
        metadata: { watch_id: row.id, user_id: userId },
      });
      await mutate(`UPDATE watches SET campflare_sub_id = $1 WHERE id = $2`, [alert.id, row.id]);
    } catch (err) {
      console.error('[watches] Campflare alert creation failed (watch still saved):', (err as Error).message);
    }
  }

  return NextResponse.json({ id: row.id, ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireAuth();

  const watchId = request.nextUrl.searchParams.get('id');
  if (!watchId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const watch = await queryOne<{ campflare_sub_id: string | null }>(
    `SELECT campflare_sub_id FROM watches WHERE id = $1 AND user_id = $2 AND active = true`,
    [watchId, userId]
  );

  if (watch?.campflare_sub_id) {
    await cancelAlert(watch.campflare_sub_id).catch((err) =>
      console.warn('[watches] Failed to cancel Campflare alert on delete:', err.message)
    );
  }

  await mutate(
    `UPDATE watches SET active = false, campflare_sub_id = NULL WHERE id = $1 AND user_id = $2`,
    [watchId, userId]
  );

  return NextResponse.json({ ok: true });
}
