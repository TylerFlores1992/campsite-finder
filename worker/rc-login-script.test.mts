// The injected RC sign-in — the credential rules, and that the source actually runs.
//
// WHY A REAL PARSE AND A REAL EXECUTION. This module emits SOURCE that is handed to
// `executeScript` in a webview. `executeScript` returns nothing useful, so "threw on line 1",
// "ran and did nothing" and "worked" are the same silence — the family that gave us
// `status = 'sent'` meaning only "Twilio returned 2xx". A syntax error here would surface at
// 08:00 on somebody's phone as a hand-off that simply never happens. So the tests compile it
// and call it against a stub DOM rather than pattern-matching the text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  loginScript, loginInvocation,
  SIGNIN_TEXTS, EMAIL_SELECTORS, PASSWORD_SELECTORS, ERROR_SELECTORS,
} from '../src/lib/rc-login-script.js';

test('the emitted source parses', () => {
  // A bare `new vm.Script` is the cheapest possible proof, and the one thing no amount of
  // reading the file gives you.
  assert.doesNotThrow(() => new vm.Script(`(function(){ ${loginScript()} })`));
});

test('the served bundle contains no credential of any kind', () => {
  // `/api/rc-precart` serves the same bytes to everyone. A credential reaching this string
  // would be served to every user, cached, and impossible to recall.
  const src = loginScript();
  assert.ok(!/password\s*[:=]\s*['"]/.test(src), 'no literal password in the served source');
  assert.match(src, /window\.__chRcLogin = function \(email, password\)/,
    'credentials must arrive as ARGUMENTS, not be baked in');
});

test('the credentials are JSON-encoded at the call site', () => {
  // Not concatenation. A password containing a quote would break the script; one containing
  // `');` would change what it does.
  const evil = `a'b"c\\d');alert(1);//`;
  const call = loginInvocation('user@example.com', evil);
  assert.doesNotThrow(() => new vm.Script(call), 'a hostile password must not break the source');

  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(`window = {}; window.__chRcLogin = (e, p) => ({ e, p });`, ctx);
  const got = vm.runInContext(call, ctx) as { e: string; p: string };
  assert.equal(got.p, evil, 'the password must survive encoding byte for byte');
  assert.equal(got.e, 'user@example.com');
});

test('the result never carries the credentials back', () => {
  // The report channel is a diagnostic that has already leaked once — the first mobile
  // version reported `location.href` mid-OAuth and handed over an authorization code. The
  // rule that came out of it: do not collect a field you then have to filter.
  const src = loginScript();
  const done = src.slice(src.indexOf('var done = function'), src.indexOf('return (async function'));
  assert.match(done, /email = null; password = null;/,
    'the credentials must be dropped from memory when the flow ends');
  assert.match(done, /return \{ ok: ok, stage: stage, reason: reason \|\| null \}/,
    'the result is a verdict, never the inputs');
  // And no report call may pass them. MATCHED ON THE IDENTIFIER OUTSIDE QUOTES — the first
  // version of this assertion flagged `ch_report('password', {})`, which is a STAGE NAME, and
  // would have been "fixed" by renaming the stage rather than by finding a leak.
  for (const call of src.match(/ch_report\([^)]*\)/g) ?? []) {
    const unquoted = call.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    assert.ok(!/\b(password|email)\b/.test(unquoted),
      `a report passes a credential as a value: ${call}`);
  }
});

test('a CAPTCHA is a PAUSE here, not a full stop', () => {
  // rc-autologin treats a challenge as fatal, correctly — it runs unattended at 07:30. This
  // path has a human holding the phone who just tapped "complete the hand-off", so the same
  // rule would be wrong. Carrying the bot's posture onto this path is the mistake the
  // 2026-08-09 mobile tests warned about explicitly.
  const src = loginScript();
  assert.match(src, /ch_report\('captcha'/, 'a challenge must be announced so the user can clear it');
  assert.match(src, /chWait\(CH_EMAIL_SELS\.concat\(CH_PW_SELS\), 300000\)/,
    'and it must WAIT for them, not abort');
});

test('presence of a reCAPTCHA frame is not a challenge', () => {
  // The correction that cost a five-minute wait for a human with nothing to solve: RC loads
  // the widget on pages that automate fine, and the wrapper is toggled hidden between uses,
  // so an ancestor check is required and not just the frame's own box.
  const src = loginScript();
  assert.match(src, /r\.width < 100 \|\| r\.height < 100/, 'a 0x0 badge frame is not a challenge');
  assert.match(src, /for \(var el = f\.parentElement; el; el = el\.parentElement\)/,
    'ancestors must be checked — the wrapper is what gets hidden');
});

test('the sign-in control is matched on text, over anchors and buttons only', () => {
  // `:has-text()` is Playwright's, not CSS — querySelector THROWS on it, and a selector that
  // throws inside a try is one that silently matches nothing. And an injected script that
  // clicks any element whose text says "sign in" is how it starts pressing things nobody
  // meant, which is the rule content-rc.js already follows.
  const src = loginScript();
  assert.ok(!/querySelector\([^)]*:has-text/.test(src), ':has-text() must never reach querySelector');
  assert.match(src, /querySelectorAll\('a, button'\)/, 'anchors and buttons only');
  assert.ok(SIGNIN_TEXTS.includes('log in' as never),
    "RC's control says 'Log in / Sign up' — a 'sign in' substring does not match it");
});

test('"Keep me signed in" is ticked, because the idx cookie depends on it', () => {
  // No tick, no Okta session, and the whole renewal path has nothing to renew against.
  assert.match(loginScript(), /function chKeepSignedIn/);
  assert.match(loginScript(), /chKeepSignedIn\(\)/);
});

test('Enter submits, not a button click', () => {
  // Okta disables Next mid-transaction, so a click reports success and does nothing. This
  // file had it backwards once and cost two failed runs.
  const src = loginScript();
  assert.match(src, /key: 'Enter'/);
  assert.match(src, /chSubmit\(user\)/);
  assert.match(src, /chSubmit\(pw\)/);
});

test("Okta's own error is read, never guessed from a timeout", () => {
  const src = loginScript();
  assert.match(src, /function chOktaError/);
  // The selectors reach the source through JSON.stringify, so the quotes are ESCAPED there.
  // Asserting the raw form passed on nothing and failed on a correct implementation.
  assert.ok(ERROR_SELECTORS.every((sel) => src.includes(JSON.stringify(sel).slice(1, -1))),
    'every error selector must reach the emitted source');
  assert.ok([...ERROR_SELECTORS].includes('[role="alert"]'));
  assert.match(src, /return done\(false, 'failed', err\)/, 'and it must be the reported reason');
});

test('the selector lists match the ones the bot actually signs in with', () => {
  // Ported, not invented. rc-autologin.mjs is itself ported from rc-probe.mjs — the version
  // that worked — and writing a fresh list cost two failed runs against walls the probe had
  // already documented. If the bot's lists change, these should be revisited together.
  assert.deepEqual([...EMAIL_SELECTORS], [
    'input[name="identifier"]',
    'input[name="username"]',
    '#okta-signin-username',
    'input[autocomplete="username"]',
    'input[type="email"]',
  ]);
  assert.deepEqual([...PASSWORD_SELECTORS], [
    'input[name="credentials.passcode"]',
    'input[name="password"]',
    '#okta-signin-password',
    'input[type="password"]',
  ]);
});

test('an existing session short-circuits before any credential is typed', () => {
  // Asking first is what stops us submitting a credential we did not need — and a needless
  // submission is the act that carries the CAPTCHA and lockout risk.
  const src = loginScript();
  const body = src.slice(src.indexOf('return (async function'));
  const check = body.indexOf('window.__camphawkRcToken');
  const setValue = body.indexOf('chSetValue');
  assert.ok(check !== -1 && setValue !== -1 && check < setValue,
    'the already-signed-in check must come before anything is typed');
});
