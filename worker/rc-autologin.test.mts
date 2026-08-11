// The guards on unattended RC sign-in. Pure — no browser — because the guards are the
// design, and the browser half is untestable here anyway.
//
// A login is the act that got the household IP blocked by RC for twelve hours on
// 2026-08-06 (repeated fresh-profile sign-ins from one address). Everything below exists
// to make sure it happens a few times a month, never in a loop, and never on a timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCredentials, SIGNIN_LINK_SELECTORS } from '../scripts/auto-cart-bot/rc-autologin.mjs';

test('the sign-in link selectors match what RC actually says', () => {
  // THE BUG THIS EXISTS FOR (2026-08-09). RC's header button reads "Log in / Sign up".
  // The selectors only had "Sign In" and "Sign in", and Playwright's :has-text() is a
  // case-insensitive SUBSTRING match — "Log in / Sign up" does not contain "sign in". So
  // nothing matched, the link was never clicked, the Okta form never loaded, and the first
  // real --test-login died at "could not find the sign-in form" while still sitting on the
  // home page. It took a photograph of the mini-PC's monitor to see it.
  //
  // Observed labels, newest first. Adding a label here is how a future RC rewording gets
  // caught by a test run instead of by a lost campsite.
  const LABELS = ['Log in / Sign up', 'Log In / Sign Up', 'Sign In'];
  const hasText = SIGNIN_LINK_SELECTORS
    .map((s: string) => s.match(/:has-text\("([^"]+)"\)/)?.[1])
    .filter((s: string | undefined): s is string => Boolean(s));

  for (const label of LABELS) {
    const hit = hasText.some((needle) => label.toLowerCase().includes(needle.toLowerCase()));
    assert.ok(hit, `no selector would match RC's "${label}" button`);
  }
});

test('no credentials means no attempt, ever', () => {
  const before = { e: process.env.RC_EMAIL, p: process.env.RC_PASSWORD, d: process.env.RC_PROFILE_DIR };
  try {
    // Point the credential store at a directory that cannot exist, so this asserts the
    // ENV path in isolation. Without it the test would pass or fail depending on whether
    // the machine running it happens to have `--save-login` creds on disk.
    process.env.RC_PROFILE_DIR = '.rc-bot-profile-test-does-not-exist';
    delete process.env.RC_EMAIL; delete process.env.RC_PASSWORD;
    assert.equal(hasCredentials(), false, 'absent');
    process.env.RC_EMAIL = 'a@b.c';
    assert.equal(hasCredentials(), false, 'email alone is not enough');
    process.env.RC_PASSWORD = 'x';
    assert.equal(hasCredentials(), true);
  } finally {
    if (before.e) process.env.RC_EMAIL = before.e; else delete process.env.RC_EMAIL;
    if (before.p) process.env.RC_PASSWORD = before.p; else delete process.env.RC_PASSWORD;
    if (before.d) process.env.RC_PROFILE_DIR = before.d; else delete process.env.RC_PROFILE_DIR;
  }
});

test('the module never logs or exports a credential', async () => {
  // The credentials live in the encrypted store on the mini-PC (DPAPI, CurrentUser) and
  // must stay there. A reason string is shown to the owner in a push notification, so it
  // must never carry one either.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  // Counting occurrences would be a brittle proxy — `hasCredentials` reads it for a
  // presence check, which leaks nothing. What matters is where the VALUE goes: into the
  // form field and nowhere else.
  // Strip STRING LITERALS and comments first. `input[name="password"]` is a CSS selector,
  // not the credential, and a text search cannot tell them apart — the first version of
  // this test failed on exactly that.
  const uses = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .split('\n')
    .map((l) => l.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''"))
    .filter((l) => /\bpassword\b/.test(l))
    .map((l) => l.trim());
  // Every line that touches the value, and the only shapes allowed: read it out of the
  // store or the env override, hand it to `credentials()`'s caller inside this module,
  // and type it into the field.
  for (const line of uses) {
    const ok = /^const password = process\.env\.RC_PASSWORD;$/.test(line)
      || /^return email && password \? \{ email, password \} : null;$/.test(line)
      || /^const \{ email, password \} = creds;$/.test(line)
      || /^await pw\.loc\.fill\(password\);$/.test(line);
    assert.ok(ok, `password value used somewhere unexpected: ${line}`);
  }
  // A HOLE THE STRIPPER ABOVE OPENS, and it matters more since attemptLogin gained a `log`
  // callback that takes template strings. Stripping string literals also strips
  // `${password}` INSIDE a template literal, so `step(`password is ${password}`)` would
  // pass the check above while printing the credential to a log file. Interpolations are
  // code, not text — check them separately.
  const interpolations = [...src.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  for (const expr of interpolations) {
    assert.ok(!/\bpassword\b/.test(expr), `a template literal interpolates the password: \${${expr}}`);
  }

  // `credentials()` returns the plaintext, so it must stay module-private — an export
  // would hand the password to anything that imports this file. Only the presence check
  // and the attempt itself are public.
  const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  // ADDING TO THIS LIST IS A DECISION, not a formality — that is why it is pinned exactly.
  // `looksLikeAnotherAccount(pageText, ourEmail)` is a pure string comparison returning a
  // boolean; it is handed the EMAIL (a username, not a secret), never the password, and
  // returns neither. Exported so it can be tested directly, since the branch it guards -
  // refusing to type our password at somebody else's remembered account - is one a browser
  // test would reach only by chance.
  assert.deepEqual(exported.sort(), ['attemptLogin', 'hasCredentials', 'looksLikeAnotherAccount']);
  // And the module must not be able to send anything anywhere by itself.
  assert.ok(!/\bfetch\s*\(/.test(src), 'rc-autologin makes no network calls of its own');
});

test('a CAPTCHA is checked BEFORE the form is touched', async () => {
  // Clicking behind a challenge overlay can never work — the overlay swallows pointer
  // events, which is what burned three retries on 2026-08-07 while the button reported
  // visible and enabled. The check must come first, not after a failed submit.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  // WITHIN attemptLogin, not within the file. The old version compared the first mention
  // anywhere, which after the helpers were extracted was comparing where the FUNCTIONS are
  // DEFINED — an ordering that says nothing about what runs first. It passed while
  // asserting nothing.
  const body = src.slice(src.indexOf('export async function attemptLogin'));
  const firstCaptcha = body.indexOf('await captchaChallenge(page)');
  const firstType = body.indexOf('typeEmail(user.loc, email)');
  assert.ok(firstCaptcha > 0 && firstType > 0, 'both steps must still exist');
  assert.ok(firstCaptcha < firstType, 'the CAPTCHA check must precede typing');
});

test('the email is submitted with Enter BEFORE any button click', async () => {
  // THE BUG THAT COST TWO FAILED TEST RUNS (2026-08-09). Okta disables the Next button
  // while a transaction is in flight, so a click can report success and do nothing, or time
  // out against a button that is visibly enabled. Enter submits the form the widget is
  // actually listening to and needs no button to be hittable.
  //
  // rc-probe.mjs learned this months earlier and says so in a comment. This file was
  // written from scratch anyway, clicked first, and pressed Enter only as a fallback —
  // exactly backwards. The guard exists so the next rewrite cannot quietly re-invert it.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  // Scope to the retry loop, and assert on SUBMIT_SELECTORS rather than a variable name.
  // The first version of this test compared `press('Enter')` against `next.loc.click(` —
  // and a sabotage that clicked first through a differently-named locator sailed straight
  // past it. You cannot click a button you have not looked up, so the LOOKUP is the thing
  // that cannot be renamed around.
  const loop = src.slice(
    src.indexOf('for (let attempt = 1'),
    src.indexOf('if (!pw) return'),
  );
  assert.ok(loop.length > 200, 'the retry loop must still be there to check');
  const enter = loop.indexOf("press('Enter')");
  const lookup = loop.indexOf('SUBMIT_SELECTORS');
  assert.ok(enter > 0, 'the email must still be submitted with Enter');
  assert.ok(lookup > 0, 'the button click must survive as the fallback');
  assert.ok(enter < lookup, 'Enter must come before the submit button is even looked up');
  // And a failed click must fall through to a direct DOM click — that is what tells
  // "Okta refused us" apart from "Playwright could not hit the button".
  assert.match(loop, /\.evaluate\(\(el\) => el\.click\(\)\)/, 'DOM-click fallback missing');
});

test('the challenge check ignores the passive badge', async () => {
  // reCAPTCHA injects an anchor iframe on pages that never ask anything. Treating that as
  // a challenge would abort every login and report a CAPTCHA that never appeared — the
  // same false-positive the probe had to learn to avoid.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  assert.match(src, /bframe/, 'only the blocking bframe counts');
  assert.match(src, /r\.width < 100 \|\| r\.height < 100/, 'and it must be a real, sized box');
  // A sized bframe is still not a challenge if a WRAPPER above it is hidden — Okta toggles
  // that wrapper between uses. Checking the iframe alone made the probe wait five minutes
  // for a human who had nothing to solve, and that false reading was then repeated as fact.
  assert.match(src, /for \(let el = f\.parentElement; el; el = el\.parentElement\)/,
    'ancestors must be checked too');
});

/**
 * ── OKTA CAN SKIP THE EMAIL STEP, AND THAT COST A CAMPSITE (2026-08-11) ────────────────
 *
 * The 07:30 auto-login reported "the sign-in form did not load" and both holds went
 * uncarted. The form had loaded: RC's `ln` cookie remembers the username, so Okta served
 * "Verify with your password" with no email field on the page at all. `attemptLogin`
 * demanded EMAIL_SELECTORS and bailed when they were absent — two lines above a lookup
 * that already knew the password could come first.
 */
test('the password field is looked for BEFORE the email step is called missing', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
  const pwIdx = src.indexOf('let pw = await findIn(page, PASSWORD_SELECTORS');
  const bail = src.indexOf("'neither an email nor a password field appeared'");
  assert.ok(pwIdx > 0 && bail > pwIdx, 'the password lookup must precede the give-up');
  // And giving up now requires BOTH to be absent, not just the email.
  assert.match(src, /if \(!user && !pw\) \{/);
  assert.ok(!/let user = await findIn\(page, EMAIL_SELECTORS\);\s*\n\s*if \(!user\) \{/.test(src),
    'the email field must not be mandatory');
});

test('a remembered-account screen is only refused on POSITIVE evidence it is not ours', async () => {
  const { looksLikeAnotherAccount } = await import('../scripts/auto-cart-bot/rc-autologin.mjs');
  const ours = 'tylerflores1992@yahoo.com';
  // The exact screen from 2026-08-11: Okta naming our own account.
  assert.equal(looksLikeAnotherAccount('Verify with your password tylerflores1992@yahoo.com', ours), false);
  assert.equal(looksLikeAnotherAccount('Verify with your password someoneelse@gmail.com', ours), true);
  // UNKNOWN IS NOT A MISMATCH. Okta renders that line differently across widget versions,
  // and treating "I cannot see an identity" as "wrong account" would send every login round
  // the houses — or fail one outright when "Back to sign in" is absent. Same rule as
  // hasAvailabilityInRange returning null.
  assert.equal(looksLikeAnotherAccount('Verify with your password', ours), false);
  assert.equal(looksLikeAnotherAccount('', ours), false);
  assert.equal(looksLikeAnotherAccount('a@b.com and tylerflores1992@yahoo.com', ours), false,
    'ours appearing anywhere on the page is enough');
  // Case is not identity.
  assert.equal(looksLikeAnotherAccount('TylerFlores1992@Yahoo.com', ours), false);
});
