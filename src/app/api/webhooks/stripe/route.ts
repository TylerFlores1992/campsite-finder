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
        // The session object carries no price — fetch the subscription to learn the
        // tier. Non-fatal: on a Stripe blip the row is still written as 'base', and
        // the first customer.subscription.updated event corrects it.
        const tier = await tierOfSubscription(session.subscription as string);
        await upsertSubscription({
          userId: session.metadata.clerk_user_id,
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
          status: 'active',
          tier,
        });
      }
      break;
    }
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

/** Tier implied by a subscription's current price. 'base' when it can't be read —
 *  see the caller for why that failure mode is the right one. */
async function tierOfSubscription(subscriptionId: string): Promise<PlanTier> {
  const stripe = getStripe();
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return tierForPriceId(sub.items?.data?.[0]?.price?.id);
  } catch (err) {
    console.error('[stripe webhook] tier lookup failed, defaulting to base:', (err as Error).message);
    return 'base';
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
