import { NextResponse } from 'next/server';
import { requireAuth, syncUser, hasActiveSubscription, hasAutocartEntitlement } from '@/lib/auth';
import { queryOne } from '@/lib/db/client';
import { autocartPlanConfigured } from '@/lib/stripe-plans';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await requireAuth();
  // MUST run before the check. Beta access lives on users.is_beta, and that row is
  // only created by syncUser — which no read path called. So a beta tester who
  // signed up and went straight to Explore had no row at all, hasActiveSubscription
  // found nothing, and the whole UI told them to start a free trial. syncUser also
  // re-evaluates is_beta against beta_emails, so someone added to the list AFTER
  // signing up is picked up on their next page load instead of never.
  await syncUser(userId);
  const active = await hasActiveSubscription(userId);
  // everSubscribed drives trial vs "resubscribe" copy (returning users get no new trial).
  const prior = await queryOne<{ id: string }>(
    'SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  // autocart = may this user use auto-cart (Auto-Cart tier, grandfathered, or beta).
  // autocartPlanAvailable = are the Auto-Cart prices configured — the UI hides the
  // plan entirely while false, so nothing offers a checkout that would 503.
  const autocart = await hasAutocartEntitlement(userId);
  // WHO HOLDS THE BILLING RELATIONSHIP — the one thing the client could not previously
  // ask, and the reason the native app had no subscription management at all. Settings
  // and the account menu both used to point at the Stripe portal unconditionally, which
  // is the wrong destination for a store subscriber: there is no stripe_customer_id on
  // their row, so the portal route 404s. `src/lib/subscription-management.ts` routes on
  // this field; the DEVICE is not the key, because somebody can subscribe on the web and
  // open the app, or buy on Android and sign in on an iPhone.
  //
  // THE ENTITLING ROW, NOT THE NEWEST ROW. `hasAutocartEntitlement` already refuses to
  // use "latest" for the same reason: a user can carry an old canceled row beside a live
  // one, and which one sorts first is ordering trivia. A lapsed Stripe row next to a live
  // Play subscription would otherwise send a Play subscriber to Stripe.
  //
  // NULL WHEN THERE IS NO LIVE ROW, which includes a beta tester — they read `active`
  // through users.is_beta with no subscription at all. `manageDestination` treats a null
  // provider as the web relationship, which is the pre-existing behaviour for that user.
  const billing = await queryOne<{ provider: string | null; tier: string | null }>(
    `SELECT provider, tier FROM subscriptions
      WHERE user_id = $1 AND status IN ('active', 'trialing')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId]
  );
  return NextResponse.json({
    active,
    everSubscribed: !!prior,
    autocart,
    autocartPlanAvailable: autocartPlanConfigured(),
    provider: billing?.provider ?? null,
    tier: billing?.tier ?? null,
  });
}
