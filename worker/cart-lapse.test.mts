// How long does RC hold a cart entry BY ITSELF? `rc-probe.mjs --cart-lapse` measures it.
//
// WHY THIS NUMBER IS WORTH A LOCKED CAMPSITE. `RC_CART_HOLD_MINUTES` is 15 and its own
// comment in `limits.ts` says it was read off RC's bundle and never observed. The only
// real datum bounds it from BELOW: on 2026-08-25 an unclaimed hold was still in the cart
// at 45 minutes, when our own `expireStaleHolds(45)` removed it and RC answered 200. So
// the bundle's figure is out by at least 3x with no upper bound at all — and
// `HOLD_LAPSE_MIN` (180) justifies itself as "far enough past both … even if the real
// number is several times what the bundle claims", three of which are already spent.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT IS A CONFIDENT WRONG NUMBER, because that is
// how "~15 minutes" got written down in the first place. Every assertion below guards a
// path that would produce one: a precart that silently failed reported as an instant
// lapse, one unreadable response reported as RC letting go, or a run that hit its own
// time cap reported as "RC holds carts forever".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-probe.mjs', 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('if (signedIn && CART_LAPSE)'),
                        SRC.indexOf('if (signedIn && (CART_CAP || CART_LADDER))'));
// Comments are stripped so a guard can never be satisfied by the prose explaining it —
// this file's header quotes several of the strings it asserts on.
const code = BLOCK.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the block was found at all', () => {
  assert.ok(BLOCK.length > 500, 'the --cart-lapse block is missing or the anchors moved');
});

/**
 * THE CONTROL, AND WITHOUT IT THE RUN IS WORSE THAN USELESS.
 *
 * A precart that silently failed leaves an empty cart. Poll that and the first read is
 * ABSENT — so the probe would report RC dropping the cart within seconds: an instant,
 * dramatic, entirely fabricated answer to the exact question it was built for. `--cart-cap`
 * has step 3 for this reason and `--concurrent-mint` refuses a verdict when no submit was
 * accepted; this is the same discipline one mode along.
 */
test('the entry is confirmed present BEFORE the clock starts', () => {
  const control = code.slice(0, code.indexOf('const started = Date.now()'));
  assert.ok(control.includes('const first = await readCart()'),
    'the cart must be read back before timing anything');
  assert.match(control, /first\.state !== 'PRESENT'/,
    'and a read that is not PRESENT must be handled as its own case');
  assert.match(control, /THE QUESTION WAS NEVER REACHED/,
    'a failed precart must refuse a verdict, never report a lapse at minute 0');
  assert.ok(code.indexOf('const first = await readCart()') < code.indexOf('const started = Date.now()'),
    'the control must run BEFORE the clock, or it is not a control');
});

test('a failed control is not reported as RC dropping the cart', () => {
  // Anchored on the next statement rather than on `} else {` — that brace pair first occurs
  // in the feed-guard block far above, so the slice came back EMPTY and the assertion
  // passed on nothing until it was read.
  const arm = code.slice(code.indexOf("first.state !== 'PRESENT'"), code.indexOf('held = { cartKey'));
  assert.match(arm, /Do NOT read this as/,
    'the operator must be told explicitly what this reading is not');
});

/**
 * AN UNREADABLE CART IS NOT AN EMPTY ONE — the third instance of RC's cart shape faking one.
 *
 * `listCartEntries` returns `{entries: []}` on a non-200 or an unparseable body, and
 * `findCartEntry` returns `{found: false}` on any throw. Both are right for CLEANUP and
 * fatal here, where ABSENT is the signal being measured: one 502 becomes "RC dropped the
 * cart". So this mode parses for itself and anything it does not understand is UNKNOWN.
 */
