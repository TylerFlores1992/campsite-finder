import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth, syncUser } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST() {
  const userId = await requireAuth();
  await syncUser(userId);

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    customer_email: user?.email ?? undefined,
    metadata: { clerk_user_id: userId },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?subscribed=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/`,
  });

  return NextResponse.json({ url: session.url });
}
