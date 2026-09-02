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
  SIGNIN_MAX_NAME_LEN, SIGNIN_WAIT_MS,
} from '../src/lib/rc-login-script.js';
import { buildPrecartScript } from '../src/lib/rc-precart-script.js';

/** Emitted source with its comments removed, so a guard cannot trip on its own reasoning. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A context with a CLOCK, because the sign-in waits now.
 *
 * `vm.createContext({})` has no `setTimeout` at all — CLAUDE.md records the day that cost,
 * because every path past the first poll threw and was swallowed by the outer `catch`, and
 * the tests still passed: they only asserted that SOME verdict was reported, so they were
 * measuring the ERROR path while reading as though they measured the flow. This file's
 * "reports its verdict" test was in exactly that state until 2026-08-23, when the sign-in
 * started polling for RC's control and the vacuum became visible.
 *
 * Real timers are not the fix either: the control hunt waits `SIGNIN_WAIT_MS` and the form
 * hunt 15s after it, so an honest run of the empty-page case is half a minute of wall clock.
 * So the clock is FAKE and `setTimeout` ADVANCES it — every deadline is reached in order,
 * at full iteration count, in milliseconds. Only the durations are imaginary; the sequence
 * the assertions depend on is the real one.
 */
function loginSandbox(): Record<string, unknown> {
  let clock = 1_700_000_000_000;
  const ctx: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms = 0) => {
      clock += Math.max(ms, 1);
      return setTimeout(fn, 0);
    },
    clearTimeout,
    Date: new Proxy(Date, { get: (t, k) => (k === 'now' ? () => clock : Reflect.get(t, k)) }),
    Promise,
    Array,
    JSON,
    String,
    Infinity,
  };
  vm.createContext(ctx);
  return ctx;
}

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
  //
  // RE-ANCHORED 2026-09-01, NOT RELAXED. This pinned the literal expression
  // `chKeepSignedIn()`, so giving the function an argument that names WHICH step called it
  // failed the guard over behaviour that had not changed at all — the shape CLAUDE.md
  // records more than twenty times. The property is that BOTH steps tick, so assert that,
  // and count the call sites so deleting one still fails.
  const src = loginScript();
  assert.match(src, /function chKeepSignedIn/);
  const calls = src.match(/chKeepSignedIn\(/g) ?? [];
  // Three: the definition and the two call sites. Fewer means a step stopped ticking.
  assert.equal(calls.length, 3,
    `expected the definition and both call sites to tick; found ${calls.length} occurrence(s)`);
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
  // RE-ANCHORED 2026-08-23, and the property it guards became TRUE for the first time in
  // the same change. This read `window.__camphawkRcToken` — a global belonging to the bot's
  // Playwright capture that nothing in a webview has ever set, so the check it was pinning
  // could never fire and the ordering it asserted was vacuous. `chSignedIn()` asks the
  // reporter, which is the one thing here that watches the token broadcast.
  const check = body.indexOf('chSignedIn()');
  const setValue = body.indexOf('chSetValue');
  assert.ok(check !== -1 && setValue !== -1 && check < setValue,
    'the already-signed-in check must come before anything is typed');
  // CODE ONLY. The comment explaining this quotes the dead global by name, and a guard that
  // fails on its own explanation gets "fixed" by deleting the explanation —
  // `chromium-attribution.test.mts` reads assignments only for the same reason.
  assert.ok(!stripComments(src).includes('__camphawkRcToken'),
    'nothing in a webview sets that global — reading it is how the check went dead');
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

// REPLACED, NOT RELAXED. This guard used to pin `let sent = false` — "fires once per
// hand-off" — and it was pinning the defect. Its own comment had the reasoning right ("RC's
// sign-in walks out to Okta and back") and drew the opposite conclusion: firing once means
// the sign-in runs on the park page, clicks through to Okta, dies with the JS context, and is
// never invoked on the page that has the form. The half it was protecting is real — a
// resubmitted password can lock the account — and both halves are now pinned by
// 'the credentials are offered once per PAGE', above.

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
  // COMMENTS STRIPPED FIRST, and that is the whole repair. This was a raw 500-character
  // proximity window, so on 2026-08-29 a comment added between the two calls pushed them
  // apart and the guard failed over behaviour that had not changed — the same shape as
  // `rehearsal.test.mts`'s `[\s\S]{0,220}` window. A guard that fails when somebody explains
  // the code gets "fixed" by deleting the explanation.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  // BOUNDED BY THE NEXT STATE TRANSITION, not by a character count. Verified by mutation:
  // deleting the `setLoginStage(null)` in this branch left another one inside the old
  // 500-character window, so the guard passed against the regression it exists for. A window
  // measured in characters is a guess about layout; the next `setRcCheck(` is the actual end
  // of this branch's work.
  // RE-ANCHORED 2026-09-01 (#249): `setRcCheck('verified')` moved out of the token branch —
  // the gate flips on RC's own `rc-session` now — so the anchor is the line that IS still
  // the token branch's: the deadline it records.
  const at = src.indexOf('setTokenDeadline(');
  assert.ok(at !== -1);
  // THE BRANCH CLOSE, and getting here took three attempts, each verified by mutation. A
  // 500-character window reached into the `login-result` handler below, which has its own
  // `setLoginStage(null)` — so did bounding on the next `setRcCheck(`. Both passed against
  // the deletion they exist to catch. The `else {` block ends at its own dedented brace.
  const next = src.indexOf('\n      }', at);
  const after = src.slice(at, next === -1 ? undefined : next);
  assert.match(after, /setLoginStage\(null\)/,
    'a captured token must clear the captcha prompt in the SAME branch that accepts it');
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

/**
 * THE SIGN-IN MUST GET A TURN ON EVERY PAGE OF OKTA'S FLOW, AND ONLY ONE PER PAGE.
 *
 * `__chRcLogin` starts by clicking RC's sign-in control, which navigates to
 * `signin.reservecalifornia.com` and destroys the JS context. A caller that fires `afterLoad`
 * once ran the sign-in on the park page, clicked through, and was never invoked again on the
 * page that has the form — the webview then just sits there, which is indistinguishable from
 * every other silent failure this channel exists to eliminate.
 *
 * Firing on EVERY load is the opposite error and the more expensive one: a repeat `loadstop`
 * on the page we just submitted on resubmits the password, and Okta locks accounts.
 *
 * Simulated against the real callback rather than asserted by reading it — the whole defect
 * was that the shape looked right.
 */
test('the credentials are offered once per PAGE — not once per handoff, not once per load', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const body = src.slice(src.indexOf('async function signInToRc'), src.indexOf('async function prepareRc'));

  const max = Number(/const MAX_LOGIN_PAGES = (\d+)/.exec(src)?.[1]);
  assert.ok(Number.isFinite(max) && max >= 4 && max <= 10,
    'a redirect loop posting a password must be bounded, and Okta needs ~4 pages');

  // Rebuild the callback's rule from its own source, then drive it.
  const pages = new Set<string>();
  const decide = (at: string) => {
    let key = at;
    try { const u = new URL(at); key = u.origin + u.pathname; } catch { /* keep raw */ }
    if (pages.has(key) || pages.size >= max) return null;
    pages.add(key);
    return 'FIRE';
  };
  assert.match(body, /pages\.has\(key\)\s*\|\|\s*pages\.size >= MAX_LOGIN_PAGES/,
    'the caller must gate on BOTH the seen-set and the cap');
  assert.match(body, /u\.origin \+ u\.pathname/,
    "key on origin+path: Okta's callback carries an exchangeable ?code=");

  const walk = [
    'https://www.reservecalifornia.com/park/720/715',
    'https://www.reservecalifornia.com/park/720/715',   // repeat load — must NOT refire
    'https://signin.reservecalifornia.com/oauth2/v1/authorize',
    'https://signin.reservecalifornia.com/login/callback?code=SECRET&state=x',
    'https://signin.reservecalifornia.com/login/callback?code=OTHER&state=y', // same page
  ].map(decide);
  assert.deepEqual(walk, ['FIRE', null, 'FIRE', 'FIRE', null],
    'a new page gets a turn; a reload and a re-entry of the same page do not');

  // The cap actually stops it.
  for (let i = 0; i < 20; i++) decide(`https://signin.reservecalifornia.com/loop/${i}`);
  assert.equal(pages.size, max, 'the cap must bound a redirect loop absolutely');
});

