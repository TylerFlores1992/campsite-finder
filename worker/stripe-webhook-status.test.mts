/**
 * A TRIAL WAS WRITTEN AS 'active', SO `trialing` COULD NEVER APPEAR.
 *
 * `checkout.session.completed` is the ONLY event that creates a `subscriptions` row, and
 * it hardcoded:
 *
 *     status: 'active',
 *
 * while the line above it fetched the subscription to read the price for the tier — and
 * threw `sub.status` away. So a checkout that started a trial was recorded as active on
 * its first day, and the admin page's Trialing count read 0 against a Stripe account
 * holding several. The two only agreed again once the trial converted and a
 * `customer.subscription.updated` event happened to write the truth.
 *
 * NOTHING WAS OVER-GRANTED, WHICH IS WHY IT SURVIVED. `hasActiveSubscription` accepts
 * `('active','trialing')` alike, so entitlement was correct throughout and only the
 * reporting was wrong — the class of defect that is invisible until somebody reads a
 * dashboard and disbelieves it.
 *
 * AND IT MADE TWO CORRECT NUMBERS LOOK LIKE A CONTRADICTION. The admin's MRR tile reads
 * Stripe live via `subscriptions.list({ status: 'active' })`, which EXCLUDES trialing, so
 * it showed "2 paying" beside our own table's "Active 5". That reads as three missed
 * cancellations — money being given away — and it was neither. Both numbers were right
 * about different things; the row status was the only lie.
 *
 * These are source assertions because the failure is a literal in a branch that only a
 * live Stripe webhook can reach. A behavioural test would need the event, the signature
 * and the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROUTE = 'src/app/api/webhooks/stripe/route.ts';

/** Comments stripped — every rule below is quoted in the note explaining it, including
 *  the hardcode itself, so a comment-blind scan would fail on its own explanation. */
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const src = code(readFileSync(ROUTE, 'utf8'));

/** The body of the `checkout.session.completed` case, which is where the bug lived. */
function checkoutBranch(): string {
  const start = src.indexOf("case 'checkout.session.completed'");
  assert.ok(start > -1, 'checkout.session.completed case not found — re-anchor this test');
  const end = src.indexOf("case 'customer.subscription", start);
  assert.ok(end > start, 'could not find the end of the checkout branch');
  return src.slice(start, end);
}

test('the checkout branch does not hardcode a subscription status', () => {
  const branch = checkoutBranch();
  assert.ok(
    !/status:\s*['"]/.test(branch),
    `The checkout branch assigns a STATUS LITERAL. That is the 2026-09-02 bug: a trial ` +
      `gets recorded as active and 'trialing' becomes unreachable, because this is the ` +
      `only event that creates a row. Take the status from the subscription Stripe ` +
      `actually returns.`
  );
});

test('the checkout branch writes the status it fetched', () => {
  const branch = checkoutBranch();
  assert.match(
    branch,
    /status:\s*facts\.status/,
    'The checkout branch must write the fetched subscription status, not a constant.'
  );
  assert.match(
    branch,
    /await\s+subscriptionFacts\(/,
    'The checkout branch must ask Stripe for the subscription before writing the row.'
  );
});

test('subscriptionFacts returns BOTH facts from ONE retrieve', () => {
  // The bug was two facts available from one call with only one of them kept, so the
  // guard is that the return carries both — not merely that the call happens.
  assert.match(
    src,
    /return\s*\{\s*status:\s*sub\.status,\s*tier:\s*tierForPriceId\(/,
    'subscriptionFacts must return the real status alongside the tier, from the same ' +
      'retrieve. Splitting them back apart is how the status got dropped the first time.'
  );
  const retrieves = src.match(/subscriptions\.retrieve\(/g) ?? [];
  assert.equal(
    retrieves.length,
    1,
    'Exactly one subscriptions.retrieve — a second call means the facts drifted apart again.'
  );
});

test('a subscription created outside checkout is still recorded', () => {
  assert.match(
    src,
    /case 'customer\.subscription\.created':/,
    "`customer.subscription.created` must be handled: it is the only event that fires " +
      'for a subscription made outside checkout, and without it such a row never exists.'
  );
});

test('the fallback status is entitled, not a silent downgrade', () => {
  // 'active' and 'trialing' are both entitled, so this fallback cannot change what a
  // subscriber can DO. Pinned so nobody "hardens" it to something unentitled — that
  // would turn an unreadable Stripe response into a revoked subscription.
  assert.match(
    src,
    /return\s*\{\s*status:\s*'active',\s*tier:\s*'base'\s*\}/,
    'The catch must fall back to an ENTITLED status. This is only reached from a ' +
      'completed subscription checkout, so the one certain fact is that they subscribed.'
  );
});
