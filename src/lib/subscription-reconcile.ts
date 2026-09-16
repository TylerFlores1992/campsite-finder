import { mutate } from '@/lib/db/client';

/**
 * Reconciling `subscriptions` against Stripe — what to change, and the write.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * The webhook is the normal path and it is fine. What it cannot do is repair rows that
 * were written wrong BEFORE it was fixed: `checkout.session.completed` hardcoded
 * `status: 'active'` until 2026-09-02, so every trial in the table reads active and only
 * corrects itself if and when Stripe happens to send an `updated` event. That is a
 * dashboard that lies for days with nothing wrong anywhere.
 *
 * More generally it answers a question nobody could answer from a session: **does our
 * table still match Stripe?** Until now that was inferred by eye from two admin tiles
 * that read DIFFERENT SYSTEMS — our database for the status counts, Stripe live for MRR —
 * which is how "Active 5 · 2 paying" got read as three people being given free
 * subscriptions when it was two correct numbers and one wrong column.
 *
 * ── THE PLANNING IS PURE, AND THE STRIPE CALL IS NOT IN HERE ───────────────────────────
 * The caller fetches from Stripe and hands the facts in already derived. That keeps this
 * module free of `stripe-plans`, which carries `import 'server-only'` and therefore
 * resolves to a throwing stub under `node:test` — the same trap recorded for the Stripe
 * client. A decision that governs who is entitled to what should not be untestable
 * because of an import.
 *
 * ── THE THREE RULES THAT MATTER ────────────────────────────────────────────────────────
 * 1. IT NEVER WRITES `grandfathered`. Migration 032 set it once, the webhook has never
 *    written it, and a renewal whose price maps to 'base' must not strip the auto-cart
 *    those subscribers were promised. Same rule, same reason, one more writer.
 * 2. ABSENCE FROM STRIPE IS NOT CANCELLATION. `subscriptions.list` omits long-canceled
 *    subscriptions, so "not in the list" is not evidence of anything. Rows Stripe cannot
 *    account for are REPORTED, never written — cancelling somebody on an inference is the
 *    one mistake here that costs a paying customer their access.
 * 3. IT NEVER CREATES A ROW. A subscription Stripe knows about and we do not is reported
 *    too, because writing one needs a Clerk user id that may not be in its metadata, and
 *    inventing an entitlement is worse than reporting a gap.
 *
 * ── THE CANCELLATION SCHEDULE IS RECONCILED TOO, AND THAT IS WHY (2026-09-16) ──────────
 * `cancel_at_period_end` landed in migration 078 and the webhook writes it — FORWARD
 * ONLY. Somebody who has already cancelled generates no further event, so the webhook
 * leaves exactly the rows that motivated the column blank, and the admin page goes on
 * showing a healthy subscriber right up until the day they vanish. This is the same
 * shape as the 2026-09-02 trial-status fix needing this module behind it: repairing what
 * gets WRITTEN repairs nothing already written.
 *
 * A difference in the cancellation alone is a real change and counts as one. It is
 * tempting to compare only status and tier — those decide entitlement, and a pending
 * cancellation decides nothing about what anyone can do today — but the whole point is
 * that a row can be perfectly correct about entitlement and silent about the thing the
 * owner needed to know.
 */

export type Tier = 'base' | 'autocart';

/** The fields this module compares and writes. `cancel_at` is an ISO string on both
 *  sides, but it is compared as an INSTANT rather than as text — see `sameInstant`. */
export interface SubFacts {
  status: string;
  tier: Tier;
  cancel_at_period_end: boolean;
  /** ISO 8601, or null when Stripe reported no date. NULL is not "no cancellation" —
   *  read `cancel_at_period_end` for that. */
  cancel_at: string | null;
}

/** One of our rows, as stored. */
export interface OurRow extends SubFacts {
  stripe_subscription_id: string;
}

/** What Stripe says about one subscription. `null` means Stripe could not account for
 *  it — a 404, or an id it does not recognise. NEVER treated as cancelled. */
