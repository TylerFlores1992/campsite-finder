/**
 * The PRE-RELEASE gate — may the bot let go of a real campsite?
 *
 * ## What this is a regression test for
 *
 * 2026-09-21, holds `#M450` and `#R359` at Carpinteria. `#R359`'s webview reported, in one
 * pre-release pass, RC's own `loggedIn: true` beside `storedToken: 'jwt'` with
 * `storedExpiresInSec: -1466016` — a token seventeen days dead. The gate read only the
 * first, authorised the release, and the user then walked the whole Okta sign-in AFTER the
 * bot had let go. Somebody else booked the site.
 *
 * `customerId` is PERSISTED, so RC's SPA renders "signed in" indefinitely over a dead
 * token. That is presence, not liveness — the house shape, arriving at the one screen whose
 * decision costs a campsite.
 *
 * ## Why these assertions are shaped the way they are
 *
 * Every one pins a RETURN VALUE against specific facts rather than asserting that a branch
 * exists. A guard that checks a condition is still written survives the mutation that flips
 * what the condition returns, which is precisely the bug — `rc-session-verdict`'s own tests
 * record having watched that mutation survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rcTokenLifeFromReport, mayReleaseHold, rcHandoffStep, MIN_TOKEN_SECONDS_FOR_HANDOFF,
} from './claim-gate';

/** The exact pre-release pass that lost #R359, transcribed from `rc_hold_requests`. */
const R359_SESSION = {
  at: 'https://www.reservecalifornia.com/park/6/360',
  opens: 89, marker: 'present', rcToken: 'jwt', oktaKeys: 3,
  rcLoggedIn: true, storedToken: 'jwt',
  lastOpenAgoSec: 1469588, firstOpenAgoSec: 1973011,
  oktaExpiresInSec: null, storedExpiresInSec: -1466016, prevTokenExpiresInSec: -1466016,
};

/** #M450's, from the same morning — healthy, and it must stay allowed. */
const M450_SESSION = { ...R359_SESSION, storedExpiresInSec: 3482, prevTokenExpiresInSec: 3482 };

test('the #R359 session stage is read as a DEAD token', () => {
  assert.equal(rcTokenLifeFromReport('session', R359_SESSION), 'dead');
});

test('and the release it authorised is now refused', () => {
  // `verified` is what RC's own loggedIn produced that morning. The whole bug is that this
  // combination returned true.
  assert.equal(mayReleaseHold('verified', 'dead', false), false);
});

test('a healthy session is untouched — #M450 still releases', () => {
  assert.equal(rcTokenLifeFromReport('session', M450_SESSION), 'alive');
  assert.equal(mayReleaseHold('verified', 'alive', false), true);
});

/**
 * THE ESCAPE HATCH IS UNCONDITIONAL AND IS CHECKED FIRST.
 *
 * A gate that can be wrong must never be the last word on a site somebody waited all
 * morning for. If this ever fails, the fix is NOT to relax the expiry reading.
 */
test('the checkbox overrides every refusal this gate can produce', () => {
  for (const check of ['idle', 'opening', 'verified', 'unconfirmed'] as const)
    for (const life of ['alive', 'dead', 'unknown'] as const)
      assert.equal(mayReleaseHold(check, life, true), true, `${check}/${life} must still pass`);
});

/**
 * AN ABSENT READING IS NOT A DEAD SESSION — the failure shape this file is an instance of,
 * so it gets its own assertions rather than a comment.
 */
test('unknown proceeds exactly as it did before this gate existed', () => {
  assert.equal(mayReleaseHold('verified', 'unknown', false), true);
  assert.equal(mayReleaseHold('unconfirmed', 'unknown', false), false);
});

test('a stage carrying no expiry returns null, and must not erase the last reading', () => {
  // `null` is the "says nothing" signal the component uses to LEAVE state alone. If any of
  // these ever returned 'dead', a routine progress report would refuse a good release.
  assert.equal(rcTokenLifeFromReport('session', { ...R359_SESSION, storedExpiresInSec: null }), null);
  assert.equal(rcTokenLifeFromReport('banner', { status: 'Reading your session…' }), null);
  assert.equal(rcTokenLifeFromReport('rc-session', { loggedIn: true }), null);
  assert.equal(rcTokenLifeFromReport('idle', { reason: 'no hold in this link' }), null);
  assert.equal(rcTokenLifeFromReport('session', null), null);
});

/**
 * `storedToken: 'none'` IS AN ABSENCE, NOT A DEATH. RC mints on demand, so an empty store
 * at injection time is the ordinary opening of a session that is about to work. Reading it
 * as death would refuse the release on a healthy silent re-mint.
 */
test('no token in storage is not evidence of a dead one', () => {
  assert.equal(rcTokenLifeFromReport('session', { storedToken: 'none', storedExpiresInSec: -5 }), null);
});

/**
 * `prevTokenExpiresInSec` IS THE TRAP, and it is negative on every healthy renewal.
 * #R359's pass had BOTH fields negative, so a test using only that row could not tell
 * whether the right field was being read. This one separates them.
 */
test('an arrived-dead token with a live stored one reads ALIVE', () => {
  const renewed = { storedToken: 'jwt', storedExpiresInSec: 3400, prevTokenExpiresInSec: -90000 };
  assert.equal(rcTokenLifeFromReport('session', renewed), 'alive',
    'prevTokenExpiresInSec is the renewal signal, not a death certificate');
});

test('the token stage still decides, and both directions are pinned', () => {
  assert.equal(rcTokenLifeFromReport('token', { captured: true, expiresInSec: 3466 }), 'alive');
  assert.equal(rcTokenLifeFromReport('token', { captured: true, expiresInSec: -82599 }), 'dead');
  // The 08-21 reading verbatim: a token expired 23 hours earlier, reported as verified.
  assert.equal(mayReleaseHold('verified', rcTokenLifeFromReport('token', {
    captured: true, decodable: true, expiresInSec: -82599,
  })!, false), false);
  // Not captured is not a reading at all.
  assert.equal(rcTokenLifeFromReport('token', { captured: false, expiresInSec: -5 }), null);
});

/** Zero is dead, not "unknown". An off-by-one here is a release over an expiring session. */
test('the boundary is > 0', () => {
  assert.equal(rcTokenLifeFromReport('session', { storedToken: 'jwt', storedExpiresInSec: 0 }), 'dead');
  assert.equal(rcTokenLifeFromReport('session', { storedToken: 'jwt', storedExpiresInSec: 1 }), 'alive');
});

/**
 * THE POST-RELEASE GATE IS A DIFFERENT QUESTION AND KEEPS ITS OWN THRESHOLD. Pinned here
 * so a future tidy-up cannot collapse the two into one number: this one may refuse a token
 * with 80 seconds left, while the pre-release gate above refuses only a dead one.
 */
test('rcHandoffStep is unchanged by any of this', () => {
  assert.equal(rcHandoffStep(true, 'verified', MIN_TOKEN_SECONDS_FOR_HANDOFF - 1), 'sign-in');
  assert.equal(rcHandoffStep(true, 'verified', MIN_TOKEN_SECONDS_FOR_HANDOFF + 1), 'finish');
  assert.equal(rcHandoffStep(true, 'verified', null), 'finish');
  assert.equal(rcHandoffStep(false, 'idle', -99), 'finish');
});
