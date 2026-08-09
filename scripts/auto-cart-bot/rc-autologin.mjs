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
 * Credentials live in `scripts/auto-cart-bot/.env` on the mini-PC (gitignored, same place
 * the rec.gov bot's already are) and are read only here. They are never logged, never
 * reported, and never leave the box.
 */

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
  return Boolean(process.env.RC_EMAIL && process.env.RC_PASSWORD);
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
export async function attemptLogin(ctx, page, { homeUrl, isLive }) {
  const email = process.env.RC_EMAIL;
  const password = process.env.RC_PASSWORD;
  if (!email || !password) return { ok: false, reason: 'no stored credentials' };

  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Get to the Okta form. RC's sign-in is a link/button on its own header; going
    // straight at a guessed /Customers/SignIn path is how earlier attempts hit dead ends.
    const signIn = page.locator('a:has-text("Sign In"), button:has-text("Sign In"), a:has-text("Sign in")').first();
    if (await signIn.isVisible().catch(() => false)) {
      await signIn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    // CHECK BEFORE TYPING. If the challenge is already up, we must not touch the form —
    // a submit attempt behind an overlay is what burned three retries on 2026-08-07.
    if (await captchaChallenge(page)) {
      return { ok: false, reason: 'ReserveCalifornia is showing a CAPTCHA — it needs you to sign in by hand' };
    }

    const emailField = await findIn(page, EMAIL_SELECTORS);
    if (!emailField) return { ok: false, reason: 'could not find the sign-in form' };
    await emailField.fill(email);

    // Identifier-first: email, Next, then password on a second screen.
    let pw = await findIn(page, PASSWORD_SELECTORS, 3000);
    if (!pw) {
      const next = await findIn(page, SUBMIT_SELECTORS, 5000);
      if (next) await next.click().catch(() => {});
      await page.waitForTimeout(2500);
      if (await captchaChallenge(page)) {
        return { ok: false, reason: 'ReserveCalifornia is showing a CAPTCHA — it needs you to sign in by hand' };
      }
      pw = await findIn(page, PASSWORD_SELECTORS, 12_000);
    }
    if (!pw) return { ok: false, reason: 'the password field never appeared' };
    await pw.fill(password);

    const submit = await findIn(page, SUBMIT_SELECTORS, 5000);
    if (submit) await submit.click().catch(() => {});
    else await pw.press('Enter').catch(() => {});

    // Wait for a session, checking for a challenge as we go. 90s is generous for a
    // redirect chain and still far short of anything that looks like a stuck retry.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
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
