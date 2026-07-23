import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth, syncUser } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());

const PRICE_IDS: Record<string, string> = {
  monthly: process.env.STRIPE_PRICE_ID_MONTHLY!,
  yearly: process.env.STRIPE_PRICE_ID_YEARLY!,
};

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

  const { interval = 'monthly' } = await req.json().catch(() => ({}));
  const priceId = PRICE_IDS[interval] ?? PRICE_IDS.monthly;

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);

  // First-time subscribers get a 7-day free trial; returning/expired customers
  // (who already have a subscription row) don't get another one.
  const prior = await queryOne<{ id: string }>(
    'SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const trialDays = prior ? undefined : 7;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user?.email ?? undefined,
    metadata: { clerk_user_id: userId },
    ...(trialDays ? { subscription_data: { trial_period_days: trialDays } } : {}),
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?subscribed=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/`,
  });

  return NextResponse.json({ url: session.url });
}
