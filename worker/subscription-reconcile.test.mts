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
  type SubFacts,
} from '../src/lib/subscription-reconcile.ts';

/** Stripe's answer for one subscription. The cancellation defaults to NOT SCHEDULED,
 *  which is what every pre-078 row holds, so the tests that predate it still describe
 *  the case they were written for. */
const sf = (
  status: string,
  tier: 'base' | 'autocart' = 'base',
  cancel: Partial<Pick<SubFacts, 'cancel_at_period_end' | 'cancel_at'>> = {}
): SubFacts => ({ status, tier, cancel_at_period_end: false, cancel_at: null, ...cancel });

const row = (
  id: string,
  status: string,
  tier: 'base' | 'autocart' = 'base',
  cancel: Partial<Pick<SubFacts, 'cancel_at_period_end' | 'cancel_at'>> = {}
): OurRow => ({ stripe_subscription_id: id, ...sf(status, tier, cancel) });

const facts = (m: Record<string, StripeFact>) => new Map(Object.entries(m));

test('a trial recorded as active is the change this exists for', () => {
  const p = planReconcile([row('sub_A', 'active', 'autocart')], facts({
    sub_A: sf('trialing', 'autocart'),
  }));
  assert.equal(p.changes.length, 1);
  assert.deepEqual(p.changes[0], {
    id: 'sub_A',
    from: sf('active', 'autocart'),
    to: sf('trialing', 'autocart'),
  });
});

test('a row Stripe agrees with is left alone', () => {
  const p = planReconcile([row('sub_A', 'active')], facts({
    sub_A: sf('active', 'base'),
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
    sub_A: sf('active', 'base'),
  }), ['sub_A', 'sub_STRANGER']);
  assert.deepEqual(p.unknownToUs, ['sub_STRANGER']);
  assert.equal(p.changes.length, 0, 'an unknown subscription must not become a change');
});

test('a store row with no Stripe id is none of this function\'s business', () => {
  // Migration 071: a Play or App Store purchase has no stripe_subscription_id. Stripe has
  // never heard of it, so it must not be reported as unaccounted — that would make every
  // reconcile look permanently dirty once store billing has any volume.
  const p = planReconcile([row('', 'active')], facts({}));
  assert.equal(p.unaccounted.length, 0);
  assert.equal(p.changes.length, 0);
});

test('every row lands in exactly one bucket', () => {
  // Totality. A row silently in none of them is a reconcile that reports success over
  // rows it quietly skipped.
  const ours = [row('a', 'active'), row('b', 'active'), row('c', 'active'), row('d', 'active')];
  const p = planReconcile(ours, facts({
    a: sf('trialing', 'base'),
    b: sf('active', 'base'),
    c: null,
  }));
  assert.equal(p.changes.length + p.unchanged + p.unaccounted.length, ours.length);
});

test('a tier change is picked up as well as a status change', () => {
  const p = planReconcile([row('sub_A', 'active', 'base')], facts({
    sub_A: sf('active', 'autocart'),
  }));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].to.tier, 'autocart');
});

// ── the cancellation schedule (migration 078) ────────────────────────────────────────
//
// THE WEBHOOK IS FORWARD-ONLY, WHICH IS WHY THESE LIVE HERE. Somebody who has already
// cancelled generates no further Stripe event, so the webhook leaves precisely the rows
// that motivated the column blank. This module is the only thing that can fill them.

test('a cancellation Stripe knows about and we do not IS a change', () => {
  // The whole point. Status and tier agree — the subscriber is active, entitled and
  // still paying — and the row is silent about the fact that it ends. Comparing only
  // status and tier would call this unchanged and the admin page would go on showing a
  // healthy subscriber until the day they vanish, which is the 2026-09-15 report.
  const p = planReconcile([row('sub_A', 'active', 'autocart')], facts({
    sub_A: sf('active', 'autocart', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    }),
  }));
  assert.equal(p.changes.length, 1, 'a pending cancellation must be picked up on its own');
  assert.equal(p.changes[0].to.cancel_at_period_end, true);
  assert.equal(p.changes[0].to.cancel_at, '2026-10-08T14:35:08.000Z');
});

test('THE FLAG ALONE IS COMPARED — with the date held identical', () => {
  // FOUND BY MUTATION. The test above varies the flag AND the date, so deleting the flag
  // comparison outright still produced a change: `sameInstant(null, <a date>)` is false
  // and absorbed it. A guard that varies two things at once measures neither.
  //
  // The state is real, not contrived. Stripe populates `cancel_at` for a subscription
  // scheduled to end on a specific date without `cancel_at_period_end`, so the same
  // instant can sit beside either value of the flag — and the flag is what the admin
  // badge reads.
  const when = '2026-10-08T14:35:08.000Z';
  const p = planReconcile(
    [row('sub_A', 'active', 'base', { cancel_at_period_end: false, cancel_at: when })],
    facts({ sub_A: sf('active', 'base', { cancel_at_period_end: true, cancel_at: when }) })
  );
  assert.equal(p.changes.length, 1, 'the flag differing on its own must be a change');
  assert.equal(p.changes[0].to.cancel_at_period_end, true);
});

