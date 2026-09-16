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

/** The `catch` inside `subscriptionFacts` — the only fallback on this path.
 *
 *  RE-ANCHORED 2026-09-16, NOT RELAXED. It used to pin the whole return literal
 *  `{ status: 'active', tier: 'base' }` up to its closing brace, so adding the
 *  cancellation fields broke it over behaviour that had not changed. The rule it protects
 *  is unchanged and is re-verified against the regression below. */
function factsCatch(): string {
  const fn = src.indexOf('async function subscriptionFacts');
  assert.ok(fn > -1, 'subscriptionFacts not found — re-anchor this test');
  const start = src.indexOf('catch', fn);
  assert.ok(start > fn, 'no catch in subscriptionFacts — the fallback has moved');
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, 'could not find the end of subscriptionFacts');
  return src.slice(start, end);
}

test('the fallback status is entitled, not a silent downgrade', () => {
  // 'active' and 'trialing' are both entitled, so this fallback cannot change what a
  // subscriber can DO. Pinned so nobody "hardens" it to something unentitled — that
  // would turn an unreadable Stripe response into a revoked subscription.
  assert.match(
    factsCatch(),
    /status:\s*'active'/,
    'The catch must fall back to an ENTITLED status. This is only reached from a ' +
      'completed subscription checkout, so the one certain fact is that they subscribed.'
  );
  assert.match(factsCatch(), /tier:\s*'base'/, 'and to the tier that fails LOUD, not free premium.');
});

// ── the cancellation schedule (migration 078) ────────────────────────────────────────
//
// The owner learned a subscriber had gone by opening Stripe. `cancel_at_period_end`
// appeared NOWHERE in the codebase, and a cancelling subscriber reads `active` with full
// entitlement right up to the day they leave — so every number we had was correct and
// between them they hid the only thing worth acting on.

test('ALL THREE WRITE PATHS carry the cancellation, not just the tidy one', () => {
  // There are three, and they are reached by different events. Wiring the obvious one
  // and missing a sibling is the recorded shape here: a subscriber whose events carry no
  // clerk_user_id takes the legacy UPDATE, and that is exactly the long-standing account
  // most likely to cancel.
  const branch = checkoutBranch();
  assert.match(branch, /cancelAtPeriodEnd:\s*facts\.cancelAtPeriodEnd/,
    'checkout.session.completed must pass the cancellation through.');

  const subBranch = src.slice(src.indexOf("case 'customer.subscription.created'"));
  assert.match(subBranch, /cancelAtPeriodEnd:\s*cancel\.cancelAtPeriodEnd/,
    'the subscription.* upsert must pass the cancellation through.');
  assert.match(subBranch, /cancel_at_period_end\s*=\s*\$4/,
    'the LEGACY no-metadata UPDATE must write the cancellation too — it is the path a ' +
      'subscriber who predates clerk_user_id metadata takes, i.e. the oldest accounts.');
});

test('the upsert writes the cancellation in BOTH directions', () => {
  // A resubscribe sends the flag back to false. An update set that only ever turns it ON
  // badges a recovered customer as leaving for ever, and a badge that is wrong in the
  // reassuring direction stops being read.
  const upsert = src.slice(src.indexOf('async function upsertSubscription'));
  assert.match(upsert, /DO UPDATE SET[\s\S]*cancel_at_period_end = EXCLUDED\.cancel_at_period_end/,
    'cancel_at_period_end must be in the conflict update set.');
  assert.match(upsert, /DO UPDATE SET[\s\S]*cancel_at = EXCLUDED\.cancel_at/,
    'cancel_at must be in the conflict update set.');
});

test('grandfathered is STILL not in the update set', () => {
  // The rule the upsert already obeyed, re-checked because a change to that statement is
  // exactly when it would get swept in. Migration 032 set it once; a price that maps to
  // 'base' must never strip the auto-cart those subscribers were promised.
  const upsert = src.slice(src.indexOf('async function upsertSubscription'));
  assert.doesNotMatch(upsert, /grandfathered\s*=/, 'the webhook must never write grandfathered.');
});

test('cancel_at is read as epoch SECONDS', () => {
  // Stripe sends seconds. `new Date(sub.cancel_at)` is 1970, which renders as a
  // cancellation that already happened — a date in the past reads as "they are gone"
  // rather than "they are leaving", which is the opposite of the fact.
  assert.match(
    src,
    /sub\.cancel_at\s*\?\s*new Date\(sub\.cancel_at\s*\*\s*1000\)/,
    'cancel_at must be multiplied by 1000 before becoming a Date.'
  );
});

test('the cancellation fallback is NOT SCHEDULED, never a guess', () => {
  // The opposite direction from the status fallback, and for the same reason: this runs
  // the instant somebody finishes checking out, nobody cancels in that window, and a
  // false "cancelling" badge on a brand-new subscriber sends somebody chasing a churn
  // that has not happened.
  assert.match(
    factsCatch(),
    /cancelAtPeriodEnd:\s*false/,
    'an unreadable Stripe response must not invent a cancellation.'
  );
  assert.match(factsCatch(), /cancelAt:\s*null/);
});

test('the flag is read, and the DATE is not what decides it', () => {
  // Stripe's types do not promise `cancel_at` is populated whenever the flag is set, and
  // it could not be checked from here — api.stripe.com is 403 at the agent proxy. So a
  // page keyed on the date alone would report a cancelling subscriber as healthy on
  // exactly the API version where that assumption does not hold.
  assert.match(
    src,
    /cancelAtPeriodEnd:\s*sub\.cancel_at_period_end === true/,
    "cancelAtPeriodEnd must come from Stripe's own boolean, not be derived from the date."
  );
});

test('current_period_end is NOT reached for', () => {
  // It is not on the Subscription object in stripe@22.3.0 — it moved onto items.data[] —
  // so it reads `undefined` and writes NULL for ever, which is indistinguishable from
  // nobody cancelling. Read out of the SDK's own types, not recalled.
  assert.doesNotMatch(
    src,
    /sub\.current_period_end/,
    'sub.current_period_end does not exist in this SDK version; use cancel_at.'
  );
});
