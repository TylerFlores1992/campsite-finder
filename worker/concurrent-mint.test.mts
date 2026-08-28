// Can carts be minted CONCURRENTLY, or do simultaneous requests race for one cart?
//
// `--cart-ladder` proved one session holds ten carts and twenty reservations — minting them
// strictly in SEQUENCE, each cart filled and proven full before the next was asked for. The
// production runner carts serially for the same reason, and at RC_HOLD_CAPACITY = 20 a
// release where every hold shares one `release_at` is twenty carts back to back through one
// Chromium.
//
// Parallelising has one unmeasured precondition: if N simultaneous NO_CART requests all
// receive the SAME new cart, two succeed and the rest fail with RC's per-cart message —
// turning a 20-capacity morning into a 2-capacity one, and doing it in a way that reads like
// an RC limit rather than a race we caused. That misreading is the expensive part.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-probe.mjs', 'utf8');
// SCOPED TO THIS MODE'S BLOCK, AND THE END ANCHOR IS LOAD-BEARING. It used to run to
// `if (signedIn && (CART_CAP || CART_LADDER))`, which was the next block at the time;
// `--cart-lapse` was then inserted between the two, and because that mode ALSO refuses a
// verdict with the words "THE QUESTION WAS NEVER REACHED", deleting this block's own copy
// left every assertion below still matching. Verified 2026-08-27: the suite passed 15/15
// against a probe whose concurrent-mint verdict had been removed. Anchor on the NEXT block,
// whatever it is, and re-check this line when one is added.
const BLOCK = SRC.slice(SRC.indexOf('if (signedIn && CONCURRENT_MINT)'),
                        SRC.indexOf('if (signedIn && CART_LAPSE)'));
const code = BLOCK.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the mints actually overlap', () => {
  // Sequential awaits would measure nothing — the ladder already knows carts can be minted
  // one after another. The whole question is what happens when they do not wait.
  assert.match(code, /await Promise\.all\(units\.map\(/,
    'the requests must be fired together, not awaited in turn');
  assert.match(code, /cartKey: NO_CART/, 'every request must ask for a FRESH cart');
});

/**
 * THE SECOND RUN REPORTED "THEY RACE" OVER SIX REQUESTS THAT NEVER ARRIVED (2026-08-17).
 *
 * Six submits failed, every key came from `finalKey` — which is `localStorage
 * ['shoppingCartKey']`, the session's EXISTING pointer that every request reads and none
 * of them mints — so six reads of one shared value counted as one distinct cart and the
 * probe declared a race. `status` was 0, meaning the fetch threw; the whole run took 0.1s
 * against 4.3s for the run that worked, and `netError` held the reason and was never shown.
 *
 * That is the most expensive misread available here: it would retire the parallel-cart plan
 * on a run where nothing was ever asked of RC.
 */
test('only a SUBMIT key counts toward the distinct-cart tally', () => {
  assert.match(code, /results\.filter\(\(r\) => r\.fromSubmit\)\.map\(\(r\) => r\.key\)/,
    'finalKey is a read of shared state — N reads are always 1 distinct, i.e. a fake race');
  assert.ok(!/const keys = results\.map\(\(r\) => r\.key\)/.test(code),
    'counting every key is what manufactured the race verdict');
});

test('a thrown request is distinguished from RC refusing', () => {
  // `call()` returns status 0 with an empty body when the fetch throws, and an empty body
  // parses as "(unparseable body)" — so "RC declined" and "RC was unreachable" printed the
  // same line. One is a fact about RC; the other is a fact about this box's network.
  assert.match(code, /netError/, 'the network error must be carried out of precartInPage');
  assert.match(code, /NO ANSWER \(request failed\)/, 'and named differently from REFUSED');
  assert.match(code, /the fetch threw, NOT an RC response/,
    'HTTP 0 must be explained where it is printed, not left as a bare zero');
});

