// Twilio request signing — the only thing protecting a public webhook.
//
// EXTRACTED FROM THE ROUTE so it can be tested. A Next route file pulls in
// `next/server` and the `@/` path alias, neither of which the tsx test runner resolves,
// so anything living inside route.ts is untestable in this repo — the same reason
// worker/claim.ts is not inside worker/poller.ts.
//
// Worth testing on its own: a signature check that always returns true and a signature
// check that works look identical from outside. The failure mode is silent and total.

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Twilio's scheme: HMAC-SHA1 over the callback URL followed by every POST parameter,
 * sorted by name, concatenated as name+value with no separators. Base64.
 *
 * `url` must be the URL TWILIO WAS GIVEN, not the URL this process sees. Behind a
 * proxy those differ, and signing the wrong one rejects 100% of legitimate callbacks
 * while looking, in code review, exactly like signing the right one.
 */
export function twilioSignature(url: string, params: URLSearchParams, authToken: string): string {
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) data += k + (params.get(k) ?? '');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * Constant-time comparison against the `X-Twilio-Signature` header.
 *
 * Fails CLOSED on a missing header or a missing auth token: without the token we
 * cannot verify anything, and "cannot verify" must never mean "accept". On this route
 * accepting an unverified POST would let anyone mark any message delivered.
 */
export function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  header: string | null,
  authToken: string | undefined
): boolean {
  if (!authToken || !header) return false;
  const a = Buffer.from(twilioSignature(url, params, authToken));
  const b = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch, so the length check is required, not
  // an optimisation. It leaks only the length of a base64 SHA-1, which is constant.
  return a.length === b.length && timingSafeEqual(a, b);
}
