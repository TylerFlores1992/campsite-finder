import { NextRequest, NextResponse } from 'next/server';
import { queryOne, mutate } from '@/lib/db/client';
import { verifyWebhookSignature } from '@/lib/campflare/client';
import { dispatchNotifications, buildPayloadFromWebhook } from '@/lib/notifications';
import type { CampflareWebhookPayload } from '@/lib/campflare/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  const authHeader = req.headers.get('authorization');
  if (!verifyWebhookSignature(authHeader)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: CampflareWebhookPayload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  console.log(`[campflare webhook] event=${event.event} alert=${event.data?.alert_id}`);

  if (event.event === 'v2-availability-alert-notification') {
    await handleAvailabilityNotification(event);
  }

  return NextResponse.json({ received: true });
}

async function handleAvailabilityNotification(event: CampflareWebhookPayload): Promise<void> {
  const watchId = event.data?.metadata?.watch_id;
  if (!watchId) {
    console.error('[campflare webhook] Missing watch_id in metadata');
    return;
  }

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

  if (watch.notification_sent_at) {
    const hoursSince = (Date.now() - new Date(watch.notification_sent_at).getTime()) / 3_600_000;
    if (hoursSince < 1) {
      console.log(`[campflare webhook] Already notified ${hoursSince.toFixed(1)}h ago — skipping`);
      return;
    }
  }

  const payload = await buildPayloadFromWebhook(event, watch);
  await dispatchNotifications(payload);

  await mutate('UPDATE watches SET notification_sent_at = NOW() WHERE id = $1', [watchId]);
}
