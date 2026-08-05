// SMS delivery via Twilio. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER in the environment to enable.

/** Where Twilio should report the real outcome. Must be publicly reachable — Twilio
 *  calls it from its own network, so localhost is silently never called (the message
 *  still sends; you just never learn whether it landed). */
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
const STATUS_CALLBACK = `${APP_URL}/api/webhooks/twilio`;

interface SmsParams {
  to: string;
  body: string;
}

/**
 * What `sendSms` could tell you, and what it couldn't.
 *
 * `sid` is Twilio's Message SID. It used to be thrown away — the function read the
 * status code and discarded the body — which meant the one identifier that lets us
 * ask "did that text arrive?" was gone the instant it arrived. Every SMS in the
 * notifications table said `sent`, which only ever meant "Twilio accepted it", and a
 * message the carrier dropped was indistinguishable from one the user read.
 *
 * `status` is Twilio's status AT ACCEPTANCE — `queued` or `accepted`, essentially
 * never `delivered`. The real outcome arrives later at the StatusCallback; see
 * /api/webhooks/twilio. Do not read this field as delivery.
 *
 * `sid: null` means Twilio is not configured (dev) or there was no destination — the
 * message did not go out at all.
 */
export interface SmsResult {
  sid: string | null;
  status: string | null;
}

export async function sendSms(params: SmsParams): Promise<SmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || (!from && !messagingServiceSid)) {
    console.log('[sms] Twilio not configured — would have sent:');
    console.log(`  To: ${params.to}`);
    console.log(`  Body: ${params.body}`);
    return { sid: null, status: null };
  }

  if (!params.to) {
    console.log('[sms] No destination number — skipping');
    return { sid: null, status: null };
  }

  // Prefer the Messaging Service (carries the A2P campaign association);
  // fall back to the raw From number.
  const body = new URLSearchParams({
    To: params.to,
    Body: params.body,
    ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from! }),
    // Ask for the delivery receipt. Twilio POSTs here on every status transition; the
    // route verifies the signature with TWILIO_AUTH_TOKEN, so an unsigned POST from
    // anyone else cannot mark a message delivered.
    StatusCallback: STATUS_CALLBACK,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const error = await response.text().catch(() => '');
    throw new Error(`Twilio error ${response.status}: ${error}`);
  }

  // Best-effort: a message that SENT but whose body we failed to parse is still sent.
  // Throwing here would turn a successful text into a logged failure and, worse, into
  // a retry — the caller's catch writes 'failed' and the user gets a second copy.
  try {
    const json = (await response.json()) as { sid?: string; status?: string };
    return { sid: json.sid ?? null, status: json.status ?? null };
  } catch {
    return { sid: null, status: null };
  }
}