export type StripeFact = SubFacts | null;

export interface Change {
  id: string;
  from: SubFacts;
  to: SubFacts;
}

export interface Plan {
  changes: Change[];
  /** Rows Stripe agreed with. */
  unchanged: number;
  /** Our rows Stripe could not account for. Reported, never written. */
  unaccounted: string[];
  /** Subscription ids Stripe has that we hold no row for. Reported, never created. */
  unknownToUs: string[];
}

/**
 * What would change, given our rows and Stripe's answer for each.
 *
 * Pure and total: every one of our rows lands in exactly one of `changes`, `unchanged` or
 * `unaccounted`, so a row can never be silently dropped from the report.
 */
export function planReconcile(
  ours: OurRow[],
  facts: Map<string, StripeFact>,
  stripeIds: readonly string[] = []
): Plan {
  const changes: Change[] = [];
  const unaccounted: string[] = [];
  let unchanged = 0;

  for (const row of ours) {
    const id = row.stripe_subscription_id;
    // A row with no Stripe id at all is a store purchase (migration 071) and is none of
    // this function's business — Stripe has never heard of it and never will.
    if (!id) continue;

    const fact = facts.get(id);
    if (fact === undefined || fact === null) {
      unaccounted.push(id);
      continue;
    }
    if (sameFacts(row, fact)) {
      unchanged++;
      continue;
    }
    changes.push({ id, from: facts_(row), to: facts_(fact) });
  }

  const held = new Set(ours.map((r) => r.stripe_subscription_id).filter(Boolean));
  const unknownToUs = stripeIds.filter((id) => !held.has(id));

  return { changes, unchanged, unaccounted, unknownToUs };
}

/** The four fields, without whatever else the caller's row carries. */
function facts_(f: SubFacts): SubFacts {
  return {
    status: f.status,
    tier: f.tier,
    cancel_at_period_end: f.cancel_at_period_end,
    cancel_at: f.cancel_at,
  };
}

/**
 * Do our row and Stripe's answer agree?
 *
 * `cancel_at` is compared as an INSTANT, not as a string. Postgres hands back
 * `2026-10-08T14:35:08.318+00:00` where Stripe's epoch seconds render as
 * `2026-10-08T14:35:08.000Z` — the same moment, spelled two ways — so a string compare
 * would report a change on every single run, rewrite every row, and make the reconcile
 * permanently noisy. A noisy reconcile is one nobody reads, which is how the real
 * difference it is there to catch gets skimmed past.
 *
 * An UNPARSEABLE date on either side counts as a difference rather than throwing: this
 * decides a report, and the honest answer to "I cannot read this value" is to show it to
 * a human, not to declare agreement.
 */
function sameFacts(a: SubFacts, b: SubFacts): boolean {
  if (a.status !== b.status) return false;
  if (a.tier !== b.tier) return false;
  if (a.cancel_at_period_end !== b.cancel_at_period_end) return false;
  return sameInstant(a.cancel_at, b.cancel_at);
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta === tb;
}

/**
 * Apply a plan.
 *
 * One statement per changed row — there are a handful of subscriptions, so the clarity of
 * "this row, to this value" is worth more than a single clever statement, and a failure
 * halfway leaves every other row already correct rather than a batch half-applied in a
 * way nobody can describe.
 *
 * `status`, `tier` and the cancellation schedule ONLY. Not `grandfathered`, not
 * `user_id`, not the Stripe ids — see rule 1 in the header.
 */
export async function applyReconcile(plan: Plan): Promise<number> {
  let applied = 0;
  for (const c of plan.changes) {
    await mutate(
      `UPDATE subscriptions
          SET status = $2, tier = $3,
              cancel_at_period_end = $4, cancel_at = $5,
              updated_at = NOW()
        WHERE stripe_subscription_id = $1`,
      [c.id, c.to.status, c.to.tier, c.to.cancel_at_period_end, c.to.cancel_at]
    );
    applied++;
  }
  return applied;
}
