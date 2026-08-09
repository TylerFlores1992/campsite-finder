/**
 * Sign in to ReserveCalifornia unattended — ONCE, shortly before a hold, and never again.
 *
 * ## Why this exists, and why it is deliberately timid
 *
 * There is nothing to keep warm. Measured 2026-08-09 with three independent instruments
 * agreeing: RC's access token lives ~60 minutes, is never renewed, and the profile holds
 * **no Okta session cookie at all** — `signin.reservecalifornia.com` carries only `DT`
 * (device id), `ln` (remembered username), `luf_*` (last factor) and a `JSESSIONID` that
 * dies with the browser. No `sid`, no `idx`. RC's own `okta-auth-js` autoRenew fires
 * `authorize?prompt=none`, finds nothing to authenticate against, fails, and deletes the
 * tokens — which is exactly the log we captured. A silent renew was never possible.
 *
 * So the only way to hold a site at 08:00 unattended is to obtain a token shortly before
 * it, which means a real credential login. That is the thing this project has spent two
 * days avoiding, for good reason: on 2026-08-06 repeated logins from FRESH PROFILES got
 * the household IP blocked by RC for twelve hours, and on 08-07 Okta started serving a
 * reCAPTCHA to this browser. Nobody in the house could book a campsite from home.
 *
 * ## The rules that make this different from what provoked that
 *
 * 1. **The persistent profile, never a fresh one.** The `DT` device cookie is what tells
 *    Okta this is a machine it has seen before. Deleting the profile is what made every
 *    previous attempt look like a new device signing into the same account — the shape of
 *    credential stuffing.
 * 2. **Only when a hold is actually due**, within `RC_AUTOLOGIN_LEAD_MIN`. A few times a
 *    month, not hourly.
 * 3. **ONE attempt per release. Ever.** No retry loop, no second try after a failure.
 * 4. **A CAPTCHA is a full stop, not a slower retry.** The challenge's overlay swallows
 *    pointer events, so clicking harder can never work — that was the whole 08-07 lesson.
 *    It aborts and asks for a human.
 * 5. **It fails toward the human.** Every failure path reports so the 07:30 pre-flight and
 *    the push alert tell the owner to sign in themselves. Losing a hold because we did
 *    nothing is recoverable; losing the household IP is not.
 *
 * ## Where the credentials live
 *
 * In the ENCRYPTED store the rec.gov bot already uses (`credstore.mjs`) — on Windows that
 * is DPAPI at CurrentUser scope, so the blob can only be decrypted by the same Windows
 * user on the same machine and is worthless if copied off the box. Not a plain `.env`
 * line: a password sitting in a file that every process on the machine can read, and that
 * gets pasted into terminals and screenshots, is a worse failure mode than the one this
 * whole feature is trying to avoid.
 *
 * `RC_EMAIL`/`RC_PASSWORD` env vars still work as an override for a dev box that has no
 * DPAPI, but the store is checked first and is what the mini-PC should use. Saved once
 * with `node rc-keepwarm.mjs --save-login`, which prompts and never echoes.
 *
 * They are never logged, never reported, and never leave the box.
 */
import { loadCreds, hasCreds } from './credstore.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The RC profile dir doubles as the credential dir — one account, one place. */
const CRED_DIR = () => path.resolve(HERE, process.env.RC_PROFILE_DIR || '.rc-bot-profile');

/** Stored (encrypted) creds, or the env override. Never both — the store wins. */
function credentials() {
  const stored = hasCreds(CRED_DIR()) ? loadCreds(CRED_DIR()) : null;
  if (stored) return stored;
  const email = process.env.RC_EMAIL;
  const password = process.env.RC_PASSWORD;
  return email && password ? { email, password } : null;
}