test('no accepted submit means NO verdict about racing', () => {
  const verdict = code.slice(code.indexOf('reached === 0'));
  assert.match(code, /const reached = results\.filter\(\(r\) => r\.ok === true\)\.length/);
  assert.match(verdict, /THE QUESTION WAS NEVER REACHED/);
  assert.ok(code.indexOf('reached === 0') < code.indexOf('THEY RACE'),
    'the never-reached arm must be tested BEFORE the race arm, or a failed run still races');
  assert.match(code, /keys\.length >= 2 && distinct\.size < keys\.length/,
    'a race needs at least two ACCEPTED submits handed the same cart');
});

test('the verdict counts DISTINCT keys, not successful calls', () => {
  // N calls returning a key is not N carts. RC handing the same new cart to all of them
  // would look like total success right up to the moment the sites collide.
  assert.match(code, /new Set\(keys\)/);
  assert.match(code, /distinct\.size === units\.length/,
    'safety requires one distinct cart PER request');
  assert.match(code, /distinct\.size < keys\.length/, 'a collision must be named as a race');
});

test('a key is not treated as a held site', () => {
  // Same rule the ladder follows: judge by reading the cart back, never by the response.
  assert.match(code, /listCartEntries\(/, 'each cart must be read back before it counts');
  assert.match(code, /matched\.push/, 'and only an identified entry counts as evidence');
});

test('the cart entry is matched on placeId + facilityId, never on the unit id', () => {
  // `findCartEntry`'s own header records that RC's cart entries carry NO unit field, and
  // that a matcher looking for one reported an empty cart for a full one twice. This probe
  // then called it with `{ unitId }` alone and did it a third time — six real campsites
  // locked, released nothing, and the run reported INCONCLUSIVE over six successful carts.
  assert.match(code, /LockedShoppingCart/, 'the pair comes off the load response');
  assert.match(code, /Number\(e\.PlaceId\) === Number\(r\.locked\.placeId\)/);
  assert.match(code, /Number\(e\.FacilityId\) === Number\(r\.locked\.facilityId\)/);
  assert.ok(!/\{ unitId: r\.unitId \}/.test(code),
    'a unit-id-only read-back is the documented mistake, not a fallback');
});

test('release is driven by the cart CONTENTS, not by the match', () => {
  // The safety property has to be independent of the evidence property. A cart minted with
  // NO_CART in this run holds only what this run put there, so releasing everything in it
  // is a guarantee about how the cart was CREATED — which cannot rot the way a matcher can,
  // and which is what stops a broken read-back stranding a campsite for a third time.
  const release = code.slice(code.indexOf('for (const e of entries)'));
  assert.match(release, /made\.push\(/, 'every entry found in a minted cart must be released');
  const push = code.slice(0, code.indexOf('for (const e of entries)'));
  assert.ok(!/if \(hit\) made\.push/.test(push),
    'the release list must not be gated on identifying the entry');
});

test('everything taken is released, and only that', () => {
  assert.match(code, /finally \{/, 'the release must survive a throw mid-run');
  assert.match(code, /releaseEntry\(/);
  assert.ok(!/empty\/shoppingcart|CART_EMPTY/.test(code),
    "never empty the cart — the bot's own may hold a site somebody is claiming");
  assert.match(code, /restored the session/, "the profile's cart pointer must be put back");
});

test('a partial result is INCONCLUSIVE, never a green light', () => {
  // Distinct keys with sites missing means something other than the race decided the run,
  // and reporting that as "safe to parallelise" is how the 08:00 path gets a change it
  // never earned.
  const verdict = code.slice(code.indexOf('distinct.size === units.length'));
  assert.match(verdict, /INCONCLUSIVE/);
  // [\s\S] rather than the /s flag: tsconfig.worker.json targets below es2018, where
  // dotAll is a compile error. Caught by CI, not locally, because `npm run verify` chains
  // typecheck FIRST and short-circuits -- so a failing typecheck produces NO test output
  // at all, which is easy to read as "nothing to report".
  assert.match(verdict, /before[\s\S]*concluding anything about concurrency/);
});

test('an unknown mode flag stops the probe instead of half-running', () => {
  // Running `--concurrent-mint` against a checkout that predates it silently ignored the
  // flag: steps 1-3 and 7 ran, the sign-in reported success, and the output read like a
  // complete probe that found nothing. Observed 2026-08-17 with the mini-PC one merge
  // behind — which is its NORMAL state, since it updates on update.bat, a quiet window or
  // a human rather than on push.
  assert.match(SRC, /const KNOWN_FLAGS = new Set\(\[/);
  assert.match(SRC, /THIS BUILD DOES NOT KNOW/);
  assert.match(SRC, /process\.exit\(2\)/,
    'it must exit non-zero — a partial run that looks complete is the failure');
  // Every mode this file implements must be listed, or the guard rejects a real flag.
  for (const flag of ['--cart-cap', '--cart-ladder', '--concurrent-mint']) {
    assert.ok(SRC.includes(`'${flag}'`), `${flag} must be in KNOWN_FLAGS`);
  }
});

/**
 * THE FIRST REAL RUN ANSWERED NOTHING, AND THAT WAS THE PROBE'S FAULT.
 *
 * 2026-08-17: six units fired, six DISTINCT keys, "0 site(s) actually held", verdict
 * INCONCLUSIVE. Two completely different stories share that output — the submits failed
 * silently, or they worked and the read-back missed them — and neither could be ruled out,
 * so a run that locked six real campsites bought no information at all.
 *
 * Cause: errors were printed only when non-empty, the submit's own `IsSuccess` was never
 * shown, and the cart's entry COUNT was thrown away. Same two-causes-one-signal shape this
 * repo is built around.
 */
test('every unit reports the submit verdict, not just an error string', () => {
  // `IsSuccess` is what RC actually sets. A missing error is not a success.
  assert.match(code, /r\.ok === true \? 'IsSuccess'/,
    'the submit verdict must be printed for every unit, including the successes');
  assert.match(code, /'\(no answer\)'/, 'no answer at all is a third state, not a failure');
  assert.match(code, /isSuccess === true/, 'read RC\'s own field, never the status code');
});

test('a key is attributed to load or to submit', () => {
  // `load` alone hands back a cart key. Treating that as evidence the site went in is how
  // "six distinct carts" gets read as "six holds" — the carts were empty.
  assert.match(code, /fromSubmit/);
  assert.match(code, /key via/, 'the output must say which call produced the key');
});

test('the read-back reports the cart SIZE', () => {
  // An empty cart means the submit never landed; a populated cart with no match means the
  // read-back is wrong. Both are `found: false` and without the count they are one line.
  assert.match(code, /entries\.length/, 'the entry count is the discriminator');
  assert.match(code, /ours NOT among them/,
    'and it must distinguish "empty" from "ours is missing"');
});

test('N distinct carts each holding one reservation is a POSITIVE result', () => {
  // The question is "does a concurrent NO_CART get its own cart that accepts a booking?".
  // N distinct keys and N carts of one answers it; identifying WHICH entry is corroboration.
  // The first run had exactly this and printed INCONCLUSIVE, which is how a probe that has
  // already cost real locked campsites gets run again for no new information.
  const verdict = code.slice(code.indexOf('distinct.size === units.length'));
  assert.match(verdict, /cartCounts\.every\(\(n\) => n === 1\)/,
    'every minted cart must hold exactly one — a cart of two is a different finding');
  assert.match(verdict, /CONCURRENT MINTING WORKS/);
  assert.ok(verdict.indexOf('CONCURRENT MINTING WORKS') < verdict.indexOf('INCONCLUSIVE'),
    'the positive branch must be reached before the catch-all, or it is unreachable');
});
