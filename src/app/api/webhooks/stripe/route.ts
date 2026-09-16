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
          cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
          cancelAt: facts.cancelAt,
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
      const cancel = cancelFacts(sub);
      if (userId) {
        await upsertSubscription({
          userId,
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          tier,
          cancelAtPeriodEnd: cancel.cancelAtPeriodEnd,
          cancelAt: cancel.cancelAt,
        });
      } else {
        // Subscriptions created before checkout stamped clerk_user_id into
        // subscription_data.metadata carry no user id on their events. The row
        // already exists (written at checkout.session.completed), so track it by
        // subscription id — without this, a legacy subscriber's cancellation or plan
        // change never lands in our table. That is not a hypothetical: the accounts
        // that predate the metadata are the OLDEST ones, i.e. the likeliest to cancel,
        // so this branch is the one a churn is most likely to arrive on.
        await mutate(
          `UPDATE subscriptions
              SET status = $2, tier = $3,
                  cancel_at_period_end = $4, cancel_at = $5,
                  updated_at = NOW()
            WHERE stripe_subscription_id = $1`,
          [sub.id, sub.status, tier, cancel.cancelAtPeriodEnd, cancel.cancelAt]
        );
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}

/** Whether a cancellation is scheduled, and when.
 *
 *  ONE definition, read by all three write paths, because the interesting half is the
 *  ASYMMETRY between the two fields and duplicating it is how they drift:
 *
 *  `cancel_at_period_end` is a plain boolean and is always present, so it is what the
 *  admin badge fires on. `cancel_at` is nullable — Stripe's own types call it "a date in
 *  the future at which the subscription will automatically get canceled" and do NOT
 *  promise it is populated whenever the flag is set. So a NULL date next to a true flag
 *  is a real state meaning "cancelling, date unknown", and it must render as that rather
 *  than collapsing into "not cancelling". Keying the whole thing on the date is the tidy
 *  version and it reports a churning subscriber as healthy.
 *
 *  Epoch SECONDS on the wire, hence the ×1000. A bare `new Date(sub.cancel_at)` is 1970
 *  and would render as a cancellation that already happened.
 *
 *  NOT `sub.current_period_end`: it is not on the Subscription object in stripe@22.3.0 —
 *  it moved onto `items.data[]` — so it reads `undefined` and writes NULL for ever, which
 *  is indistinguishable from nobody cancelling. */
function cancelFacts(sub: Stripe.Subscription): {
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
} {
  return {
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
  };
}

/** Status, tier and the cancellation schedule as Stripe reports them right now.
 *
 *  ONE retrieve for all of them, deliberately: status and tier were two facts from one
 *  call with only one of them kept, and the cancellation schedule was a third fact on the
 *  same object that nobody was reading at all. That is the defect this whole change is
 *  about — the owner learned a subscriber had gone by opening Stripe.
 *
 *  The fallbacks differ because the failure modes do. Tier falls back to 'base' so an
 *  unreadable price surfaces as "paying premium, treated as base" — a complaint we can
 *  fix — rather than free premium, which never surfaces. Status falls back to 'active'
 *  because this is only ever reached from a COMPLETED subscription checkout, so the one
 *  thing we do know is that they subscribed; 'active' and 'trialing' are both entitled,
 *  so the fallback cannot change what anyone can do, only what the admin page reports.
 *  The cancellation falls back to NOT SCHEDULED for the same reason in reverse: this
 *  branch runs the instant somebody finishes checking out, nobody cancels in that window,
 *  and a false "cancelling" badge on a brand-new subscriber would send somebody chasing a
 *  churn that has not happened. Knowing nothing is the status quo; guessing is not. */
async function subscriptionFacts(subscriptionId: string): Promise<{
  status: string;
  tier: PlanTier;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
}> {
  const stripe = getStripe();
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return {
      status: sub.status,
      tier: tierForPriceId(sub.items?.data?.[0]?.price?.id),
      ...cancelFacts(sub),
    };
  } catch (err) {
    console.error(
      '[stripe webhook] subscription lookup failed, defaulting to active/base:',
      (err as Error).message
    );
    return { status: 'active', tier: 'base', cancelAtPeriodEnd: false, cancelAt: null };
  }
}

async function upsertSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
  tier,
  cancelAtPeriodEnd,
  cancelAt,
}: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  tier: PlanTier;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
}) {
  // grandfathered is deliberately NOT in the update set — it is written once by
  // migration 032 and never by the webhook, so a renewal event on a pre-tier
  // subscription (whose price maps to 'base') can't strip the included auto-cart.
  //
  // The cancellation fields ARE in it, and they have to be: a cancellation is undone by
  // an `updated` event carrying the flag back to false, so a write set that only ever
  // turns it ON would leave a resubscribed customer badged as cancelling for ever. Both
  // directions, or the badge rots into noise and stops being read.
  await mutate(
    `INSERT INTO subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status, tier,
        cancel_at_period_end, cancel_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stripe_subscription_id)
     DO UPDATE SET status = EXCLUDED.status,
                   tier = EXCLUDED.tier,
                   cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                   cancel_at = EXCLUDED.cancel_at,
                   updated_at = NOW()`,
    [userId, stripeCustomerId, stripeSubscriptionId, status, tier, cancelAtPeriodEnd, cancelAt]
  );
}
