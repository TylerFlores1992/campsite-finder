/**
 * RECONCILING `subscriptions` AGAINST STRIPE.
 *
 * The webhook is the normal path; this repairs rows it wrote wrong before it was fixed —
 * every trial in the table reads `active`, because `checkout.session.completed` hardcoded
 * that status until 2026-09-02 and it is the only event that creates a row.
 *
 * THE DANGEROUS DIRECTION IS NOT "fails to fix a row". It is writing a status Stripe
 * never said — cancelling a paying subscriber over a network blip, or stripping the
 * auto-cart a grandfathered subscriber was promised. Most of what is pinned below is
 * about what this must REFUSE to do.
 *
 * The planning is pure and tested as such; the write is real-DB, because it is one
 * statement and a test asserting a copy of a statement asserts the copy.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client.ts';
import {
  planReconcile,
  applyReconcile,
  type OurRow,
  type StripeFact,
} from '../src/lib/subscription-reconcile.ts';

const row = (id: string, status: string, tier: 'base' | 'autocart' = 'base'): OurRow => ({
  stripe_subscription_id: id,
  status,
  tier,
});
const facts = (m: Record<string, StripeFact>) => new Map(Object.entries(m));

test('a trial recorded as active is the change this exists for', () => {
  const p = planReconcile([row('sub_A', 'active', 'autocart')], facts({
    sub_A: { status: 'trialing', tier: 'autocart' },
  }));
  assert.equal(p.changes.length, 1);
  assert.deepEqual(p.changes[0], {
    id: 'sub_A',
    from: { status: 'active', tier: 'autocart' },
    to: { status: 'trialing', tier: 'autocart' },
  });
});

test('a row Stripe agrees with is left alone', () => {
  const p = planReconcile([row('sub_A', 'active')], facts({
    sub_A: { status: 'active', tier: 'base' },
  }));
  assert.equal(p.changes.length, 0);
  assert.equal(p.unchanged, 1);
});

test('ABSENCE FROM STRIPE IS NOT CANCELLATION — it is reported, never written', () => {
  // The expensive mistake available here. A 404, a timeout and a genuine deletion all
  // arrive as `null`, and writing 'canceled' for any of them revokes a paying customer.
  const p = planReconcile([row('sub_A', 'active')], facts({ sub_A: null }));
  assert.equal(p.changes.length, 0, 'an unaccounted row must produce NO change');
  assert.deepEqual(p.unaccounted, ['sub_A']);
});

test('a row Stripe was never asked about is unaccounted, not unchanged', () => {
  // `undefined` (never in the map) and `null` (asked, no answer) must land in the same
  // place. Counting a never-asked row as unchanged would report a clean reconcile over
  // rows nobody checked.
  const p = planReconcile([row('sub_A', 'active')], facts({}));
  assert.deepEqual(p.unaccounted, ['sub_A']);
  assert.equal(p.unchanged, 0);
});

test('a subscription Stripe has and we do not is reported, never created', () => {
  const p = planReconcile([row('sub_A', 'active')], facts({
    sub_A: { status: 'active', tier: 'base' },
  }), ['sub_A', 'sub_STRANGER']);
  assert.deepEqual(p.unknownToUs, ['sub_STRANGER']);
  assert.equal(p.changes.length, 0, 'an unknown subscription must not become a change');
});

test('a store row with no Stripe id is none of this function\'s business', () => {
  // Migration 071: a Play or App Store purchase has no stripe_subscription_id. Stripe has
  // never heard of it, so it must not be reported as unaccounted — that would make every
  // reconcile look permanently dirty once store billing has any volume.
  const p = planReconcile([{ stripe_subscription_id: '', status: 'active', tier: 'base' }], facts({}));
  assert.equal(p.unaccounted.length, 0);
  assert.equal(p.changes.length, 0);
});

test('every row lands in exactly one bucket', () => {
  // Totality. A row silently in none of them is a reconcile that reports success over
  // rows it quietly skipped.
  const ours = [row('a', 'active'), row('b', 'active'), row('c', 'active'), row('d', 'active')];
  const p = planReconcile(ours, facts({
    a: { status: 'trialing', tier: 'base' },
    b: { status: 'active', tier: 'base' },
    c: null,
  }));
  assert.equal(p.changes.length + p.unchanged + p.unaccounted.length, ours.length);
});

test('a tier change is picked up as well as a status change', () => {
  const p = planReconcile([row('sub_A', 'active', 'base')], facts({
    sub_A: { status: 'active', tier: 'autocart' },
  }));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].to.tier, 'autocart');
});

// ── the write ────────────────────────────────────────────────────────────────────────
const SUB = '__tsr-sub-1';
const USER = '__tsr-user';

async function sweep() {
  await mutate(`DELETE FROM subscriptions WHERE stripe_subscription_id = $1`, [SUB]);
  await mutate(`DELETE FROM users WHERE id = $1`, [USER]);
}

before(async () => {
  await sweep();
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $2)`, [USER, `${USER}@example.invalid`]);
  await mutate(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id,
                                status, tier, grandfathered)
     VALUES ($1, '__tsr-cus', $2, 'active', 'base', true)`,
    [USER, SUB]
  );
});

after(sweep);

test('the write applies the plan', async () => {
  const plan = planReconcile([row(SUB, 'active', 'base')], facts({
    [SUB]: { status: 'trialing', tier: 'autocart' },
  }));
  const applied = await applyReconcile(plan);
  assert.equal(applied, 1);

  const rows = await query<{ status: string; tier: string }>(
    `SELECT status, tier FROM subscriptions WHERE stripe_subscription_id = $1`, [SUB]
  );
  assert.equal(rows[0].status, 'trialing');
  assert.equal(rows[0].tier, 'autocart');
});

test('the write NEVER touches grandfathered', async () => {
  // Migration 032 set it once and the webhook has never written it, so a price that maps
  // to 'base' cannot strip the auto-cart those subscribers were promised. This is one
  // more writer of the same column and it obeys the same rule.
  const rows = await query<{ grandfathered: boolean }>(
    `SELECT grandfathered FROM subscriptions WHERE stripe_subscription_id = $1`, [SUB]
  );
  assert.equal(rows[0].grandfathered, true);
});

test('an empty plan writes nothing', async () => {
  const applied = await applyReconcile({ changes: [], unchanged: 3, unaccounted: [], unknownToUs: [] });
  assert.equal(applied, 0);
});
