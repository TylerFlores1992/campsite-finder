import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';
import { autocartPlanConfigured, isPlanTier, priceIdFor, tierForPriceId } from '@/lib/stripe-plans';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());

/**
 * Change an EXISTING subscription's plan in place (base <-> autocart), keeping the
 * billing interval. This is deliberately not a second checkout: a checkout would
 * mint a second live subscription next to the first, which is how one customer ends
 * up billed twice. Stripe prorates the switch on the current invoice cycle.
 *
 * New subscribers never hit this — the UI sends them to /api/stripe/checkout with
 * a plan. This route requires a live subscription and 409s without one.
 */
export async function POST(req: NextRequest) {
  const userId = await requireAuth();

  const body = (await req.json().catch(() => ({}))) as { plan?: unknown };
  if (!isPlanTier(body.plan)) {
    return NextResponse.json({ error: 'plan must be base or autocart' }, { status: 400 });
  }
  const plan = body.plan;
  if (plan === 'autocart' && !autocartPlanConfigured()) {
    return NextResponse.json(
      { error: 'not_configured', message: 'The Auto-Cart plan is not available yet.' },
      { status: 503 }
    );
  }

  const row = await queryOne<{ stripe_subscription_id: string }>(
    `SELECT stripe_subscription_id FROM subscriptions
      WHERE user_id = $1 AND status IN ('active', 'trialing')
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!row) {
    return NextResponse.json(
      { error: 'no_subscription', message: 'No active subscription to change — subscribe first.' },
      { status: 409 }
    );
  }

  const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const item = sub.items?.data?.[0];
  if (!item?.price) {
    return NextResponse.json({ error: 'subscription has no price item' }, { status: 500 });
  }
  if (tierForPriceId(item.price.id) === plan) {
    return NextResponse.json({ ok: true, plan, changed: false });
  }

  const interval = item.price.recurring?.interval === 'year' ? 'yearly' : 'monthly';
  const targetPrice = priceIdFor(plan, interval);
  if (!targetPrice) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: targetPrice }],
    proration_behavior: 'create_prorations',
    // Stamp the user id for future webhook events while we're here — pre-tier
    // subscriptions were created without it (see checkout route).
    metadata: { clerk_user_id: userId },
  });

  // Reflect the tier locally right away rather than waiting on the webhook — the
  // settings screen re-reads entitlement on the next paint. The webhook's
  // customer.subscription.updated event writes the same value again; both are
  // idempotent. NOTE: grandfathered is untouched, so a grandfathered subscriber
  // who ever "upgrades" (paying for what they had free) and later downgrades ends
  // where they started, having lost nothing.
  await mutate(
    `UPDATE subscriptions SET tier = $2, updated_at = NOW() WHERE stripe_subscription_id = $1`,
    [sub.id, plan]
  );

  return NextResponse.json({ ok: true, plan, changed: true });
}
