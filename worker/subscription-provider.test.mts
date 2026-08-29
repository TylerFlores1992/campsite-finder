/**
 * A STORE SUBSCRIPTION IS ENTITLED WITH NO CHANGE TO THE ENTITLEMENT QUERY (migration 071).
 *
 * `docs/STOREKIT-PLAN.md` §2's central find is that `hasAutocartEntitlement` reads only
 * `status`, `tier` and `grandfathered` — so the ONE definition with six enforcers (the toggle
 * API, the bot roster feed, `isAutocartLane`, the RC hold offer, the hold action) picks up
 * Play and App Store subscribers for free. **That is a property of a query somebody could
 * change in one line**, and the change that breaks it — adding `AND s.provider = 'stripe'`,
 * or restoring NOT NULL on the Stripe columns — looks like tidying.
 *
 * REAL DB, on purpose. The thing under test is a schema migration and a SQL predicate; a mock
 * would assert a copy of both and stay green while production rejected every store purchase.
 *
 * FIXTURES ARE PREFIXED `__tsp` AND SWEPT BOTH WAYS. `docs/LANES.md` records three suites
 * that delete each other's rows with an over-broad LIKE; this one owns exactly its own prefix.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { hasAutocartEntitlement, hasActiveSubscription } from '../src/lib/auth';
import { readFileSync } from 'node:fs';

const P = '__tsp';
const U_STORE = `${P}_google_user`;
const U_APPLE = `${P}_apple_user`;
const TXN = `${P}_txn_1`;

// SWEPT BY EXACT ID, NEVER `LIKE`. `_` is a single-character WILDCARD in LIKE, so the
// obvious `LIKE '__tsp%'` matches "any two characters, then tsp" — against `users`, whose
// FK cascades to watches and subscriptions. A sweep that can match a real Clerk id is not
// worth the convenience of a prefix, and the ids are known here anyway.
const FIXTURE_USERS = [U_STORE, U_APPLE];

async function sweep() {
  await mutate(`DELETE FROM subscriptions WHERE user_id = ANY($1)`, [FIXTURE_USERS]);
  await mutate(`DELETE FROM users WHERE id = ANY($1)`, [FIXTURE_USERS]);
}

before(async () => {
  await sweep();
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`,
    [U_STORE, `${P}-google@camphawk.invalid`, U_APPLE, `${P}-apple@camphawk.invalid`]);
});
after(sweep);

test('a Play subscription with NO Stripe ids is entitled', async () => {
  // The row migration 071 exists to make writable at all: both Stripe columns were NOT NULL.
  await mutate(
    `INSERT INTO subscriptions (user_id, provider, store_transaction_id, status, tier)
     VALUES ($1, 'google', $2, 'active', 'autocart')`,
    [U_STORE, TXN],
  );
  assert.equal(await hasAutocartEntitlement(U_STORE), true,
    'a Play Auto-Cart subscriber must be entitled — the six enforcers all read this one query');
  assert.equal(await hasActiveSubscription(U_STORE), true,
    'and must count as subscribed, or the paywall sells to a paying customer');
});

test('a trialing store subscription counts, matching the intro-free-week offer', async () => {
  // Play grants `intro-free-week` on all four base plans; RevenueCat reports the trial period,
  // and a trial that did not count as subscribed would paywall every new subscriber for a week.
  await mutate(`UPDATE subscriptions SET status = 'trialing' WHERE user_id = $1`, [U_STORE]);
  assert.equal(await hasActiveSubscription(U_STORE), true);
  assert.equal(await hasAutocartEntitlement(U_STORE), true);
  await mutate(`UPDATE subscriptions SET status = 'active' WHERE user_id = $1`, [U_STORE]);
});

test('one store transaction cannot be claimed by two accounts', async () => {
  // Without the partial unique index, a reinstall under a different account writes the same
  // purchase twice and BOTH are entitled.
  await assert.rejects(
    mutate(
      `INSERT INTO subscriptions (user_id, provider, store_transaction_id, status, tier)
       VALUES ($1, 'google', $2, 'active', 'base')`,
      [U_APPLE, TXN],
    ),
    'the second claim on one Play transaction must be refused',
  );
});

test('the same id under a DIFFERENT store is allowed', async () => {
  // Why the index is on the PAIR: the two stores mint these independently and nothing
  // promises they cannot collide. Keying on the id alone would refuse a legitimate purchase.
  await mutate(
    `INSERT INTO subscriptions (user_id, provider, store_transaction_id, status, tier)
     VALUES ($1, 'apple', $2, 'active', 'base')`,
    [U_APPLE, TXN],
  );
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM subscriptions WHERE store_transaction_id = $1`, [TXN]);
  assert.equal(rows[0].n, 2, 'one id, two stores, two rows');
});

test('Stripe rows are untouched by the partial index', async () => {
  // PARTIAL on `store_transaction_id IS NOT NULL`, so the three live Stripe rows — which never
  // populate it — cannot collide with each other through it.
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM subscriptions WHERE provider = 'stripe' AND NOT (user_id = ANY($1))`,
    [FIXTURE_USERS]);
  assert.ok(rows[0].n >= 1, 'the live Stripe rows are still here and still provider=stripe');
});

test('the entitlement query does not filter on provider', () => {
  // Structural, and scoped to the function body rather than the file: `provider` appears in
  // this repo in plenty of unrelated places, and a whole-file grep would pass vacuously or
  // fail on a comment. Anchored on the function this guard is about.
  const src = readFileSync('src/lib/auth.ts', 'utf8');
  const at = src.indexOf('export async function hasAutocartEntitlement');
  assert.ok(at > -1, 'hasAutocartEntitlement not found — this guard is anchored on a name that moved');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.ok(!/provider/.test(body),
    'hasAutocartEntitlement must stay provider-agnostic — filtering it to Stripe silently ' +
    'un-entitles every Play and App Store subscriber, with nothing red anywhere');
});
