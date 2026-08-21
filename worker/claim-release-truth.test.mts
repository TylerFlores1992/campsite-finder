// THE CLAIM SCREEN MUST NOT LIE ABOUT AN IRREVERSIBLE ACT, IN EITHER DIRECTION.
//
// Both defects here were found by the owner running the real 08:00 flow on a phone on
// 2026-08-21, and both are the same family: a field that only ever meant "something was
// there" being read as "it works". `status = 'sent'` meaning only "Twilio returned 2xx".
//
// ── 1. A SUCCESSFUL RELEASE WAS REPORTED AS A NETWORK FAILURE ─────────────────────────────
// `await load()` sat beside the claim POST inside one `try`, so a refetch that threw printed
// `Network error. Try again.` over a release that had already happened. Measured on hold
// 9252cbaa: `claim_started 15:01:46`, `released 15:01:54`, status `released` — and the phone
// showed nothing but the error card.
//
// "Try again" is advice for an act that CANNOT be repeated: the bot has let go and the site
// is on the open market. And `if (error) return <Notice>` replaces the whole screen, so a
// successful release destroyed the hand-off UI the user needed next.
//
// ── 2. THE RELEASE GATE READ PRESENCE, NOT LIVENESS ───────────────────────────────────────
// `setRcCheck('verified')` fired on `captured` alone. The same run reported
//
//     token { captured: true, decodable: true, expiresInSec: -82599 }
//
// a token 23 HOURS dead, and the screen said the session was good. The user released against
// it, the precart found `storedToken: "none"`, sat on "Reading your session…", and the site
// went back on the open market carted for nobody.
//
// `expiresInSec` has been in that report since migration 058 — whose note reads "Never
// presence, always liveness". The reporter supplied it; the gate ignored it.
//
// These are structural tests. The logic lives inside a React component with a webview, a
// fetch and a native plugin behind it; extracting it to make it callable would be a bigger,
// riskier change than the fix, and the properties that matter are positional — WHICH side of
// a `try` a call is on, and WHETHER a branch is reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
/** Comments stripped: several quote the exact shapes these tests forbid. */
const code = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** The body of `claim()`, bounded so an assertion cannot wander into a neighbour. */
function claimBody(): string {
  const from = code.indexOf('async function claim()');
  assert.ok(from > -1, 'claim() must still exist — anchor not found');
  const to = code.indexOf('\n  if (error) {', from);
  assert.ok(to > from, 'the end anchor must be found AFTER the start, or the slice runs backwards');
  return code.slice(from, to);
}

// ── 1. The release ────────────────────────────────────────────────────────────────────────

test('the refetch is NOT inside the try that decides the verdict', () => {
  // The whole defect. A refetch is a stale screen; it is never a failed release.
  const body = claimBody();
  const tryAt = body.indexOf('try {');
  const catchAt = body.indexOf('} catch');
  assert.ok(tryAt > -1 && catchAt > tryAt, 'the try/catch must be found in order');
  const guarded = body.slice(tryAt, catchAt);
  assert.ok(!/await load\(\)/.test(guarded),
    'load() inside the try turns a completed, IRREVERSIBLE release into "Network error. '
    + 'Try again." — advice for an act that cannot be repeated');
});

test('the refetch still happens, after the release stands', () => {
  // Removing it entirely would leave the screen stale for ever, which is the other way to
  // "fix" this and is not a fix.
  const body = claimBody();
  const catchAt = body.indexOf('} catch');
  assert.match(body.slice(catchAt), /await load\(\)/,
    'the screen must still refresh once the release is recorded');
});

