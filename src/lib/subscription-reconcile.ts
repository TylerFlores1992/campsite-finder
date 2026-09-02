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
 */

export type Tier = 'base' | 'autocart';

/** One of our rows, as stored. */
export interface OurRow {
  stripe_subscription_id: string;
  status: string;
  tier: Tier;
}

/** What Stripe says about one subscription. `null` means Stripe could not account for
 *  it — a 404, or an id it does not recognise. NEVER treated as cancelled. */
export type StripeFact = { status: string; tier: Tier } | null;

export interface Change {
  id: string;
  from: { status: string; tier: Tier };
  to: { status: string; tier: Tier };
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
    if (fact.status === row.status && fact.tier === row.tier) {
      unchanged++;
      continue;
    }
    changes.push({
      id,
      from: { status: row.status, tier: row.tier },
      to: { status: fact.status, tier: fact.tier },
    });
  }

  const held = new Set(ours.map((r) => r.stripe_subscription_id).filter(Boolean));
  const unknownToUs = stripeIds.filter((id) => !held.has(id));

  return { changes, unchanged, unaccounted, unknownToUs };
}

/**
 * Apply a plan.
 *
 * One statement per changed row — there are a handful of subscriptions, so the clarity of
 * "this row, to this value" is worth more than a single clever statement, and a failure
 * halfway leaves every other row already correct rather than a batch half-applied in a
 * way nobody can describe.
 *
 * `status` and `tier` ONLY. Not `grandfathered`, not `user_id`, not the Stripe ids — see
 * rule 1 in the header.
 */
export async function applyReconcile(plan: Plan): Promise<number> {
  let applied = 0;
  for (const c of plan.changes) {
    await mutate(
      `UPDATE subscriptions
          SET status = $2, tier = $3, updated_at = NOW()
        WHERE stripe_subscription_id = $1`,
      [c.id, c.to.status, c.to.tier]
    );
    applied++;
  }
  return applied;
}
