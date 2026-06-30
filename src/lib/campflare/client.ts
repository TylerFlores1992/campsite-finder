// Campflare API client.
// Docs: https://campflare.com/api
// IMPORTANT: Exact endpoint paths and auth header name need to be confirmed
// from the real API docs once credentials arrive. Update BASE_URL and auth
// header below — everything else should work as-is.

import type { CampflareSubscription, CreateSubscriptionParams } from './types';

const BASE_URL = 'https://api.campflare.com/v1'; // ← confirm from real docs

function getApiKey(): string {
  const key = process.env.CAMPFLARE_API_KEY;
  if (!key) throw new Error('CAMPFLARE_API_KEY is not set');
  return key;
}

async function campflareRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`, // ← confirm auth scheme from docs
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Campflare ${method} ${path} → ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

/** Create a campground availability subscription. Returns the subscription ID to store. */
export async function createSubscription(
  params: CreateSubscriptionParams
): Promise<CampflareSubscription> {
  return campflareRequest<CampflareSubscription>('POST', '/subscriptions', params);
}

/** Cancel a subscription (call when user removes a watch). */
export async function deleteSubscription(subscriptionId: string): Promise<void> {
  await campflareRequest<void>('DELETE', `/subscriptions/${subscriptionId}`);
}

/** List active subscriptions (useful for admin/debug). */
export async function listSubscriptions(): Promise<CampflareSubscription[]> {
  const data = await campflareRequest<{ subscriptions: CampflareSubscription[] }>(
    'GET',
    '/subscriptions'
  );
  return data.subscriptions;
}

/** Verify a webhook signature to ensure it came from Campflare.
 *  IMPORTANT: Confirm the exact signing scheme from the real docs.
 *  Many services use HMAC-SHA256 of the raw body with a shared secret.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secret = process.env.CAMPFLARE_WEBHOOK_SECRET;
  if (!secret) {
    // If no secret configured, skip verification (dev mode only)
    console.warn('[Campflare] CAMPFLARE_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }
  if (!signatureHeader) return false;

  // Standard HMAC-SHA256 verification — adapt if Campflare uses a different scheme
  const { createHmac } = require('crypto');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader.replace('sha256=', ''), 'hex');
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}
