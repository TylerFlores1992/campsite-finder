// The cart ladder must never report a ceiling it did not reach.
//
// `--cart-cap` answered "is the cap per cart?" and stopped at two, saying so. That left
// RC_MAX_CARTS = 1 out of caution, and because `holdWindowLoad` counts holds GLOBALLY the
// whole product carts RC_SITES_PER_CART x 1 = 2 sites per release, for all customers
// combined. The ladder exists to turn that from a guess into a number.
//
// These are SOURCE assertions: the probe drives a real browser against ReserveCalifornia and
// cannot be executed here. What CAN be pinned is the discipline -- every way this probe could
// report a ceiling it has not earned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-probe.mjs', 'utf8');
const LADDER = SRC.slice(SRC.indexOf('const runLadder ='), SRC.indexOf('      try {', SRC.indexOf('const runLadder =')));
/** Comments quote the failure modes to explain them; a guard must not read its own prose. */
const code = LADDER.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('a fresh key that we already hold is NOT counted as a new cart', () => {
  // The entire measurement. RC returning the site to an existing cart means it minted
  // nothing, and counting that as a rung would inflate the ceiling — the one direction
  // that costs a real customer a campsite.
  assert.match(code, /keys\.includes\(a\.key\)/,
    'a repeated cart key must stop the ladder, not extend it');
  assert.match(code, /why: 'same-cart'/);
});

test('every rung requires a genuine cap refusal before asking for the next cart', () => {
  // RC only mints a new cart once the current one is full. Without proving the refusal is
  // THE CAP, a fresh key proves nothing about a ceiling.
  assert.match(code, /isCapRefusal\(c\.err\)/, 'the control must match RC\'s own cap wording');
  assert.match(code, /why: 'other-refusal'/, 'a different refusal must be inconclusive, not a rung');
  assert.match(code, /why: 'cap-not-firing'/, 'a third add SUCCEEDING invalidates the premise');
});

test('running out of units is reported as a floor, never as a maximum', () => {
  // The failure this whole file guards against: "we tested three and it worked" becoming
  // "the limit is three". `--cart-cap` got this right ("NOT yet proven: how many carts")
  // and the ladder must not lose it.
  assert.match(code, /AT LEAST/, 'a completed ladder reports a floor');
  assert.match(code, /CEILING IS STILL NOT FOUND/, 'and says the ceiling was not reached');
  assert.match(code, /do not write down a maximum/i);
});

test('an inconclusive rung never yields a number', () => {
  const inconclusive = code.slice(code.indexOf("why === 'other-refusal'"), code.indexOf("why === 'same-cart'"));
  assert.match(inconclusive, /INCONCLUSIVE/);
  assert.ok(!/RC_MAX_CARTS/.test(inconclusive),
    'an inconclusive run must not recommend a constant — that is how a guess becomes config');
});

test('the ladder releases through the shared finally, and never empties the cart', () => {
  // The bot's own cart may be holding a site somebody is on their way to claim.
  const block = SRC.slice(SRC.indexOf('if (signedIn && (CART_CAP || CART_LADDER))'));
  const body = block.slice(0, block.indexOf('\n  }\n'));
  assert.match(body, /if \(CART_LADDER\) \{ await runLadder\(\); \} else \{/,
    'the ladder must run INSIDE the try, or its locks are never released');
  assert.ok(!/CART_EMPTY/.test(body), 'never empty the shopping cart — release entries individually');
});

test('--cart-ladder demands its own unit count', () => {
  // Six units, not three. Reusing the 3-unit gate would run a ladder with undefined units
  // and report a ceiling from a run that never happened.
  assert.match(SRC, /const needUnits = CART_LADDER \? 6 : 3;/);
  assert.match(SRC, /units\.length !== needUnits/);
});
