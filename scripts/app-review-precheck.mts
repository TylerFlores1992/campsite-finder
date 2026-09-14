/**
 * Will the App Store reviewer actually SEE the in-app paywall?
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/app-review-precheck.mts [email]
 *
 * Run it BEFORE every submission. Two of the four App Store rejections so far were this
 * exact class — something true of the ARTEFACT and false of what the reviewer was handed:
 *
 *   2026-08-14  Guideline 2.1   the password in Sign-In Information did not work, and
 *                               the "verified done" check had only confirmed the field
 *                               was POPULATED. Presence is not liveness.
 *   2026-08-22  Guideline 3.1.1 the link-out fix was live in production and INVISIBLE to
 *                               the reviewer, because every purchase surface is gated on
 *                               `!subscribed` and the demo account was a subscriber.
 *
 * ── IT TAKES AN EMAIL, AND THAT IS THE POINT ─────────────────────────────────────────
 * The scratchpad version of this check hardcoded a Clerk id and called it "the App Review
 * demo account". It was not — it was the sandbox TEST account — so it reported CLEAN while
 * the real Sign-In account carried a live grandfathered Stripe subscription. A check that
 * names its subject by an id nobody re-reads is a check that can be pointed at the wrong
 * thing and go on passing. Take the email from the console, not from memory:
 *
 *   App Store Connect -> the version -> App Review Information -> Sign-In Information
 *
 * ── IT ASKS `hasActiveSubscription`, NEVER A COPY OF THE RULE ─────────────────────────
 * `is_beta` short-circuits it before any subscription row is read (`src/lib/auth.ts`), so
 * a beta tester reads as subscribed and sees no paywall however empty `subscriptions` is.
 * A re-implementation here would have to know that, and would be the copy that drifts.
 *
 * ── WHAT IT CANNOT ANSWER, STATED SO A PASS IS NOT OVER-READ ──────────────────────────
 *  1. THE PASSWORD. `api.clerk.com` is connect_rejected at the agent proxy, so the
 *     one-command check that would have prevented 2026-08-14 is not available from a
 *     session any more. Sign in at camphawk.app with the exact string pasted into ASC.
 *  2. THE BUILD. `@revenuecat/purchases-capacitor` landed 2026-08-29 (`8818544`). An iOS
 *     build older than that contains no StoreKit at all and the paywall renders its
 *     `unavailable` fallback — visually identical to a healthy pre-IAP build. Read the
 *     attached build's date in the console.
 *  3. THE SANDBOX GRANT. App Review purchases run in SANDBOX, and `ignoreReason` drops
 *     every non-PRODUCTION event unless the buyer is in `REVENUECAT_SANDBOX_USER_IDS`.
 *     Clear that before approval and the reviewer's purchase succeeds at StoreKit and
 *     unlocks nothing. The Clerk id printed below is the value that must be in it.
 */
import { query } from '@/lib/db/client';
import { hasActiveSubscription } from '@/lib/auth';

// APP-STORE.md:120 records this as the Sign-In Information username. It is a DEFAULT, not
// an assertion — pass the email on the command line if the console says something else.
const DEFAULT_EMAIL = 'tylerflores1992@yahoo.com';

const email = process.argv[2] ?? DEFAULT_EMAIL;

const users = await query<{ id: string; is_beta: boolean }>(
  'SELECT id, is_beta FROM users WHERE email = $1',
  [email]
);

// NO SUCH ACCOUNT IS A REFUSAL, NOT A PASS. An empty result and a clean account are
// opposite readings, and the empty one means the reviewer cannot sign in at all.
if (users.length !== 1) {
  console.log(`REFUSING: ${users.length} account(s) for ${email}.`);
  console.log('That is not "clean" — the reviewer cannot sign in. Check the email in ASC.');
  process.exit(1);
}

const { id, is_beta } = users[0];

const subs = await query<{
  status: string; tier: string; provider: string | null;
  grandfathered: boolean; store_transaction_id: string | null; created_at: string;
}>(
  `SELECT status, tier, provider, grandfathered, store_transaction_id, created_at
     FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
  [id]
);

console.log(`Sign-In account : ${email}`);
console.log(`  clerk id      : ${id}`);
console.log(`  is_beta       : ${is_beta}${is_beta ? '   <-- reads as SUBSCRIBED on its own' : ''}`);
console.log(`  subscriptions : ${subs.length === 0 ? 'none' : ''}`);
for (const s of subs) {
  console.log(
    `      ${s.status} ${s.tier} ${s.provider ?? '-'} grandfathered=${s.grandfathered} ` +
    `${s.store_transaction_id ?? '-'} ${s.created_at}`
  );
}

const subscribed = await hasActiveSubscription(id);
console.log(`\n  hasActiveSubscription: ${subscribed}`);

if (!subscribed) {
  console.log('\nCLEAN — signed in as this account, the reviewer reaches the in-app paywall.');
  console.log(`Through review, REVENUECAT_SANDBOX_USER_IDS must contain: ${id}`);
  console.log('Then clear it once the app is APPROVED, and delete any row the purchase wrote.');
  process.exit(0);
}

// NAME WHICH OF THE TWO, because they need different fixes and only one of them is a row
// you can delete. Reporting a bare "not clean" is what sends somebody deleting rows from
// an account whose problem is a boolean.
const live = subs.filter((s) => s.status === 'active' || s.status === 'trialing');
console.log('\nNOT CLEAN — every purchase surface is gated on !subscribed, so the reviewer');
console.log('sees NO paywall and NO way to buy. That is the 2026-08-22 rejection.');
if (is_beta) {
  console.log(`\n  CAUSE: is_beta = true. No row to delete — clear the flag, or use another account.`);
}
for (const s of live) {
  console.log(`\n  CAUSE: a live ${s.provider ?? 'unknown'} row (${s.status} ${s.tier}).` +
    (s.provider === 'stripe'
      ? ' A STRIPE row is a REAL subscription — do not delete it to pass this check,'
      : ' A STORE row from a sandbox test is safe to delete.'));
  if (s.provider === 'stripe' && s.grandfathered) {
    console.log('         and it is GRANDFATHERED, which the webhook never writes back.');
    console.log('         Point Sign-In Information at a non-subscriber instead.');
  }
}
process.exit(1);
