import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-client';
import { clerkClient } from '@clerk/nextjs/server';
import { requireAuth } from '@/lib/auth';
import { query, mutate } from '@/lib/db/client';

/**
 * Delete the signed-in user's account, for real.
 *
 * REQUIRED BY THE APP STORE. Apple guideline 5.1.1(v): an app that lets people
 * create an account must let them delete it from inside the app. There was no
 * deletion path at all, which is a certain rejection.
 *
 * Authenticated the normal way (Clerk), so NOT in `isPublicRoute` — a signed-out
 * caller gets middleware's 404 before reaching this code.
 *
 * ── ORDER IS LOAD-BEARING ─────────────────────────────────────────────────────
 * 1. Cancel at Stripe. 2. Delete the Clerk user. 3. Delete our row.
 *
 * Stripe MUST come first. Every user-owned table is ON DELETE CASCADE from
 * `users`, so deleting that row takes `subscriptions` — and with it the
 * `stripe_subscription_id` — leaving a live subscription still billing a person
 * whose account no longer exists, and no record left to find it by. That is the
 * bug this route was written to close: the `user.deleted` webhook has always
 * removed the data, and has never touched billing.
 *
 * If Stripe fails we abort and delete NOTHING. A user who keeps their account is
 * a recoverable state; a deleted account still being charged is not.
 *
 * Cancellation is IMMEDIATE (`subscriptions.cancel`), not at period end, and the
 * remainder of the period is not refunded. Cancel-at-period-end would leave a
 * paid subscription attached to a user who is gone. The UI says this in plain
 * words before the button is pressed — see v2/DeleteAccount.tsx.
 */
export async function POST() {
  const stripe = getStripe();
  const userId = await requireAuth();

  // ── 1. Stop the billing ────────────────────────────────────────────────────
  const subs = await query<{ stripe_subscription_id: string | null }>(
    `SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1`,
    [userId]
  );

  for (const s of subs) {
    if (!s.stripe_subscription_id) continue;
    try {
      await stripe.subscriptions.cancel(s.stripe_subscription_id);
    } catch (err) {
      // `resource_missing` means Stripe has no such subscription — already
      // cancelled, or test data. Nothing to stop, so carry on.
      const code = (err as { code?: string })?.code;
      if (code === 'resource_missing') continue;

      console.error('[account delete] Stripe cancel failed', s.stripe_subscription_id, err);
      return NextResponse.json(
        {
          error:
            "We couldn't cancel your subscription, so nothing was deleted. Your account is untouched. Please try again, or contact alerts@camphawk.app.",
        },
        { status: 502 }
      );
    }
  }

  // ── 2. Delete the identity ─────────────────────────────────────────────────
  // This fires the `user.deleted` webhook, which deletes our row and cascades.
  // Doing it before our own delete means a failure here leaves the account
  // intact and usable rather than stranding a Clerk user with no data.
  try {
    const clerk = await clerkClient();
    await clerk.users.deleteUser(userId);
  } catch (err) {
    console.error('[account delete] Clerk delete failed', userId, err);
    return NextResponse.json(
      {
        error:
          'Your subscription was cancelled, but we could not delete the account itself. Please contact alerts@camphawk.app so we can finish it.',
      },
      { status: 502 }
    );
  }

  // ── 3. Delete our data, without waiting on the webhook ─────────────────────
  // The webhook does this too. Both are idempotent, and doing it here means the
  // data is gone by the time this responds rather than whenever Svix delivers —
  // which matters if a reviewer (or a user) checks immediately afterwards.
  try {
    await mutate('DELETE FROM users WHERE id = $1', [userId]);
  } catch (err) {
    // The account is already gone from Clerk and billing is stopped; the webhook
    // is the backstop for the row. Don't fail the request over it.
    console.error('[account delete] direct row delete failed, leaving it to the webhook', userId, err);
  }

  return NextResponse.json({ deleted: true });
}
