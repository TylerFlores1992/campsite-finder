/**
 * The unattended login's timing, as arithmetic rather than as three numbers that look
 * reasonable next to each other.
 *
 * WHAT MAKES THIS BREAKABLE. A login at T−LEAD mints a ~60-minute access token. The bot
 * needs it not only to CART at T−0 but to RELEASE at up to T+CART_HOLD — the user has the
 * whole cart hold to tap claim, and `remove/cartentry` runs on the bot's own session. Every
 * constant here is one side of that inequality, they live in three different files, and two
 * of them are not even the same language. Nothing but a test holds them together.
 *
 * This exists because moving the lead from 15 to 30 on 2026-08-11 silently invalidated
 * `AUTOLOGIN_MIN_TOKEN_MIN` — which was already wrong at 15.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RC_CART_HOLD_MINUTES } from '../src/lib/limits.js';

const keepwarm = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');

/** Read a `const NAME = Number(process.env.X || <n>)` default out of a source file. */
function num(src: string, name: string): number {
  const m = src.match(new RegExp(String.raw`const ${name} = Number\(\s*process\.env\.\w+ (?:\|\||\?\?) ([0-9_]+)\s*[,)]`));
  assert.ok(m, `could not read ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

/** ~60 minutes, measured: 60 → 40 → 20 → gone across four 20-minute passes, 2026-08-09. */
const TOKEN_LIFE_MIN = 60;

const LEAD = num(keepwarm, 'AUTOLOGIN_LEAD_MIN');
const CART_HOLD = Number(keepwarm.match(/const CART_HOLD_MIN = (\d+);/)![1]);
// Derived in the source, so read the expression rather than a literal.
const MIN_TOKEN = LEAD + CART_HOLD + 5;

test('the bot mirrors the real cart-hold length', () => {
  // rc-keepwarm.mjs is plain .mjs and cannot import a .ts constant, so it carries a copy.
  // A copy nothing checks is a copy that drifts.
  assert.equal(CART_HOLD, RC_CART_HOLD_MINUTES,
    'CART_HOLD_MIN must match RC_CART_HOLD_MINUTES in src/lib/limits.ts');
});

test('the token still covers the RELEASE, not merely the cart', () => {
  // THE HARD CEILING. Sign in too early and the session dies while the user is walking to
  // their phone — the cart succeeds and the hand-off fails, which is worse than not
  // carting, because the unit is locked and nobody can take it.
  assert.ok(
    TOKEN_LIFE_MIN - LEAD >= CART_HOLD,
    `a login at T-${LEAD} leaves ${TOKEN_LIFE_MIN - LEAD}m at the cart, ` +
    `which must cover the ${CART_HOLD}m someone has to claim it`,
  );
  // And with real margin, not exactly. The 60 minutes is a measurement, not a contract.
  assert.ok(TOKEN_LIFE_MIN - LEAD - CART_HOLD >= 10, 'keep at least 10 minutes of slack');
});

test('the lead is long enough for a human to be the fallback', () => {
  // A CAPTCHA is a full stop for the bot — the repair is a person. Fifteen minutes to
  // notice a call, surface, find a computer and sign in was a coin flip.
  assert.ok(LEAD >= 25, `${LEAD}m is not enough time for someone to sign in by hand`);
});

test('"already covered" means covered through the claim, not through the cart', () => {
  // THE BUG THIS FILE EXISTS FOR. At a flat 20, the bot would see a token with 21 minutes
  // left, call the hold covered, skip its ONE login, cart at T-0 with ~6 minutes of token,
  // and then fail the release. Reachable by signing in by hand an hour before a release.
  assert.ok(
    MIN_TOKEN >= LEAD + CART_HOLD,
    `a token judged "covering" a hold at T-${LEAD} must outlive T+${CART_HOLD}`,
  );
  // It is DERIVED in the source. A literal here would pass while the source drifted.
  assert.match(
    keepwarm,
    /RC_AUTOLOGIN_MIN_TOKEN_MIN \|\| AUTOLOGIN_LEAD_MIN \+ CART_HOLD_MIN \+ 5/,
    'the threshold must be derived from the lead, not chosen',
  );
});

test('the alarm fallback stays just inside the login window', () => {
  // `afterMin < lead` alone is not enough — 12 against a lead of 30 satisfies it and buys
  // an 18-minute silence in the only window where somebody can still act. The relationship
  // that matters is how far inside.
  const afterMin = num(route, 'ALARM_AFTER_MIN');
  assert.ok(afterMin < LEAD, `alarm-after (${afterMin}) must be inside the lead (${LEAD})`);
  assert.ok(
    LEAD - afterMin <= 8,
    `alarm-after (${afterMin}) sits ${LEAD - afterMin}m inside the lead — too long a silence ` +
    'when the keep-warm reports nothing at all',
  );
});
