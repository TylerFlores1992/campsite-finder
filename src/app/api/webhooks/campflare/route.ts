import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db/client';
import { verifyWebhookSignature } from '@/lib/campflare/client';
import { dispatchNotifications, buildPayloadFromWebhook } from '@/lib/notifications';
import type { CampflareWebhookPayload } from '@/lib/campflare/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  // Verify the request came from Campflare
  const signature = req.headers.get('x-campflare-signature'); // ← confirm header name from docs
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: CampflareWebhookPayload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  console.log(`[campflare webhook] event=${event.event} sub=${event.subscription_id}`);

  if (event.event === 'availability.found') {
    await handleAvailabilityFound(event);
  } else if (event.event === 'subscription.expired') {
    await handleSubscriptionExpired(event);
  }

  // Always 200 so Campflare doesn't retry indefinitely
  return NextResponse.json({ received: true });
}

async function handleAvailabilityFound(event: CampflareWebhookPayload): Promise<void> {
  const watchId = event.metadata?.watch_id;
  if (!watchId) {
    console.error('[campflare webhook] Missing watch_id in metadata');
    return;
  }

  // Load the watch + campground name
  const watch = await queryOne<{
    id: string;
    user_id: string;
    campground_id: string;
    start_date: string;
    end_date: string;
    notification_sent_at: string | null;
  }>(
    `SELECT w.id, w.user_id, w.campground_id, w.start_date::text, w.end_date::text, w.notification_sent_at
     FROM watches w WHERE w.id = $1 AND w.active = true`,
    [watchId]
  );

  if (!watch) {
    console.log(`[campflare webhook] Watch ${watchId} not found or inactive — ignoring`);
    return;
  }

  // De-duplicate: don't spam the user if Campflare fires multiple times for same opening
  if (watch.notification_sent_at) {
    const lastSent = new Date(watch.notification_sent_at);
    const hoursSince = (Date.now() - lastSent.getTime()) / 1000 / 60 / 60;
    if (hoursSince < 1) {
      console.log(`[campflare webhook] Already notified ${hoursSince.toFixed(1)}h ago — skipping`);
      return;
    }
  }

  const campground = await queryOne<{ name: string }>(
    'SELECT name FROM campgrounds WHERE id = $1',
    [watch.campground_id]
  );

  const payload = await buildPayloadFromWebhook(
    event,
    watch,
    campground?.name ?? 'Campground'
  );

  await dispatchNotifications(payload);

  // Mark notification sent time
  await query(
    'UPDATE watches SET notification_sent_at = NOW() WHERE id = $1',
    [watchId]
  );
}

async function handleSubscriptionExpired(event: CampflareWebhookPayload): Promise<void> {
  const watchId = event.metadata?.watch_id;
  if (!watchId) return;

  // Deactivate the watch since Campflare subscription has expired
  await query(
    `UPDATE watches SET active = false, campflare_sub_id = NULL WHERE id = $1`,
    [watchId]
  );
  console.log(`[campflare webhook] Deactivated watch ${watchId} (subscription expired)`);
}
