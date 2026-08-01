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
  return NextResponse.json({
    active,
    everSubscribed: !!prior,
    autocart,
    autocartPlanAvailable: autocartPlanConfigured(),
  });
}
