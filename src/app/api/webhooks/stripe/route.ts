import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-client';
import { mutate } from '@/lib/db/client';
import { tierForPriceId, type PlanTier } from '@/lib/stripe-plans';

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig!, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error('[stripe webhook] Invalid signature:', (err as Error).message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.metadata?.clerk_user_id) {
        // The session object carries neither the price nor the status, so fetch the
        // subscription and take BOTH from it.
        //
        // STATUS WAS HARDCODED 'active' HERE UNTIL 2026-09-02, AND THE REAL VALUE WAS
        // BEING FETCHED AND THROWN AWAY. This call already existed — it read the price
        // for the tier and discarded `sub.status` — so a checkout that starts a TRIAL
        // was written as active on its first day. Since `checkout.session.completed` is
        // the only event that CREATES a row, `trialing` could essentially never appear:
        // the admin's Trialing count read 0 while Stripe held several, and the two only
        // agreed again once a trial converted and an `updated` event wrote the truth.
        // A trial is entitled either way (`hasActiveSubscription` accepts both), so
        // nothing was over- or under-granted — what was wrong was every report.
        const facts = await subscriptionFacts(session.subscription as string);
        await upsertSubscription({
          userId: session.metadata.clerk_user_id,
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
          status: facts.status,
          tier: facts.tier,
        });
      }
      break;
    }
    // `created` is handled because it is the only event that fires for a subscription
    // made outside checkout. The upsert is idempotent on stripe_subscription_id, so a
    // created/completed pair for the same subscription writes the same row twice rather
    // than racing.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tier = tierForPriceId(sub.items?.data?.[0]?.price?.id);
      const userId = sub.metadata?.clerk_user_id;
      if (userId) {
        await upsertSubscription({
          userId,
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          tier,
        });
      } else {
        // Subscriptions created before checkout stamped clerk_user_id into
        // subscription_data.metadata carry no user id on their events. The row
        // already exists (written at checkout.session.completed), so track status
        // and tier by subscription id — without this, a legacy subscriber's
        // cancellation or plan change never lands in our table.
        await mutate(
          `UPDATE subscriptions SET status = $2, tier = $3, updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [sub.id, sub.status, tier]
        );
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}

/** Status and tier as Stripe reports them right now.
 *
 *  ONE retrieve for both, deliberately: they were two facts from one call and only one
 *  of them was being kept.
 *
 *  The fallbacks differ because the failure modes do. Tier falls back to 'base' so an
 *  unreadable price surfaces as "paying premium, treated as base" — a complaint we can
 *  fix — rather than free premium, which never surfaces. Status falls back to 'active'
 *  because this is only ever reached from a COMPLETED subscription checkout, so the one
 *  thing we do know is that they subscribed; 'active' and 'trialing' are both entitled,
 *  so the fallback cannot change what anyone can do, only what the admin page reports. */
async function subscriptionFacts(
  subscriptionId: string
): Promise<{ status: string; tier: PlanTier }> {
  const stripe = getStripe();
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return { status: sub.status, tier: tierForPriceId(sub.items?.data?.[0]?.price?.id) };
  } catch (err) {
    console.error(
      '[stripe webhook] subscription lookup failed, defaulting to active/base:',
      (err as Error).message
    );
    return { status: 'active', tier: 'base' };
  }
}

async function upsertSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
  tier,
}: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  tier: PlanTier;
}) {
  // grandfathered is deliberately NOT in the update set — it is written once by
  // migration 032 and never by the webhook, so a renewal event on a pre-tier
  // subscription (whose price maps to 'base') can't strip the included auto-cart.
  await mutate(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, tier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_subscription_id)
     DO UPDATE SET status = EXCLUDED.status, tier = EXCLUDED.tier, updated_at = NOW()`,
    [userId, stripeCustomerId, stripeSubscriptionId, status, tier]
  );
}
