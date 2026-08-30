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
  // ANCHORED ON THE MOUNT, NOT THE PROP LIST. The first version matched the bare
  // self-closing `<StorePlansLink />` and broke the moment the component took
  // `variant`/`fullWidth` — a guard failing over a change to something it does not care
  // about. What it exists to pin is that this surface offers the route at all.
  assert.match(ctaCode, /<StorePlansLink[\s/>]/, 'SubscribeCta must offer the route');
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

// ─── THE SENTENCE BESIDE THE LINK (2026-08-30, hours after the link shipped) ──────────

test('the sentence does not say "managed at camphawk.app" where the app can sell', () => {
  // Observed on a real device: "Subscriptions are managed at camphawk.app. See plans" —
  // the sentence sending a user to a website while the link beside it opened an in-app
  // purchase. StorePaywall's own header had already written the rule down and it was read
  // as being about that component rather than about this string.
  // ANCHORED ON THE BRANCH, NOT THE IDENTIFIER. The first version compared
  // `indexOf('canSell')` — which finds the `const canSell = …` DECLARATION at the top of
  // the function, above everything — so a mutation that moved the real test below both
  // website branches passed. `canSell` occurs twice; only one occurrence is the decision.
  const fn = body(nativeCode, 'export function useSubscribeSentence');
  const canSellAt = fn.indexOf('if (canSell)');
  const camphawkAt = fn.indexOf('camphawk.app');
  assert.ok(canSellAt > -1, 'the sentence must BRANCH on whether the app can sell');
  assert.ok(camphawkAt > -1, 'the other two cases still name the website');
  assert.ok(canSellAt < camphawkAt,
    'the canSell branch must come BEFORE any branch that names the website');
});

test('the in-app case names no website at all', () => {
  // Not "shorter copy" — a sentence that mentions camphawk.app while a buy route sits
  // beside it is the same defect in a milder costume.
  const fn = body(nativeCode, 'export function useSubscribeSentence');
  const inApp = fn.slice(fn.indexOf('if (canSell)'), fn.indexOf('return linkout'));
  assert.doesNotMatch(inApp, /camphawk\.app/, 'the in-app sentence must not steer out');
});

test('both website cases survive — iOS still has nowhere else to go', () => {
  const fn = body(nativeCode, 'export function useSubscribeSentence');
  assert.match(fn, /set up at camphawk\.app/, 'the link-out sentence must stay for iOS');
  assert.match(fn, /managed at camphawk\.app/, 'the no-route sentence must stay');
});

// ─── THE SHAPE IN THE SUBMIT BUTTON'S SLOT (2026-08-30) ──────────────────────────────
//
// Reported twice, looking at /new: "there is no start watch." Correct — SubscribeCta
// REPLACES the submit control for a non-subscriber, on web and in the app alike. The web
// replacement is a full-width Button; the native one was a <p> of text-ch-fine grey copy.
// Same gate, same position, and one of them does not look like a control.

test('where the app can sell, the replacement is a BUTTON not a sentence', () => {
  const fn = body(ctaCode, 'export default function SubscribeCta');
  const branch = fn.slice(fn.indexOf('if (canSell)'), fn.indexOf('text-ch-fine'));
  assert.ok(branch.length > 0, 'the canSell branch must come before the sentence branch');
  assert.match(branch, /variant="button"/, 'it must render as a button, not an inline link');
  assert.match(branch, /fullWidth=\{fullWidth\}/,
    'it stands in a full-width submit control slot and must honour it');
});

test('both shapes share ONE gate', () => {
  // Two components would be two places to forget useStoreCanSell, and the failure of the
  // forgotten one is a buy control on a shell that cannot buy.
  const fn = body(nativeCode, 'export function StorePlansLink');
  assert.match(fn, /const canSell = useStoreCanSell\(\)/, 'one gate for both shapes');
  assert.match(fn, /if \(!canSell\) return null/);
  assert.match(fn, /variant === "button"/, 'the button shape lives behind that same gate');
  assert.doesNotMatch(nativeCode, /export function StorePlansButton/,
    'a second component is a second place to forget the gate');
});

test('the no-route case keeps the sentence, and keeps the iOS steer', () => {
  // Where nothing can be pressed, a sentence is the honest shape. Turning it into a button
  // that leads to a page which cannot sell is the claim-copy failure inverted.
  const fn = body(ctaCode, 'export default function SubscribeCta');
  const tail = fn.slice(fn.indexOf('text-ch-fine'));
  assert.match(tail, /<SubscribeSentence \/>/, 'the sentence survives for iOS');
  assert.match(tail, /<SubscribeLink \/>/, 'iOS still needs its steer out');
  assert.doesNotMatch(tail, /<StorePlansLink/,
    'the plans link must not also sit in the branch that cannot sell');
});
