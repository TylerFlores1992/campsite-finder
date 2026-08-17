// Each hold gets its OWN ReserveCalifornia cart.
//
// RC caps a cart at two reservations (measured, with RC's own refusal as the control). The
// runner passed `localStorage["shoppingCartKey"]` for every hold, so every hold the system
// ever made was funnelled into ONE cart — and the third hold of a release came back refused
// in RC's own words. That was read as a hard limit on the account and written into
// RC_MAX_CARTS = 1.
//
// It was never RC's limit. `--cart-cap` held two carts live at once on one session and one
// account, so the ceiling was this line. Because `holdWindowLoad` counts holds GLOBALLY,
// that line capped the entire product at two carted sites per release.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RC_SITES_PER_CART, RC_MAX_CARTS, RC_HOLD_CAPACITY } from '../src/lib/limits.js';

const RUNNER = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
const HOLDS = readFileSync('src/lib/rc-holds.ts', 'utf8');
const ROUTE = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
/** Comments quote the removed shape to explain it; a guard must not read its own prose. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

test('the runner uses the HOLD\'s cart, never the browser pointer', () => {
  const body = code(RUNNER);
  assert.match(body, /cartKey: h\.cartKey \|\| NO_CART/,
    'each hold must mint or reuse its own cart');
  // The read is GONE, not merely unused — a live variable holding the previous hold's cart
  // is an invitation to the exact bug being removed.
  assert.ok(!/getItem\('shoppingCartKey'\)/.test(body),
    'the browser cart pointer must not be read by the runner at all');
});

test('a failed attempt still records the cart it tried', () => {
  // The one way per-hold carts could LOSE a site: a submit that landed while the read-back
  // did not leaves the entry in a cart nothing remembers, so the retry mints a fresh one,
  // looks in the wrong place, and the site sits orphaned until RC drops it. The old shared
  // cart got this right by accident.
  assert.match(code(RUNNER), /ok: false, error: String\(why\)\.slice\(0, 300\), cartKey/,
    'the runner must report the cart key on failure');
  assert.match(code(ROUTE), /reportCartFailure\([\s\S]{0,200}cartKey/,
    'the route must forward it');
  assert.match(code(HOLDS), /cart_key\s*=\s*COALESCE\(cart_key, \$4\)/,
    'and it must never overwrite a key the hold already has');
});

test('capacity reflects what was measured, and only that', () => {
  assert.equal(RC_SITES_PER_CART, 2, "RC's own cap, measured 2026-08-13");
  assert.equal(RC_MAX_CARTS, 2, 'two live carts were observed on one session, 2026-08-15');
  assert.equal(RC_HOLD_CAPACITY, 4);
  // The guard that matters is the UPPER one. Raising RC_MAX_CARTS past what a probe has
  // actually seen is promising a user capacity the morning cannot deliver — and the cost is
  // not a failed cart, it is that somebody who believes the site is handled stops watching.
  assert.ok(RC_MAX_CARTS <= 2,
    'run rc-probe.mjs --cart-ladder before raising this; do not raise it on reasoning');
});
