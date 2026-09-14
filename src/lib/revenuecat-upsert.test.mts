// The store-subscription upsert, exercised against the REAL table.
//
// REAL-DB ON PURPOSE, for the reason `claim.test.mts` is: the whole thing being tested is
// one `ON CONFLICT` inference, which lives inside a SQL string. A mock would agree with
// whatever we wrote, and what we wrote was wrong for a fortnight — `ON CONFLICT (provider,
// store_transaction_id)` against migration 071's PARTIAL unique index, which Postgres
// refuses to infer without the index's own `WHERE` predicate. It raised 42P10 at PLAN
// time, so the statement could not run at all, and the route returned an empty 500.
//
// IT RUNS THE EXPORTED STATEMENT, NEVER A COPY. A test carrying its own INSERT would have
// passed against the broken route all along — the defect was in the text of the query, so
// the query text is the thing that has to be under test.
//
// THE FIXTURE IS SCOPED PER RUN. A fixed sentinel deleted by exact id is mutually
// destructive between two runs of this same suite, which `#203` covers for `LIKE` prefix
// sweeps and explicitly does not cover here; two verify jobs overlap on every push (3-301s
// measured), so the id carries the pid and the clock. Leftovers are swept by prefix AND by
// age, so a cancelled run's litter is cleaned without a concurrent run's rows being touched.
//
// THE USER ID DELIBERATELY DOES NOT START `user_`. The dashboards count real accounts with
// `LIKE 'user\_%'`, so a fixture shaped like a Clerk id would show up as a signup.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, queryOne, mutate } from '@/lib/db/client';
import { UPSERT_STORE_SUBSCRIPTION } from '@/lib/revenuecat';

const PREFIX = '__camphawk-rcupsert-';
const RUN = `${PREFIX}${process.pid}-${Date.now()}__`;
const TXN = `${RUN}-txn`;

async function rows() {
  return query<{ status: string; tier: string; grandfathered: boolean }>(
    `SELECT status, tier, grandfathered FROM subscriptions WHERE user_id = $1`, [RUN]);
}

before(async () => {
  // Age-gated: never reach a CONCURRENT run's live rows. Deleting the user cascades.
  await mutate(
    `DELETE FROM users WHERE id LIKE $1 AND created_at < NOW() - interval '10 minutes'`,
    [`${PREFIX}%`]);
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $2)`,
    [RUN, `${RUN}@example.invalid`]);
});

after(async () => {
  await mutate(`DELETE FROM users WHERE id = $1`, [RUN]);
});

test('the upsert can be PLANNED at all — the partial index is inferred', async () => {
  // THE REGRESSION, AND IT IS A PLAN-TIME FAILURE. Drop the `WHERE` from the statement and
  // this throws 42P10 before a single row is considered — no conflict needed, no second
  // insert needed. That is why the bug survived every code review: the statement is not
  // subtly wrong on some rows, it is unrunnable on all of them.
  await mutate(UPSERT_STORE_SUBSCRIPTION, [RUN, 'apple', TXN, 'trialing', 'base']);
  const after1 = await rows();
  assert.equal(after1.length, 1, 'the first event must insert exactly one row');
  assert.equal(after1[0].status, 'trialing');
  assert.equal(after1[0].tier, 'base');
});

test('a second event for the same transaction UPDATES rather than duplicating', async () => {
  // The index exists to stop one purchase being claimed twice. If the inference ever
  // silently stopped matching, the ON CONFLICT would be dead and renewals would pile up a
  // row a month — which reads as a working webhook right up until somebody counts.
  await mutate(UPSERT_STORE_SUBSCRIPTION, [RUN, 'apple', TXN, 'active', 'autocart']);
  const after2 = await rows();
  assert.equal(after2.length, 1, 'a renewal must not create a second row');
  assert.equal(after2[0].status, 'active', 'the status must move on a renewal');
  assert.equal(after2[0].tier, 'autocart', 'a PRODUCT_CHANGE must move the tier');
});

test('the upsert never strips grandfathered', async () => {
  // Migration 032 wrote it once and no webhook may take it away. The Stripe path obeys
  // this and the store path has to as well: the column is the "keep your rate" promise.
  await mutate(`UPDATE subscriptions SET grandfathered = true WHERE user_id = $1`, [RUN]);
  await mutate(UPSERT_STORE_SUBSCRIPTION, [RUN, 'apple', TXN, 'active', 'base']);
  const g = await queryOne<{ grandfathered: boolean }>(
    `SELECT grandfathered FROM subscriptions WHERE user_id = $1`, [RUN]);
  assert.equal(g?.grandfathered, true, 'grandfathered must survive a later store event');
});

test('the statement names the partial index predicate', async () => {
  // Structural, because the behavioural tests above pass the moment ANY unique index
  // matches — and somebody "simplifying" migration 071's index to a plain one would make
  // them green while changing what the database enforces for Stripe rows.
  assert.match(UPSERT_STORE_SUBSCRIPTION, /ON CONFLICT \(provider, store_transaction_id\)\s+WHERE store_transaction_id IS NOT NULL/,
    'ON CONFLICT must carry the partial index predicate or Postgres cannot infer it');
});

test('the route uses the shared statement rather than its own INSERT', async () => {
  // FIX-PRESENT-AND-INERT, the shape this repo has paid for eight times: the constant can
  // be perfect and the route can keep the broken copy it had, and every test above still
  // passes. Pinned as a bare call so `void 0 &&` or a dead branch cannot satisfy it.
  const route = readFileSync('src/app/api/webhooks/revenuecat/route.ts', 'utf8');
  assert.match(route, /\n\s*await mutate\(UPSERT_STORE_SUBSCRIPTION,/,
    'the route must write through UPSERT_STORE_SUBSCRIPTION');
  assert.doesNotMatch(route, /INSERT INTO subscriptions/,
    'the route must not carry its own copy of the statement');
});

test('a failed write is a 500 that names itself, not a bare throw', async () => {
  // An unhandled throw returns `Content-Length: 0` and no body, which is indistinguishable
  // in RevenueCat's delivery log from a crash and from an auth refusal. It must stay a
  // non-2xx so the retries still run, and it must never return the DB message: `sqlit`
  // interpolates, so that string carries real values.
  const route = readFileSync('src/app/api/webhooks/revenuecat/route.ts', 'utf8');
  const from = route.indexOf('await mutate(UPSERT_STORE_SUBSCRIPTION');
  assert.ok(from > -1, 'the write must be present');
  const tail = route.slice(from, from + 1600);
  assert.match(tail, /catch \(e\)/, 'the write must be guarded');
  assert.match(tail, /status: 500/, 'a write failure must stay retryable');
  assert.match(tail, /console\.error\(/, 'a write failure must be logged');
  // THE ARGUMENT, NOT THE WHOLE BLOCK. A first version asserted `doesNotMatch` over `tail`
  // with a `\b` after `String(e)` — and a word boundary cannot match between `)` and a
  // space, so the guard never fired and the mutation that returns the DB message survived
  // the suite. Anchored on the response object itself now.
  const ret = tail.match(/return NextResponse\.json\(([^;]*)\{ status: 500 \}\);/);
  assert.ok(ret, 'the write failure must return a 500 through NextResponse.json');
  assert.doesNotMatch(ret[1], /\be\b|String\(|instanceof Error|detail/,
    'the DB message must be logged, never returned — sqlit interpolates real values into it');
});