/**
 * The link that gets us from RC's home page to the Okta form.
 *
 * **RC'S BUTTON SAYS "Log in / Sign up", NOT "Sign In"** — confirmed from a screenshot of
 * the live site on 2026-08-09, and it is why the first real `--test-login` failed. The
 * original list only had `Sign In`/`Sign in`, and Playwright's `:has-text()` is a
 * case-insensitive SUBSTRING match: "Log in / Sign up" does not contain "sign in", so
 * nothing matched, the link was never clicked, and the run died at "could not find the
 * sign-in form" while still sitting on the home page.
 *
 * `Log in` first, because that is what the site actually says. The rest are kept for the
 * day RC rewords it — this is exactly the kind of thing a redesign changes, and the cost of
 * an extra selector is nothing next to the cost of finding out at 07:45.
 *
 * NOTE the ordering trap: "Log in / Sign up" contains BOTH "Log in" and "Sign up", so a
 * `Sign up` selector in this list could match the same element — harmless here, but do not
 * add one on the theory that it finds a different control.
 */
export const SIGNIN_LINK_SELECTORS = [
  'a:has-text("Log in")',
  'button:has-text("Log in")',
  'a:has-text("Login")',
  'button:has-text("Login")',
  'a:has-text("Sign In")',
  'button:has-text("Sign In")',
  '[href*="signin" i]',
  '[href*="sign-in" i]',
];

const EMAIL_SELECTORS = [
  'input[name="identifier"]',            // Okta Identity Engine
  'input[name="username"]',              // Okta Classic
  '#okta-signin-username',
  'input[autocomplete="username"]',
  'input[type="email"]',
];
const PASSWORD_SELECTORS = [
  'input[name="credentials.passcode"]',  // Okta Identity Engine
  'input[name="password"]',              // Okta Classic
  '#okta-signin-password',
  'input[type="password"]',
];
const SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  'button:has-text("Next")',
  'button:has-text("Verify")',
  'button:has-text("Sign In")',
];

export function hasCredentials() {
  return credentials() !== null;
}

/**
 * Find the first visible match across ALL frames.
 *
 * Okta is frequently served in an iframe, and a main-frame-only lookup reports "field not
 * found" for a field plainly on screen — which is how the probe's first run failed.
 */
async function findIn(page, selectors, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        const el = frame.locator(sel).first();
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(400);
  }
}

/**
 * Is a reCAPTCHA CHALLENGE on screen — not merely the passive badge?
 *
 * Presence is not a challenge. reCAPTCHA injects an anchor iframe on pages that never ask
 * you anything; only the `bframe` (the image grid) is the blocking one. Reading the badge
 * as a challenge would abort every login and report a CAPTCHA that never appeared.
 */
async function captchaChallenge(page) {
  for (const frame of page.frames()) {
    const hit = await frame.evaluate(() => {
      const bframe = document.querySelector(
        'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]',
      );
      if (!bframe) return false;
      const r = bframe.getBoundingClientRect();
      // A hidden bframe is 0×0 and parked off-screen; a live challenge is a real box.
      return r.width > 80 && r.height > 80;
    }).catch(() => false);
    if (hit) return true;
  }
  return false;
}

/**
 * One attempt. Returns `{ ok, reason }` — never throws, never retries.
 *
 * `reason` is written for the person who will read it in a push notification at 07:45,
 * so it says what to do, not what failed internally.
 */