test('THE SAME INSTANT SPELLED TWO WAYS IS NOT A CHANGE', () => {
  // Postgres hands back an offset form; Stripe's epoch seconds render as Zulu. A string
  // compare reports a change on EVERY run, rewrites every row every time, and turns the
  // reconcile into noise nobody reads — at which point the real difference it exists to
  // catch is the one that gets skimmed past.
  const p = planReconcile(
    [row('sub_A', 'active', 'base', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000+00:00',
    })],
    facts({
      sub_A: sf('active', 'base', {
        cancel_at_period_end: true,
        cancel_at: '2026-10-08T14:35:08.000Z',
      }),
    })
  );
  assert.equal(p.changes.length, 0, 'two spellings of one instant must compare equal');
  assert.equal(p.unchanged, 1);
});

test('a genuinely different end date IS a change', () => {
  // The other side of the rule above: comparing as instants must not make every date
  // equal to every other one.
  const p = planReconcile(
    [row('sub_A', 'active', 'base', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    })],
    facts({
      sub_A: sf('active', 'base', {
        cancel_at_period_end: true,
        cancel_at: '2026-11-08T14:35:08.000Z',
      }),
    })
  );
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].to.cancel_at, '2026-11-08T14:35:08.000Z');
});

test('a date arriving where we held none is a change, and vice versa', () => {
  const gained = planReconcile(
    [row('sub_A', 'active', 'base', { cancel_at_period_end: true, cancel_at: null })],
    facts({
      sub_A: sf('active', 'base', {
        cancel_at_period_end: true,
        cancel_at: '2026-10-08T14:35:08.000Z',
      }),
    })
  );
  assert.equal(gained.changes.length, 1, 'null -> a date is a change');

  const lost = planReconcile(
    [row('sub_A', 'active', 'base', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    })],
    facts({ sub_A: sf('active', 'base', { cancel_at_period_end: true, cancel_at: null }) })
  );
  assert.equal(lost.changes.length, 1, 'a date -> null is a change');
});

test('an UNREADABLE date is a difference, not agreement', () => {
  // This decides a report. The honest answer to "I cannot parse this" is to show it to a
  // human, never to declare the two sides equal and move on.
  const p = planReconcile(
    [row('sub_A', 'active', 'base', { cancel_at_period_end: true, cancel_at: 'not a date' })],
    facts({
      sub_A: sf('active', 'base', {
        cancel_at_period_end: true,
        cancel_at: '2026-10-08T14:35:08.000Z',
      }),
    })
  );
  assert.equal(p.changes.length, 1);
});

test('A CANCELLATION BEING UNDONE IS A CHANGE TOO', () => {
  // A resubscribe sends the flag back to false. A reconcile that only ever turned it ON
  // would badge a recovered customer as cancelling for ever, and a badge that lies in
  // the reassuring direction stops being read at all.
  const p = planReconcile(
    [row('sub_A', 'active', 'base', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    })],
    facts({ sub_A: sf('active', 'base') })
  );
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].to.cancel_at_period_end, false);
  assert.equal(p.changes[0].to.cancel_at, null);
});

test('an unaccounted row is still never written, cancellation included', () => {
  // Rule 2, restated for the new fields. A 404 or a timeout must not blank a real
  // pending cancellation any more than it may cancel a live subscription.
  const p = planReconcile(
    [row('sub_A', 'active', 'base', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    })],
    facts({ sub_A: null })
  );
  assert.equal(p.changes.length, 0);
  assert.deepEqual(p.unaccounted, ['sub_A']);
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
    [SUB]: sf('trialing', 'autocart'),
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

test('the write PERSISTS the cancellation schedule', async () => {
  // Real-DB, not a copy of the UPDATE. The failure this guards is one the planner cannot
  // see: a plan that correctly describes a pending cancellation, applied by a statement
  // whose SET clause never learned the columns. Everything would pass and the admin page
  // would stay blank — which is precisely the state the whole change exists to end.
  const plan = planReconcile([row(SUB, 'trialing', 'autocart')], facts({
    [SUB]: sf('trialing', 'autocart', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    }),
  }));
  assert.equal(await applyReconcile(plan), 1);

  const rows = await query<{ cancel_at_period_end: boolean; cancel_at: string }>(
    `SELECT cancel_at_period_end, cancel_at::text FROM subscriptions
      WHERE stripe_subscription_id = $1`,
    [SUB]
  );
  assert.equal(rows[0].cancel_at_period_end, true);
  assert.equal(
    Date.parse(rows[0].cancel_at),
    Date.parse('2026-10-08T14:35:08.000Z'),
    'the stored instant must be the one Stripe gave, whatever spelling Postgres returns'
  );
});

test('the write CLEARS a cancellation that was undone', async () => {
  // Runs after the test above, on the row it left cancelling. A SET clause that only
  // ever writes true leaves a resubscribed customer badged as leaving for ever.
  const plan = planReconcile(
    [row(SUB, 'trialing', 'autocart', {
      cancel_at_period_end: true,
      cancel_at: '2026-10-08T14:35:08.000Z',
    })],
    facts({ [SUB]: sf('trialing', 'autocart') })
  );
  assert.equal(await applyReconcile(plan), 1);

  const rows = await query<{ cancel_at_period_end: boolean; cancel_at: string | null }>(
    `SELECT cancel_at_period_end, cancel_at::text FROM subscriptions
      WHERE stripe_subscription_id = $1`,
    [SUB]
  );
  assert.equal(rows[0].cancel_at_period_end, false);
  assert.equal(rows[0].cancel_at, null);
});

test('an empty plan writes nothing', async () => {
  const applied = await applyReconcile({ changes: [], unchanged: 3, unaccounted: [], unknownToUs: [] });
  assert.equal(applied, 0);
});
