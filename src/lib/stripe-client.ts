import Stripe from 'stripe';

// DELIBERATELY NOT `import 'server-only'`. That package resolves to a throwing stub outside
// a server bundle, which also means outside `node:test` — so keeping it here would make the
// one behaviour worth testing (what happens when the key is missing) untestable, and this
// module exists precisely because that behaviour was wrong. The property it would buy is
// asserted mechanically instead: `worker/stripe-init.test.mts` fails if any `'use client'`
// file imports this. A test that runs in CI beats a guard that makes the test impossible.

/**
 * The one place a Stripe client is constructed.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Five routes each did this at MODULE SCOPE:
 *
 *     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());
 *
 * `!` is a promise you cannot keep about an environment variable. If `STRIPE_SECRET_KEY`
 * ever went missing from Vercel — deleted, renamed, scoped to the wrong environment, or
 * simply not present on a preview deployment — `.trim()` throws `TypeError: Cannot read
 * properties of undefined` while the MODULE IS BEING EVALUATED. A route whose module fails
 * to evaluate does not return a 500 from your handler; it never reaches your handler at
 * all, and every request to it fails identically no matter what it was asked to do.
 *
 * That is DEAD, not degraded, and the blast radius is the whole billing surface:
 * checkout, plan change, portal, account deletion, and — worst — the Stripe WEBHOOK.
 * A dead webhook is silent by construction: Stripe retries for days, subscriptions stop
 * being updated in our database, and nothing in the product looks wrong until somebody's
 * `active` row quietly disagrees with what they are actually paying. Same family as
 * `notifications.status = 'sent'` meaning only "Twilio returned 2xx" — the failure and
 * the healthy case produce the same silence.
 *
 * ── WHAT LAZY INIT BUYS ────────────────────────────────────────────────────────────────
 * The throw moves from module evaluation to the first request that actually needs Stripe.
 * That turns five dead routes into five routes that return a real error, keeps the rest of
 * the app up, and — the part that matters — makes it VISIBLE, because a handler throwing
 * is a 500 with a message rather than a route that silently does not exist.
 *
 * The client is cached after the first successful construction, so this costs one
 * `if` per call and nothing else. Do not "simplify" it back to module scope.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  // NAMED, and it says where to look. A bare "missing key" in a log at 2am is the
  // difference between a one-minute fix and an evening — the same reason the bot's feed
  // 401 names which token source it used.
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set — check Vercel → CampHawk → Settings → Environment ' +
      'Variables, and that it is enabled for this environment (Production/Preview).',
    );
  }
  client = new Stripe(key);
  return client;
}

/**
 * Is Stripe usable at all? For callers that would rather answer "billing is unavailable"
 * than throw — never for deciding whether to CHARGE someone.
 */
export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}