test('the cart read is three-valued, and UNKNOWN never advances the verdict', () => {
  const reader = code.slice(code.indexOf('const readCart = async ()'),
                            code.indexOf('const first = await readCart()'));
  assert.match(reader, /state: 'UNKNOWN'/, 'an unreadable cart must have its own state');
  // PRESENT and ABSENT come back through one ternary on the match, so there is no literal
  // `state: 'PRESENT'` to look for. Asserting the key form matched the shape this guard
  // imagined rather than the shape the probe has.
  assert.match(reader, /state: hit \? 'PRESENT' : 'ABSENT'/,
    'the two knowable outcomes must be decided by the match, not defaulted');
  // EACH CONDITION IS PINNED TO WHAT IT RETURNS, NOT MERELY TO EXISTING. The first version
  // asserted `/!resp\.ok\(\)/` — so flipping that branch's result from UNKNOWN to ABSENT,
  // which is precisely the bug, left the condition in place and the guard green. Verified:
  // that mutation survived. Pin the comparison, not the branch it guards.
  for (const [why, re] of [
    ['a request that threw', /if \(!resp\) return \{ state: 'UNKNOWN'/],
    ['a non-200', /if \(!resp\.ok\(\)\) return \{ state: 'UNKNOWN'/],
    ['an unparseable body', /catch \{ return \{ state: 'UNKNOWN', why: 'the body did not parse' \}/],
    ['a missing Result', /if \(res == null\) return \{ state: 'UNKNOWN'/],
    ['a shape we do not understand', /if \(!Array\.isArray\(list\)\) return \{ state: 'UNKNOWN'/],
  ]) assert.match(reader, re as RegExp, `${why} must read as UNKNOWN, not as an empty cart`);

  // The lenient helpers must not decide the verdict. They are fine for cleanup and this
  // block does its own cleanup by key, so it should not reach for them at all.
  assert.ok(!/listCartEntries\(|findCartEntry\(/.test(code),
    'the two-valued helpers must not be what this verdict is read from');
});

test('an UNKNOWN read is counted as neither', () => {
  const loop = code.slice(code.indexOf('while (mins() < LAPSE_MAX_MIN)'));
  assert.match(loop, /not counted/, 'the log must say the reading was skipped');
  // PINNED BY COUNT AND ORDER rather than by slicing the arm. Brace-matching on
  // `} else {` picked up an inner `if/else` in the PRESENT arm, so the "arm" being
  // checked contained the ABSENT branch and the assertion failed against correct code.
  // The rule is simply that neither end of the bracket is written anywhere but its own
  // arm, and the unknown arm is last.
  const assigns = (re: RegExp) => (loop.match(re) ?? []).length;
  assert.equal(assigns(/lastPresent = t/g), 1, 'exactly one place may advance the present end');
  assert.equal(assigns(/firstAbsent = t/g), 1, 'exactly one place may open the absent end');
  assert.ok(loop.indexOf('lastPresent = t') < loop.indexOf('unknowns += 1'),
    'the unknown arm is last, so no bracket assignment may follow it');
  assert.ok(loop.indexOf('firstAbsent = t') < loop.indexOf('unknowns += 1'),
    'the unknown arm is last, so no bracket assignment may follow it');
});

/**
 * ONE ABSENT READ IS NOT THE ANSWER, and a cart that comes BACK is worth its own line —
 * it means one of the two reads was lying and the bracket would have been wrong.
 */
test('a lapse is confirmed on a second read before it is declared', () => {
  const loop = code.slice(code.indexOf('while (mins() < LAPSE_MAX_MIN)'));
  assert.match(loop, /if \(firstAbsent == null\) \{/,
    'the first ABSENT must arm a confirmation rather than conclude');
  assert.ok(loop.indexOf('confirming on the next read') < loop.indexOf('RC DROPPED THE CART'),
    'the verdict must come after the confirmation, not before it');
  assert.match(loop, /was spurious/, 'a cart that returns must be reported, not silently ignored');
});

test('the answer is a BRACKET, because a poll cannot be more precise than its interval', () => {
  const verdict = code.slice(code.indexOf('RC DROPPED THE CART'));
  assert.match(verdict, /BETWEEN t\+\$\{lastPresent/, 'both ends of the bracket must be printed');
  assert.match(verdict, /firstAbsent/);
  assert.match(verdict, /the whole precision/,
    'and the interval must be named so the number is not quoted as exact');
});

/**
 * HITTING THE TIME CAP IS A LOWER BOUND. Reporting it as "RC holds carts forever" would be
 * the same class of claim as the 15 this probe exists to replace.
 */
test('running out of time is reported as a lower bound, not as an answer', () => {
  const timeout = code.slice(code.indexOf('NO LAPSE IN'));
  assert.match(timeout, /LOWER BOUND, not the answer/);
  assert.match(timeout, /Do NOT record/, 'the wrong conclusion must be named and refused');
});

/**
 * IT LOCKS A REAL CAMPSITE. Everything below is what stops the measurement costing one.
 */
test('the site is released on every exit path', () => {
  assert.match(code, /finally \{/, 'the release must survive a throw mid-run');
  assert.match(code, /releaseEntry\(/);
  assert.match(code, /process\.once\('SIGINT'/,
    'an interrupted run is the likeliest way this strands the site it is measuring, ' +
    'and `finally` does not run on SIGINT');
  assert.ok(!/empty\/shoppingcart|CART_EMPTY/.test(code),
    'never empty the whole cart — that would take a real hold with it');
  assert.match(code, /restored the session/, "the profile's cart pointer must be put back");
});

test('a confirmed lapse stops the release, because RC already let go', () => {
  const loop = code.slice(code.indexOf('while (mins() < LAPSE_MAX_MIN)'));
  const declared = loop.slice(loop.indexOf('RC DROPPED THE CART'));
  assert.match(declared, /held = null/,
    'RC dropped it, so the finally must not then post a release for an entry that is gone');
});

/**
 * IT REFUSES NEAR A RELEASE. The run holds a cart for hours; at 08:00 that is one of the ten
 * cart slots `RC_HOLD_CAPACITY` is built on, spent on a measurement.
 *
 * AND AN UNREACHABLE FEED REFUSES TOO. "We could not find out" is not permission — the same
 * rule the updater's own release check follows, and the one `unknown` has followed since it
 * stopped rounding to "signed-out".
 */
test('it refuses to start when a release is near, or when it cannot tell', () => {
  const guard = code.slice(code.indexOf('const guard = await'), code.indexOf('if (!guard.ok)'));
  assert.match(guard, /nextRelease/, 'the feed is the only thing that knows');
  assert.match(guard, /LAPSE_MAX_MIN \+ 60/,
    'the window must cover the run itself plus margin, not a fixed guess');
  // EACH BRANCH IS PINNED TO `ok: false`, NOT COUNTED. The first version asserted the
  // reason strings existed and that `ok: false` appeared at least four times — so flipping
  // the unreachable-feed branch to `ok: true` left its string in place and four other
  // refusals behind it, and the guard passed. Verified: that mutation survived. A count is
  // not a pairing.
  for (const [why, re] of [
    ['no token', /if \(!token\) return \{ ok: false/],
    // `res.ok` is a PROPERTY here — this branch uses `fetch`, not Playwright's request
    // context, whose `ok()` is a method. Getting that backwards failed against correct code.
    ['a non-200', /if \(!res\.ok\) return \{ ok: false, why: `the feed answered/],
    ['a throw', /return \{ ok: false, why: `the feed was unreachable/],
    ['an unparseable release time', /return \{ ok: false, why: `could not read nextRelease/],
    ['a release inside the run', /return \{ ok: false, why: `a hold releases in/],
  ]) assert.match(guard, re as RegExp, `${why} must be a refusal, not a start`);
  assert.match(code.slice(code.indexOf('if (!guard.ok)')), /REFUSING TO START/);
});

test('the cart is minted FRESH, so it holds only what this run put in it', () => {
  assert.match(code, /cartKey: NO_CART/,
    'a shared cart could contain a real hold, and its contents would not be ours to reason about');
});

/**
 * THE ENTRY IS MATCHED ON (placeId, facilityId), NEVER ON THE UNIT ID. RC's cart entries
 * carry no unit field at all — `findCartEntry`'s own header records that matching on one
 * "reported an empty cart for a full one, twice", and a third time on 2026-08-17, which is
 * what left six real campsites locked. Here it would also invert the measurement: a matcher
 * that never matches reports the cart as dropped immediately.
 */
test('the entry is matched on the pair off the load response', () => {
  assert.match(code, /LockedShoppingCart/, 'the pair comes off the LOAD response');
  assert.match(code, /Number\(e\.PlaceId\) === Number\(locked\.PlaceId\)/);
  assert.match(code, /Number\(e\.FacilityId\) === Number\(locked\.FacilityId\)/);
  assert.ok(!/includes\(String\(unitId\)\)/.test(code),
    'never fall back to searching the entry JSON for the unit id');
});

/**
 * A UNIT ID MUST COME FROM THE OPERATOR, NEVER FROM A DEFAULT. An invented id can collide
 * with a real site and lock it — the rule broken on 2026-08-17, when six ids were written
 * into a paste-ready block in the same message that said never to guess them.
 */
test('it will not run without an explicitly supplied unit and date', () => {
  assert.match(code, /if \(!unitId \|\| !arrival\)/, 'both must be required');
  assert.ok(!/RC_LAPSE_UNIT\s*\|\|\s*['"]\d/.test(SRC),
    'RC_LAPSE_UNIT must have no numeric default');
  assert.match(code, /rc-test-hold\.mts --find/,
    'and the skip message must say where a real id comes from');
});

test('the flag is known to the build, so an old checkout says so', () => {
  // A mode flag this build does not know is an error, not a no-op: the mini-PC is routinely
  // a commit or two behind, and on 2026-08-17 a missing --concurrent-mint read as "the probe
  // ran and found nothing".
  const flags = SRC.slice(SRC.indexOf('const KNOWN_FLAGS = new Set(['));
  assert.match(flags.slice(0, flags.indexOf(']')), /'--cart-lapse'/);
});