test('afterLoad is handed the URL, and the webview actually passes it', () => {
  const handoff = readFileSync('src/lib/native/rc-handoff.ts', 'utf8');
  assert.match(handoff, /afterLoad\?:\s*\(url: string\)\s*=>\s*string \| null/,
    'the signature must carry the page, or the caller cannot tell pages apart');
  // AND THE CALLER MUST STILL BE CALLED WITH IT. A widened signature that is invoked with
  // nothing is the inert-fix shape: it typechecks, it reviews well, and it changes nothing.
  assert.match(handoff, /const once = afterLoad\(at\);/,
    'the loadstop handler must pass the URL it just loaded');
  assert.match(handoff, /\(ev as \{ url\?: string \} \| undefined\)\?\.url/,
    'the URL must come off the loadstop event');
});

/**
 * EVERY TERMINAL PATH MUST ANNOUNCE ITSELF.
 *
 * Until 2026-08-16 `done()` only RETURNED its verdict, and `executeScript` discards return
 * values — so "could not find RC's sign-in control", "the password field never appeared",
 * "Okta rejected the password" and "signed in" were the same silence. A real run reported
 * `injected`, `session`, `idle` and stopped: the sign-in had run, failed, and said nothing,
 * which is indistinguishable from its never having been invoked at all. That ambiguity cost
 * two test cycles, because each failure looked exactly like the previous bug.
 *
 * Driven against a stub DOM rather than pattern-matched, so it fails if the report stops
 * being reachable as well as if the line is deleted.
 */
test('a failed sign-in reports its verdict — silence was the whole problem', async () => {
  const ctx: Record<string, unknown> = loginSandbox();
  // A page with nothing on it: no token, no password field, no sign-in control. That is the
  // shape a real run hit, and it used to produce not one report.
  vm.runInContext(`
    said = [];
    window = { __camphawkRc: { send: (s, d) => said.push([s, d]) } };
    document = { querySelector: () => null, querySelectorAll: () => [] };
    HTMLInputElement = function () {}; HTMLTextAreaElement = function () {};
  `, ctx);
  vm.runInContext(loginScript(), ctx);
  await vm.runInContext(`window.__chRcLogin("a@b.com", "hunter2!")`, ctx) as Promise<unknown>;

  const said = [...(ctx.said as [string, Record<string, unknown>][])];
  const stages = said.map((s) => s[0]);
  assert.ok(stages.includes('login-result'),
    `a terminal outcome must be announced; got ${JSON.stringify(stages)}`);

  const verdict = said.find((s) => s[0] === 'login-result')![1];
  assert.equal(verdict.ok, false, 'this run cannot have succeeded');
  assert.ok(verdict.reason, 'the verdict must say WHY — that is the entire point');
  assert.ok(!JSON.stringify(said).includes('hunter2!'), 'no report may carry the password');

  // AND the miss that caused it is named separately: "RC reworded its control" and "the page
  // had not rendered" need different fixes and used to be the same nothing.
  assert.ok(stages.includes('signin-missing'),
    `not finding RC's sign-in control is a fact and must be reported; got ${JSON.stringify(stages)}`);
});

