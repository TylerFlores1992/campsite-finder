// A LIVE RC SESSION MUST NEVER BE REPORTED DEAD.
//
// 2026-08-16 07:33 PT: the owner's phone rang, twenty-seven minutes before a release that
// then carted both holds at T+43s and T+49s. The chain was
//
//   acceptable() = isLive() AND covers(deadline)
//     → a LIVE session with a 40m token against a 46m requirement returns false
//     → drop-and-re-mint does not lift it
//     → RC shows no sign-in form (it never does to a signed-in user)
//     → attemptLogin returns { ok: false, reason: 'neither an email nor a password field
//       appeared — RC said: "You have a reservation arriving on today's date"' }
//     → maybeAutoLogin reports `dead`, "auto sign-in failed"
//     → autocart.rc_session FAILS, holdAtRisk rings, and the printed remedy is
//       `rc-login.bat` — which force-kills the Chromium the access token lives in.
//
// Following the alarm's own advice would have destroyed the working session it was
// complaining about. The severity is the defect, not the sentence: `dead` is what pages.
//
// These are SOURCE assertions because both halves live inside a Playwright call chain that
// cannot be constructed here (`attemptLogin` needs a real page; `maybeAutoLogin` runs inside
// a loop that starts on import) — the same reason `session-coverage.mjs` was extracted. Both
// halves are pinned, because the fix is inert if either one is dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const AUTOLOGIN = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');

/** Comments quote the broken forms to explain them; a guard must not read its own remedy. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('attemptLogin distinguishes a live session from a failed sign-in', () => {
  const body = code(AUTOLOGIN);
  assert.match(body, /const stillLive = await isLive\(\);/,
    'the terminal exit must ask whether a session exists before calling it a failure');
  assert.match(body, /sessionLive: true/,
    'a live session must be flagged so the caller can pick a different severity');

  // ORDERING: the live check must come BEFORE the withBanner failure return, or it is
  // unreachable and the diff merely looks right.
  //
  // ANCHORED ON `withBanner(link`, NOT on the whole assignment. The first version pinned
  // `reason: await withBanner(link` and went red the moment that expression was hoisted into
  // a `const said` — over code whose behaviour was unchanged. A guard that breaks on a rename
  // teaches people to relax it, and the next relaxation is the one that matters. What is
  // load-bearing is the ORDER of the two calls, so pin exactly that.
  const liveAt = body.indexOf('const stillLive = await isLive()');
  const bannerAt = body.indexOf('withBanner(link');
  assert.ok(liveAt > 0 && bannerAt > liveAt,
    'the live check must precede the banner failure, or it can never run');
});

test("RC's banner is never folded into a live session's reason", () => {
  // To a signed-in user RC renders "You have a reservation arriving on today's date". That
  // is evidence of SUCCESS, and printing it as the explanation for a failure has now cost
  // three separate mornings. The live branch must return before withBanner is reached.
  const body = code(AUTOLOGIN);
  //
  // BOUNDED BY THE BLOCK, NOT BY THE FIRST MENTION OF THE BANNER. An earlier rewrite sliced
  // at the first `withBanner(` — which means folding a banner INTO the live branch simply
  // makes the slice shorter, and the mutation passes. Verified: that version went green
  // against exactly the bug this test exists for. Take the `if (stillLive === true)` body and
  // assert against that.
  const open = body.indexOf('if (stillLive === true) {');
  assert.ok(open > 0, 'the live branch must exist');
  const branch = body.slice(open, body.indexOf('\n      }', open));
  assert.ok(branch.includes('sessionLive: true') && branch.includes('return {'),
    'the live branch must actually RETURN, not merely be computed');
  assert.ok(!branch.includes('withBanner'),
    "a live session's reason must not carry RC's signed-in banner");
});

test('the keep-warm reports a live-but-short session as warm, never dead', () => {
  const body = code(KEEPWARM);
  const branch = body.indexOf('} else if (r.sessionLive) {');
  assert.ok(branch > 0, 'a live session needs its own branch — `dead` is what pages');

  const dead = body.indexOf("await reportSession('dead', `auto sign-in failed");
  assert.ok(dead > branch,
    'the live branch must be checked BEFORE the dead branch, or it never runs');

  // Slice to the NEXT arm, not to the dead report — the else block's own
  // `saveFailureShot` sits between them and would be read as this arm's.
  //
  // THE NEXT ARM MAY ITSELF BE AN `else if`. This searched for `} else {` literally, so
  // inserting a `} else if (r.provedNothing) {` arm between the live branch and the plain
  // failure branch silently widened the slice to cover BOTH — and the new arm's own
  // screenshot was then read as this one's. The rule being pinned is "nothing inside the
  // LIVE arm treats it as a failure"; where that arm ends is not part of the rule.
  const nextArm = /\n\s*\} else\b/.exec(body.slice(branch + 1));
  assert.ok(nextArm, 'the live arm must be followed by another arm');
  const arm = body.slice(branch, branch + 1 + nextArm.index);
  assert.match(arm, /reportSession\('warm'/,
    'a session RC accepts must be reported live, with the shortfall stated');
  assert.ok(!/reportSession\('dead'/.test(arm), 'this arm must never report dead');
  assert.ok(!/saveFailureShot/.test(arm), 'nothing failed — do not file it as a failure');
  assert.match(arm, /autoLogin\.spent -= 1;/,
    'no credential was submitted, so the attempt is refunded and T−5 still gets a turn');
});

test('the shortfall is still visible — this must not become a silent pass', () => {
  // The opposite failure, and the one that makes a downgrade dangerous: a genuinely short
  // token that nobody is told about. `warm` is correct about liveness and must stay honest
  // about coverage, so the pre-flight can show the risk without calling it an outage.
  const body = code(KEEPWARM);
  const branch = body.slice(body.indexOf('} else if (r.sessionLive) {'));
  const arm = branch.slice(0, branch.indexOf('} else {'));
  assert.match(arm, /may not cover the hold/,
    'the reported note must say coverage is short, or the risk disappears');
  assert.match(arm, /log\(/, 'and it must say so on the box, where a human reads it');
});
