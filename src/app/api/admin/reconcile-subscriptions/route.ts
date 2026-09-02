import { NextRequest, NextResponse } from 'next/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { getStripe, stripeConfigured } from '@/lib/stripe-client';
import { tierForPriceId } from '@/lib/stripe-plans';
import { query } from '@/lib/db/client';
import {
  planReconcile,
  applyReconcile,
  type OurRow,
  type StripeFact,
  type Plan,
} from '@/lib/subscription-reconcile';

export const dynamic = 'force-dynamic';

/**
 * "Does our `subscriptions` table still match Stripe?" — and optionally, fix it.
 *
 * ADMIN ONLY, `currentUserIsAdmin` server-side, 404 rather than 403, like every other
 * /api/admin route. It writes the column that decides who is entitled to auto-cart.
 *
 * GET  previews  — reports what WOULD change and touches nothing.
 * POST applies   — writes exactly what the preview described.
 *
 * PREVIEW AND APPLY ARE THE SAME CODE PATH, deliberately: they build the identical plan
 * and differ only in whether `applyReconcile` runs. A preview that is computed
 * differently from the thing it previews is not a preview.
 *
 * ── WHY THIS RUNS HERE AND NOT IN A SCRIPT ─────────────────────────────────────────────
 * `api.stripe.com` is 403 at the agent proxy, so no session can reconcile from a laptop
 * or a Claude run. Vercel reaches Stripe fine. That is the whole reason this is a route.
 *
 * ── PER-ROW RETRIEVE, NOT A LIST ───────────────────────────────────────────────────────
 * It asks Stripe about each of OUR ids rather than diffing against `subscriptions.list`.
 * A list omits long-canceled subscriptions, so a row's absence from it says nothing —
 * and `retrieve` answers for a canceled subscription, which is exactly the row most worth
 * repairing. A handful of subscriptions makes N calls a non-issue, and it keeps rule 2 in
 * `lib/subscription-reconcile` structurally true: we only ever write a status Stripe
 * actually said out loud.
 *
 * The list IS still fetched, for the other direction only — a subscription Stripe has and
 * we hold no row for. That is reported and never created; see rule 3.
 */
async function buildPlan(): Promise<Plan> {
  const stripe = getStripe();

  const ours = await query<OurRow>(
    `SELECT stripe_subscription_id, status, tier
       FROM subscriptions
      WHERE stripe_subscription_id IS NOT NULL`
  );

  const facts = new Map<string, StripeFact>();
  for (const row of ours) {
    const id = row.stripe_subscription_id;
    try {
      const sub = await stripe.subscriptions.retrieve(id);
      facts.set(id, {
        status: sub.status,
        tier: tierForPriceId(sub.items?.data?.[0]?.price?.id),
      });
    } catch {
      // NULL means "Stripe could not account for this", NEVER "cancelled". The plan
      // reports it and writes nothing — see rule 2. A network blip lands here too, and
      // treating that as a cancellation would revoke a paying subscriber over a timeout.
      facts.set(id, null);
    }
  }

  // The other direction. Bounded rather than exhaustive on purpose: this is a report, and
  // an admin page that hangs paginating a large account is worse than one that says
  // "here are the first hundred".
  const stripeIds: string[] = [];
  for await (const sub of stripe.subscriptions.list({ limit: 100 })) {
    stripeIds.push(sub.id);
    if (stripeIds.length >= 100) break;
  }

  return planReconcile(ours, facts, stripeIds);
}

export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }
  return NextResponse.json({ applied: 0, preview: true, plan: await buildPlan() });
}

export async function POST(req: NextRequest) {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }
  // The body is ignored beyond this: POST means apply. A boolean in the body that could
  // arrive false would make the dangerous call and the safe one indistinguishable from
  // the outside, which is the opposite of what a method split is for.
  void req;
  const plan = await buildPlan();
  const applied = await applyReconcile(plan);
  return NextResponse.json({ applied, preview: false, plan });
}
