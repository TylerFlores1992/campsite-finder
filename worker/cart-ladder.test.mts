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
  // PINNED ON THE THIRD ADD, not on a variable name. An earlier version matched
  // `isCapRefusal(c.err)` and went red when `c` was repurposed for the unit control — the
  // guard was right about the rule and wrong about how it identified it.
  const thirdAdd = code.slice(code.indexOf('const third = await attempt('));
  assert.match(thirdAdd, /isCapRefusal\(third\.err\)/,
    "the third add must be matched against RC's own cap wording");
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
  // AT LEAST six, not exactly six: spare units are what let a refusal be disambiguated
  // instead of reported as undecidable, so a longer list is strictly better.
  assert.match(SRC, /units\.length < needUnits/);
});

/**
 * THE ACCOUNT LIMIT IS THE GROWTH NUMBER, and it must never be inferred from one refusal.
 *
 * RC's only documented rule is per CART. A refusal arriving when the cart is NOT full
 * therefore cannot be that rule — it is the first sign of a session/account limit, which is
 * the constraint that decides whether carts are a growth path at all.
 *
 * But it has a second reading: that unit may simply not be bookable. Those need opposite
 * responses and arrive as the same refusal — the house failure shape. So a refusal is only
 * evidence once a DIFFERENT unit is refused at the same point.
 */
test('an account limit is only claimed after a second unit is refused too', () => {
  assert.match(code, /const control = async \(cartKey, what\)/,
    'a refusal must be retried with a different unit before it means anything');
  assert.match(code, /why: 'account-limit'/);
  // The control must be REQUIRED: only `!c.ok` — a second refusal — may set account-limit.
  assert.match(code, /else if \(!c\.ok\) stopped = \{ rung, why: 'account-limit'/,
    'only a SECOND refusal may be called an account limit');
  // EVERY account-limit verdict must be immediately guarded by the CONTROL's result.
  //
  // The first version of this assertion matched one single-line shape and a mutation that
  // put the assignment on its own line walked straight through it — a guard written from
  // the shape of the bug rather than from the rule. This looks at each occurrence and
  // requires `!c.ok` in the text just before it, so the verdict cannot be reached from a
  // first refusal however the branch is written.
  const verdicts = [...code.matchAll(/why: 'account-limit'/g)];
  assert.ok(verdicts.length >= 2, 'both the mint and the fill refusal must be handled');
  for (const m of verdicts) {
    const before = code.slice(Math.max(0, m.index! - 160), m.index!);
    assert.match(before, /!c\.ok/,
      'an account limit must follow a SECOND refusal, never a first');
  }
});

test('no spare unit means UNDECIDABLE, never a number', () => {
  // "We could not tell" is a real answer; a ceiling guessed from one refusal is not.
  assert.match(code, /if \(c === null\) stopped = \{ rung, why: 'undecidable'/,
    'an empty pool must yield undecidable at both the mint and the fill');
  const undecidable = code.slice(code.indexOf("why === 'undecidable'"), code.indexOf("why === 'cap-not-firing'"));
  assert.match(undecidable, /FLOOR on the account, not the limit/,
    'an undecidable run reports a floor, never a ceiling');
});

test('the reservation count travels with every verdict', () => {
  // The number the decision needs is "how many did ONE account hold", not "how many carts".
  assert.match(code, /let held = 0;/);
  assert.match(code, /held\b/, 'the count must be carried into the stopped record');
  const stops = code.match(/stopped = \{[^}]*\}/g) ?? [];
  assert.ok(stops.length >= 5, 'expected every stop reason to be represented');
  for (const st of stops) {
    assert.match(st, /held/, `a stop reason without the reservation count: ${st}`);
  }
});
