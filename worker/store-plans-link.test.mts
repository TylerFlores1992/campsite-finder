/**
 * THE ROUTE TO THE PAYWALL — the gap that made Play in-app purchase decorative.
 *
 * On 2026-08-30, with `STORE_PURCHASE_ENABLED = true`, the SDK configured, four Active
 * Play products and `StorePaywall` mounted in `PricingSection`, **no path in the app
 * reached `/pricing` or `/`.** The nav lists Watches / New watch / Explore, its logo
 * routes to `/search` when native, `PricingLink` and `PlanOptionsButton` both return null
 * when native, and `NewWatch`'s subscription gate rendered plain text. Nobody could buy.
 *
 * STRUCTURAL BY NECESSITY. These are client components behind `useNativePlatform`, a
 * `useSyncExternalStore` over the user agent — there is no DOM here and no renderer. What
 * can be pinned is that the decision has ONE definition, that the surfaces mount it, and
 * that it does not probe the store. That last one is not styling: `useStorePurchases`
 * calls `Purchases.configure()` and `getOfferings()`, so a probe at each link site fires
 * those once per surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NATIVE = readFileSync('src/components/v2/nativeSubscribe.tsx', 'utf8');
const CTA = readFileSync('src/components/v2/SubscribeCta.tsx', 'utf8');
const NEW_WATCH = readFileSync('src/components/v2/NewWatch.tsx', 'utf8');
const PAYWALL = readFileSync('src/components/v2/StorePaywall.tsx', 'utf8');

/** Comments stripped: these files EXPLAIN the traps they avoid, so a guard reading raw
 *  source matches its own explanation and passes vacuously. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const nativeCode = code(NATIVE);
const ctaCode = code(CTA);
const newWatchCode = code(NEW_WATCH);

/**
 * A named declaration's source, bounded by the NEXT top-level `export` rather than by a
 * brace. The first version cut at the first `\n}` — which in a component with destructured
 * props is the `}: {` of the parameter type, three lines in, so every assertion about the
 * body read an empty string and two tests failed against correct code. A slice between two
 * anchors is only as good as the anchor, and a brace is a bad one.
 */
function body(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `not found: ${decl}`);
  const rest = src.slice(start + decl.length);
  const next = rest.indexOf('\nexport ');
  return decl + (next === -1 ? rest : rest.slice(0, next));
}

test('the paywall link exists and points at /pricing', () => {
  const fn = body(nativeCode, 'export function StorePlansLink');
  assert.match(fn, /href="\/pricing"/, 'the link must route to the paywall page');
});

test('it NEVER steers out — that is the other component', () => {
  // SUBSCRIBE_HREF is camphawk.app. A store that sells in-app must not also be handed a
  // web checkout from the same control: on Play that is the payments policy, and the two
  // links are deliberately separate components for that reason.
  const fn = body(nativeCode, 'export function StorePlansLink');
  assert.doesNotMatch(fn, /SUBSCRIBE_HREF|camphawk\.app|data-native-external/,
    'the plans link must not become a steer to the web');
});

test('it renders nothing on the web, and nothing where IAP is off', () => {
  const fn = body(nativeCode, 'export function useStoreCanSell');
  assert.match(fn, /!!platform/, 'the web (no platform) must be false');
  assert.match(fn, /STORE_PURCHASE_ENABLED/, 'the master switch must be honoured');
  assert.match(fn, /IN_APP_PURCHASE_BY_STORE\[platform\]/, 'the per-store map must be read');
  assert.match(body(nativeCode, 'export function StorePlansLink'), /if \(!canSell\) return null/);
});

test('the per-store map is a SECOND map, not the complement of the link-out', () => {
  // They are not opposites. US rules let an app do both, and once Apple's products exist
  // iOS should carry the paywall AND keep the §2c link-out the 08-22 resubmission argues.
  // Deriving one from the other reads tidier and is wrong about the future.
  assert.match(nativeCode, /export const IN_APP_PURCHASE_BY_STORE/);
  const fn = body(nativeCode, 'export function useStoreCanSell');
  assert.doesNotMatch(fn, /LINKOUT_BY_STORE|useNativeLinkout/,
    'in-app purchase must not be derived from the steering flag');
});

test('iOS is OFF until its products exist', () => {
  // No products in App Store Connect and no NEXT_PUBLIC_REVENUECAT_IOS_KEY — verified
  // absent in the deployed bundle. Linking iOS at the paywall today lands on a fallback.
  const map = nativeCode.slice(nativeCode.indexOf('IN_APP_PURCHASE_BY_STORE'));
  assert.match(map.slice(0, 200), /ios:\s*false/, 'iOS must stay off until §8 is done');
  assert.match(map.slice(0, 200), /android:\s*true/, 'Android sells today');
});

test('it does NOT probe the store — one configure, in the paywall', () => {
  // useStorePurchases calls Purchases.configure() and getOfferings(). A probe at each
  // link site fires those once per surface rendering a link.
  assert.doesNotMatch(nativeCode, /useStorePurchases/,
    'the link must not probe; StorePaywall owns the single probe');
  assert.match(code(PAYWALL), /useStorePurchases/, 'the paywall still owns it');
});

test('the shared non-subscriber CTA mounts it', () => {
  // Covers Explore and the Watches account wall. Without this an Android non-subscriber
  // reads a sentence with no way to act on it — SubscribeLink returns null there.
  assert.match(ctaCode, /<StorePlansLink \/>/, 'SubscribeCta must offer the route');
  assert.match(ctaCode, /import \{[^}]*StorePlansLink[^}]*\} from "\.\/nativeSubscribe"/);
});

test('the /new subscription gate mounts it, and checks canSell FIRST', () => {
  // The sharpest moment in the product: a campground and dates are entered and the server
  // has just refused the submit. A shell that can buy must never be sent to a website, so
  // canSell is tested before the link-out branch.
  assert.match(newWatchCode, /<StorePlansLink \/>/, '/new must offer the route');
  const gate = newWatchCode.slice(newWatchCode.indexOf('needsSubscription &&'));
  const canSellAt = gate.indexOf('canSell ?');
  const linkoutAt = gate.indexOf('linkout ?');
  assert.ok(canSellAt > -1, 'the gate must branch on canSell');
  assert.ok(linkoutAt > -1, 'the link-out branch must survive for iOS');
  assert.ok(canSellAt < linkoutAt, 'canSell must be checked before the steer to the web');
});

test('the link-out survives for the store that still needs it', () => {
  // iOS sells nothing in-app yet, so SubscribeLink is its only route. Deleting it as
  // "superseded" would leave iOS non-subscribers with nothing at all.
  assert.match(ctaCode, /<SubscribeLink \/>/, 'iOS still needs the steer out');
});
