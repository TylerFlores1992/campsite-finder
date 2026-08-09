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
      || /^await pw\.fill\(password\);$/.test(line);
    assert.ok(ok, `password value used somewhere unexpected: ${line}`);
  }
  // `credentials()` returns the plaintext, so it must stay module-private — an export
  // would hand the password to anything that imports this file. Only the presence check
  // and the attempt itself are public.
  const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ['attemptLogin', 'hasCredentials']);
  // And the module must not be able to send anything anywhere by itself.
  assert.ok(!/\bfetch\s*\(/.test(src), 'rc-autologin makes no network calls of its own');
});

test('a CAPTCHA is checked BEFORE the form is touched', async () => {
  // Clicking behind a challenge overlay can never work — the overlay swallows pointer
  // events, which is what burned three retries on 2026-08-07 while the button reported
  // visible and enabled. The check must come first, not after a failed submit.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  const firstCaptcha = src.indexOf('captchaChallenge(page)');
  const firstFill = src.indexOf('.fill(email)');
  assert.ok(firstCaptcha > 0 && firstFill > 0);
  assert.ok(firstCaptcha < firstFill, 'the CAPTCHA check must precede typing');
});

test('the challenge check ignores the passive badge', async () => {
  // reCAPTCHA injects an anchor iframe on pages that never ask anything. Treating that as
  // a challenge would abort every login and report a CAPTCHA that never appeared — the
  // same false-positive the probe had to learn to avoid.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
  assert.match(src, /bframe/, 'only the blocking bframe counts');
  assert.match(src, /width > 80 && r\.height > 80/, 'and it must be a real, sized box');
});
