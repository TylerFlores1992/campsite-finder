/**
 * The RevenueCat webhook's decisions.
 *
 * WHY THESE ARE WORTH TESTING: every one of them is silent when wrong. A tier that maps
 * to 'base' when it should be 'autocart', a sandbox event that grants a real
 * subscription, a cancelled subscriber revoked a fortnight early — none of them throws,
 * and all of them are a paying customer's problem before they are ours.
 *
 * The payload shape here is taken from a REAL event captured on 2026-08-28
 * (`docs/STOREKIT-PLAN.md` §4c), not from memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  tierForProductId, providerForStore, ignoreReason, statusForEvent,
  storeTransactionId, verifyAuthHeader, verifyHmac, type RcEvent,
} from '../src/lib/revenuecat';

const NOW = 1_800_000_000_000;
const SOON = NOW + 86_400_000;   // tomorrow
const PAST = NOW - 86_400_000;   // yesterday

const ev = (o: Partial<RcEvent> = {}): RcEvent =>
  ({ type: 'RENEWAL', environment: 'PRODUCTION', store: 'PLAY_STORE', ...o });

test('tier comes from the part before the first colon', () => {
  assert.equal(tierForProductId('camphawk_autocart:monthly'), 'autocart');
  assert.equal(tierForProductId('camphawk_autocart:yearly'), 'autocart');
  assert.equal(tierForProductId('camphawk_base:monthly'), 'base');
  assert.equal(tierForProductId('camphawk_base:yearly'), 'base');
});

test('an unknown product is base, never autocart', () => {
  // The safe direction: "paying but treated as base", never silent free premium.
  for (const id of ['something_else:monthly', 'camphawk_autocart_v2:monthly', '', null, undefined]) {
    assert.equal(tierForProductId(id as string), 'base', `${id} must not grant autocart`);
  }
});

test('store maps to provider, and an unknown store maps to nothing', () => {
  assert.equal(providerForStore('PLAY_STORE'), 'google');
  assert.equal(providerForStore('APP_STORE'), 'apple');
  assert.equal(providerForStore('AMAZON'), null);
  assert.equal(providerForStore(undefined), null);
});

test('a SANDBOX event is never acted on', () => {
  // The production webhook receives these — the integration is set to both environments
  // on purpose. Granting on one lets anyone with a test device mint a subscription.
  assert.ok(ignoreReason(ev({ environment: 'SANDBOX' })));
  assert.ok(ignoreReason(ev({ environment: undefined })));
  assert.equal(ignoreReason(ev({ environment: 'PRODUCTION' })), null);
});

test('a TEST event is never acted on', () => {
  assert.ok(ignoreReason(ev({ type: 'TEST', environment: 'PRODUCTION' })));
});

test('a live expiry grants, a past one expires', () => {
  assert.equal(statusForEvent(ev({ expiration_at_ms: SOON }), NOW), 'active');
  assert.equal(statusForEvent(ev({ expiration_at_ms: PAST }), NOW), 'expired');
});

test('period_type TRIAL is how the intro-free-week arrives', () => {
  // Both Apple and Stripe produce a trialing state; if this said 'active' the three
  // platforms would disagree about a subscriber the offer exists to create.
  assert.equal(statusForEvent(ev({ expiration_at_ms: SOON, period_type: 'TRIAL' }), NOW), 'trialing');
  assert.equal(statusForEvent(ev({ expiration_at_ms: SOON, period_type: 'NORMAL' }), NOW), 'active');
});

test('CANCELLATION does not revoke access before the period ends', () => {
  // The expensive one. A cancelled subscriber keeps what they paid for until expiry;
  // mapping the event NAME to a status would cut them off the moment they cancel.
  assert.equal(
    statusForEvent(ev({ type: 'CANCELLATION', expiration_at_ms: SOON }), NOW), 'active');
});

test('BILLING_ISSUE splits on the expiry, which is the grace/hold distinction', () => {
  // Play gives a 7-day GRACE PERIOD (still entitled) then a 32-day ACCOUNT HOLD (not).
  // Both arrive as BILLING_ISSUE; only the expiry tells them apart.
  assert.equal(statusForEvent(ev({ type: 'BILLING_ISSUE', expiration_at_ms: SOON }), NOW), 'active');
  assert.equal(statusForEvent(ev({ type: 'BILLING_ISSUE', expiration_at_ms: PAST }), NOW), 'expired');
});

test('a missing expiry never revokes', () => {
  // Unknown is not "not subscribed". Without an expiry we grant only on an event that
  // says a purchase happened, and otherwise leave the row alone.
  assert.equal(statusForEvent(ev({ type: 'INITIAL_PURCHASE', expiration_at_ms: null }), NOW), 'active');
  assert.equal(statusForEvent(ev({ type: 'CANCELLATION', expiration_at_ms: null }), NOW), null);
  assert.equal(statusForEvent(ev({ type: 'EXPIRATION', expiration_at_ms: null }), NOW), null);
});

test('the store id prefers the ORIGINAL transaction', () => {
  // transaction_id changes every renewal; keying on it would write a new row a month and
  // the unique index would stop preventing two accounts claiming one purchase.
  assert.equal(storeTransactionId(ev({ original_transaction_id: 'orig', transaction_id: 'new' })), 'orig');
  assert.equal(storeTransactionId(ev({ original_transaction_id: null, transaction_id: 'new' })), 'new');
  assert.equal(storeTransactionId(ev({})), null);
});

test('the Authorization check fails CLOSED', () => {
  assert.equal(verifyAuthHeader('sekrit', 'sekrit'), true);
  assert.equal(verifyAuthHeader('wrong!', 'sekrit'), false);
  assert.equal(verifyAuthHeader('sekrit-but-longer', 'sekrit'), false);
  assert.equal(verifyAuthHeader(null, 'sekrit'), false, 'no header must not pass');
  assert.equal(verifyAuthHeader('sekrit', undefined), false, 'no secret configured must not pass');
  assert.equal(verifyAuthHeader(null, undefined), false);
});

test('HMAC returns null when it cannot judge, never false', () => {
  // null and false are different facts: "we could not check" must not read as "forged".
  const body = '{"a":1}';
  const secret = 'shh';
  const good = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(verifyHmac(body, good, secret), true);
  assert.equal(verifyHmac(body, 'deadbeef', secret), false);
  assert.equal(verifyHmac(body, null, secret), null, 'no header = cannot judge');
  assert.equal(verifyHmac(body, good, undefined), null, 'no secret = cannot judge');
});

// ---- structural guards on the route, which the test runner cannot import ----

const ROUTE = readFileSync('src/app/api/webhooks/revenuecat/route.ts', 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
  .join('\n');

test('the route rejects a bad Authorization header with a non-2xx', () => {
  // Fail-closed has to be visible in the RESPONSE, not only in a log line.
  //
  // SLICED TO THE BLOCK, NOT A PROXIMITY WINDOW. A `{0,200}` span is what this repo has
  // been bitten by twice — one added comment pushes the match past the window and the
  // guard fails against correct code, which gets it "fixed" by widening until it proves
  // nothing. Take the braces instead.
  const at = ROUTE.indexOf('if (!verifyAuthHeader(');
  assert.ok(at > -1, 'the auth check moved or was renamed — this guard is measuring nothing');
  const block = ROUTE.slice(at, ROUTE.indexOf('\n  }', at));
  assert.match(block, /status: 401/,
    'a failed auth check must return 401 before anything is written');
});

test('the route never writes grandfathered', () => {
  // Migration 032 wrote it once; no webhook may strip it. Same rule the Stripe webhook
  // states in its own upsert.
  assert.ok(!/grandfathered/.test(ROUTE),
    'grandfathered must not appear in the webhook at all — reading it is fine, writing it is how a renewal strips included auto-cart');
});

test('the upsert conflicts on the pair migration 071 indexes', () => {
  assert.match(ROUTE, /ON CONFLICT \(provider, store_transaction_id\)/,
    'conflicting on anything else would write a new row per renewal');
});

test('the ignore checks run BEFORE anything is written', () => {
  const guard = ROUTE.indexOf('ignoreReason(');
  const write = ROUTE.indexOf('INSERT INTO subscriptions');
  assert.ok(guard > -1 && write > -1, 'anchors moved — this guard is measuring nothing');
  assert.ok(guard < write, 'a sandbox or test event must be dropped before the INSERT');
});
