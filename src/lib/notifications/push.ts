// Native push delivery via Firebase Cloud Messaging (FCM HTTP v1). One integration
// covers both platforms — FCM relays to APNs for iOS. Set FCM_SERVICE_ACCOUNT to the
// full service-account JSON (as a single env string) to enable; unset = no-op (mirrors
// sms.ts, so local/dev and unconfigured environments log instead of throwing).
//
// v1 auth is an OAuth2 bearer token minted from the service account (self-signed JWT
// grant → oauth2.googleapis.com/token). We mint it with `jsonwebtoken` (already a dep)
// and cache it in-process until just before expiry, so a burst of alerts reuses one.
import jwt from 'jsonwebtoken';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface PushMessage {
  /** FCM registration tokens to deliver to. */
  tokens: string[];
  title: string;
  body: string;
  /** String-only key/value bag delivered to the app (deep-link target, ids, kind). */
  data?: Record<string, string>;
}

/** Tokens FCM reported as permanently dead — the caller prunes these from push_tokens. */
export interface PushResult {
  sent: number;
  deadTokens: string[];
}

/**
 * Is FCM usable IN THIS RUNTIME? Names no secret — just whether one is loadable here.
 *
 * WHY THIS IS NOT THE SAME QUESTION the `delivery:push` canary answers. That canary runs
 * in the WORKER, on Fly, and proves Fly's credentials mint an access token. But the most
 * important push this product sends — "we're holding your site, come and get it" — is
 * dispatched from a VERCEL route (`notifyHeld` in the hold feed), and nothing anywhere
 * checked Vercel's copy.
 *
 * On 2026-08-09 that gap cost the real one: the cart push failed with "FCM accepted 0 of 2
 * token(s)" at 15:00:03 while the worker's ordinary alert to the SAME two devices went out
 * fine eight seconds later. Two runtimes, one configured. A green canary in the wrong
 * process is not coverage.
 */
export function pushConfigStatus(): { ok: boolean; detail: string } {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return { ok: false, detail: 'FCM_SERVICE_ACCOUNT is not set in this runtime' };

  // SHAPE ONLY, NEVER CONTENT. Length and the first character are enough to tell the
  // three failure modes apart and give away nothing: a service account that arrived
  // double-encoded starts with a quote, a truncated paste is short, and a good one starts
  // with a brace. The value is a private key — it must not reach a log, a health endpoint
  // or an error message.
  const shape = `${raw.length} chars, starts ${JSON.stringify(raw[0] ?? '')}`;

  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    return {
      ok: false,
      detail:
        `FCM_SERVICE_ACCOUNT is set but is NOT VALID JSON (${shape}). ` +
        'Usual cause: the key was pasted with surrounding quotes, or newlines in ' +
        'private_key broke it. Paste the service-account file verbatim.',
    };
  }
  const missing = (['client_email', 'private_key', 'project_id'] as const).filter((k) => !sa[k]);
  if (missing.length) {
    return { ok: false, detail: `FCM_SERVICE_ACCOUNT parses but is missing: ${missing.join(', ')}` };
  }
  return { ok: true, detail: `FCM service account loads (project ${sa.project_id})` };
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    // Env-var stored private keys often carry literal "\n" — normalize to real newlines.
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch {
    console.error('[push] FCM_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Do the OAuth2 JWT-bearer exchange for a Firebase messaging access token. */
async function exchangeToken(sa: ServiceAccount): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(timeNow() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    },
    sa.private_key,
    { algorithm: 'RS256' }
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`FCM token exchange failed ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { token: json.access_token, expiresIn: json.expires_in };
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  // Reuse until 60s before expiry.
  if (cachedToken && cachedToken.expiresAt - 60_000 > timeNow()) {
    return cachedToken.value;
  }
  const { token, expiresIn } = await exchangeToken(sa);
  cachedToken = { value: token, expiresAt: timeNow() + expiresIn * 1000 };
  return token;
}

/** Whether FCM is configured at all (a valid service-account JSON is present). */
export function isPushConfigured(): boolean {
  return loadServiceAccount() !== null;
}

/** Canary check: prove the FCM credential is live by minting a fresh access token
 *  (bypasses the cache, so it actually exercises the OAuth exchange each call). This is
 *  push's "last mile" — the thing that breaks silently if FCM_SERVICE_ACCOUNT is
 *  removed, malformed, or the service-account key is revoked. Throws on any failure.
 *  Returns a short detail string on success. */
export async function verifyPushCredential(): Promise<string> {
  const sa = loadServiceAccount();
  if (!sa) throw new Error('FCM_SERVICE_ACCOUNT not configured');
  await exchangeToken(sa);
  return `FCM credential valid — access token minted for project ${sa.project_id}`;
}

// Isolated so the (rare) test/no-clock environments don't blow up on Date usage.
function timeNow(): number {
  return Date.now();
}

/** Deliver one notification to a set of device tokens. Returns dead tokens to prune.
 *  Throws only on a systemic failure (bad credentials / token exchange); a per-token
 *  delivery failure is captured, not thrown, so one dead device can't sink the batch. */
export async function sendPush(msg: PushMessage): Promise<PushResult> {
  const sa = loadServiceAccount();
  if (!sa) {
    console.log('[push] FCM not configured — would have sent:');
    console.log(`  Tokens: ${msg.tokens.length}  Title: ${msg.title}  Body: ${msg.body}`);
    return { sent: 0, deadTokens: [] };
  }
  if (msg.tokens.length === 0) return { sent: 0, deadTokens: [] };

  const accessToken = await getAccessToken(sa);
  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

  let sent = 0;
  const deadTokens: string[] = [];

  const results = await Promise.allSettled(
    msg.tokens.map(async (token) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: msg.title, body: msg.body },
            data: msg.data ?? {},
            // High priority so a cancellation wakes the device immediately.
            android: { priority: 'high' },
            apns: { headers: { 'apns-priority': '10' } },
          },
        }),
      });

      if (res.ok) {
        sent++;
        return;
      }

      // A dead/unregistered token: FCM v1 returns 404 NOT_FOUND or 400
      // UNREGISTERED/INVALID_ARGUMENT. Mark for pruning so we stop paying to hit it.
      const text = await res.text().catch(() => '');
      if (res.status === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text)) {
        deadTokens.push(token);
      } else {
        throw new Error(`FCM send ${res.status}: ${text}`);
      }
    })
  );

  for (const r of results) {
    if (r.status === 'rejected') console.error('[push] send failed:', r.reason);
  }

  return { sent, deadTokens };
}
