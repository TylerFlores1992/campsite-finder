import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { mutate } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Clerk webhook — keeps our DB in sync with account lifecycle events. Right now we
// only care about deletions: when a user deletes their Clerk account, remove their
// row so we don't retain their data. Every user-owned table (watches, favorites,
// notifications, subscriptions) is ON DELETE CASCADE, so one DELETE cleans it all.
//
// Setup: in Clerk (Production) → Webhooks, add an endpoint
//   https://camphawk.app/api/webhooks/clerk  subscribed to `user.deleted`, then
// put its signing secret in Vercel as CLERK_WEBHOOK_SECRET (starts `whsec_`).

// Clerk signs with Svix. Verify the signature manually (no extra dependency):
// signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64
// secret, compared against the v1 signatures in the svix-signature header.
function verifySvix(body: string, headers: Headers, secret: string): boolean {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !timestamp || !sigHeader) return false;

  // Reject stale deliveries (replay guard): timestamp must be within 5 minutes.
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  // Header holds one or more space-separated "v1,<sig>" entries.
  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503 });

  const body = await req.text();
  if (!verifySvix(body, req.headers, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: { type?: string; data?: { id?: string } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 });
  }

  if (event.type === 'user.deleted' && event.data?.id) {
    await mutate('DELETE FROM users WHERE id = $1', [event.data.id]);
    console.log(`[clerk webhook] deleted user ${event.data.id} and cascaded their data`);
  }

  return NextResponse.json({ received: true });
}
