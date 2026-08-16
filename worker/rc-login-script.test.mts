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
import { readFileSync } from 'node:fs';
import {
  loginScript, loginInvocation,
  SIGNIN_TEXTS, EMAIL_SELECTORS, PASSWORD_SELECTORS, ERROR_SELECTORS,
} from '../src/lib/rc-login-script.js';
import { buildPrecartScript } from '../src/lib/rc-precart-script.js';

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
  // Captured by side effect, because the invocation is an IIFE that returns nothing — see
  // `loginInvocation`'s header for why it has to be one.
  vm.runInContext(`window = {}; window.__chRcLogin = (e, p) => { window.got = { e, p }; };`, ctx);
  vm.runInContext(call, ctx);
  const got = (ctx.window as { got: { e: string; p: string } }).got;
  assert.equal(got.p, evil, 'the password must survive encoding byte for byte');
  assert.equal(got.e, 'user@example.com');
});

/**
 * THE LEAK OF 2026-08-16, GUARDED AT ITS MECHANISM.
 *
 * A user's real ReserveCalifornia password reached the production database because WebKit
 * quotes the failing SOURCE EXPRESSION in a TypeError, and the expression was
 * `window.__chRcLogin("<email>", "<password>")`. Nothing mishandled the secret — the engine
 * published it, and the bundle's global error listener reported it.
 *
 * This asserts the property that makes that impossible regardless of engine or scrubber: no
 * credential literal may sit inside a call expression. It is checked by EXECUTION as well as
 * by shape, because the value has to still arrive intact.
 */
test('no credential is inside a call expression — an engine quoting the source cannot leak one', () => {
  const call = loginInvocation('user@example.com', 'hunter2!');

  // Every `(` … `)` that follows an identifier. The credentials must appear in NONE of them.
  const callArgs = [...call.matchAll(/[\w.$]+\(([^()]*)\)/g)].map((m) => m[1]);
  assert.ok(callArgs.length > 0, 'the invocation must actually call something');
  for (const args of callArgs) {
    assert.ok(!args.includes('hunter2!'), `a call expression carries the password: ${args}`);
    assert.ok(!args.includes('user@example.com'), `a call expression carries the email: ${args}`);
  }
  // …and specifically the one that failed.
  assert.match(call, /__chRcLogin\(\s*\w+\s*,\s*\w+\s*\)/,
    'the sign-in must be called with identifiers, never with literals');
});

test('a missing sign-in script is a named report, not a thrown TypeError', () => {
  const call = loginInvocation('user@example.com', 'hunter2!');
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  // The exact 2026-08-16 state: the reporter is present, the sign-in is not.
  vm.runInContext(
    `window = {}; window.said = []; window.__camphawkRc = { send: (s, d) => window.said.push([s, d]) };`,
    ctx,
  );
  assert.doesNotThrow(() => vm.runInContext(call, ctx),
    'an absent __chRcLogin must not throw — a TypeError is what carried the password');

  const said = (ctx.window as { said: [string, unknown][] }).said;
  // Spread into a HOST array: `said` is built in the vm realm, so its prototype is a
  // different `Array` and a strict deep-equal fails on two identical-looking lists.
  assert.deepEqual([...said].map((s) => s[0]), ['login-unavailable'],
    'the failure must NAME itself; silence and a TypeError were the same evidence');
  assert.ok(!JSON.stringify(said).includes('hunter2!'), 'the report must not carry the password');
});

test('ClaimFlow surfaces login-unavailable — the screen must not just sit there', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /login-unavailable/,
    'the stage the invocation emits must be handled, or it is a silent dead end');
  assert.match(src, /login-threw/);
});

