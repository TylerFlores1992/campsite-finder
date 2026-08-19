// "RC'S APP DID NOT LOAD" IS NOT A FAILED LOGIN — IN THE RELEASE-CRITICAL PATH TOO.
//
// `attemptLogin` returns `provedNothing` when RC answers *"We're having trouble loading the
// application"*, because there is no sign-in form on a page that never rendered. That
// detection shipped 2026-08-18 after a blank load was reported as **the unattended login is
// BROKEN** with a real hold twelve hours out.
//
// THE REHEARSAL HONOURED IT AND `maybeAutoLogin` DID NOT. The refund lived inside the `r.ok`
// branch, and a blank load returns `ok: false` — so the caller that runs at T−30 of a real
// release fell through to the plain failure path and:
//
//   * spent one of only two sign-in attempts,
//   * reported the session `dead`,
//   * fired `holdAtRisk`, which rings the owner's phone,
//   * and printed `rc-login.bat`, which force-kills the Chromium the token lives in.
//
// Following that alarm destroys the session it is complaining about. It is the 2026-08-16
// 07:33 false alarm, in the one place it had not been fixed — and two transient loads eight
// minutes apart would exhaust the budget twenty minutes before the cart.
//
// Observed live 2026-08-19: RC showed exactly this screen during a hand sign-in, and cleared
// on a retry. So the transient case is real, it happens, and it happens near the box being
// disturbed — which is precisely what T−30 looks like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const AUTOLOGIN = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');

/** `maybeAutoLogin`'s body only — `runLoginRehearsal` has its own provedNothing handling. */
function autoLoginBody(): string {
  const at = SRC.indexOf('async function maybeAutoLogin');
  assert.ok(at > -1, 'maybeAutoLogin must exist');
  const end = SRC.indexOf('\n/**', at);
  return SRC.slice(at, end > -1 ? end : at + 12_000);
}

test('the blank-load branch exists and is reached on ok:false', () => {
  // The bug was that the only refund sat inside `if (r.ok)`, which a blank load never enters.
  const body = autoLoginBody();
  const branch = body.indexOf('} else if (r.provedNothing) {');
  assert.ok(branch > -1,
    'there must be a provedNothing arm on the failure side, not only inside the ok branch');
  const plainFail = body.indexOf("log(`  ✗ could not sign in:");
  assert.ok(plainFail > branch,
    'and it must come BEFORE the plain failure arm, or it is unreachable');
});

test('the attempt is REFUNDED — no credential was submitted', () => {
  const body = autoLoginBody();
  const branch = body.slice(body.indexOf('} else if (r.provedNothing) {'),
    body.indexOf("log(`  ✗ could not sign in:"));
  assert.match(branch, /autoLogin\.spent -= 1/,
    'a blank load must not spend one of the two attempts that protect the cart');
});

test('NOTHING IS REPORTED — `warm` and `dead` are both verdicts we did not earn', () => {
  // A page that never rendered says nothing about the session. Posting nothing lets the
  // previous verdict go stale, which is the honest reading and the rule this file already
  // applies to an unknown Okta probe. `dead` is the one that pages a human and prints the
  // destructive remedy.
  const body = autoLoginBody();
  const branch = body.slice(body.indexOf('} else if (r.provedNothing) {'),
    body.indexOf("log(`  ✗ could not sign in:"));
  assert.ok(!/reportSession\(/.test(branch),
    'the blank-load arm must report no verdict at all');
  assert.ok(!/'dead'/.test(branch), 'and must never report dead');
});

test('it stays LOUD — this is also the 08-14 profile-fault signature', () => {
  // The severity changes, never the visibility. A silent blank load would hide the persistent
  // fault, where the profile itself is the cause and a human does need to act.
  const body = autoLoginBody();
  const branch = body.slice(body.indexOf('} else if (r.provedNothing) {'),
    body.indexOf("log(`  ✗ could not sign in:"));
  assert.match(branch, /saveFailureShot\(/, 'the picture is how the 08-14 fault was diagnosed');
  assert.match(branch, /rc-bot-profile/, 'and the log must name the remedy if it repeats');
});

test('a REAL login failure still reports dead and still spends an attempt', () => {
  // The guard must not have been bought by making every failure inconclusive. A wrong
  // password or a CAPTCHA is a genuine dead session and must still page a human.
  const body = autoLoginBody();
  const plain = body.slice(body.indexOf("log(`  ✗ could not sign in:"));
  assert.match(plain, /reportSession\('dead'/,
    'a real sign-in failure must still be reported dead');
  assert.ok(!/autoLogin\.spent -= 1/.test(plain.slice(0, 400)),
    'and must still count against the budget');
});

test('the detection itself is unchanged and still matches RC\'s wording', () => {
  // Both halves are needed: attemptLogin must SET the flag and maybeAutoLogin must honour it.
  // Pinning only the caller would go green against a build that stopped detecting.
  assert.match(AUTOLOGIN, /trouble loading the application\|check your connection/,
    'the blank-load detection must still match RC\'s own text');
  assert.match(AUTOLOGIN, /provedNothing: true/);
});
