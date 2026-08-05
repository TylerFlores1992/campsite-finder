// Twilio delivery receipts — the answer to "did the text actually arrive?".
//
// Twilio POSTs here on every status transition of a message we sent
// (queued → sent → delivered, or → undelivered / failed). We record the outcome on
// the notifications row matched by MessageSid.
//
// WHY THIS EXISTS: `notifications.status = 'sent'` only ever meant Twilio's API
// returned 2xx. Carrier rejection, an unreachable handset and A2P filtering all
// happen after that, and every one of them left a row saying `sent` next to a phone
// that never buzzed. The user hit exactly this on 2026-08-05 — email and push arrived,
// the text did not — and there was no way to tell from our own data whether the
// message had been dropped or was merely slow.
//
// It is a PUBLIC route (`/api/webhooks/(.*)` is already in isPublicRoute), so the
// signature check is the only thing standing between an anonymous POST and a row that
// claims a message was delivered. Fails CLOSED: no signature, wrong signature, or no
// TWILIO_AUTH_TOKEN configured → 403, nothing written.

import { NextRequest, NextResponse } from 'next/server';
import { mutate } from '@/lib/db/client';
import { verifyTwilioSignature } from '@/lib/notifications/twilio-signature';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');

const PATH = '/api/webhooks/twilio';

/**
 * The URL Twilio signed — and the reason this is a LIST.
 *
 * Twilio computes the signature over the URL it was GIVEN, which is whatever the
 * sender put in `StatusCallback`. Two senders exist and they read
 * `NEXT_PUBLIC_APP_URL` from two different environments: the Fly worker (which has no
 * such var, so it falls back to camphawk.app) and Vercel (which has one, set to a value
 * neither the API nor the build output will show us). If those two strings ever differ
 * — an `www.`, a trailing slash, a preview domain — verifying against only one of them
 * rejects 100% of the other sender's receipts, forever, with nothing in the data but
 * texts stuck on `pending`.
 *
 * So accept a signature computed over EITHER the configured URL or the URL this request
 * actually arrived at (`x-forwarded-host` first: behind Vercel's proxy `req.url` can be
 * an internal hostname). This is not a weakening — every candidate is still verified
 * against `TWILIO_AUTH_TOKEN`, so a forged Host buys an attacker nothing without the
 * secret, and it is what Twilio's own helper libraries do (they validate against the
 * received request URL).
 */
function candidateUrls(req: NextRequest): string[] {
  const urls = [`${APP_URL}${PATH}`];
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host) urls.push(`${proto}://${host}${PATH}`);
  return [...new Set(urls)];
}

/** Twilio's terminal states. Anything else is a way-point we record but don't stamp. */
const TERMINAL = new Set(['delivered', 'undelivered', 'failed', 'canceled']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  const header = req.headers.get('x-twilio-signature');
  const verified = candidateUrls(req).some((url) =>
    verifyTwilioSignature(url, params, header, process.env.TWILIO_AUTH_TOKEN)
  );
  if (!verified) {
    console.warn('[twilio] rejected a status callback with a bad or missing signature');
    return NextResponse.json({ error: 'bad signature' }, { status: 403 });
  }

  const sid = params.get('MessageSid') ?? params.get('SmsSid');
  const status = params.get('MessageStatus') ?? params.get('SmsStatus');
  if (!sid || !status) {
    return NextResponse.json({ error: 'missing MessageSid or MessageStatus' }, { status: 400 });
  }

  const code = params.get('ErrorCode');
  const detail = params.get('ErrorMessage');
  const error = code ? `${code}${detail ? `: ${detail}` : ''}` : null;

  // Callbacks are not ordered — `sent` can land after `delivered` on a retry, and
  // Twilio redelivers on any non-2xx. Never let a way-point overwrite a terminal
  // status, or a delivered message can end its life recorded as 'sent'.
  const rows = await mutate<{ id: string }>(
    `UPDATE notifications
        SET delivery_status = $2,
            delivery_error  = COALESCE($3, delivery_error),
            delivered_at    = CASE WHEN $4 THEN NOW() ELSE delivered_at END
      WHERE provider_id = $1
        AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered','undelivered','failed','canceled'))
      RETURNING id`,
    [sid, status, error, TERMINAL.has(status)]
  );

  if (rows.length === 0) {
    // Four ordinary reasons: we already have the terminal answer (Twilio retries), the
    // SID belongs to the daily delivery canary (which sends without logging a row), the
    // message predates this feature, or the very first `queued` callback beat our own
    // INSERT — the row is written just after sendSms returns, so a callback in that
    // window matches nothing. The last one is self-healing: Twilio posts again for
    // `sent` and `delivered`. Logged because a PERMANENT stream of these would mean the
    // SID is not being saved at send time, which is the one way this feature dies quietly.
    console.log(`[twilio] ${status} for ${sid} — no open notification row to update`);
  }

  // 200 with an empty body: Twilio retries anything else, and it does not read this.
  return new NextResponse(null, { status: 200 });
}
