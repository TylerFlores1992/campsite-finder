/**
 * THE §9a PRORATION DECISION, AND THE THING THAT CHARGES SOMEBODY TWICE.
 *
 * `docs/STOREKIT-PLAN.md` §9a: Play has no subscription groups, so upgrade-vs-downgrade is
 * stated by APP CODE. **No console screen can show that mistake** — which means there is no
 * instrument for it anywhere except this file.
 *
 * PURE, NOT REAL-DB, and deliberately so. Every neighbouring store test hits the database
 * because it is testing a SQL predicate. What is under test here is arithmetic over four
 * product ids; a database would add nothing and would make the suite one more thing that can
 * flake against a concurrent run (`docs/LANES.md`).
 *
 * The structural half is not decoration. `store-plans.ts` can be perfect while
 * `purchases.ts` assembles `storeProductChangeInfo` by hand and forgets it on one branch —
 * the fix-present-and-inert shape this repo has paid for six times. Those assertions read
 * the callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PLAY_SUBSCRIPTION_ID,
  decidePurchase,
  planForProductId,
  replacementModeFor,
  type BillingInterval,
  type PlanTier,
  type StoreReplacementMode,
} from '../src/lib/store-plans';

const PURCHASES = readFileSync('src/lib/native/purchases.ts', 'utf8');
const PAYWALL = readFileSync('src/components/v2/StorePaywall.tsx', 'utf8');
const PLANS_SRC = readFileSync('src/lib/store-plans.ts', 'utf8');

/** Comments are stripped before any structural assertion: these files EXPLAIN the traps
 *  they avoid, so a guard reading raw source matches its own explanation and passes
 *  vacuously. Twenty-plus instances of that in CLAUDE.md. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const id = (tier: PlanTier, interval: BillingInterval) =>
  `${PLAY_SUBSCRIPTION_ID[tier]}:${interval}`;
const ALL: Array<{ tier: PlanTier; interval: BillingInterval }> = [
  { tier: 'base', interval: 'monthly' },
  { tier: 'base', interval: 'yearly' },
  { tier: 'autocart', interval: 'monthly' },
  { tier: 'autocart', interval: 'yearly' },
];

// ── the decision itself ────────────────────────────────────────────────────────────────

test('every one of the twelve plan changes gets a mode, and it is the right one', () => {
  // EXHAUSTIVE, NOT SAMPLED. Twelve is small enough to enumerate, and the mistake this
  // guards is exactly the one that hides in the pair nobody thought to write down.
  const expected: Record<string, StoreReplacementMode> = {
    // tier UP: immediate, credited. Never a charge — see store-plans.ts.
    'base:monthly->autocart:monthly': 'WITH_TIME_PRORATION',
    'base:monthly->autocart:yearly': 'WITH_TIME_PRORATION',
    'base:yearly->autocart:monthly': 'WITH_TIME_PRORATION',
    'base:yearly->autocart:yearly': 'WITH_TIME_PRORATION',
    // tier DOWN: deferred. They have already paid for Auto-Cart through the period.
    'autocart:monthly->base:monthly': 'DEFERRED',
    'autocart:monthly->base:yearly': 'DEFERRED',
    'autocart:yearly->base:monthly': 'DEFERRED',
    'autocart:yearly->base:yearly': 'DEFERRED',
    // same tier, longer term: immediate, the unused time credited toward the year.
    'base:monthly->base:yearly': 'WITH_TIME_PRORATION',
    'autocart:monthly->autocart:yearly': 'WITH_TIME_PRORATION',
    // same tier, shorter term: deferred. We do not refund eleven months.
    'base:yearly->base:monthly': 'DEFERRED',
    'autocart:yearly->autocart:monthly': 'DEFERRED',
  };

  let checked = 0;
  for (const from of ALL) {
    for (const to of ALL) {
      if (from.tier === to.tier && from.interval === to.interval) continue;
      const key = `${from.tier}:${from.interval}->${to.tier}:${to.interval}`;
      assert.equal(replacementModeFor(from, to), expected[key], key);
      checked++;
    }
  }
  // A table that stopped being reached would pass every assertion above it.
  assert.equal(checked, 12, 'all twelve transitions must be exercised');
});

test('a downgrade is NEVER immediate — it is the charge-for-what-we-withdraw case', () => {
  // Stated separately from the table because it is the RULE, not a cell of it. A table can
  // be edited a line at a time; this fails on any downgrade that starts taking effect now.
  for (const from of ALL) {
    for (const to of ALL) {
      const tierDown = from.tier === 'autocart' && to.tier === 'base';
      const termDown = from.tier === to.tier && from.interval === 'yearly' && to.interval === 'monthly';
      if (tierDown || termDown) {
        assert.equal(replacementModeFor(from, to), 'DEFERRED', `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
      }
    }
  }
});

test('an unclassifiable current plan defers rather than guessing', () => {
  // Reached by a fifth product or a shape Play changes under us. Deferring neither charges
  // now nor removes access now; every alternative spends money on a guess.
  assert.equal(replacementModeFor(null, { tier: 'autocart', interval: 'yearly' }), 'DEFERRED');
  assert.equal(replacementModeFor(planForProductId('camphawk_legacy:monthly'), ALL[0]), 'DEFERRED');
});

test('no transition ever charges the full price of the new plan', () => {
  // CHARGE_FULL_PRICE bills the new plan in full AND grants a fresh cycle on top of the
  // remaining prorated time — the mode that most looks like a double charge to the person
  // reading their card statement.
  for (const from of [...ALL, null]) {
    for (const to of ALL) {
      assert.notEqual(replacementModeFor(from, to), 'CHARGE_FULL_PRICE');
    }
  }
});

// ── the double charge ──────────────────────────────────────────────────────────────────

test('an existing store subscription is NEVER a plain buy', () => {
  // THE ONE THAT COSTS MONEY. `purchasePackage` with no `storeProductChangeInfo` asks Play
  // for a second, independent subscription, and the user is billed for both.
  for (const from of ALL) {
    for (const to of ALL) {
      const d = decidePurchase(
        { provider: 'google', storeProductId: id(from.tier, from.interval) },
        to
      );
      assert.notEqual(d.action, 'buy', `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
      if (from.tier === to.tier && from.interval === to.interval) {
        assert.equal(d.action, 'refuse');
      } else {
        assert.equal(d.action, 'change');
      }
    }
  }
});

test('an unrecognised current product still replaces rather than duplicating', () => {
  // The parse failing must not degrade into a second subscription. It degrades into a
  // DEFERRED change, which is the safe half.
  const d = decidePurchase({ provider: 'google', storeProductId: 'something_else' }, ALL[3]);
  assert.equal(d.action, 'change');
  assert.equal(d.action === 'change' && d.replacementMode, 'DEFERRED');
});

test("the old product id is passed through verbatim, never rebuilt", () => {
  // What Play expects here (`camphawk_base` vs `camphawk_base:monthly`) was never verified
  // against a live account. Reconstructing it would be writing a store identifier from
  // memory — the mistake that answered an invented RC URL with a 404 twice.
  const odd = 'camphawk_base:monthly:something-we-did-not-expect';
  const d = decidePurchase({ provider: 'google', storeProductId: odd }, ALL[3]);
  assert.equal(d.action === 'change' && d.oldProductIdentifier, odd);
});

test('a Stripe subscriber is refused, because Play cannot replace a Stripe subscription', () => {
  // There is no `oldProductIdentifier` for a Stripe row, so a purchase that slipped past the
  // `!subscribed` gates would run two live subscriptions on two providers in parallel.
  for (const to of ALL) {
    const d = decidePurchase({ provider: 'stripe', storeProductId: null }, to);
    assert.equal(d.action, 'refuse');
    assert.match(d.action === 'refuse' ? d.message : '', /camphawk\.app/);
  }
});

test('nobody is a plain buy unless there is genuinely nothing to replace', () => {
  assert.equal(decidePurchase({ provider: null, storeProductId: null }, ALL[0]).action, 'buy');
});

// ── the vocabulary this file copies ────────────────────────────────────────────────────

test('the replacement-mode union matches the SDK enum member for member', async () => {
  // `store-plans.ts` restates STORE_REPLACEMENT_MODE as a string union so the SDK stays out
  // of the web bundle. That copy IS the wire format, so a value renamed upstream must fail
  // here rather than reach Play as a mode it ignores.
  const sdk = (await import('@revenuecat/purchases-typescript-internal-esm')) as unknown as {
    STORE_REPLACEMENT_MODE: Record<string, string>;
  };
  const values = Object.values(sdk.STORE_REPLACEMENT_MODE);
  assert.ok(values.length > 0, 'the SDK enum must be readable, or this test proves nothing');
  const ours: StoreReplacementMode[] = [
    'WITHOUT_PRORATION',
    'WITH_TIME_PRORATION',
    'CHARGE_FULL_PRICE',
    'CHARGE_PRORATED_PRICE',
    'DEFERRED',
  ];
  for (const m of ours) assert.ok(values.includes(m), `${m} is not a STORE_REPLACEMENT_MODE`);
  assert.equal(values.length, ours.length, 'the SDK gained or lost a mode — re-read §9a');
});

test('the Play tier vocabulary matches the Stripe one', () => {
  // `store-plans.ts` re-declares PlanTier because `stripe-plans.ts` is server-only. A drift
  // would put a paying subscriber on the wrong tier with nothing failing.
  const stripe = readFileSync('src/lib/stripe-plans.ts', 'utf8');
  assert.match(stripe, /export type PlanTier = 'base' \| 'autocart'/);
  assert.match(stripe, /export type BillingInterval = 'monthly' \| 'yearly'/);
  assert.match(PLANS_SRC, /export type PlanTier = 'base' \| 'autocart'/);
  assert.match(PLANS_SRC, /export type BillingInterval = 'monthly' \| 'yearly'/);
});

test('product ids parse, and an unknown one is null rather than a guess', () => {
  assert.deepEqual(planForProductId('camphawk_base:monthly'), { tier: 'base', interval: 'monthly' });
  assert.deepEqual(planForProductId('camphawk_autocart:yearly'), { tier: 'autocart', interval: 'yearly' });
  // A bare subscription id has no base plan, so the interval is unknown — and an interval
  // guessed as monthly on a yearly plan is §9b's twelve-times-the-price trap from our side.
  assert.equal(planForProductId('camphawk_base'), null);
  assert.equal(planForProductId('camphawk_other:monthly'), null);
  assert.equal(planForProductId('camphawk_base:weekly'), null);
  assert.equal(planForProductId(null), null);
});

// ── the callers: a correct decision reached by nobody is worth nothing ─────────────────

test('purchases.ts passes the decision through instead of assembling its own', () => {
  const src = code(PURCHASES);
  assert.match(src, /decidePurchase\(/, 'the decision must be taken');
  assert.match(
    src,
    /oldProductIdentifier:\s*decision\.oldProductIdentifier/,
    'the old id must come from the decision, not be rebuilt at the call site'
  );
  assert.match(
    src,
    /replacementMode:\s*decision\.replacementMode/,
    'the mode must come from the decision'
  );
  // A refusal that is not honoured is a refusal that does not exist.
  assert.match(src, /decision\.action === 'refuse'/);
});

test('the capability test is the native plugin, not isPluginAvailable and not the platform', () => {
  const src = code(PURCHASES);
  // `isPluginAvailable('Purchases')` is TRUE in a desktop browser: the plugin registers a
  // web implementation whose every method throws. Using it would be presence-not-liveness
  // one more time.
  assert.doesNotMatch(src, /isPluginAvailable/);
  assert.match(src, /PluginHeaders/, 'the native plugin list is what distinguishes a binary that can buy');
  // And the UA marker must not be the gate — every install before the plugin shipped has
  // the identical User-Agent.
  assert.doesNotMatch(src, /useIsNativeApp|isNativeApp/);
});

test('an anonymous RevenueCat id can never be configured with', () => {
  // The webhook refuses any `app_user_id` it cannot resolve to a users row, so a purchase
  // made under `$RCAnonymousID:…` is money taken for no entitlement.
  const src = code(PURCHASES);
  assert.match(src, /appUserID:\s*userId/, 'configure must bind the Clerk id');
  assert.match(
    src,
    /if \(!isSignedIn \|\| !userId\)[\s\S]{0,120}status: 'unavailable'/,
    'signed out must be unavailable, never a purchase under an anonymous id'
  );
});

test('the paywall is off until the four Play prices have been read back', () => {
  // §9b: the amounts were never read from the console, and a base plan named `yearly` that
  // bills MONTHLY charges twelve times the intended price with nothing objecting. This
  // screen prints the store's price string and cannot see the PERIOD.
  assert.match(code(PAYWALL), /export const STORE_PURCHASE_ENABLED = false/);
});

test('the paywall never sells on a failed status lookup', () => {
  const src = code(PAYWALL);
  assert.match(
    src,
    /if \(unknown\) return <>\{fallback\}<\/>;/,
    'unknown must render the fallback, never a Buy button'
  );
  // NOT AN ORDERING ASSERTION, AND THE FIRST DRAFT WAS ONE. It asserted the guard appears
  // before `store.plans.map`, and the mutation that moved it to the last line before the
  // render PASSED — because this component renders buy buttons from a single return, so
  // EVERY position before it is correct and the assertion could not fail for any real
  // defect. A guard anchored on the wrong thing, which CLAUDE.md records twenty-five times.
  //
  // What can actually go wrong is the sense of the test and the source of the flag, so
  // those are what is pinned. `!unknown` reads as caution and sells to exactly the people
  // it must refuse; a locally-invented `unknown` is the flag present and permanently false.
  assert.doesNotMatch(src, /if \(!unknown\)/, 'inverted: this would sell ONLY on a failed lookup');
  assert.match(
    src,
    /const \{ unknown \} = useSubscription\(\);/,
    'the flag must come from useSubscription, which is the only thing that reports it'
  );
});

test('a cancelled purchase is not reported as an error', () => {
  // Somebody who taps the system back button has not hit a problem. Telling them they have
  // is how a working paywall reads as broken — and is how they try again and buy twice.
  const src = code(PAYWALL);
  assert.match(src, /outcome\.result === "cancelled"[\s\S]{0,80}kind: "idle"/);
  assert.match(code(PURCHASES), /userCancelled[\s\S]{0,80}result: 'cancelled'/);
});

test('running out of polls is never reported as a failed purchase', () => {
  // The money is already taken and the entitlement already granted when the poll starts;
  // only OUR row is behind. Reporting that as a failure is how a completed purchase is
  // made a second time.
  const src = code(PAYWALL);
  assert.match(src, /kind: "slow"/);
  assert.doesNotMatch(
    src,
    /waitForEntitlement\(\)\)\s*\?\s*\{ kind: "done" \}\s*:\s*\{ kind: "error"/,
    'a slow webhook must not become an error'
  );
});