test('ClaimFlow shows the verdict rather than sitting there', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  assert.match(src, /r\.stage === 'login-result'/, 'the verdict must be handled');
  assert.match(src, /d\?\.reason \|\|/,
    "RC's own words when we have them — 'wrong password' and 'no form found' differ");
  assert.match(src, /'signin-missing'/, 'the miss must reach the form as a stage');
});

// ── THE 2026-08-20 FILL BUG ────────────────────────────────────────────────────────────
//
// A real claim reported email/password/submitted and then Okta's form-level error, with the
// DOM read-back passing throughout. The cause is React's `_valueTracker`: it suppresses the
// change event when handed a value equal to the one it already tracks, and iOS keychain
// autofill had already put the address there. So the widget's model stayed empty behind a
// field that visibly held the right text — "can't leave blank even though it was filled in".
//
// These run the REAL emitted source against a stub that reproduces the tracker's rule, so a
// regression is caught by behaviour rather than by the shape of the code.

/**
 * The stub context needs REAL TIMERS, and that is not a detail.
 *
 * `vm.createContext({})` has no `setTimeout`, so every path through the emitted script that
 * awaits one — `chWait`'s poll, and `chSettle` — throws immediately and is swallowed by the
 * outer catch as a generic failure. The older stub tests above ran that way and passed,
 * because they only assert that SOME verdict was reported. So they were proving the error
 * path worked, not the sign-in. Anything asserting on progress past the first timer has to
 * install these first.
 */
function stubContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = { setTimeout, clearTimeout };
  vm.createContext(ctx);
  return ctx;
}

/** A stub input whose framework state only updates when React's tracker sees a change. */
const REACT_STUB = `
  said = []; submits = []; frameworkState = '';
  Event = function (t) { this.type = t; };
  FocusEvent = function (t) { this.type = t; };
  KeyboardEvent = function (t, o) { this.type = t; this.key = (o || {}).key; };
  HTMLTextAreaElement = function () {};
  HTMLInputElement = function () {};
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true,
    get: function () { return this.__v; },
    set: function (v) { this.__v = v; },
  });
  function makeInput(autofilled) {
    var el = Object.create(HTMLInputElement.prototype);
    el.__v = autofilled;
    el.offsetParent = {};
    el.focus = function () {};
    // React's real rule, modelled exactly: the change is delivered to the framework ONLY
    // when the tracked value differs from the node's current value.
    var tracked = autofilled;
    el._valueTracker = {
      getValue: function () { return tracked; },
      setValue: function (v) { tracked = v; },
    };
    el.dispatchEvent = function (ev) {
      if (ev.type === 'input') {
        if (tracked !== el.__v) { frameworkState = el.__v; tracked = el.__v; }
      } else if (ev.type === 'keydown' && ev.key === 'Enter') {
        submits.push(frameworkState);
      }
    };
    return el;
  }
`;

test('an autofilled field still reaches the framework — the tracker must be reset', async () => {
  const ctx = stubContext();
  vm.runInContext(REACT_STUB, ctx);
  vm.runInContext(`
    var email = makeInput('a@b.com');   // <- autofill already put the SAME address here
    window = {
      __camphawkRc: { send: function (s, d) { said.push([s, d]); } },
      __camphawkRcToken: null,
    };
    document = {
      querySelector: function (s) { return /pass/i.test(s) ? null : email; },
      querySelectorAll: function () { return []; },
    };
  `, ctx);
  vm.runInContext(loginScript(), ctx);
  await vm.runInContext(`window.__chRcLogin("a@b.com", "hunter2!")`, ctx) as Promise<unknown>;

  assert.equal(ctx.frameworkState, 'a@b.com',
    'the widget never saw the address: React suppressed the change because the tracked ' +
    'value already equalled it. That is the 2026-08-20 bug, and Okta answers it with ' +
    '"we found some errors" over a field that looks correctly filled.');
});

test('the fill SETTLES before the submit — structural, because a stub cannot batch', () => {
  // The second candidate mechanism for the 08-20 failure: submitting in the same synchronous
  // block as the fill lets a batched framework handle it while its model still holds the old
  // value. It produces an identical symptom to the tracker bug and the trace cannot separate
  // them, so both are fixed.
  //
  // THIS ONE IS ASSERTED STRUCTURALLY ON PURPOSE. The stub below models React's tracker rule
  // faithfully because that rule is documented and synchronous; it does NOT model React's
  // async batching, and inventing a batching model would mean asserting against my own
  // guess. A behavioural test written on top of that stub PASSED with the settle removed —
  // it was measuring the tracker fix twice and reporting it as two guards. A structural
  // assertion that admits what it is beats a behavioural one that proves something else.
  const src = loginScript();
  for (const field of ['user', 'pw']) {
    const at = src.indexOf(`chSubmit(${field})`);
    assert.ok(at > -1, `chSubmit(${field}) must exist — anchor not found`);
    const before = src.slice(Math.max(0, at - 200), at);
    assert.match(before, /await chSettle\(\);\s*$/,
      `the ${field} submit must be preceded by a settle, or it can race the framework flush`);
  }
});

