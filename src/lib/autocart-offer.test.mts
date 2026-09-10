// THE /new AUTO-CART CONTROL MUST NOT PROMISE A PLAN THE READER DOES NOT HAVE.
//
// THE DEFECT (found 2026-09-09 from a real subscriber). The toggle was gated on
// `supportsAutoCart(campgroundSource)` alone and on nothing about the person reading it. It
// defaults ON and says "We put the site in your Recreation.gov cart the moment it opens", with
// a TrustPanel under it. A base-tier subscriber created three watches with it left on; the
// poller's `isAutocartLane` correctly refuses and fails open to an ordinary alert, so the
// SAFETY was never in question — the PROMISE was.
//
// HALF THESE TESTS ARE STRUCTURAL, and that is deliberate. `autoCartOffer` can be perfect
// while `NewWatch` never calls it, or calls it and renders the promise anyway. That is the
// fix-present-and-inert shape this repo has recorded five times, and a pure-function test
// cannot see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoCartOffer, autoCartIntent } from './autocart-offer';

const NEW_WATCH = () =>
  readFileSync(new URL('../components/v2/NewWatch.tsx', import.meta.url), 'utf8');
/** Comments stripped — every string asserted below also appears in the note explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('a confirmed non-entitled reader gets the upsell, not the promise', () => {
  assert.equal(autoCartOffer({ loaded: true, autocart: false, unknown: false }), 'upsell');
});

test('an entitled reader keeps the historic control', () => {
  assert.equal(autoCartOffer({ loaded: true, autocart: true, unknown: false }), 'promise');
});

test('a FAILED lookup keeps the promise — unknown never downgrades a paying reader', () => {
  // The rule that stops a Clerk blip telling an Auto-Cart subscriber they are on the wrong
  // plan. `unknown` is "we could not tell", never "no".
  assert.equal(autoCartOffer({ loaded: true, autocart: false, unknown: true }), 'promise');
});

test('an unresolved lookup keeps the promise rather than flashing an upsell', () => {
  assert.equal(autoCartOffer({ loaded: false, autocart: false, unknown: false }), 'promise');
});

test('a signed-out visitor gets the upsell — deliberately, not by accident', () => {
  // `/new` is public and `useSubscription` reports signed-out as loaded/false/false, i.e. the
  // same shape as a confirmed base-tier subscriber. Correct: for both, auto-cart will not
  // happen for the watch they are about to create.
  assert.equal(autoCartOffer({ loaded: true, autocart: false, unknown: false }), 'upsell');
});

test('an upsell reader records NO auto-cart intent, whatever the toggle says', () => {
  // The column outlives the watch: a stale `true` would start carting real campsites the day
  // they upgrade, on a consent nobody gave.
  assert.equal(autoCartIntent('upsell', true), false);
  assert.equal(autoCartIntent('upsell', false), false);
});

test('an entitled reader still controls their own toggle', () => {
  assert.equal(autoCartIntent('promise', true), true);
  assert.equal(autoCartIntent('promise', false), false);
});

test('NewWatch gates the promising fieldset on the offer, not on the campground alone', () => {
  const src = code(NEW_WATCH());
  assert.match(
    src,
    /\{canAutoCart && offer === "promise" && \(/,
    'the carting promise must be gated on the reader, not only on supportsAutoCart'
  );
  assert.ok(
    src.includes('canAutoCart && offer === "upsell"'),
    'a confirmed non-entitled reader needs to be told what they DO get'
  );
});

test('NewWatch sends the intent, never the raw toggle', () => {
  const src = code(NEW_WATCH());
  assert.match(src, /autoCart: autoCartIntent\(offer, autoCart\)/);
  assert.doesNotMatch(
    src,
    /^\s+autoCart,$/m,
    'posting the bare toggle records intent the upsell reader was told they did not have'
  );
});

test('`offer` is in the submit dependency array', () => {
  // `useCallback` hands back a closure over whatever the deps were when it last rebuilt. This
  // exact array lost `autoCart` once already and posted a stale value; the note above it in
  // NewWatch says every value the body reads belongs here.
  const src = code(NEW_WATCH());
  const deps = src.match(/\}, \[campgroundId, campgroundName[^\]]*\]\);/);
  assert.ok(deps, 'the submit dependency array should still be findable');
  assert.match(deps[0], /\boffer\b/);
});

test('`offer` is declared ABOVE submit, or it is in the temporal dead zone', () => {
  const src = code(NEW_WATCH());
  const decl = src.indexOf('const offer = autoCartOffer(');
  const submit = src.indexOf('const submit = useCallback(');
  assert.ok(decl > -1 && submit > -1, 'both anchors must exist');
  assert.ok(decl < submit, 'the dependency array evaluates at render and would throw');
});

test('the RC hold panel is gated on the same offer — the sibling promise', () => {
  // The poller's hold offer is gated on `hasAutocartEntitlement`, so "we'll offer to cart it
  // the second it does" never arrives for a base-tier reader. Fixing the toggle above and
  // leaving this is a rule applied to one of two siblings asking the same question.
  const src = code(NEW_WATCH());
  assert.match(src, /\{canRcHold && offer === "promise" && \(/);
  assert.ok(src.includes('canRcHold && offer === "upsell"'), 'RC needs the honest twin too');
});

test('the RC upsell carries no BETA badge and no price', () => {
  // The badge caveats a promise; there is no promise in the upsell variant to caveat, and a
  // warning about something the reader is not being offered reads as a fault.
  const src = code(NEW_WATCH());
  const i = src.indexOf('canRcHold && offer === "upsell"');
  assert.ok(i > -1);
  const block = src.slice(i, src.indexOf('</div>', i));
  assert.doesNotMatch(block, /AUTOCART_BETA_LABEL/);
  assert.doesNotMatch(block, /\$\d/);
  assert.match(block, /href="\/pricing"/);
});

test('the upsell copy names no price', () => {
  // The App Store forbids a price in the native build, and this component renders in it.
  // `/pricing` already shows the right thing per platform; a second copy of that decision
  // here is how the gated surfaces drift apart.
  const src = code(NEW_WATCH());
  const i = src.indexOf('canAutoCart && offer === "upsell"');
  assert.ok(i > -1);
  const block = src.slice(i, src.indexOf('</fieldset>', i));
  assert.doesNotMatch(block, /\$\d/, 'no price may appear on this screen');
  assert.match(block, /href="\/pricing"/, 'the reader needs a way to act on it');
});
