/**
 * A MISSING ENV VAR MUST NOT KILL A ROUTE AT MODULE LOAD.
 *
 * Five routes each constructed Stripe at module scope:
 *
 *     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());
 *
 * `!` is a promise you cannot keep about an environment variable. If the key ever went
 * missing from Vercel — deleted, renamed, scoped to the wrong environment, absent on a
 * preview — `.trim()` throws while the MODULE IS BEING EVALUATED. A module that fails to
 * evaluate does not give you a 500 from the handler; the route never reaches the handler
 * at all, and every request fails identically whatever it asked for. Dead, not degraded.
 *
 * The blast radius was the whole billing surface: checkout, plan change, portal, account
 * deletion, and the WEBHOOK. A dead webhook is silent by construction — Stripe retries for
 * days while our subscription rows quietly stop matching what people actually pay. Same
 * family as `notifications.status = 'sent'` meaning only "Twilio returned 2xx".
 *
 * These are source assertions because the failure is at IMPORT time: a test that imports
 * the route to check it would either crash the suite or need the very env var whose
 * absence is the case under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = [
  'src/app/api/user/delete/route.ts',
  'src/app/api/stripe/plan/route.ts',
  'src/app/api/stripe/checkout/route.ts',
  'src/app/api/stripe/portal/route.ts',
  'src/app/api/webhooks/stripe/route.ts',
];

/** Comments stripped — every rule below is quoted in the note explaining it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

test('Stripe is constructed in exactly one place', () => {
  // Scanning the tree, not just the five known files: the point is that the SIXTH route
  // somebody adds cannot reintroduce this, and that is invisible in any single file.
  const offenders = walk('src')
    .filter((f) => f !== 'src/lib/stripe-client.ts')
    .filter((f) => /new Stripe\(/.test(code(readFileSync(f, 'utf8'))));
  assert.deepEqual(offenders, [],
    'construct Stripe through getStripe() — a module-scope client dies at import time');
});

test('no route asserts the secret key is present with `!`', () => {
  // The non-null assertion is the whole bug: it turns "this might be missing" into a
  // runtime TypeError at the least recoverable moment.
  for (const f of ROUTES) {
    assert.ok(!/STRIPE_SECRET_KEY!/.test(code(readFileSync(f, 'utf8'))),
      `${f} must not assert STRIPE_SECRET_KEY is set`);
  }
});

test('every Stripe route gets its client inside the handler', () => {
  // Inside the exported handler, so the throw lands where a caller can see it — a 500 with
  // a message beats a route that silently does not exist.
  for (const f of ROUTES) {
    const s = code(readFileSync(f, 'utf8'));
    const handler = s.indexOf('export async function POST');
    const init = s.indexOf('const stripe = getStripe()');
    assert.ok(init > handler && handler > 0,
      `${f} must call getStripe() inside POST, not at module scope`);
  }
});

test('no client component imports the Stripe client', () => {
  // This stands in for `import 'server-only'`, which cannot live in stripe-client.ts: that
  // package resolves to a throwing stub outside a server bundle, which includes node:test,
  // and it would make the missing-key behaviour below untestable. Same property, asserted
  // where it can also be run.
  const offenders = walk('src').filter((f) => {
    const s = readFileSync(f, 'utf8');
    return /^\s*['"]use client['"]/m.test(s) && /@\/lib\/stripe-client/.test(s);
  });
  assert.deepEqual(offenders, [],
    'stripe-client is server-only — a client component importing it ships the billing path');
});

test('a missing key throws a message that says where to look', async () => {
  // Behaviour, not source: the client caches only on SUCCESS, so clearing the variable
  // before the first call in this process exercises the real path. tsx runs each test file
  // in its own process, so this cannot leak into another suite.
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const { getStripe, stripeConfigured } = await import('../src/lib/stripe-client.js');
    assert.equal(stripeConfigured(), false);
    assert.throws(() => getStripe(), /STRIPE_SECRET_KEY is not set[\s\S]*Vercel/,
      'the error must name the variable AND where it is configured');
  } finally {
    if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved;
  }
});
