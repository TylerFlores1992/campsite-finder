/**
 * THE MANAGE-SUBSCRIPTION ROUTER, TESTED WHERE IT CAN ACTUALLY RUN.
 *
 * ## Why this file exists at all
 *
 * The decision it covers is reachable, in production, only from inside a native webview
 * on somebody else's phone. This repo has shipped that shape several times and paid for
 * it each time: a paywall with no route to it, a link-out that was live and invisible to
 * the reviewer holding the credentials we supplied, an assertion that could not fail.
 * **A branch nothing runs is a branch nobody has checked**, however carefully it was
 * written. So the branch lives in a pure function and the function is exercised here.
 *
 * ## UNDER `src/`, NOT `worker/`
 *
 * `npm test` globs both, but `worker/**` is the FIRST entry in `worker-deploy.yml`'s
 * `paths:`, so a test file there restarts both poller machines on merge. Checked against
 * the workflow rather than remembered — `platform-parity.test.mts` records the same
 * reasoning, and CLAUDE.md records getting the claim wrong twice.
 *
 * ## What the assertions are FOR
 *
 * Two of them are the whole point and the rest are bookkeeping:
 *
 *   1. **A failed lookup never lands on Stripe and never says "no subscription".** That
 *      is the rule a Clerk blip already has to obey one layer up; a store subscriber sent
 *      to a portal that 404s reads it as their subscription having vanished.
 *   2. **The route is the STORED provider, not the device.** Nothing here can see a
 *      platform, which is enforced by the absence of any import that could.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANDROID_PACKAGE_NAME,
  APPLE_SUBSCRIPTIONS_URL,
  PLAY_SUBSCRIPTIONS_URL,
  SUPPORT_HREF,
  manageDestination,
  playSkuForTier,
  playSubscriptionUrl,
  type BillingReading,
} from './subscription-management';
import { PLAY_SUBSCRIPTION_ID } from './store-plans';

const known = (provider: string | null, tier: string | null = null): BillingReading => ({
  known: true,
  provider,
  tier,
});

// ─────────────────────────────────────────────────────────── the routing decision

test('a Play subscriber goes to Play, deep-linked to their own sku and package', () => {
  const d = manageDestination(known('google', 'autocart'));
  assert.equal(d.kind, 'play');
  assert.ok(d.external, 'Play has to leave the webview — it is the Play app, not our site');

  const url = new URL(d.href!);
  assert.equal(`${url.origin}${url.pathname}`, PLAY_SUBSCRIPTIONS_URL);
  assert.equal(url.searchParams.get('sku'), PLAY_SUBSCRIPTION_ID.autocart);
  assert.equal(url.searchParams.get('package'), ANDROID_PACKAGE_NAME);
});

test('the real 2026-09-19 row routes to Play', () => {
  // The first production store purchase this product has ever had, and the report that
  // started this work: provider='google', tier='autocart', status='trialing'. Pinned as a
  // case rather than left implicit, because "it works for the subscriber who complained"
  // is the only acceptance criterion anybody will check.
  const d = manageDestination(known('google', 'autocart'));
  assert.equal(d.kind, 'play');
  assert.match(d.href!, /sku=camphawk_autocart/);
});

test('an Apple subscriber goes to the App Store', () => {
  const d = manageDestination(known('apple', 'base'));
  assert.equal(d.kind, 'app-store');
  assert.equal(d.href, APPLE_SUBSCRIPTIONS_URL);
  assert.ok(d.external);
});

test('a Stripe subscriber goes to the portal, which is a POST and so has no href', () => {
  const d = manageDestination(known('stripe', 'base'));
  assert.equal(d.kind, 'stripe-portal');
  assert.equal(d.href, null, 'the portal session is minted per click; an anchor would be stale');
});

test('no subscription row is the web relationship, not an unknown one', () => {
  // migration 071 backfilled every pre-store row to 'stripe' and defaults the column to
  // it, so `null` here means "no row", which is the web's shape.
  assert.equal(manageDestination(known(null)).kind, 'stripe-portal');
});

test('case and surrounding whitespace do not change the answer', () => {
  assert.equal(manageDestination(known('GOOGLE')).kind, 'play');
  assert.equal(manageDestination(known(' apple ')).kind, 'app-store');
  assert.equal(manageDestination(known('Stripe')).kind, 'stripe-portal');
});

// ───────────────────────────────────────────────── the arm that must never round down

test('a failed lookup says so, offers support, and never mentions Stripe', () => {
  const d = manageDestination({ known: false });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.href, SUPPORT_HREF);
  assert.equal(d.external, false, 'support is our own page — it stays in the webview');
  assert.match(d.detail, /couldn't check/i);
});

test('the unknown arm never claims the user has no subscription', () => {
  // THE ASSERTION THIS FILE EXISTS FOR. A Clerk blip must not be able to tell a paying
  // subscriber they are not subscribed, at any layer. Phrased as a ban on the claim
  // rather than a check of one sentence, so a rewrite of the copy still has to obey it.
  const d = manageDestination({ known: false });
  for (const claim of [/no subscription/i, /not subscribed/i, /subscription has ended/i]) {
    assert.doesNotMatch(d.detail, claim);
    assert.doesNotMatch(d.label, claim);
  }
});

test('a provider we have never seen is unknown, not a guess and not Stripe', () => {
  // migration 071 deliberately puts NO CHECK constraint on `provider`, precisely so an
  // unexpected store is recorded rather than rejected. That makes this reachable.
  for (const p of ['amazon', 'roku', 'paddle', '', '   ']) {
    assert.equal(manageDestination(known(p)).kind, 'unknown', `provider=${JSON.stringify(p)}`);
  }
});

// ──────────────────────────────────────────────────────────── the Play deep link

test('an unrecognized tier degrades to the plain Play screen rather than guessing a sku', () => {
  for (const tier of [null, undefined, 'pro', 'BASE', '']) {
    assert.equal(playSubscriptionUrl(tier), PLAY_SUBSCRIPTIONS_URL, `tier=${String(tier)}`);
  }
  // …and the whole destination still works — a Play subscriber whose tier we cannot read
  // must still reach Play, one tap further in.
  const d = manageDestination(known('google', 'mystery'));
  assert.equal(d.kind, 'play');
  assert.equal(d.href, PLAY_SUBSCRIPTIONS_URL);
});

test('the sku comes from store-plans and is never a second copy', () => {
  assert.equal(playSkuForTier('base'), PLAY_SUBSCRIPTION_ID.base);
  assert.equal(playSkuForTier('autocart'), PLAY_SUBSCRIPTION_ID.autocart);
  // And the module holds no literal of its own. `camphawk_` appears in store-plans.ts
  // and nowhere here, so the two cannot drift.
  const src = readFileSync('src/lib/subscription-management.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /camphawk_/, 'the Play ids belong to store-plans.ts');
});

// ──────────────────────────────────────────── the one constant that is copied, pinned

test('ANDROID_PACKAGE_NAME equals the id both build systems actually use', () => {
  // It is copied because `capacitor.config.ts` is outside `src/`. A copy with a test is
  // the repo's standing trade (store-plans re-declares the RevenueCat enum the same way);
  // a copy without one is how a deep link points at an app nobody has installed.
  const cap = readFileSync('capacitor.config.ts', 'utf8');
  assert.match(cap, new RegExp(`appId:\\s*'${ANDROID_PACKAGE_NAME.replace(/\./g, '\\.')}'`));

  const codemagic = readFileSync('codemagic.yaml', 'utf8');
  assert.match(codemagic, new RegExp(`PACKAGE_NAME:\\s*"${ANDROID_PACKAGE_NAME.replace(/\./g, '\\.')}"`));
});

// ─────────────────────────────────────────────── it cannot be routing on the device

test('the module cannot see a platform, so it cannot be routing on one', () => {
  // Constraint 3, enforced rather than asserted in prose: a user can buy on the web and
  // open the app, or buy on Android and sign in on an iPhone. The device answers a
  // question nobody asked. If this module ever imports the platform, it can start.
  const src = readFileSync('src/lib/subscription-management.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /native\/context|useNativePlatform|useIsNativeApp|navigator/);
  assert.doesNotMatch(code, /['"](?:ios|android)['"]/);
});

test('every destination carries copy — a control with no words is a control nobody taps', () => {
  const readings: BillingReading[] = [
    { known: false },
    known('google', 'autocart'),
    known('apple', 'base'),
    known('stripe'),
    known(null),
    known('amazon'),
  ];
  const kinds = new Set<string>();
  for (const r of readings) {
    const d = manageDestination(r);
    kinds.add(d.kind);
    assert.ok(d.label.length > 0, `empty label for ${JSON.stringify(r)}`);
    assert.ok(d.detail.length > 20, `thin detail for ${JSON.stringify(r)}`);
  }
  // A scanner that inspects nothing approves everything: prove all four arms were hit.
  assert.deepEqual([...kinds].sort(), ['app-store', 'play', 'stripe-portal', 'unknown']);
});

// ──────────────────────────────────────────── no price, and no checkout, in the app

test('nothing here renders a price or points at a checkout route', () => {
  // Constraint 2. This is MANAGEMENT. `StorePaywall`, `SubscribeCta`, `WatchCta`,
  // `NewWatch` and `LINKOUT_BY_STORE` own buying and are untouched by this module; a
  // price or a `/pricing` link appearing in these strings would put a purchase surface
  // in front of a subscriber, which is the one thing both stores genuinely do police.
  const readings: BillingReading[] = [
    { known: false },
    known('google', 'autocart'),
    known('apple', 'base'),
    known('stripe'),
  ];
  for (const r of readings) {
    const { label, detail, href } = manageDestination(r);
    const text = `${label} ${detail} ${href ?? ''}`;
    assert.doesNotMatch(text, /\$\d/, 'no price');
    // `\bsubscribe\b` and not `subscribe`: the unknown arm legitimately says "if you
    // subscribed inside the app", which is past tense about a purchase already made.
    // What must not appear is an INVITATION to buy.
    assert.doesNotMatch(text, /\/pricing|\bsubscribe\b|free trial|resubscribe/i, 'no checkout route');
  }
});
