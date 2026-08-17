// Carting a release group in parallel.
//
// Carting was strictly serial. At RC_HOLD_CAPACITY = 20 a release where every hold shares
// one `release_at` is twenty carts back to back at roughly a second each, so the twentieth
// site sits un-carted for twenty seconds after it frees — exposed to everyone else watching
// it — and the cost grows with the product rather than shrinking.
//
// `rc-probe.mjs --concurrent-mint` answered the precondition on 2026-08-17: six simultaneous
// NO_CART precarts produced six DISTINCT carts, each holding exactly one reservation, all
// six identified by (placeId, facilityId) and all six released, in 1.4s. Until that run the
// failure mode was live: if concurrent mints RACED for one cart, the losers would be refused
// in RC's own per-cart wording and read as an account limit rather than as a race we caused.
//
// Two properties do the work here and both are easy to break invisibly:
//   * the lead is waited ONCE PER RELEASE, and
//   * parallelism NEVER crosses a release boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
/** Comment-stripped, because the comments quote the shapes these tests forbid. */
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CART = code.slice(code.indexOf('const groups = new Map()'), code.indexOf('THE PASS DID NOTHING'));

test('holds are grouped by release, and the lead is waited once per group', () => {
  assert.match(CART, /groups\.set\(h\.releaseAt/, 'the group key is the release time');
  // The old shape waited inside the per-hold loop, where every wait after the first was
  // already zero — so the sequencing was pure serialisation gating nothing.
  const wait = CART.indexOf('msUntilRelease(');
  const fan = CART.indexOf('pMap(');
  assert.ok(wait > -1 && fan > -1 && wait < fan,
    'the wait must happen BEFORE the fan-out, or holds cart before their site is released');
  assert.ok(!/pMap\([\s\S]*msUntilRelease\(/.test(CART),
    'the lead must not be re-waited inside a task — that is the serialisation coming back');
});

test('parallelism never crosses a release boundary', () => {
  // Firing a later group early is the 2026-08-08 bug: a cart submitted 85 seconds before
  // the release was refused for a site RC had not let go of yet, and `failed` was terminal.
  // Each group must be awaited before the next one's wait begins.
  assert.match(CART, /for \(const \[releaseAt, holds\] of ordered\) \{/);
  assert.match(CART, /await pMap\(holds,/,
    'each group must be AWAITED — an unawaited fan-out overlaps every release at once');
  assert.ok(!/pMap\(cart,/.test(CART), 'the fan-out takes one group, never the whole list');
});

test('groups run earliest release first', () => {
  // `release_at` is zone-less Pacific TEXT in a fixed format, so it sorts lexically. Parsing
  // it would reintroduce the offset question that a bare NOW() already got wrong once.
  assert.match(CART, /\.sort\(\(a, b\) => \(a\[0\] < b\[0\] \? -1 : a\[0\] > b\[0\] \? 1 : 0\)\)/);
  assert.ok(!/new Date\(releaseAt\)/.test(CART),
    'never parse a zone-less Pacific string as a Date — it is seven hours adrift');
});

test('the concurrency is BOUNDED, and bounded at what was measured', () => {
  // The probe demonstrated six. It demonstrated nothing about twenty, and the next ceiling
  // is the WAF rather than RC's cart rules — this address has eaten a 12-hour block once.
  assert.match(code, /const CART_CONCURRENCY = Math\.max\(1, Number\(process\.env\.RC_CART_CONCURRENCY \|\| 4\)\)/);
  const n = Number(/RC_CART_CONCURRENCY \|\| (\d+)/.exec(code)?.[1]);
  assert.ok(n >= 1 && n <= 6,
    `the default must not exceed what --concurrent-mint actually demonstrated (6); got ${n}`);
  assert.match(code, /Math\.min\(limit, queue\.length\)/,
    'the worker count must never exceed the limit');
});

test('one hold failing does not cancel its siblings', () => {
  // Ordinary: RC refuses one site. The other nineteen still have a release to make, and
  // Promise.all would abandon them on the first rejection.
  const pmap = code.slice(code.indexOf('async function pMap('), code.indexOf('const TOKEN_SOURCE'));
  assert.match(pmap, /try \{ await task\(item, i\); \} catch/,
    'each task must be isolated inside the worker');
  assert.ok(!/await Promise\.all\(items\.map\(/.test(pmap),
    'a bare Promise.all over the items abandons the rest on the first rejection');
});

test('each hold still gets its OWN cart', () => {
  // The parallelism is worth nothing if the holds share a cart — RC caps a cart at two, so
  // a shared key turns a 20-capacity release into a 2-capacity one. This is the property
  // per-hold carting bought and the one a refactor here would most easily undo.
  assert.match(CART, /cartKey: h\.cartKey \|\| NO_CART/);
  assert.ok(!/localStorage\.getItem\('shoppingCartKey'\)/.test(CART),
    "the browser's pointer belongs to whichever hold went last — that was the bug");
});
