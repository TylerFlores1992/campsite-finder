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

test('the readout quotes the real lead, not a remembered one', () => {
  // It said "~15 min" after the lead moved to 30, and it is read at 07:50 by somebody
  // deciding whether to intervene — a stale figure there is worse than none. The readout
  // cannot import rc-keepwarm.mjs from a web session, so it carries a mirror; this pins it.
  const readout = readFileSync('scripts/rc-holds-readout.mts', 'utf8');
  const m = readout.match(/const RC_AUTOLOGIN_LEAD_MIN = Number\(process\.env\.\w+ \|\| (\d+)\)/);
  assert.ok(m, 'the readout must carry the lead as a named constant');
  assert.equal(Number(m[1]), LEAD, 'and it must match rc-keepwarm.mjs');
  assert.ok(!/~15 min before a hold/.test(readout), 'no hard-coded lead in the printed text');
});

test('the health check does not declare the repair spent before it has run', () => {
  // THE BUG THIS PINS, caught live at T-34 on 2026-08-12. `autocart.rc_session` read `fail`
  // and said "the auto-login has had its turn — run mini-pc\rc-login.bat" while
  // `maybeAutoLogin` had not run at all; it then ran at ~T-31 and signed in unattended.
  // Anyone acting on that sentence would have driven to the box over a session that
  // repaired itself four minutes later — the 2026-08-09 cry-wolf, a second time, in the
  // one check the 07:40 pre-flight reads.
  //
  // Cause: ONE constant was doing two jobs. RC_SESSION_CRITICAL_MIN (45) is when a dead
  // session starts to MATTER; it is not when the repair is spent, which cannot be sooner
  // than the login actually runs (LEAD, 30). The alarm gate learned this and the health
  // check kept the naive version.
  const th = readFileSync('src/lib/health-thresholds.ts', 'utf8');
  const spent = num(th, 'RC_SESSION_REPAIR_SPENT_MIN');

  assert.ok(
    spent < LEAD,
    `the repair cannot be "spent" at T-${spent} when the login does not run until T-${LEAD}`,
  );
  assert.ok(
    LEAD - spent <= 8,
    `spent (${spent}) sits ${LEAD - spent}m inside the lead — too long to keep calling a dead ` +
    'session routine once the repair has had its chance',
  );

  // One definition, shared with the phone alarm. Two numbers for "has the repair had its
  // turn" is how the page and the phone come to disagree about the same session.
  assert.equal(spent, num(route, 'ALARM_AFTER_MIN'), 'must be the same number the alarm gates on');

  // And the web side's mirror of the lead must track the box's, since it is printed in the
  // sentence a human reads while deciding whether to intervene.
  assert.equal(num(th, 'RC_AUTOLOGIN_LEAD_MIN'), LEAD, 'web-side lead mirror must match rc-keepwarm.mjs');

  // The severity must be driven by the spent window, not by the "matters" window.
  const health = readFileSync('src/app/api/health/status/route.ts', 'utf8');
  assert.match(health, /repairSpent \? 'fail'/, 'severity must gate on repairSpent');
  assert.ok(
    !/dead && soon > 0 \? 'fail'/.test(health),
    'the 45-minute window must not decide that the auto-login has had its turn',
  );
});