test('a failed refetch cannot surface as an error', () => {
  // It is best-effort by construction: the release stands whatever it does.
  const body = claimBody();
  const at = body.lastIndexOf('await load()');
  assert.ok(at > -1);
  assert.match(body.slice(at, at + 60), /\.catch\(/,
    'the refetch must swallow its own failure — the release already happened');
});

test('"Network error" is reachable ONLY when nothing was released', () => {
  // The one case where "try again" is honest: the POST never completed, so the bot never
  // let go. Any other path reaching this string is the 08-21 bug returning.
  const body = claimBody();
  const at = body.indexOf("setError('Network error");
  assert.ok(at > -1, 'the message must still exist for the genuine case');
  const catchAt = body.indexOf('} catch');
  assert.ok(at > catchAt, 'it must live in the catch, not on a success path');
  // And that catch must return rather than falling through into the refetch, or a thrown
  // POST would be followed by a load() that could flip the screen into a released state.
  assert.match(body.slice(at, at + 120), /return;/,
    'a thrown POST must stop there — nothing was released');
});

// ── 2. The gate ───────────────────────────────────────────────────────────────────────────

/** The `token` arm of the report handler, bounded by the next stage it checks. */
function tokenArm(): string {
  const from = code.indexOf("if (r.stage === 'token'");
  assert.ok(from > -1, 'the token arm must exist — anchor not found');
  const to = code.indexOf('LOGIN_STAGES.has(r.stage)', from);
  assert.ok(to > from, 'the end anchor must be found AFTER the start');
  return code.slice(from, to);
}

test('a captured token is not enough — the gate reads its EXPIRY', () => {
  const arm = tokenArm();
  assert.match(arm, /expiresInSec/,
    'the gate must consult expiry; `captured` alone is presence, not liveness, and it '
    + 'verified a 23-hour-dead token on 2026-08-21');
  assert.match(arm, /<=\s*0/, 'and an expired token must take a different branch');
});

test('an EXPIRED token does not verify, and the user is told', () => {
  // Positive evidence of no session. Saying nothing would leave the screen looking exactly
  // as it did on 08-21: a ready-looking hand-off over a session that cannot cart.
  const arm = tokenArm();
  const dead = arm.slice(arm.indexOf('<= 0'));
  const nextBranch = dead.indexOf('} else {');
  assert.ok(nextBranch > -1, 'the dead branch must be followed by the live one');
  const deadArm = dead.slice(0, nextBranch);
  assert.ok(!/setRcCheck\('verified'\)/.test(deadArm),
    'an expired token must never reach `verified`');
  assert.match(deadArm, /setRcCheck\('unconfirmed'\)/, 'it falls back to the checkbox');
  assert.match(deadArm, /setLoginError\(/, 'and says so — silence is what made 08-21 invisible');
});

test('a live token still takes the fast path', () => {
  // The fix must not cost the feature. A live session verifies exactly as before.
  const arm = tokenArm();
  const live = arm.slice(arm.indexOf('} else {'));
  assert.match(live, /setRcCheck\('verified'\)/, 'a live token still verifies');
  assert.match(live, /setLoginStage\(null\)/, 'and clears a stale captcha prompt');
});

test('an UNDECODABLE token is unconfirmed, never a verdict either way', () => {
  // `unknown` must not round to a verdict in either direction — the rule that keeps
  // `hasAvailabilityInRange` returning null and an unknown Okta probe from reading as dead.
  // A non-numeric `expiresInSec` must fall through to the live branch, which is `verified`
  // exactly as before this change: we could not tell, so we do not newly refuse.
  const arm = tokenArm();
  assert.match(arm, /typeof d\?\.expiresInSec === 'number' \? d\.expiresInSec : null/,
    'a missing or non-numeric expiry must become null, not 0 — 0 would read as EXPIRED and '
    + 'would lock out every client on a bundle older than this one');
  assert.match(arm, /secs != null && secs <= 0/,
    'and only a decoded, non-null expiry may condemn the session');
});

test('nothing here can lock a user out of a hold', () => {
  // The rule that survives all of it: an unconfirmed check falls back to the checkbox rather
  // than refusing, because "we could not confirm" and "there is no session" are different
  // facts and only the second would justify blocking — and a wrong read costs somebody the
  // hold they waited all morning for.
  assert.match(code, /const mayRelease = rcCheck === 'verified' \|\| signedIn;/,
    'the checkbox must remain an independent route to release');
});