export async function attemptLogin(ctx, page, { homeUrl, isLive, log = () => {} }) {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'no stored credentials' };
  const { email, password } = creds;
  // NARRATE EVERY STEP. The second --test-login failure (2026-08-09) was reported as
  // "email entered, then the window closed" — accurate, and not enough to act on: three
  // different faults produce exactly that. Diagnosing it from the outside meant reasoning
  // about which timeout the elapsed seconds matched. The log now says which step, so a
  // failure is read rather than deduced. `log` never receives the password.
  const step = (m) => log(`    → ${m}`);

  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    step(`opened ${new URL(page.url()).host}`);

    // Get to the Okta form. RC's sign-in is a link/button on its own header; going
    // straight at a guessed /Customers/SignIn path is how earlier attempts hit dead ends.
    const signIn = await findIn(page, SIGNIN_LINK_SELECTORS, 10_000);
    if (signIn) {
      await signIn.click().catch(() => {});
      // Okta is a full navigation to signin.reservecalifornia.com, not an in-page modal.
      // Waiting for the URL to change beats a fixed sleep: a slow redirect used to look
      // exactly like a missing form.
      await page.waitForURL(/signin\.reservecalifornia\.com|\/signin/i, { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      step(`clicked the sign-in link → ${new URL(page.url()).host}`);
    } else {
      step('no sign-in link found — already on a sign-in page?');
    }

    // CHECK BEFORE TYPING. If the challenge is already up, we must not touch the form —
    // a submit attempt behind an overlay is what burned three retries on 2026-08-07.
    if (await captchaChallenge(page)) {
      return { ok: false, reason: 'ReserveCalifornia is showing a CAPTCHA — it needs you to sign in by hand' };
    }

    const emailField = await findIn(page, EMAIL_SELECTORS);
    if (!emailField) {
      // SAY WHERE WE ENDED UP. "could not find the sign-in form" is true of both "the
      // sign-in link was never clicked" and "Okta loaded and looks different now", and
      // those have completely different fixes. The first failure of this cost a round trip
      // to a screenshot to tell apart — the URL alone would have said it immediately.
      const where = page.url().slice(0, 80);
      return {
        ok: false,
        reason: signIn
          ? `the sign-in form did not load (stuck at ${where})`
          : `could not find the "Log in" link on ${where} — RC may have reworded it`,
      };
    }
    await emailField.fill(email);
    step('email entered');

    // Identifier-first: email, Next, then password on a SECOND screen.
    let pw = await findIn(page, PASSWORD_SELECTORS, 3000);
    if (!pw) {
      const next = await findIn(page, SUBMIT_SELECTORS, 5000);
      if (!next) step('no Next button found — submitting with Enter instead');
      if (next) await next.click().catch(() => {});
      else await emailField.press('Enter').catch(() => {});
      step('submitted the email, waiting for the password screen…');
      await page.waitForTimeout(2500);
      if (await captchaChallenge(page)) {
        return { ok: false, reason: 'ReserveCalifornia is showing a CAPTCHA — it needs you to sign in by hand' };
      }
      // THIRTY SECONDS, not twelve. Okta's password screen is a separate render after a
      // round trip, and 12s was chosen by feel rather than measurement — the second
      // --test-login failure spent its whole budget here. A slow screen and a missing one
      // are not the same fault, and a too-short wait reports the second when it means the
      // first. Overshooting costs nothing: this runs once, with a human watching, or once
      // at 07:45 against an 08:00 release.
      pw = await findIn(page, PASSWORD_SELECTORS, 30_000);
    }
    if (!pw) {
      const where = page.url().slice(0, 100);
      return { ok: false, reason: `the password field never appeared (stuck at ${where})` };
    }
    await pw.fill(password);
    step('password entered, submitting');

    const submit = await findIn(page, SUBMIT_SELECTORS, 5000);
    if (submit) await submit.click().catch(() => {});
    else await pw.press('Enter').catch(() => {});

    // Wait for a session, checking for a challenge as we go. 90s is generous for a
    // redirect chain and still far short of anything that looks like a stuck retry.
    const deadline = Date.now() + 90_000;
    let waited = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      waited += 3;
      if (waited % 15 === 0) step(`waiting for the session… ${waited}s`);
      if (await captchaChallenge(page)) {
        return { ok: false, reason: 'a CAPTCHA appeared during sign-in — it needs you to sign in by hand' };
      }
      if ((await isLive()) === true) return { ok: true, reason: 'signed in' };
    }
    // No session and no CAPTCHA: most likely a wrong password or an MFA prompt. Either
    // way it is a human's problem, and trying again would be the pattern we must avoid.
    return { ok: false, reason: 'sign-in did not complete — check the password, or an MFA prompt may be waiting' };
  } catch (err) {
    return { ok: false, reason: `sign-in error: ${String(err.message).slice(0, 120)}` };
  }
}
