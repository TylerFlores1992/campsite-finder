/**
 * WHEN MAY THE SIGN-IN WEBVIEW CLOSE?
 *
 * Three generations of this decision closed on the TOKEN in some form, and all three raced
 * RC's own second sign-in step. Read out of RC's bundle on 2026-09-01: its sign-in writes
 * `ssoAccessToken` (the JWT we capture) on Okta's callback with `isLoggedIn: false`, then
 * awaits `GetSSOLoggedInUser`, and only that RESPONSE writes `customerId` — the one key RC
 * boots `isLoggedIn` from. The token is captured off step two's own request header, so
 * "token captured" is the instant step two LEAVES. #240's 10s timer on `/login/callback` was
 * the same race with a longer fuse; `settled` could never fire (client-side navigation) and
 * both platforms closed on `timeout`. Android's plugin kills the in-flight request on close
 * (`about:blank`); iOS's only dismisses the view controller. That is the whole platform story.
 *
 * The rule now: close on `rc-session { loggedIn: true }` — RC's own `customerId` — and on
 * NOTHING else. No timer. These guard the decision (`rcCloseAction`), the readings, and
 * that the host actually USES it. `rc-session-close.test.mts` drives the seam behaviourally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rcCloseAction, keepSignedInReading, signInPathReading, rcSessionReading,
} from '../src/lib/rc-token-liveness';

const LIVE = { captured: true, expiresInSec: 3598 };

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

// ── rcCloseAction ──────────────────────────────────────────────────────────────────────

test("RC reporting signed in closes the window — that is the whole rule", () => {
  assert.equal(rcCloseAction({
    closeOnToken: true, stage: 'rc-session', detail: { loggedIn: true, at: 'https://www.reservecalifornia.com/park/690/612' },
  }), 'close');
});

test('RC reporting NOT signed in never closes, however live the token is', () => {
  // The 09-01 state exactly: an Okta token present, `customerId` absent. Closing here is the
  // defect — RC renders signed out over a locked campsite.
  assert.equal(rcCloseAction({ closeOnToken: true, stage: 'rc-session', detail: { loggedIn: false } }), 'wait');
});

test('a LIVE token is not a reason to close — on any page', () => {
  // Every previous generation closed on this. A live token is step ONE of RC's sign-in, and
  // it is captured off step two's own request, so closing on it races step two's response.
  assert.equal(rcCloseAction({ closeOnToken: true, stage: 'token', detail: LIVE }), 'wait');
});

test('the signal is STRICTLY true — a missing or malformed field never closes', () => {
  // A bundle older than #249 sends no `rc-session` at all; a malformed one is not a reading.
  for (const detail of [null, undefined, {}, { loggedIn: 'true' }, { loggedIn: 1 }, { loggedIn: null }]) {
    assert.equal(rcCloseAction({ closeOnToken: true, stage: 'rc-session', detail }), 'wait', JSON.stringify(detail));
  }
});

test('the cart path never closes, whatever RC reports', () => {
  // closeOnToken is false there because the window IS the job — closing it for any reason
  // kills the two RC cart POSTs it exists to make.
  for (const stage of ['rc-session', 'token', 'session']) {
    assert.equal(rcCloseAction({ closeOnToken: false, stage, detail: { loggedIn: true, ...LIVE } }), 'wait', stage);
  }
});

test('no other stage is a close', () => {
  for (const stage of ['session', 'banner', 'status', 'cart-verified', 'settle-timeout', 'injected']) {
    assert.equal(rcCloseAction({ closeOnToken: true, stage, detail: { loggedIn: true } }), 'wait', stage);
  }
});

// ── the caller actually uses it ────────────────────────────────────────────────────────

test('the hand-off routes its close through rcCloseAction, not its own copy', () => {
  // THE FIX-PRESENT-BUT-INERT SHAPE. rcCloseAction can be perfect while the message handler
  // keeps a token test beside it, and every test above still passes. Pinned structurally
  // because no behavioural test can reach a real InAppBrowser.
  const src = code('src/lib/native/rc-handoff.ts');
  assert.match(src, /rcCloseAction\(\{/, 'the handler must call the shared decision');
  assert.doesNotMatch(src, /if \(closeOnToken && r\.stage === 'token'/, 'the inline decision must be gone');
  assert.doesNotMatch(src, /closeOnce\('token'\)/, 'nothing may close on a token any more');
});

test('THERE IS NO SETTLE TIMER, and none may come back as a "backstop"', () => {
  // The backstop WAS the defect: a timer that closes before RC's step two returns is the
  // 09-01 race by construction, on both platforms. The only timer left is the load watchdog,
  // which guards a page that never rendered and disarms on the first loadstop.
  const src = code('src/lib/native/rc-handoff.ts');
  assert.doesNotMatch(src, /SIGN_IN_SETTLE_MS|settleTimer/, 'no settle timer');
  assert.doesNotMatch(src, /closeOnce\('timeout'\)|closeOnce\('settled'\)/, 'no timed or URL-driven close');
  assert.doesNotMatch(src, /isMidSignIn/, 'the URL heuristic must not come back');
  // Exactly one setTimeout: the load watchdog.
  const timers = src.match(/setTimeout\(/g) ?? [];
  assert.equal(timers.length, 1, `expected only the load watchdog; found ${timers.length} setTimeout(s)`);
  assert.match(src, /LOAD_WATCHDOG_MS\)/, 'and it must be the load watchdog');
});

test('every close names a reason, and the ordinary one is `session`', () => {
  const src = code('src/lib/native/rc-handoff.ts');
  assert.match(src, /stage: 'close', detail: \{ reason \}/);
  for (const reason of ['session', 'never-loaded', 'load-error']) {
    assert.match(src, new RegExp(`closeOnce\\('${reason}'\\)`), reason);
  }
});

test('a user-driven exit marks the window gone and disarms the watchdog', () => {
  const src = code('src/lib/native/rc-handoff.ts');
  const exit = src.slice(src.indexOf("addEventListener('exit'"));
  assert.ok(exit.length > 0, 'the exit listener must exist');
  assert.match(exit.slice(0, 300), /closedAlready = true/);
  assert.match(exit.slice(0, 300), /disarmLoadTimer\(\)/);
});

// ── the bundle reports the signal, and only as a boolean ───────────────────────────────

test('the bundle reports rc-session from customerId, as a BOOLEAN, and shows a notice if step two never finishes', () => {
  const src = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  assert.match(src, /localStorage\.getItem\("customerId"\)/, 'the signal is RC\'s own key');
  assert.match(src, /send\("rc-session", \{ loggedIn: v, sso: so, at: href\(\) \}\)/,
    'reported as booleans — never the id, never the token');
  assert.doesNotMatch(src, /customerId: *get\(|customerId\) *\}|send\([^)]*customerId[^)]*getItem/,
    'the customer id value must never be reported');
  assert.match(src, /send\("settle-timeout", \{ held: true/, 'a stalled step two is reported, not closed');
  assert.match(src, /camphawk-rc-hold/, 'and the user is told what to do inside the window');
  assert.match(src, /tap Done/, 'the notice must name the action');
});

// ── the claim gate reads RC's signal, not the token (B) ────────────────────────────────

test("the claim gate flips to verified on rc-session, and NOT on the token", () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  // The rc-session branch flips the gate...
  const rc = src.indexOf("r.stage === 'rc-session'");
  assert.ok(rc > -1, 'the rc-session branch must exist');
  assert.match(src.slice(rc, rc + 300), /setRcCheck\('verified'\)/, 'rc-session must flip the gate');
  assert.match(src.slice(rc, rc + 120), /loggedIn === true/, 'strictly true — an old bundle sends nothing');
  // ...and the token branch no longer does. Bounded to the token branch's own block.
  const tok = src.indexOf("r.stage === 'token' && (r.detail as { captured?: boolean }");
  assert.ok(tok > -1, 'the token branch must still exist — it carries the deadline');
  const tokEnd = src.indexOf("r.stage === 'rc-session'", tok);
  assert.doesNotMatch(src.slice(tok, tokEnd), /setRcCheck\('verified'\)/,
    'a token must not flip the gate — that is the token-only check the owner objected to');
});

// ── reading RC's session state ─────────────────────────────────────────────────────────

test('customerId present reads as signed in', () => {
  const r = rcSessionReading({ rcLoggedIn: true, ssoToken: 'jwt', rcToken: 'jwt' });
  assert.ok(r); assert.equal(r!.level, 'info'); assert.match(r!.text, /PRESENT/);
});

test('an Okta token with NO customerId is THE 09-01 DEFECT and is named as such', () => {
  const r = rcSessionReading({ rcLoggedIn: false, ssoToken: 'jwt', rcToken: 'none' });
  assert.ok(r); assert.equal(r!.level, 'warn');
  assert.match(r!.text, /step two|GetSSOLoggedInUser/, 'it must name the mechanism');
});

test('no token and no customerId is plainly signed out, not a defect', () => {
  const r = rcSessionReading({ rcLoggedIn: false, ssoToken: 'none' });
  assert.ok(r); assert.equal(r!.level, 'info'); assert.match(r!.text, /plainly signed out/);
});

test('a census older than #249 produces NO reading', () => {
  // Inventing a state from a bundle that never measured one is the absent-reading-as-a-
  // negative shape.
  assert.equal(rcSessionReading({}), null);
  assert.equal(rcSessionReading({ ssoToken: 'jwt' }), null);
});

// ── READING THE "KEEP ME SIGNED IN" REPORT ─────────────────────────────────────────────
//
// The reading is a pure function for the same reason `closeReasonReading` is: the branch
// that matters — "there was no checkbox on the page at all" — cannot be reached without a
// real hand-off in the database, so written inline in `rc-holds-readout.mts` it would ship
// having never once run. That is the branch the 2026-09-01 Android trace lands on.

test('a tick that happened reads as a tick, and names the step', () => {
  const r = keepSignedInReading({ ticked: true, boxes: 1, matched: true, at: 'email' });
  assert.equal(r.level, 'info', 'a successful tick is not a warning');
  assert.match(r.text, /ticked/);
  assert.match(r.text, /email/, 'which step ticked it is the difference between the two paths');
});

test('NO CHECKBOX and A MISSED CHECKBOX are different findings', () => {
  const none = keepSignedInReading({ ticked: false, boxes: 0, at: 'password' });
  const missed = keepSignedInReading({ ticked: false, boxes: 3, matched: false, at: 'password' });

  assert.equal(none.level, 'warn');
  assert.equal(missed.level, 'warn');
  // The two need OPPOSITE fixes — one is the flow skipping Okta's identifier step, the other
  // is our selector no longer matching an attribute Okta reworded. A reading that collapsed
  // them would put the next reader on the wrong hunt, which is the whole cost this file
  // keeps paying. They must not produce the same sentence.
  assert.notEqual(none.text, missed.text,
    'a missing page and a missed match must not read identically');
  assert.match(none.text, /identifier step/,
    'the zero case must name WHY the box was absent — that is the Android trace');
  assert.match(missed.text, /selector/,
    'the non-zero case must point at the selector, not at the flow');
  assert.ok(!/selector/.test(none.text),
    'the zero case must NOT send anyone to widen a selector — there was no box to match');
});

test('the zero case is stated as a candidate, not as a finding', () => {
  // Three mechanisms have been guessed at in this area and each cost a test. The 08-09
  // measurement supports this one and does not establish it: what is established is that
  // the tick did not happen. The wording has to carry that, or the next reader records an
  // inference as a fact — which is how the duplicate-facility story got into two files.
  const none = keepSignedInReading({ ticked: false, boxes: 0, at: 'password' });
  assert.match(none.text, /likely/,
    'the consequence is inferred from one prior measurement and must be hedged');
});

test('an absent count does not read as a missed match', () => {
  // `boxes` is undefined for a bundle older than this change. Defaulting it to anything
  // other than "no box" would report a selector problem that nobody can act on, over a run
  // that never told us. The absent-reading-as-a-negative shape, for the umpteenth time.
  const r = keepSignedInReading({ ticked: false });
  assert.match(r.text, /no checkbox on the page at all/,
    'an unreported count must take the no-box branch, not the missed-match one');
});

test('the readout actually USES both readings — a pure function nothing calls is inert', () => {
  // FOUND BY MUTATION 2026-09-01, and it covered the sibling too. Replacing the readout's
  // `keepSignedInReading(keep)` call with a literal passed the entire suite: every test
  // above exercises the function directly, so none of them can see the one caller stop
  // calling it. That is the fix-present-and-inert shape — the version that looks right in
  // review and changes nothing — and CLAUDE.md records it costing this repo five separate
  // times, including `6006428`, which claimed a fix it never made.
  //
  // `closeReasonReading` had exactly the same exposure and was never guarded either. Both
  // are pinned here, because the argument for extracting them ("the branch that matters
  // cannot be reached without a real hand-off") is precisely the argument for why nothing
  // else will notice if the caller drops them.
  const src = readFileSync('scripts/rc-holds-readout.mts', 'utf8')
    // Comments quote these names to explain them; a guard that matched its own explanation
    // would be satisfied by a file that only talked about calling them.
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const fn of ['keepSignedInReading', 'closeReasonReading', 'rcSessionReading', 'signInPathReading']) {
    assert.match(src, new RegExp(`${fn}\\(`),
      `${fn} must be CALLED by the readout, not merely imported`);
  }
  // And the result has to reach the screen. Calling it and discarding the answer is the
  // same outcome with an extra step.
  assert.match(src, /\$\{r\.level === 'warn' \? '⚠ ' : ''\}\$\{r\.text\}/,
    'the keep-signed-in reading must be PRINTED, severity and all');
  assert.match(src, /sign-in window closed: \$\{closeReason\} — \$\{reading\.text\}/,
    'the close reading must be PRINTED');
});

// ── WHICH OKTA PATH A RUN TOOK ─────────────────────────────────────────────────────────

test('the two Okta paths are distinguishable, and neither is keyed on platform', () => {
  const ios = signInPathReading(['injected', 'signin-missing', 'email', 'password', 'submitted']);
  const android = signInPathReading(['injected', 'signin-open', 'password', 'submitted']);
  assert.ok(ios && android);
  assert.match(ios!, /IDENTIFIER-FIRST/);
  assert.match(android!, /PASSWORD-FIRST/);
  // The password-first line must NAME the consequence, or it is trivia. It is the
  // precondition for the keep-signed-in miss directly below it in the readout.
  assert.match(android!, /Keep me signed in/,
    'the reading has to say WHY the path matters, not merely which one it was');
});

test('a run with no sign-in gets NO path reading', () => {
  // An already-signed-in hand-off never visits Okta. Reporting a path over it would invent
  // one nobody took — the absent-reading-as-a-negative shape.
  assert.equal(signInPathReading(['injected', 'session', 'idle', 'token']), null);
  assert.equal(signInPathReading([]), null);
});

test('the path is derived from the STAGES, never from the platform', () => {
  // THE WHOLE POINT. iOS takes the password-first route whenever Okta remembers the account,
  // so keying this on the device would encode the exact confusion it exists to end — and
  // would make an Android-only symptom look platform-caused when it is path-caused.
  const src = readFileSync('src/lib/rc-token-liveness.ts', 'utf8');
  const at = src.indexOf('export function signInPathReading');
  assert.ok(at > -1, 'anchor not found');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.doesNotMatch(body, /ios|android|platform/i,
    'the path reading must not consult the platform');
  assert.match(body, /stages\.includes\('email'\)/,
    "the discriminator is whether Okta's identifier page was reached");
});

test('the readout prints the path ABOVE the keep-signed-in line', () => {
  // Order is the argument: password-first is the PRECONDITION for the box being absent, so
  // reading the consequence first leaves the reader deriving the cause backwards.
  const src = readFileSync('scripts/rc-holds-readout.mts', 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const p = src.indexOf('signInPathReading(');
  const k = src.indexOf('keepSignedInReading(');
  assert.ok(p > -1, 'the readout must call signInPathReading — a reading nothing prints is inert');
  assert.ok(k > -1 && p < k, 'the path must be printed before the keep-signed-in reading');
});
