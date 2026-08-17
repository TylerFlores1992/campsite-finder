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
const BLOCK = SRC.slice(SRC.indexOf('if (signedIn && CONCURRENT_MINT)'),
                        SRC.indexOf('if (signedIn && (CART_CAP || CART_LADDER))'));
const code = BLOCK.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the mints actually overlap', () => {
  // Sequential awaits would measure nothing — the ladder already knows carts can be minted
  // one after another. The whole question is what happens when they do not wait.
  assert.match(code, /await Promise\.all\(units\.map\(/,
    'the requests must be fired together, not awaited in turn');
  assert.match(code, /cartKey: NO_CART/, 'every request must ask for a FRESH cart');
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
  assert.match(code, /findCartEntry\(/, 'each cart must be read back before it counts');
  assert.match(code, /found\?\.found/, 'and only a found entry may be released later');
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
