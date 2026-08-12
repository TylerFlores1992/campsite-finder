/**
 * ONE place that reads Twilio's credentials out of the environment — and TRIMS them.
 *
 * ## Why this exists
 *
 * On 2026-08-12 `scripts/sms-link-test.mts` failed all four sends with Twilio's
 * `Authentication Error - invalid username`, which reads exactly like a wrong or revoked
 * Account SID. The credentials were correct. `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
 * had each arrived with a **leading space** — 35 and 33 characters against the 34 and 32
 * they should be — because that is what pasting a value into an environment does. Nothing
 * in the codebase trimmed, so the space went straight into the basic-auth header.
 *
 * The wasted run is the cheap half. The expensive half is that the SAME untrimmed read
 * guards `/api/webhooks/twilio`, which verifies the delivery receipt's signature against
 * `TWILIO_AUTH_TOKEN` and **fails CLOSED**. A padded token there rejects 100% of carrier
 * callbacks with a 403 — so every message would sit `sent` with no `delivery_status`
 * forever, which is precisely the blindness migration 038 was built to end. It would also
 * read on the admin panel as "all pending, no answers", i.e. a broken callback URL, and
 * send whoever investigated it looking at the wrong thing entirely.
 *
 * That is the same family as `notifications.status = 'sent'` meaning only "Twilio returned
 * 2xx": an invisible difference between a healthy path and a dead one. A credential that
 * differs from the real one by one space it is impossible to see is worth exactly one
 * `.trim()`, in one place, rather than six correct call sites and a seventh added later.
 *
 * ## Whitespace-only reads as ABSENT, not as configured
 *
 * `'   '` is truthy, so today it passes every `!accountSid` guard and then fails
 * authentication at the API — "configured but broken", the worst of the three states.
 * Trimming to `undefined` makes it "not configured", which every caller already handles
 * honestly (`sendSms` logs what it would have sent; the webhook 403s deliberately).
 *
 * Deliberately NOT `import 'server-only'`: `scripts/sms-link-test.mts` and the worker tests
 * both import this outside a server bundle, where that resolves to a throwing stub. Same
 * call as `lib/stripe-client`.
 */

/** Trimmed, or `undefined` if unset or all whitespace. */
function read(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const twilioAccountSid = (): string | undefined => read('TWILIO_ACCOUNT_SID');
export const twilioAuthToken = (): string | undefined => read('TWILIO_AUTH_TOKEN');
export const twilioFromNumber = (): string | undefined => read('TWILIO_FROM_NUMBER');
export const twilioMessagingServiceSid = (): string | undefined =>
  read('TWILIO_MESSAGING_SERVICE_SID');
