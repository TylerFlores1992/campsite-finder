// The Twilio webhook's signature check.
//
// Run: npm test
//
// Pure — no network, no DB, no credentials. It is here because /api/webhooks/twilio is
// a PUBLIC route that writes delivery history, so this function is the entire access
// control on it, and a broken access check looks exactly like a working one from
// outside. The vector is real: an unsigned POST claiming `MessageStatus=delivered`
// would otherwise let anyone paper over an outage in our own data.
//
// The expected signature is computed against Twilio's published example (the one in
// their security docs), so this asserts the ALGORITHM, not merely that our encoder
// agrees with our decoder — a test that signs with the same function it verifies with
// would pass just as happily if we had invented our own scheme.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twilioSignature, verifyTwilioSignature } from './twilio-signature';

const TOKEN = '12345';
const URL_ = 'https://example.com/myapp.php?foo=1&bar=2';
const PARAMS = new URLSearchParams([
  ['Digits', '1234'],
  ['To', '+18005551212'],
  ['From', '+14158675310'],
  ['Caller', '+14158675310'],
  ['CallSid', 'CA1234567890ABCDE'],
]);
/** From Twilio's own worked example (docs/usage/security) for the above URL, params
 *  and token. The string hashed is
 *  `…myapp.php?foo=1&bar=2CallSidCA1234567890ABCDECaller+14158675310Digits1234From+14158675310To+18005551212`. */
const KNOWN_GOOD = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

test('matches Twilio’s published example signature', () => {
  assert.equal(twilioSignature(URL_, PARAMS, TOKEN), KNOWN_GOOD);
});

test('accepts a correctly signed request', () => {
  assert.equal(verifyTwilioSignature(URL_, PARAMS, KNOWN_GOOD, TOKEN), true);
});

test('rejects a tampered parameter', () => {
  // The attack: same signature, a body that now claims a different outcome.
  const tampered = new URLSearchParams(PARAMS);
  tampered.set('Digits', '9999');
  assert.equal(verifyTwilioSignature(URL_, tampered, KNOWN_GOOD, TOKEN), false);
});

test('rejects a request signed for a DIFFERENT url', () => {
  // Why the route signs the URL we gave Twilio rather than the one it received: behind
  // a proxy those differ, and this is what it costs to get wrong.
  const other = twilioSignature('https://camphawk.app/api/webhooks/twilio', PARAMS, TOKEN);
  assert.equal(verifyTwilioSignature(URL_, PARAMS, other, TOKEN), false);
});

test('rejects the wrong auth token', () => {
  assert.equal(verifyTwilioSignature(URL_, PARAMS, KNOWN_GOOD, 'not-the-token'), false);
});

test('fails CLOSED with no signature header and with no auth token', () => {
  // "Cannot verify" must never mean "accept". Both of these were once one `if` away
  // from being an open endpoint.
  assert.equal(verifyTwilioSignature(URL_, PARAMS, null, TOKEN), false);
  assert.equal(verifyTwilioSignature(URL_, PARAMS, KNOWN_GOOD, undefined), false);
  assert.equal(verifyTwilioSignature(URL_, PARAMS, '', TOKEN), false);
});

test('a wrong-length signature is rejected, not thrown', () => {
  // timingSafeEqual THROWS on mismatched lengths. Uncaught, that turns a junk POST
  // into a 500 and, on a route Twilio retries, into a retry storm.
  assert.doesNotThrow(() => verifyTwilioSignature(URL_, PARAMS, 'short', TOKEN));
  assert.equal(verifyTwilioSignature(URL_, PARAMS, 'short', TOKEN), false);
});

test('parameter order in the body does not change the signature', () => {
  // Twilio sorts by name; so must we. If we hashed in arrival order, verification
  // would work in testing and fail intermittently in production.
  const shuffled = new URLSearchParams([...PARAMS.entries()].reverse());
  assert.equal(twilioSignature(URL_, shuffled, TOKEN), KNOWN_GOOD);
});