test("scrub() drops WebKit's source quote, which is the second layer", () => {
  // The regex lives in the served bundle as source lines; run the real thing rather than a
  // copy of it — a test asserting against a copy asserts the copy.
  const bundle = buildPrecartScript();
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${bundle.slice(bundle.indexOf('function scrub'), bundle.indexOf('function href'))}
     out = scrub("TypeError: window.__chRcLogin is not a function. "
       + "(In 'window.__chRcLogin(\\"a@b.com\\", \\"hunter2!\\")', 'window.__chRcLogin' is undefined)");`,
    ctx,
  );
  const out = String(ctx.out);
  assert.ok(!out.includes('hunter2!'), `scrub left the password in: ${out}`);
  assert.ok(!out.includes('a@b.com'), `scrub left the email in: ${out}`);
  assert.match(out, /is not a function/, 'the diagnosis must survive — only the quote goes');
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
  assert.match(src, /chSay\('captcha'/, 'a challenge must be announced so the user can clear it');
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

// ── THE WIRING ─────────────────────────────────────────────────────────────────────────
//
// The module above can be perfect while nothing calls it, or while a caller leaks the very
// thing it was careful with. These read the call site, because that is where the credential
// actually travels — and because a fix present but inert has cost this repo three commits.

test('the credentials are never React state', () => {
  // State lands in the component tree, in devtools, and in any error-boundary snapshot. They
  // belong to the closure of the one function that submits them and nowhere else.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  // MATCHED ON THE DECLARED NAME, not on proximity. The first version of this looked for
  // `password` AFTER `useState` on the same line and sailed straight past
  // `const [password, setPassword] = useState('')` — the exact declaration it exists to
  // forbid, because the name comes first. It survived its own mutation.
  const declared = [...src.matchAll(/const \[\s*(\w+)\s*,[^\]]*\]\s*=\s*useState/g)].map((m) => m[1]);
  const secret = declared.filter((n) => /password|passcode|credential|secret/i.test(n));
  assert.deepEqual(secret, [], `credentials must not be React state: ${secret.join(', ')}`);
  assert.match(src, /async function signInToRc\(email: string, password: string\)/,
    'the credentials arrive as arguments to the submitting function');
});

test('ClaimFlow hands the credentials over through loginInvocation, not by hand', () => {
  // The JSON encoding is the whole defence against a password containing a quote. A call site
  // that builds the string itself would reintroduce it silently.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /loginInvocation\(email, password\)/);
  assert.ok(!/__chRcLogin\(/.test(src), 'ClaimFlow must not compose the call itself');
});

test('the login injection fires once per hand-off', () => {
  // `afterLoad` is re-asked on EVERY navigation, and RC's sign-in walks out to Okta and back.
  // Without the guard the password is resubmitted on the return trip — and Okta locks
  // accounts, which is why the bot carries a two-strike rule.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const fn = src.slice(src.indexOf('async function signInToRc'));
  const body = fn.slice(0, fn.indexOf('\n  async function'));
  assert.match(body, /let sent = false/);
  assert.match(body, /if \(sent\) return null;/);
  assert.match(body, /sent = true;/);
});

test('the sign-in window cannot cart', () => {
  // No `unitId`, so `rcFragment` returns '' and the injected script finds no job. Signing in
  // and handing over stay separate acts — which is what lets the user decide when the ~2.5s
  // window where the site belongs to nobody actually opens.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const fn = src.slice(src.indexOf('async function signInToRc'));
  const body = fn.slice(0, fn.indexOf('\n  async function'));
  assert.ok(!/unitId/.test(body), 'the sign-in open must pass no unitId');
});

test('afterLoad runs AFTER the served bundle, which defines the function it calls', () => {
  // Reversed, `__chRcLogin` would be undefined and the call a silent no-op — and
  // `executeScript` returns nothing useful, so it would look exactly like a login that ran
  // and did nothing. Same silence as `status = 'sent'` meaning only "Twilio returned 2xx".
  const src = readFileSync('src/lib/native/rc-handoff.ts', 'utf8');
  const stop = src.slice(src.indexOf("ref.addEventListener('loadstop'"));
  const block = stop.slice(0, stop.indexOf('\n    },'));
  const bundle = block.indexOf('executeScript({ code })');
  const once = block.indexOf('afterLoad');
  assert.ok(bundle !== -1 && once !== -1 && bundle < once,
    'the bundle must be injected before the one-off call');
});

test('a captured token clears the captcha prompt', () => {
  // Leaving `captcha` on screen after a successful sign-in tells the user to solve a
  // challenge that is no longer there — the same shape as instructing an app user to
  // "switch to your ReserveCalifornia tab" in an app with no tabs.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const at = src.indexOf("setRcCheck('verified')");
  assert.ok(at !== -1);
  const after = src.slice(at, at + 500);
  assert.match(after, /setLoginStage\(null\)/);
});

test('the form stays mounted while the sign-in runs', () => {
  // `captcha` is the one stage the USER has a job for. Swapping the form for a spinner would
  // unmount the only thing able to tell them. TypeScript found this: it narrowed `rcCheck`
  // past 'opening' and made the dead `busy` prop an error.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /rcCheck === 'opening' && !canInject/,
    'the busy Step is for the path we cannot drive; the injectable path keeps the form');
});

test('the checkout button uses the OBSERVED cart URL, not a constructed one', () => {
  // The RC URL shape has been written from memory twice, both times answered with RC's
  // branded 404, the second time burning a live test that needed a human, an emulator and a
  // fresh build. `lib/booking-url` is the one place allowed to build an RC URL, and this one
  // was copied off the address bar rather than derived.
  const url = readFileSync('src/lib/booking-url.ts', 'utf8');
  assert.match(url, /RC_CART_URL = 'https:\/\/www\.reservecalifornia\.com\/Customers\/ShoppingCart'/);

  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /import \{ RC_CART_URL \} from '@\/lib\/booking-url'/);
  // SCOPED TO THE CART PATH. `bookingUrl`'s default is RC's home page and is a different
  // thing; forbidding every mention would fail on it and get this guard deleted.
  //
  // It found a real one on its first run: a hardcoded "/Customers/ShoppingCart" href already
  // in this file, added separately. Two spellings of one URL is how the park link came to be
  // wrong twice — hence the single constant.
  assert.ok(!/reservecalifornia\.com\/Customers/.test(src),
    'the cart URL must come from RC_CART_URL, never be spelled here');
});

test('checkout is offered only once a cart is REPORTED', () => {
  // A checkout button over an empty cart is the same broken promise the copy rule has
  // enforced since 2026-08-09: a user who believes the site is handled stops watching.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /\{carted && \(/, 'the button must be gated on the reported cart');
  assert.match(src, /includes\(CARTED_BANNER\)/, 'and set from the precart status report');
});

test('the carted banner text matches what the readout looks for', () => {
  // The screen and the post-mortem must agree about what "it worked" looks like. This is our
  // own copy, so changing it means changing both — pinned together rather than left to whoever
  // edits one of them.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const readout = readFileSync('scripts/rc-holds-readout.mts', 'utf8');
  const m = src.match(/const CARTED_BANNER = '([^']+)'/);
  assert.ok(m, 'CARTED_BANNER must be a named constant');
  assert.ok(readout.includes(m![1]),
    `rc-holds-readout.mts must look for the same phrase (${m![1]})`);
});

test('the checkout window cannot cart', () => {
  // No unitId, so rcFragment returns '' and the injected script finds no job. Otherwise
  // arriving on the cart page would re-run the precart against a cart that is already right.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const at = src.indexOf('openRcHandoff({ url: RC_CART_URL }');
  assert.ok(at !== -1, 'the checkout button must open the cart URL');
  assert.ok(!src.slice(at, at + 120).includes('unitId'), 'and pass no unitId');
});

// ── THE BUNDLE ACTUALLY DEFINES IT ─────────────────────────────────────────────────────
//
// THE BUG THESE EXIST FOR (2026-08-15, found by running it on a phone). The module, the
// wiring, the call site and eleven passing tests all existed — and `loginScript()` was never
// added to `buildPrecartScript()`. So `window.__chRcLogin` was undefined, the one-off
// injection threw inside a try, and the user saw RC's park page and nothing else.
//
// The guard that should have caught it asserted the ORDER of the two injections and never
// that the first defines what the second calls. Order is not existence. These run the REAL
// served bundle, which is the only assertion that could not have passed.

test('the served bundle defines the function the claim screen calls', async () => {
  const { buildPrecartScript } = await import('../src/lib/rc-precart-script.js');
  const bundle = buildPrecartScript();
  assert.match(bundle, /window\.__chRcLogin = function/,
    'buildPrecartScript must include loginScript() — the wiring is inert without it');
});

test('the whole served bundle parses', () => {
  // It concatenates our source with two files out of extension/. A syntax error in any of
  // them takes the precart down with the login, and `executeScript` reports nothing.
  const bundleSrc = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  assert.match(bundleSrc, /loginScript\(\),/, 'loginScript must be in the assembly list');
});

test('the login reports through the reporter that actually exists', () => {
  // `reporter()` exposes `window.__camphawkRc.send` and nothing else. The first version of
  // this module called `ch_report(...)`, invented from memory, which would have thrown on
  // every report — inside a try, so invisibly.
  const src = loginScript();
  assert.ok(!/ch_report\(/.test(src), 'ch_report does not exist — use the reporter API');
  assert.match(src, /window\.__camphawkRc\.send\(stage, detail/,
    'reports must go through window.__camphawkRc.send');
  // And it must survive the reporter being absent: losing diagnostics is survivable, losing
  // the sign-in is not.
  assert.match(src, /if \(window\.__camphawkRc\) window\.__camphawkRc\.send/);
});

test('no backticks inside the emitted template literal', () => {
  // The script is a template literal, so a backtick anywhere in it — including in a comment —
  // terminates the string, and the parse error surfaces somewhere unrelated. CLAUDE.md
  // records this for SQL comments in the poller; it has now cost a build here too.
  const file = readFileSync('src/lib/rc-login-script.ts', 'utf8');
  const body = file.slice(file.indexOf('export function loginScript'));
  const lit = body.slice(body.indexOf('return `') + 8, body.indexOf('\n  };'));
  assert.ok(!lit.includes('`'), 'a backtick inside the template literal ends it early');
});