test('the emitted bundle is free of control characters', () => {
  // A NUL reached this file while the tracker fix was being written: an intended space came
  // through as \x00, and NOTHING noticed — tsc passed, every test passed, and it would have
  // been served to every webview. This repo has already lost a day to a NUL (an admin
  // diagnostic went unstorable because Postgres text cannot hold one) and a day to a
  // non-ASCII byte in a .ps1. The bundle is generated source shipped verbatim, so it gets
  // the same rule the PowerShell scripts have.
  for (const [name, src] of [['loginScript', loginScript()],
                             ['loginInvocation', loginInvocation('a@b.com', 'pw')]] as const) {
    const bad = [...src].map((c, i) => [c, i] as const)
      .filter(([c]) => c !== '\n' && c !== '\t' && c.charCodeAt(0) < 0x20);
    assert.deepEqual(bad, [],
      `${name} contains a control character at ${JSON.stringify(bad.map(([, i]) => i))}`);
  }
});

test('the fill blurs, because Okta validates required fields on blur', () => {
  // Without it the first thing to read the model is the submit, and the failure arrives as a
  // form-level error with no field attached — which is exactly what 08-20 reported.
  const src = loginScript();
  const at = src.indexOf('function chSetValue');
  assert.ok(at > -1, 'chSetValue must still exist — anchor not found');
  const body = src.slice(at, src.indexOf('\n  }', at));
  assert.match(body, /dispatchEvent\(new FocusEvent\('blur'/, 'the fill must blur');
  assert.match(body, /_valueTracker/, 'and it must reset the tracker');
  assert.ok(body.indexOf('_valueTracker') < body.indexOf("new Event('input'"),
    'the tracker reset is pointless after the value is written and the event dispatched');
});

test('the password is never read back into a comparison', () => {
  // The email field IS read back, deliberately. The password must not be: a comparison is an
  // expression, and an engine quoting a failing expression is exactly how a real password
  // reached the database on 2026-08-16.
  const src = loginScript();
  assert.ok(!/\bpw\.value\s*!==\s*password\b/.test(src),
    'comparing pw.value to the password puts the secret in an expression that can be quoted');
  assert.match(src, /user\.value !== email/, 'the email read-back stays — it is safe and useful');
});

// ── FINDING RC'S OWN SIGN-IN CONTROL (2026-08-23) ──────────────────────────────────────
//
// Owner, after a hold that otherwise worked perfectly: "I enter my info on our app side.
// Click our button to sign in. Takes me to RC. It scrolls to calendar. Nothing happens. I
// hit login on that page and it then completed everything for me."
//
// Three defects, all reproduced against the SERVED BUNDLE before anything was written —
// `chSignInControl()` was called once, synchronously, with no visibility test and a bare
// substring match in document order. These run the real emitted source against a stub page
// rather than reading it, because "clicked the wrong element" and "found nothing" both look
// like a calendar to the person holding the phone.

type Btn = { name: string; visible: boolean; clicks: number };
const btn = (name: string, visible = true): Btn => ({ name, visible, clicks: 0 });

/** A page whose anchors and buttons are ours, optionally appearing only after N looks. */
function signinPage(opts: { now?: Btn[]; later?: Btn[]; afterLooks?: number; signedIn?: boolean }) {
  const ctx = loginSandbox();
  let looks = 0;
  const wrap = (b: Btn) => ({
    get innerText() { return b.visible ? b.name : ''; },
    get textContent() { return b.name; },
    get offsetParent() { return b.visible ? {} : null; },
    getBoundingClientRect: () => (b.visible ? { width: 90, height: 24 } : { width: 0, height: 0 }),
    click() { b.clicks += 1; },
  });
  const said: [string, Record<string, unknown>][] = [];
  const doc = {
    querySelector: () => null,
    querySelectorAll: (sel: string) => {
      if (sel !== 'a, button') return [];
      looks += 1;
      const live = [...(opts.now ?? [])];
      if (opts.later && looks > (opts.afterLooks ?? 3)) live.push(...opts.later);
      return live.map(wrap);
    },
  };
  ctx.document = doc;
  ctx.window = {
    __camphawkRc: {
      send: (s: string, d: Record<string, unknown>) => { said.push([s, d]); },
      signedIn: () => opts.signedIn === true,
    },
  };
  ctx.HTMLInputElement = function () {};
  ctx.HTMLTextAreaElement = function () {};
  vm.runInContext(loginScript(), ctx);
  return {
    said,
    stages: () => said.map((s) => s[0]),
    run: () => vm.runInContext('window.__chRcLogin("a@b.com", "hunter2!")', ctx) as Promise<unknown>,
  };
}

test('the sign-in control is WAITED for — RC renders its header after we are injected', async () => {
  // THE DEFECT THE OWNER HIT. We are injected at `loadstop`; RC's SPA paints its header
  // afterwards, on its own clock. One synchronous look loses that race silently — and then
  // spends fifteen seconds waiting for a credential form nothing asked for, which is the
  // calendar they sat in front of. `scrollToTop()` already documents the same race.
  const late = btn('Log in / Sign up');
  const p = signinPage({ now: [], later: [late], afterLooks: 3 });
  await p.run();

  assert.equal(late.clicks, 1, "RC's control must be pressed once it appears");
  assert.ok(p.stages().includes('signin-open'), 'and the press must be reported');
  assert.ok(!p.stages().includes('signin-missing'),
    'a control that arrived late was not missing — reporting it so hides the real fault');
});

test('a control that is in the DOM but not on the page is never clicked', async () => {
  // RC ships a responsive header, so the same words exist twice and one copy is hidden.
  // The old matcher took the first in DOCUMENT ORDER and clicked it — and clicking a hidden
  // element does nothing while still reporting `signin-open`, so the run announced that it
  // had opened the sign-in and then waited for a form that could never come. A false
  // positive is worse than the miss: it points the next reader at the wrong half.
  const hidden = btn('Log in / Sign up', false);
  const shown = btn('Log in / Sign up', true);
  const p = signinPage({ now: [hidden, shown] });
  await p.run();

  assert.equal(hidden.clicks, 0, 'a hidden control cannot be pressed by a user or by us');
  assert.equal(shown.clicks, 1, 'the one they can see is the one to press');
});

test('the SHORTEST visible match wins, so a container never beats the control', async () => {
  // The test has to stay a SUBSTRING one — RC says "Log in / Sign up", so an anchored
  // `/^log ?in$/` matches nothing, which is the trap SIGNIN_LINK_SELECTORS' header records.
  // Over a whole page that also matches any ancestor carrying those words. Ranking by name
  // length is what keeps a substring match safe.
  // SHORT ENOUGH TO PASS THE CEILING, so this measures the RANKING and not the ceiling.
  const wrapper = btn('Log in / Sign up My account');
  const control = btn('Log in / Sign up');
  const p = signinPage({ now: [wrapper, control] });
  await p.run();

  assert.equal(wrapper.clicks, 0, 'a region that merely contains the words is not the control');
  assert.equal(control.clicks, 1);
});

test('a name too long to be a control is rejected outright', () => {
  // The length ceiling is the backstop for the ranking above: if the only match on the page
  // is a whole nav region, pressing it is still wrong.
  assert.ok(SIGNIN_MAX_NAME_LEN >= 'log in / sign up'.length + 8,
    'RC could reword this — leave room');
  assert.ok(SIGNIN_MAX_NAME_LEN <= 80, 'a ceiling this high stops excluding containers');
});

test('the wait ends the moment a session appears, not when it times out', async () => {
  // A SIGNED-IN USER HAS NO SIGN-IN CONTROL, because RC does not render one for them. The
  // old code asked `window.__camphawkRcToken` once, up top — a global nothing in a webview
  // sets — so it went hunting anyway. Even with a real signal, asking once would miss: the
  // token arrives with RC's first authenticated call, which is also after `loadstop`.
  // Whichever becomes true first has to end the wait.
  const p = signinPage({ now: [], signedIn: true });
  const r = await p.run() as { ok: boolean; stage: string };

  assert.equal(r.ok, true);
  assert.equal(r.stage, 'signed-in');
  assert.ok(!p.stages().includes('signin-missing'),
    'a signed-in webview is not a page where the control went missing');
});

test('the wait is bounded, and a real miss is still reported', async () => {
  const p = signinPage({ now: [] });
  await p.run();
  assert.ok(p.stages().includes('signin-missing'),
    "not finding RC's control after waiting is a fact, and needs a different fix from a reword");
  assert.ok(SIGNIN_WAIT_MS >= 5_000, 'shorter than the SPA takes to boot and this is the bug again');
  assert.ok(SIGNIN_WAIT_MS <= 20_000,
    'the form hunt waits again after this one — a long wait here is a user watching a calendar');
});

// ── "KEEP ME SIGNED IN" WAS A SILENT NO-OP ─────────────────────────────────────────────
//
// 2026-09-01. Two hand-offs eleven minutes apart on the same code: iOS carted and RC's
// header carried the owner's name; Android carted and RC asked him to log in. Their traces
// matched on every recorded field — `✓ Added to cart`, `cart read back: 1 entry`,
// `close: timeout`, the same okta-store census. The instruments did not measure the thing
// that differed, which is the failure this repo records more often than any other.
//
// The stages diverged upstream:
//
//     iOS      signin-missing → email → password → submitted
//     Android  signin-open    →         password → submitted
//
// Android never reached Okta's IDENTIFIER page: a password field was already present, so
// the caller skipped the email step. Okta renders "Keep me signed in" on the identifier
// step — so there was no checkbox in the DOM, `chKeepSignedIn` found nothing, and returned
// a boolean NOBODY READ. "Ticked it" and "there was no box" were the same silence.
//
// That is load-bearing rather than cosmetic: this repo measured on 2026-08-09 that the box
// is what makes Okta issue a persistent session (`okta=GONE(404)` before it was ticked, a
// ~12h session after), and the function's own comment says the `idx` cookie comes from it.
// A run without it still completes the OAuth exchange and mints a good access token — which
// is why the cart POSTs succeed — while leaving nothing for RC's SPA to render a name from.
test('the keep-signed-in tick reports itself, including when there is no box', async () => {
  const ctx = stubContext();
  vm.runInContext(REACT_STUB, ctx);
  // THE ANDROID PATH, MODELLED EXACTLY: a password field is already on the page, so the
  // email step is skipped — and there is not one checkbox anywhere.
  vm.runInContext(`
    var pw = makeInput('');
    window = {
      __camphawkRc: { send: function (s, d) { said.push([s, d]); } },
      __camphawkRcToken: null,
    };
    document = {
      querySelector: function (s) { return /pass/i.test(s) ? pw : null; },
      querySelectorAll: function () { return []; },
    };
  `, ctx);
  vm.runInContext(loginScript(), ctx);
  await vm.runInContext(`window.__chRcLogin("a@b.com", "hunter2!")`, ctx) as Promise<unknown>;

  const said = [...(ctx.said as [string, Record<string, unknown>][])];
  const keep = said.find((s) => s[0] === 'keep-signed-in');
  assert.ok(keep, `the tick must report; got stages ${JSON.stringify(said.map((s) => s[0]))}`);
  assert.equal(keep![1].ticked, false, 'there was no checkbox, so nothing can have been ticked');
  // ZERO IS THE WHOLE FINDING and must be reported as a number, not merely as "not ticked".
  // "The page never offered the option" and "the box was there and the selector missed it"
  // are a flow problem and a selector problem respectively, and they have nothing to do with
  // each other. Collapsing them puts the next reader on the wrong hunt.
  assert.equal(keep![1].boxes, 0, 'the candidate count separates a missing page from a missed match');
  assert.ok(!JSON.stringify(said).includes('hunter2!'), 'no report may carry the password');
});

test('a box that IS there is ticked, and says so', async () => {
  const ctx = stubContext();
  vm.runInContext(REACT_STUB, ctx);
  vm.runInContext(`
    var pw = makeInput('');
    var box = { offsetParent: {}, checked: false, name: 'rememberMe', id: '', clicks: 0,
                click: function () { this.clicks++; this.checked = true; } };
    window = {
      __camphawkRc: { send: function (s, d) { said.push([s, d]); } },
      __camphawkRcToken: null,
    };
    document = {
      querySelector: function (s) { return /pass/i.test(s) ? pw : null; },
      querySelectorAll: function (s) { return /checkbox/.test(s) ? [box] : []; },
    };
    theBox = box;
  `, ctx);
  vm.runInContext(loginScript(), ctx);
  await vm.runInContext(`window.__chRcLogin("a@b.com", "hunter2!")`, ctx) as Promise<unknown>;

  const said = [...(ctx.said as [string, Record<string, unknown>][])];
  const keep = said.find((s) => s[0] === 'keep-signed-in');
  assert.ok(keep, 'the tick must report on the success path too, not only on the miss');
  assert.equal(keep![1].ticked, true, 'a visible, unchecked, name-matching box must be clicked');
  // AND THE COUNT MUST REFLECT THE PAGE. Found by mutation: hardcoding `boxes: 0` passed the
  // whole suite, because the no-box test asserts zero (trivially true) and this one only ever
  // checked `ticked`. A permanently-zero count reads as "Okta never offered the option" on
  // EVERY run — the exact branch that sends the next reader to fix the flow instead of the
  // selector. The count is only worth reporting if it is measured.
  assert.equal(keep![1].boxes, 1, 'the count must be the real number of candidates on the page');
  // The report must describe what HAPPENED, not what was intended. Asserting the click
  // separately is what stops a report that always says `ticked: true`.
  assert.equal((ctx.theBox as { clicks: number }).clicks, 1, 'the box must actually be clicked once');
});

test('both call sites name where they were — a tick on the password step is a different fact', () => {
  // The `at` field is what turns "not ticked" into "not ticked ON THE PASSWORD STEP, having
  // skipped the identifier" — which is the Android trace. Without it the two call sites are
  // indistinguishable in the record and the readout cannot say which path the run took.
  const src = loginScript();
  assert.match(src, /chKeepSignedIn\('email'\)/, 'the identifier step must name itself');
  assert.match(src, /chKeepSignedIn\('password'\)/, 'the password step must name itself');
});

// ── THE CALLBACK PAGE IS RC'S, NOT OURS (2026-09-01, #250) ─────────────────────────────
//
// Measured on both platforms: re-run on /login/callback, the script found no form and no
// session yet and clicked RC's "Log in" — navigating away while RC's SDK was mid-exchange.
// A second callback followed; on Android the first exchange had already persisted
// ssoCustomerName, so the second boot ran RC's interceptor into customerLogOut and the home
// page. The user saw "Before booking, please sign in" over a locked campsite.

test('the sign-in script does NOTHING on /login/callback, and says so, before any other check', () => {
  const src = stripComments(loginScript());
  const body = src.slice(src.indexOf('return (async function'));
  const guard = body.indexOf("chPath.indexOf('/login/callback') === 0");
  const signedIn = body.indexOf('chSignedIn()');
  const click = body.indexOf('found.click()');
  assert.ok(guard !== -1, 'the callback guard must exist');
  assert.ok(guard < signedIn && guard < click,
    'the guard must run before the signed-in check and long before any click');
  assert.match(body, /chSay\('callback-in-flight'/, 'not acting must still be a named report');
  // A named terminal path, through done(), so the claim screen is told rather than left
  // waiting on a verdict that never arrives — the 08-16 silent-terminal-path lesson.
  assert.match(body, /return done\(true, 'callback-in-flight'/);
});

test('ClaimFlow does not hand the credential to the callback page at all', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const a = src.indexOf('afterLoad: (at: string) =>');
  assert.ok(a !== -1);
  const block = src.slice(a, src.indexOf('return loginInvocation(', a));
  assert.match(block, /\/login\\\/callback[\s\S]{0,40}return null/,
    'afterLoad must return null on the callback — a second guard for a cached older bundle');
});

// ── THE TWELVE-SECOND PAUSE ON OKTA'S PAGE (2026-09-02) ────────────────────────────────
//
// Owner, after three successful hand-offs: "RC opens and goes to login screen, there is a
// long pause before it clicks stay signed in and continues to password. I feel like an end
// user will assume it's failing and start to do things that could affect the login."
//
// He was right, and it was a defect rather than slowness. `chSignInControl()` looks for RC's
// OWN "Log in / Sign up" control. On `signin.reservecalifornia.com` that control does not
// exist, so the hunt could only ever run out the clock — every sign-in spent the full
// SIGNIN_WAIT_MS on Okta's identifier page before typing anything, then found the email field
// instantly. The trace said `signin-missing {candidates: 6}`: six anchors is Okta's sparse
// page, not RC's header.
//
// These run the REAL emitted script against a stub page, on a virtual clock, so the pause is
// measured rather than described.

/** A page that is Okta's or RC's, with a form and/or a sign-in control. */
function hostPage(opts: {
  host: string; form?: boolean; control?: Btn; signedIn?: boolean;
  /** Sessions arrive AFTER loadstop. Flip to signed-in once the wait has polled this often. */
  signedInAfterLooks?: number;
}) {
  const ctx = loginSandbox();
  const said: [string, Record<string, unknown>][] = [];
  let looks = 0;
  const field = () => ({
    value: '', focus() {}, blur() {}, dispatchEvent() {}, click() {},
    get offsetParent() { return {}; },
    setAttribute() {}, removeAttribute() {},
  });
  const wrap = (b: Btn) => ({
    get innerText() { return b.visible ? b.name : ''; },
    get textContent() { return b.name; },
    get offsetParent() { return b.visible ? {} : null; },
    getBoundingClientRect: () => ({ width: 90, height: 24 }),
    click() { b.clicks += 1; },
  });
  ctx.location = { hostname: opts.host, pathname: '/oauth2/v1/authorize' };
  ctx.document = {
    // Only the credential selectors resolve, and only when this page has a form.
    // EMAIL ONLY, which is what Okta's identifier page actually shows. Matching the password
    // selectors too made `pw = chFind(CH_PW_SELS)` succeed at the top of the run, skipping
    // the whole wait block this file exists to test — the stub was staging a page that does
    // not occur.
    querySelector: (sel: string) => (opts.form && /identifier|username|autocomplete="username"|type="email"/i.test(sel)
      && !/passcode|password/i.test(sel) ? field() : null),
    querySelectorAll: (sel: string) => (sel === 'a, button' && opts.control ? [wrap(opts.control)] : []),
  };
  ctx.window = {
    __camphawkRc: {
      send: (s: string, d: Record<string, unknown>) => { said.push([s, d]); },
      signedIn: () => {
        if (opts.signedIn === true) return true;
        if (opts.signedInAfterLooks === undefined) return false;
        looks += 1;
        return looks > opts.signedInAfterLooks;
      },
    },
  };
  ctx.HTMLInputElement = function () {};
  ctx.HTMLTextAreaElement = function () {};
  ctx.FocusEvent = function () {};
  ctx.Event = function () {};
  ctx.KeyboardEvent = function () {};
  vm.runInContext(loginScript(), ctx);
  const detail = (stage: string) => said.find((s) => s[0] === stage)?.[1];
  return {
    said,
    detail,
    stages: () => said.map((s) => s[0]),
    run: () => vm.runInContext('window.__chRcLogin("a@b.com", "hunter2!")', ctx) as Promise<unknown>,
  };
}

test("on Okta's own host the FORM ends the wait — no hunting a control that cannot be there", async () => {
  const p = hostPage({ host: 'signin.reservecalifornia.com', form: true });
  await p.run();
  assert.ok(p.stages().includes('signin-form'), `expected signin-form; got ${p.stages().join(',')}`);
  // THE PAUSE, MEASURED. The sandbox clock advances by each setTimeout's delay, so a run that
  // polled to the deadline reports the full SIGNIN_WAIT_MS here. Before this change it did.
  const waited = Number((p.detail('signin-form') as { waitedMs: number }).waitedMs);
  assert.ok(waited < 1_000, `the form was on the page and the script still waited ${waited}ms`);
  assert.ok(!p.stages().includes('signin-missing'),
    'a form found is not a control missing — reporting the miss is what read as failing');
});

test("on RC's own host a form does NOT end the wait — only RC's control does", async () => {
  // THE SAFETY PROPERTY, and the reason this is a host check rather than "race everything".
  // RC's pages carry their own login modal with email and password inputs, driving RC's
  // customerLogin — a DIFFERENT flow from the Okta SSO the whole hand-off depends on.
  // chFind requires offsetParent today, so a hidden modal cannot match; accepting the form on
  // RC's host anyway would put that one CSS change away from typing the credential into the
  // wrong form.
  const control = btn('Log in / Sign up');
  const p = hostPage({ host: 'www.reservecalifornia.com', form: true, control });
  await p.run();
  assert.equal(control.clicks, 1, "RC's own control must be what is pressed");
  assert.ok(p.stages().includes('signin-open'), `expected signin-open; got ${p.stages().join(',')}`);
  assert.ok(!p.stages().includes('signin-form'), 'the form must not win on RC\'s host');
});

test('every outcome of the wait reports how long it took', async () => {
  // The pause was invisible in the trace: `signin-missing` said the hunt failed and never
  // said it had spent twelve seconds failing. A number is what makes the next one a reading.
  const found = hostPage({ host: 'signin.reservecalifornia.com', form: true });
  await found.run();
  assert.equal(typeof (found.detail('signin-form') as { waitedMs?: unknown }).waitedMs, 'number');

  const clicked = hostPage({ host: 'www.reservecalifornia.com', control: btn('Log in / Sign up') });
  await clicked.run();
  assert.equal(typeof (clicked.detail('signin-open') as { waitedMs?: unknown }).waitedMs, 'number');

  // And a genuine miss still reports the miss, with the wait and which host it was on.
  const missed = hostPage({ host: 'www.reservecalifornia.com' });
  await missed.run();
  const d = missed.detail('signin-missing') as { waitedMs?: unknown; atOkta?: unknown };
  assert.equal(typeof d.waitedMs, 'number');
  assert.equal(d.atOkta, false);
});

test('an already-signed-in session short-circuits before the wait is even entered', async () => {
  const p = hostPage({ host: 'signin.reservecalifornia.com', form: true, signedIn: true });
  const r = await p.run() as { stage: string };
  assert.equal(r.stage, 'signed-in');
  assert.ok(!p.stages().includes('signin-form'), 'a live session outranks the form');
});

test('a session that arrives DURING the wait ends it — the token lands after loadstop', async () => {
  // THIS GUARD REPLACES ONE THAT WAS VACUOUS, found by mutation. The version above stages a
  // session that is live BEFORE the run, so it returns at the top-of-run check and never
  // reaches the signed-in arm inside the wait predicate — deleting that arm left it green.
  //
  // The arm is real and this is the case for it: the token arrives with RC's first
  // authenticated call, which is after loadstop, so a session can appear mid-wait. Without
  // the arm this run polls to the deadline and reports a miss over a session that is fine.
  const p = hostPage({ host: 'www.reservecalifornia.com', signedInAfterLooks: 2 });
  const r = await p.run() as { stage: string };
  assert.equal(r.stage, 'signed-in', `expected the wait to end on the session; got ${p.stages().join(',')}`);
  assert.ok(!p.stages().includes('signin-missing'),
    'a session appearing mid-wait is not a missing control');
});

// ── A CHALLENGE BETWEEN THE EMAIL AND THE PASSWORD (2026-09-02) ────────────────────────
//
// Owner, on the fifth Android hand-off: "RC opened. captcha. completed. I had to finish sign
// in by hand." The trace says exactly where it gave up:
//
//   email {}
//   login-result {"ok":false,"stage":"password","reason":"the password field never appeared"}
//
// Okta shows its challenge AFTER the identifier is submitted. There are challenge arms either
// side of that gap — before the email, after the password — and there was none inside it, so
// `chWait(CH_PW_SELS, 20000)` ran a flat twenty seconds while a human solved the puzzle and
// then reported a failure over a sign-in that was proceeding normally.

/** A page whose password field arrives late, optionally behind a visible challenge. */
function challengePage(opts: { pwAfterMs: number; challengeUntilMs?: number }) {
  const ctx = loginSandbox();
  const said: [string, Record<string, unknown>][] = [];
  const started = (ctx.Date as DateConstructor).now();
  const since = () => (ctx.Date as DateConstructor).now() - started;
  const field = () => ({
    value: '', focus() {}, blur() {}, dispatchEvent() {}, click() {},
    get offsetParent() { return {}; },
    setAttribute() {}, removeAttribute() {},
  });
  ctx.location = { hostname: 'signin.reservecalifornia.com', pathname: '/oauth2/v1/authorize' };
  ctx.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
  ctx.document = {
    querySelector: (sel: string) => {
      const wantsPw = /passcode|password/i.test(sel);
      if (wantsPw) return since() >= opts.pwAfterMs ? field() : null;
      return /identifier|username|type="email"/i.test(sel) ? field() : null;
    },
    querySelectorAll: (sel: string) => {
      // The challenge frame, visible only while the puzzle is up.
      if (sel.includes('recaptcha') && opts.challengeUntilMs && since() < opts.challengeUntilMs) {
        return [{
          getBoundingClientRect: () => ({ width: 300, height: 400 }),
          parentElement: null,
        }];
      }
      return [];
    },
  };
  ctx.window = {
    __camphawkRc: {
      send: (s: string, d: Record<string, unknown>) => { said.push([s, d]); },
      signedIn: () => false,
    },
  };
  ctx.HTMLInputElement = function () {};
  ctx.HTMLTextAreaElement = function () {};
  ctx.FocusEvent = function () {};
  ctx.Event = function () {};
  ctx.KeyboardEvent = function () {};
  vm.runInContext(loginScript(), ctx);
  return {
    stages: () => said.map((s) => s[0]),
    detail: (stage: string) => said.find((s) => s[0] === stage)?.[1],
    run: () => vm.runInContext('window.__chRcLogin("a@b.com", "hunter2!")', ctx) as Promise<{ ok: boolean; stage: string }>,
  };
}

test('a challenge solved between email and password is TAKEN BACK OVER, not abandoned', async () => {
  // Two minutes of puzzle — comfortably past the ordinary 20s allowance, which is what made
  // this a reported failure rather than a pause.
  const p = challengePage({ pwAfterMs: 130_000, challengeUntilMs: 120_000 });
  const r = await p.run();
  assert.ok(p.stages().includes('captcha'), 'the user must be TOLD there is a challenge');
  assert.ok(p.stages().includes('captcha-cleared'),
    `the takeover must announce itself; got ${p.stages().join(',')}`);
  assert.ok(p.stages().includes('password'), 'and the run must go on to type the password');
  assert.notEqual(r.stage, 'password', 'it must not report "the password field never appeared"');
});

test('the challenge extends the deadline ONCE, to a fixed point — never unbounded', async () => {
  // A puzzle nobody solves must still end. Refreshing the deadline per tick while the frame
  // is up is an unbounded wait wearing a timeout's clothes, and a window that never closes
  // strands the user — the 2026-08-12 bug by another door.
  const p = challengePage({ pwAfterMs: 9_000_000, challengeUntilMs: 9_000_000 });
  const r = await p.run();
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'password', 'an unsolved challenge still ends as a named failure');
  assert.ok(p.stages().includes('captcha'), 'and it still reported the challenge');
  assert.ok(!p.stages().includes('captcha-cleared'), 'nothing was cleared, so nothing may claim it was');
});

test('with NO challenge the ordinary allowance is unchanged', async () => {
  // The 20s default is Okta rendering its own next screen. A slower default would only make
  // a genuinely broken sign-in take longer to report.
  const quick = challengePage({ pwAfterMs: 2_000 });
  await quick.run();
  assert.ok(quick.stages().includes('password'));
  assert.ok(!quick.stages().includes('captcha'), 'no challenge, no challenge report');

  const late = challengePage({ pwAfterMs: 60_000 });
  const r = await late.run();
  assert.equal(r.stage, 'password', 'past the allowance with no challenge is still a failure');
});
