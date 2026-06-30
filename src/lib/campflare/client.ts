// Campflare API v2 client — https://docs-v2.campflare.com

import jwt from 'jsonwebtoken';
import type { CampflareAlert, CreateAlertParams } from './types';

const BASE_URL = 'https://api.campflare.com/v2';

function getApiKey(): string {
  const key = process.env.CAMPFLARE_API_KEY;
  if (!key) throw new Error('CAMPFLARE_API_KEY is not set');
  return key;
}

async function campflareRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': getApiKey(),
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

/** Create an availability alert for one or more campgrounds. */
export async function createAlert(params: CreateAlertParams): Promise<CampflareAlert> {
  return campflareRequest<CampflareAlert>('POST', '/alert/create', params);
}

/** Cancel an alert (call when user removes a watch). */
export async function cancelAlert(alertId: string): Promise<CampflareAlert> {
  return campflareRequest<CampflareAlert>('POST', `/alert/${alertId}/cancel`);
}

/** Fetch a single alert by ID. */
export async function getAlert(alertId: string): Promise<CampflareAlert> {
  return campflareRequest<CampflareAlert>('GET', `/alert/${alertId}`);
}

/** Verify a webhook's `authorization` header — a JWT (HS256) signed with the dashboard webhook secret. */
export function verifyWebhookSignature(authHeader: string | null): boolean {
  const secret = process.env.CAMPFLARE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Campflare] CAMPFLARE_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }
  if (!authHeader) return false;

  const token = authHeader.replace(/^Bearer\s+/i, '');
  try {
    // The dashboard secret is base64url text; the actual HMAC key is its decoded bytes.
    jwt.verify(token, Buffer.from(secret, 'base64url'), { algorithms: ['HS256'] });
    return true;
  } catch (err) {
    console.warn('[Campflare] Webhook JWT verification failed:', (err as Error).message);
    return false;
  }
}
