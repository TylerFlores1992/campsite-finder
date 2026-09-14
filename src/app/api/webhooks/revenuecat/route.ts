// RevenueCat webhook — store subscriptions (Play now, App Store later).
//
// RevenueCat POSTs here on every subscription lifecycle event. We map it onto
// `subscriptions`, which migration 071 taught to hold a store purchase: `provider`,
// `store_transaction_id`, and nullable Stripe columns.
//
// THE ENTITLEMENT QUERY NEEDS NO CHANGE. `hasAutocartEntitlement` reads only `status`,
// `tier` and `grandfathered`, so writing a correct row here is the whole job — all six
// enforcers pick it up untouched.
//
// PUBLIC ROUTE. `/api/webhooks/(.*)` is already in `isPublicRoute`, so this file is
// reachable by anyone the moment it exists — the middleware wildcard is a description of
// a family, and adding a file to that family opts it out of Clerk. The auth check below
// is therefore the ONLY thing between an anonymous POST and a row claiming somebody paid.
// It fails CLOSED.
//
// The decisions live in `@/lib/revenuecat` so they can be tested; see that file's header.

import { NextRequest, NextResponse } from 'next/server';
import { mutate, queryOne } from '@/lib/db/client';
import {
  ignoreReason,
  sandboxGranted,
  providerForStore,
  statusForEvent,
  storeTransactionId,
  tierForProductId,
  verifyAuthHeader,
  verifyHmac,
  type RcEvent,
} from '@/lib/revenuecat';

/** Always 200 once authorised. A non-2xx makes RevenueCat retry, and an event we have
 *  decided not to act on will never become processable — retrying it forever buys
 *  nothing and buries the events that matter. */
function ok(detail: Record<string, unknown> = {}) {
  return NextResponse.json({ received: true, ...detail });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();

  const authHeader = req.headers.get('authorization');
  const authSecret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!verifyAuthHeader(authHeader, authSecret)) {
    // A REFUSAL MUST NAME ITSELF, and this one did not. "No secret configured on Vercel"
    // and "a secret that does not match" produced the identical 401 with the identical
    // body, so RevenueCat's delivery log — which shows only the response — could not tell
    // them apart. On 2026-09-14 that cost three round trips against a webhook that had
    // been 401ing every event for a fortnight, with no subscription row ever written by
    // either store. Same family as `status = 'sent'` meaning only "Twilio returned 2xx".
    //
    // BOOLEANS ONLY. Never the value, never its length, never a prefix — a length is a
    // real hint to somebody guessing, and "don't collect a field you would then have to
    // filter" applies just as hard to one you would have to redact. That an endpoint is
    // guarded at all is something the 401 already announces.
    const detail = { secret_configured: !!authSecret, header_present: !!authHeader };
    console.error(`[revenuecat webhook] rejected: ${JSON.stringify(detail)}`);
    return NextResponse.json({ error: 'unauthorized', ...detail }, { status: 401 });
  }

  // REPORTED, NOT ENFORCED — see verifyHmac. The scheme could not be verified from the
  // session that wrote this, and rejecting real events over an unconfirmed algorithm is
  // the failure that took 100% of Twilio's callbacks once. Watch for this line, then
  // promote it to a rejection.
  const hmac = verifyHmac(raw, req.headers.get('x-revenuecat-webhook-signature'),
    process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET);
  if (hmac === false) {
    console.error('[revenuecat webhook] HMAC MISMATCH — not rejecting yet, but this is either ' +
      'a forged request or our scheme is wrong. Confirm before enforcing.');
  }

  let event: RcEvent;
  try {
    event = (JSON.parse(raw) as { event?: RcEvent }).event ?? {};
  } catch {
    // Authorised but unparseable: nothing to retry into.
    console.error('[revenuecat webhook] body was not JSON');
    return ok({ ignored: 'unparseable' });
  }

  // READ ONCE AND PASSED TO BOTH, so the decision and the line that reports it cannot
  // disagree about whether this grant happened. See `sandboxGranted` for why the exception
  // exists and when to clear the variable.
  const sandboxUsers = process.env.REVENUECAT_SANDBOX_USER_IDS;

  const ignored = ignoreReason(event, sandboxUsers);
  if (ignored) return ok({ ignored });

  // LOUD, ALWAYS. A test purchase granting a real entitlement is a thing somebody chose,
  // and an unlogged exception is one nobody can find later. It fires only when the guard
  // let a non-production event through, so it cannot narrate a grant that did not happen.
  if (sandboxGranted(event, sandboxUsers)) {
    console.warn(
      `[revenuecat webhook] SANDBOX GRANT for ${event.app_user_id} (event ${event.id}, ` +
      `${event.product_id}) — REVENUECAT_SANDBOX_USER_IDS lists this user, so a test ` +
      'purchase is about to write a real subscription row. Clear the variable once App ' +
      'Review is done.'
    );
  }

  const userId = event.app_user_id;
  const provider = providerForStore(event.store);
  const txnId = storeTransactionId(event);
  if (!userId || !provider || !txnId) {
    console.error(`[revenuecat webhook] incomplete event ${event.id}: ` +
      `user=${!!userId} provider=${provider ?? 'unknown'} txn=${!!txnId}`);
    return ok({ ignored: 'incomplete' });
  }

  // ANONYMOUS IDS ARE NOT OUR USERS. RevenueCat mints its own id ($RCAnonymousID:…) when
  // the SDK has not been told who this is, and `subscriptions.user_id` is a foreign key —
  // so an unknown id would fail the INSERT rather than be ignored. Checked first so the
  // ordinary case produces a clear log line instead of a constraint error.
  const known = await queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
  if (!known) {
    console.error(`[revenuecat webhook] no such user ${userId} — event ${event.id} ignored`);
    return ok({ ignored: 'unknown user' });
  }

  const status = statusForEvent(event, Date.now());
  if (status === null) {
    // No expiry and nothing that says a purchase happened: we cannot tell, so we leave
    // the row alone. Unknown is never "not subscribed".
    return ok({ ignored: 'indeterminate', type: event.type });
  }

  // `grandfathered` is deliberately NOT in the update set, exactly as the Stripe webhook
  // does it: migration 032 wrote it once and no webhook may strip it.
  await mutate(
    `INSERT INTO subscriptions (user_id, provider, store_transaction_id, status, tier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, store_transaction_id)
     DO UPDATE SET status = EXCLUDED.status, tier = EXCLUDED.tier, updated_at = NOW()`,
    [userId, provider, txnId, status, tierForProductId(event.product_id)]
  );

  return ok({ type: event.type, status });
}
