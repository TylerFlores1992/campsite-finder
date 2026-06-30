import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { mutate } from '@/lib/db/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
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
        await upsertSubscription({
          userId: session.metadata.clerk_user_id,
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
          status: 'active',
        });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.clerk_user_id;
      if (userId) {
        await upsertSubscription({
          userId,
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          status: sub.status,
        });
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}

async function upsertSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
}: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
}) {
  await mutate(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_subscription_id)
     DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
    [userId, stripeCustomerId, stripeSubscriptionId, status]
  );
}
