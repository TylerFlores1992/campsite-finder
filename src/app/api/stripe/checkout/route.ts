import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth, syncUser } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';
import { autocartPlanConfigured, isBillingInterval, isPlanTier, priceIdFor } from '@/lib/stripe-plans';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  // Beta testers have complimentary full access — never send them to Stripe, so a
  // stray subscribe CTA can't charge them (this is why melinda.flores0501 got billed).
  const beta = await queryOne<{ is_beta: boolean }>('SELECT is_beta FROM users WHERE id = $1', [userId]);
  if (beta?.is_beta) {
    return NextResponse.json(
      { error: 'beta_access', message: 'You have complimentary beta access — no subscription needed.' },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { interval?: unknown; plan?: unknown };
  const interval = isBillingInterval(body.interval) ? body.interval : 'monthly';
  const plan = isPlanTier(body.plan) ? body.plan : 'base';

  // A deploy where the Auto-Cart prices aren't configured yet must refuse the plan,
  // not quietly sell base at base price to someone who clicked a $10 button.
  if (plan === 'autocart' && !autocartPlanConfigured()) {
    return NextResponse.json(
      { error: 'not_configured', message: 'The Auto-Cart plan is not available yet.' },
      { status: 503 }
    );
  }
  const priceId = priceIdFor(plan, interval) ?? priceIdFor('base', 'monthly')!;

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);

  // First-time subscribers get a 7-day free trial. The local check is the fast path
  // and covers the ordinary returning/expired customer.
  const prior = await queryOne<{ id: string }>(
    'SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );

  // …but the local check alone is defeated by deleting the account and signing up
  // again, which is not hypothetical: tylerflores1992@yahoo.com did exactly that on
  // 2026-07-29 and drew a second 7-day trial 17 minutes after the first. Account
  // deletion cascades `subscriptions` away and Clerk issues a fresh user id, so the
  // one row that proved "already had a trial" is precisely what deletion destroys.
  //
  // Stripe is the durable record. We cancel the subscription on delete but never the
  // CUSTOMER, so a prior trial is still visible there, keyed by email rather than by
  // an id we throw away. Note this stores nothing new on our side — the data is
  // already Stripe's as our processor — so "deleting your account deletes your data"
  // stays true.
  const priorTrial = prior ? true : await hasHadTrialInStripe(user?.email);

  // Reuse the existing customer rather than minting another. `customer_email` creates
  // a NEW customer per checkout, which is why that one address now has two.
  const existingCustomer = user?.email ? await findCustomerId(user.email) : null;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    // Stripe rejects both together, so it is one or the other.
    ...(existingCustomer ? { customer: existingCustomer } : { customer_email: user?.email ?? undefined }),
    metadata: { clerk_user_id: userId },
    // ALSO on the subscription itself, not just the session: customer.subscription.*
    // events carry only the subscription's metadata, and without the user id there
    // the webhook can't attribute them (it falls back to matching by subscription id,
    // which works only for rows that already exist).
    subscription_data: {
      metadata: { clerk_user_id: userId },
      ...(priorTrial ? {} : { trial_period_days: 7 }),
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?subscribed=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/`,
  });

  return NextResponse.json({ url: session.url });
}

/** Most recent Stripe customer for this email, or null. */
async function findCustomerId(email: string): Promise<string | null> {
  try {
    const { data } = await stripe.customers.list({ email, limit: 100 });
    if (data.length === 0) return null;
    return data.reduce((a, b) => (b.created > a.created ? b : a)).id;
  } catch (err) {
    console.error('[checkout] customer lookup failed (non-fatal):', err);
    return null;
  }
}

/**
 * Has any subscription under any customer with this email ever started a trial?
 *
 * `status: 'all'` is required — the giveaway subscription is usually `canceled` by
 * the time someone tries again, and the default listing hides exactly that.
 *
 * On a Stripe error this returns FALSE, i.e. it falls back to the local check and
 * the user still gets their trial. Denying a genuine first-time subscriber their
 * trial because Stripe blipped is a worse failure than the alternative, and abusing
 * the gap would need a delete-and-resignup timed to a Stripe outage.
 */
async function hasHadTrialInStripe(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  try {
    const { data: customers } = await stripe.customers.list({ email, limit: 100 });
    for (const c of customers) {
      const { data: subs } = await stripe.subscriptions.list({
        customer: c.id,
        status: 'all',
        limit: 100,
      });
      if (subs.some((s) => s.trial_start !== null)) return true;
    }
    return false;
  } catch (err) {
    console.error('[checkout] prior-trial lookup failed, allowing trial:', err);
    return false;
  }
}
