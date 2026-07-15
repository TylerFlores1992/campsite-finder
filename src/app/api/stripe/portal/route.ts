import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());

export async function POST() {
  const userId = await requireAuth();

  const sub = await queryOne<{ stripe_customer_id: string }>(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (!sub?.stripe_customer_id) {
    return NextResponse.json({ error: 'No subscription found' }, { status: 404 });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    // The stored customer can be absent in the current Stripe mode — e.g. a
    // test-mode customer left over from before the live switch, or a deleted
    // customer. That's an expected 4xx, not a server fault: tell the client so
    // it can route the user to re-subscribe, and don't page us via Sentry.
    if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') {
      return NextResponse.json(
        { error: 'billing_profile_missing', message: "We couldn't find your billing profile. Please subscribe again." },
        { status: 409 }
      );
    }
    throw err; // genuine/unexpected Stripe failures still surface in Sentry
  }
}
