/**
 * WHEN MAY THE SIGN-IN WEBVIEW CLOSE?
 *
 * The 2026-08-31 bug: `closeOnToken` fired on the first live token, which arrives while RC
 * is still on Okta's `/login/callback` finishing its own OAuth exchange. Killing the webview
 * there left a session that authenticated its own API calls while rendering SIGNED OUT — no
 * name in the header, and a cart the owner had been told was theirs and could not open.
 *
 * Bisected by hand in the app: the ADMIN probe passes no `closeOnToken`, so its window stays
 * open — a manual sign-in there showed the name, and it SURVIVED a close and a reopen. So
 * close/reopen is innocent and the timing is the variable.
 *
 * These guard the decision (`rcCloseAction`) and, separately, that the hand-off actually
 * USES it. Both halves are needed: this repo has shipped a correct pure function with an
 * inert call site more than once, and a guard on the function alone would pass against it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMidSignIn, rcCloseAction, keepSignedInReading } from '../src/lib/rc-token-liveness';

const LIVE = { captured: true, expiresInSec: 3598 };
const CALLBACK = 'https://www.reservecalifornia.com/login/callback?code=abc&state=xyz';
const PARK = 'https://www.reservecalifornia.com/park/690/612';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

// ── isMidSignIn ────────────────────────────────────────────────────────────────────────

test("Okta's callback is mid sign-in — the page the 08-31 bug closed on", () => {
  assert.equal(isMidSignIn(CALLBACK), true);
  // Without the query too: the OAuth code must never be needed to make this decision.
  assert.equal(isMidSignIn('https://www.reservecalifornia.com/login/callback'), true);
});

test("Okta's own host is mid sign-in whatever the path", () => {
  assert.equal(isMidSignIn('https://signin.reservecalifornia.com/oauth2/v1/authorize'), true);
  assert.equal(isMidSignIn('https://signin.reservecalifornia.com/'), true);
});

test("RC's ordinary pages are NOT mid sign-in, so the signed-in path still closes at once", () => {
  // This is the 2026-08-12 stranded-when-it-worked case: already signed in, token captured
  // on RC's first API call, no Okta and no callback. It must close instantly, as it did
  // before this change — a version that waited here would reintroduce that bug for everyone.
  assert.equal(isMidSignIn(PARK), false);
  assert.equal(isMidSignIn('https://www.reservecalifornia.com/'), false);
  assert.equal(isMidSignIn('https://www.reservecalifornia.com/Customers/ShoppingCart'), false);
});

test('an unrecognisable URL is NOT mid sign-in — narrow on purpose', () => {
  // The plugin's loadstop event is the source and it can report an empty string. Waiting on
  // anything unparseable would make every already-signed-in hand-off sit through the settle
  // timeout. The cost of narrow is recorded in the module: if RC moves its callback path
  // this silently stops matching, and the `close` report's reason is what would show it.
  assert.equal(isMidSignIn(''), false);
  assert.equal(isMidSignIn('not a url'), false);
});

// ── rcCloseAction ──────────────────────────────────────────────────────────────────────

test('a live token on the callback ARMS rather than closing', () => {
  assert.equal(rcCloseAction({
    closeOnToken: true, stage: 'token', detail: LIVE, currentUrl: CALLBACK, timerArmed: false,
  }), 'arm');
});

test('a live token anywhere else closes immediately', () => {
  assert.equal(rcCloseAction({
    closeOnToken: true, stage: 'token', detail: LIVE, currentUrl: PARK, timerArmed: false,
  }), 'close');
});

test('the timer is armed ONCE — a rebroadcast must not push the deadline out', () => {
  // rc-inject.js replays the token on every RC API call, sixty-plus during a bootstrap. If
  // each one re-armed, the timeout could never fire and "wait for RC" would be unbounded.
  assert.equal(rcCloseAction({
    closeOnToken: true, stage: 'token', detail: LIVE, currentUrl: CALLBACK, timerArmed: true,
  }), 'wait');
});

test('the cart path never closes on a token, callback or not', () => {
  // closeOnToken is false there because the token is the MIDDLE of that job — closing on it
  // would kill the webview before the two RC cart POSTs it exists to make.
  for (const currentUrl of [CALLBACK, PARK]) {
    assert.equal(rcCloseAction({
      closeOnToken: false, stage: 'token', detail: LIVE, currentUrl, timerArmed: false,
    }), 'wait', currentUrl);
  }
});

test('an expired or unreadable token never closes, on any page', () => {
  // The 2026-08-24 failure: a STALE token closed the window in under a second and read as
  // "auto login worked" with no credential ever typed.
  for (const detail of [{ captured: true, expiresInSec: 0 }, { captured: true }, null]) {
    for (const currentUrl of [CALLBACK, PARK]) {
      assert.equal(rcCloseAction({
        closeOnToken: true, stage: 'token', detail, currentUrl, timerArmed: false,
      }), 'wait', `${JSON.stringify(detail)} @ ${currentUrl}`);
    }
  }
});

test('a non-token stage is never a close', () => {
  for (const stage of ['session', 'banner', 'status', 'cart-verified']) {
    assert.equal(rcCloseAction({
      closeOnToken: true, stage, detail: LIVE, currentUrl: PARK, timerArmed: false,
    }), 'wait', stage);
  }
});

// ── the caller actually uses it ────────────────────────────────────────────────────────

test('the hand-off routes its close through rcCloseAction, not its own copy', () => {
  // THE FIX-PRESENT-BUT-INERT SHAPE. rcCloseAction can be perfect while the message handler
  // keeps the old `mayCloseOnToken(r.detail)` test beside it, and every test above still
  // passes. Pinned structurally because no behavioural test can reach an InAppBrowser.
  const src = code('src/lib/native/rc-handoff.ts');
  assert.match(src, /rcCloseAction\(\{/, 'the handler must call the shared decision');
  assert.doesNotMatch(
    src, /if \(closeOnToken && r\.stage === 'token'/,
    'the inline decision must be gone, not merely duplicated',
  );
});

test('the settle timer is bounded, and the bound is sane', () => {
  // Unbounded is the 2026-08-12 stranded-when-it-worked bug by another door.
  const src = code('src/lib/native/rc-handoff.ts');
  const m = src.match(/SIGN_IN_SETTLE_MS\s*=\s*([\d_]+)/);
  assert.ok(m, 'SIGN_IN_SETTLE_MS must be a literal that can be read');
  const ms = Number(m![1].replace(/_/g, ''));
  assert.ok(ms >= 3_000, `too short to let RC finish its bootstrap: ${ms}ms`);
  assert.ok(ms <= 30_000, `long enough to read as stranded: ${ms}ms`);
  assert.match(src, /setTimeout\([\s\S]{0,200}SIGN_IN_SETTLE_MS\)/, 'the timer must use it');
});

test("RC leaving the sign-in flow closes the window — that is the fix's whole point", () => {
  const src = code('src/lib/native/rc-handoff.ts');
  assert.match(
    src, /if \(settleTimer && at && !isMidSignIn\(at\)\) closeOnce\('settled'\)/,
    'loadstop must close a deferred window once RC is off the callback',
  );
});

test('a non-empty loadstop URL is what updates lastUrl', () => {
  // The plugin can report an empty URL, and assigning it would throw away the last thing we
  // knew — sending the decision to "not mid sign-in" and closing mid-callback again.
  assert.match(code('src/lib/native/rc-handoff.ts'), /if \(at\) lastUrl = at;/);
});

test('a user-driven exit cancels the pending close', () => {
  // Otherwise the timer fires on a webview that is gone: close() on a dead ref, and a `close`
  // report naming a reason that never happened.
  const src = code('src/lib/native/rc-handoff.ts');
  const exit = src.slice(src.indexOf("addEventListener('exit'"));
  assert.ok(exit.length > 0, 'the exit listener must exist');
  assert.match(exit.slice(0, 300), /clearTimeout\(settleTimer\)/);
  assert.match(exit.slice(0, 300), /closedAlready = true/);
});

test('every close names a reason, and the three are distinguishable', () => {
  // A hand-off that still fails must say WHICH path it took. `token` is the ordinary
  // already-signed-in close, `settled` is RC finishing under its own steam (the fix
  // working), `timeout` is RC never finishing. Without the reason, a fix that never fired
  // and a fix that worked produce the identical report.
  const src = code('src/lib/native/rc-handoff.ts');
  assert.match(src, /stage: 'close', detail: \{ reason \}/);
  for (const reason of ['token', 'settled', 'timeout']) {
    assert.match(src, new RegExp(`closeOnce\\('${reason}'\\)`), reason);
  }
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
