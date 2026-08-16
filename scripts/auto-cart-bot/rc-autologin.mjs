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
import { dropStoredToken } from './rc-token.mjs';
import { sessionAcceptable } from './session-coverage.mjs';
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
const BACK_TO_SIGNIN_SELECTORS = [
  'a:has-text("Back to sign in")',
  'a:has-text("Sign in with a different")',
  'button:has-text("Back to sign in")',
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
 * THE FLOW BELOW IS PORTED FROM `rc-probe.mjs`, WHICH IS THE VERSION THAT ACTUALLY WORKED.
 *
 * On 2026-08-06 the probe signed in to RC unattended and carted a site. Then this file was
 * written from scratch — a fresh, simpler implementation of the same nine steps, four
 * hundred lines away from a battle-tested one in the same directory — and it failed twice
 * in a row for reasons the probe had already found and fixed months earlier. Every
 * difference below is a bug the probe hit first:
 *
 *  1. **ENTER BEFORE THE BUTTON.** Okta DISABLES the Next button while a transaction is in
 *     flight, so a click can report success and do nothing, or time out against a button
 *     that is visible and enabled. Enter submits the form the widget is actually listening
 *     to and needs no button to be hittable. This file clicked first and only pressed
 *     Enter when no button was found — backwards.
 *  2. **THE EMAIL STEP IS FLAKY, NOT BLOCKED**, and a RELOAD between rounds is what clears
 *     a half-finished Okta transaction. Clicking again never does.
 *  3. **"Keep me signed in" was never ticked.** The probe calls it load-bearing.
 *  4. **Okta's error banner was never read.** `[role="alert"]` / `.okta-form-infobox-error`
 *     carry the real reason in a sentence — "incorrect password", "account locked" — and we
 *     were reporting a guess derived from which timeout expired.
 *  5. **The email was `fill()`ed and never verified.** The probe types it and reads it
 *     back, because a field that silently holds something else is otherwise invisible.
 *  6. **A DOM-click fallback** distinguishes "Okta refused us" from "Playwright could not
 *     hit the button", which are different problems with different fixes.
 *
 * WHAT IS DELIBERATELY *NOT* PORTED: the probe's willingness to keep going. This runs
 * unattended before a real hold, so the outer rule stands — ONE login per release, ever,
 * enforced by the caller. The three rounds here are three attempts to get ONE form to
 * advance over about thirty seconds; they are not three logins, and they are not a retry
 * after a rejected credential. A wrong password or a CAPTCHA still stops dead.
 */

/**
 * Find the first visible match across ALL frames, and say WHICH selector matched.
 *
 * Okta is frequently served in an iframe, and a main-frame-only lookup reports "field not
 * found" for a field plainly on screen — which is how the probe's first run failed.
 *
 * Returns `{ loc, sel }` rather than a bare locator: when this breaks again, knowing that
 * it matched `input[type="email"]` rather than `input[name="identifier"]` is the difference
 * between "Okta swapped widgets" and "we are typing into the wrong box".
 */
/**
 * Is this remembered-account screen showing SOMEBODY ELSE?
 *
 * Only ever true on POSITIVE evidence of a different address. "I cannot see an identity"
 * must not read as "wrong account": Okta renders that line differently across widget
 * versions, and treating unknown as a mismatch would send every login round the houses -
 * or, if "Back to sign in" is absent, fail one that would have worked. Same rule as
 * `hasAvailabilityInRange` returning null.
 *
 * The cost of getting it wrong the other way is real, which is why it is checked at all:
 * typing our password at another account spends a bad-password strike, and RC locks
 * accounts.
 */
export function looksLikeAnotherAccount(pageText, ourEmail) {
  const text = String(pageText ?? '');
  const ours = String(ourEmail ?? '').toLowerCase();
  const shown = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (!shown || !ours) return false;
  return !shown.some((a) => a.toLowerCase() === ours);
}

async function findIn(page, selectors, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel).first();
          if ((await loc.count()) && (await loc.isVisible())) return { loc, sel };
        } catch { /* frame detached mid-poll — try the next */ }
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(400);
  }
}

/**
 * Press RC's own sign-in control and wait for wherever it takes us.
 *
 * ONE DEFINITION, TWO CALLERS, and the second caller is why it moved out of `attemptLogin`.
 * The renewal in `rc-token.mjs` needs exactly this act and nothing else around it: clicking
 * here is what starts the authorization-code flow, which Okta answers from the live `idx`
 * cookie **with no form and no credential** — the only path measured to re-mint a token
 * (2026-08-15, twice, each producing a full 59-minute token).
 *
 * A second hand-rolled copy would have been the cheaper edit and is the mistake this repo
 * keeps paying for: `content-rc.js` spent months telling users to click a cart icon while
 * `rc-cart.mjs` did the right thing, because the two were copies. The selector list is
 * already shared; the act should be too.
 *
 * Returns the `{ loc, sel }` that was pressed, or `null` when no control was found — which
 * is a real outcome and not an error. On 2026-08-15 18:22 a clear failed to sign the SPA
 * out, so RC went on rendering its signed-in header, no "Log in" anchor existed, and the
 * flow was never started at all. That is a different fault from Okta refusing us and the
 * callers are entitled to tell them apart.
 *
 * `rc-token.mjs` takes this as an INJECTED callback rather than importing it, so that module
 * stays structurally incapable of signing in — see its header.
 */
export async function clickSignInControl(page, { timeoutMs = 10_000 } = {}) {
  const link = await findIn(page, SIGNIN_LINK_SELECTORS, timeoutMs);
  if (!link) return null;
  await link.loc.click().catch(() => {});
  // Best-effort: on the renewal path Okta may answer and bounce us back to RC before this
  // ever matches, and that is the SUCCESS case — so a timeout here means nothing on its own
  // and must never be read as a failure.
  await page.waitForURL(/signin\.reservecalifornia\.com|\/signin/i, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return link;
}

/**
 * Tick "Keep me signed in" when present.
 *
 * The probe calls this load-bearing and it was missing here entirely. It does not extend
 * the ~60-minute access token — nothing does, that is settled — but it is what Okta reads
 * as "this is a returning user on a known device", and it costs nothing to get right.
 */
async function keepSignedIn(page) {
  for (const frame of page.frames()) {
    for (const sel of ['input[type="checkbox"][name*="rememberMe" i]', 'input[type="checkbox"]']) {
      try {
        const box = frame.locator(sel).first();
        if ((await box.count()) && (await box.isVisible()) && !(await box.isChecked())) {
          await box.check({ timeout: 3000 });
          return true;
        }
      } catch { /* not the box, or not checkable */ }
    }
  }
  return false;
}

/**
 * Is a reCAPTCHA CHALLENGE on screen — not merely the passive badge?
 *
 * Presence is not a challenge. reCAPTCHA injects a `bframe` on every page that loads the
 * widget, sized 0x0 and hidden, and RC loads it on sign-in pages that automate perfectly
 * well. Reading that as a challenge made the probe wait five minutes for a human who had
 * nothing to solve — and that false reading then got repeated back as fact. A real
 * challenge is VISIBLE and has real size, INCLUDING its ancestors: the wrapper is toggled
 * hidden between uses, so a bframe can be big and still not be asking anything.
 */
async function captchaChallenge(page) {
  for (const frame of page.frames()) {
    const hit = await frame.evaluate(() => {
      const frames = Array.from(document.querySelectorAll(
        'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]',
      ));
      return frames.some((f) => {
        const r = f.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) return false;
        const st = getComputedStyle(f);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
        for (let el = f.parentElement; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.visibility === 'hidden' || s.display === 'none') return false;
        }
        return true;
      });
    }).catch(() => false);
    if (hit) return true;
  }
  return false;
}

/**
 * What the page is actually saying. Okta puts the real reason in a banner, and it is
 * frequently a sentence no regex of ours would have guessed.
 *
 * This is the difference between reporting "check the password" because a timeout expired
 * and reporting it because RC said so.
 */
async function diagnose(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const has = (re) => re.test(text);
    return {
      url: location.href,
      mfa: has(/verification code|verify your identity|enter the code|multifactor|authenticator/i),
      badCreds: has(/incorrect|invalid|does not match|unable to sign/i),
      locked: has(/locked|too many attempts|temporarily unavailable/i),
      error: Array.from(document.querySelectorAll(
        '[role="alert"], .okta-form-infobox-error, .infobox-error, .o-form-error-container',
      )).map((el) => el.textContent?.trim()).filter(Boolean).join(' | ').slice(0, 200),
      snippet: text.replace(/\s+/g, ' ').slice(0, 200),
    };
  }).catch(() => ({ url: '', mfa: false, badCreds: false, locked: false, error: '', snippet: '' }));
}

/** visible/enabled/size — the three facts that tell a refused click from an unhittable one. */
async function describeButton(loc) {
  try {
    const [visible, enabled, box] = await Promise.all([
      loc.isVisible().catch(() => null),
      loc.isEnabled().catch(() => null),
      loc.boundingBox().catch(() => null),
    ]);
    return `visible=${visible} enabled=${enabled} size=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none'}`;
  } catch {
    return '(could not inspect)';
  }
}

/**
 * Type the email and READ IT BACK.
 *
 * `fill()` alone is silent about a field that ends up holding something else — an
 * autofilled value, a masked input that reformats, a widget that clears on blur. The probe
 * types it character by character and verifies, and that check has caught a real mismatch.
 */
async function typeEmail(loc, email) {
  await loc.click({ timeout: 5000 }).catch(() => {});
  await loc.fill('').catch(() => {});
  await loc.pressSequentially(email, { delay: 25 }).catch(async () => { await loc.fill(email); });
  const got = await loc.inputValue().catch(() => null);
  return got === email;
}

/**
 * One login attempt. Returns `{ ok, reason }` — never throws.
 *
 * `reason` is written for the person who will read it in a push notification at 07:45, so
 * it says what to do, not what failed internally. Where RC gave us its own words, those
 * words are used: a guess about the password and RC saying the password is wrong are not
 * the same fact, and only one of them is worth acting on.
 *
 * `humanPresent` is what `--test-login` passes. With somebody at the keyboard a CAPTCHA is
 * worth waiting on — they can solve it and the run continues. Unattended it is a full stop,
 * because clicking behind a challenge overlay can never work and retrying is exactly the
 * pattern that got this address blocked.
 */
export async function attemptLogin(
  ctx, page, { homeUrl, isLive, sufficient = null, log = () => {}, humanPresent = false },
) {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'no stored credentials' };
  const { email, password } = creds;
  const step = (m) => log(`    → ${m}`);

  /**
   * "ALREADY SIGNED IN" IS NOT THE SAME AS "COVERED", AND CONFLATING THEM LOST A CART.
   *
   * 2026-08-15, 07:30:42 PT, thirty minutes before a real release:
   *
   *     ⏰ hold releases in 30m and the session will not cover it — signing in ONCE
   *         → already signed in — nothing to do
   *       ✓ signed in unattended — the hold is covered
   *
   * `maybeAutoLogin` had just computed that the token would NOT last, called this function
   * to fix it, and this function short-circuited on `isLive()` — which asks whether a
   * session exists, never whether it will still exist when it is needed. It returned ok, the
   * caller logged "the hold is covered", the one attempt for that release was spent, the
   * token died at 07:53 and the 08:00 cart failed.
   *
   * That is the 2026-08-09 lesson running backwards. `isLive()` was ADDED because this
   * reported failure over a healthy session; nobody checked the opposite direction. And
   * `rehearsal.mjs` already documents this very short-circuit as a hazard — "attemptLogin
   * short-circuits on isLive(), so it would return ok without exercising one line of the
   * sign-in" — but only for the nightly rehearsal. The same line sits in the release-critical
   * path and the two were never connected.
   *
   * So a caller that has a deadline passes `sufficient`. It is OPT-IN: the rehearsal and
   * `--test-login` have no deadline and a live session is a fine answer for them, so the
   * default is unchanged.
   *
   * `null` from `sufficient` means "could not tell" and counts as good enough. Forcing a
   * sign-in is destructive — it drops a token that may have been fine — and the house rule
   * is that an unknown is never treated as a failure.
   */
  const acceptable = async () => {
    const live = await isLive();
    const enough = sufficient ? await sufficient().catch(() => null) : undefined;
    return sessionAcceptable(live, enough);
  };
  /** Fold Okta's own words into the reason when it gave us any. */
  const withBanner = async (base) => {
    const d = await diagnose(page);
    if (d.locked) return 'ReserveCalifornia has temporarily locked the account — do not retry, sign in by hand later';
    if (d.badCreds) return 'ReserveCalifornia rejected the email or password — re-run rc-save-password.bat';
    if (d.mfa) return 'ReserveCalifornia asked for a verification code — it needs you to sign in by hand';
    if (d.error) return `${base} — RC said: "${d.error}"`;
    return `${base} (at ${d.url.slice(0, 80) || page.url().slice(0, 80)})`;
  };

  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    step(`opened ${new URL(page.url()).host}`);

    // ARE WE ALREADY IN? Ask before hunting for a form to fill.
    //
    // THE BUG THIS FIXES, and it cost a morning (2026-08-09). `maybeAutoLogin` decides to
    // run because the token it can SEE is gone — but loading RC's home page is itself what
    // makes the SPA fetch a token, so by the time we look for a sign-in link there may be
    // a perfectly good session and no link to find. That is exactly what happened: the
    // login "failed" at 14:45 with "the sign-in form did not load", the session was in
    // fact healthy, and the token proved it — 45 minutes of life left on a 60-minute token
    // at 15:00 puts its issue right at 14:45. The bot then carted the site two seconds
    // after release using the very session it had just reported dead.
    //
    // The false failure was not harmless: it drove the dead-session verdict, which fired
    // two alarm calls at the owner, which sent me chasing a phantom modal and telling them
    // to sign in by hand over a working session.
    //
    // `isLive()` is the caller's real probe — it POSTs to RC's API and reads the status —
    // so this is the authoritative question, not another guess from page furniture. The
    // wait exists because the token arrives with RC's own first API call, not with
    // domcontentloaded; without it this would report "not signed in" for a session that is
    // one second away from proving itself.
    await page.waitForTimeout(4000);
    if (await acceptable()) {
      step('already signed in — nothing to do');
      return { ok: true, reason: 'already signed in' };
    }

    // LIVE BUT NOT GOOD ENOUGH. There is a session, so RC renders no sign-in link and the
    // form hunt below would find nothing — it would report "the sign-in form did not load",
    // which is the 2026-08-09 false alarm exactly. Drop the token to reach a signed-out
    // state we can actually sign in from. Cookies are untouched, so `DT` survives and this
    // still looks like the device Okta has seen before; it is the same clear
    // `rc-test-login.bat` has always used to rehearse a real login.
    if ((await isLive()) === true) {
      step('signed in, but the token will not cover the hold — dropping it to sign in fresh');
      await dropStoredToken(page);
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      // If RC bootstrapped a genuinely fresh token from the Okta cookie, that IS the repair
      // and no credential is needed. Cheaper and safer than typing one, so take it.
      if (await acceptable()) {
        step('RC re-minted a token from the Okta session — no credential needed');
        return { ok: true, reason: 'renewed from the Okta session without signing in' };
      }
    }

    // Get to the Okta form. RC's sign-in is a link/button on its own header; going
    // straight at a guessed /Customers/SignIn path is how earlier attempts hit dead ends.
    const link = await clickSignInControl(page);
    if (link) {
      step(`clicked ${link.sel} → ${new URL(page.url()).host}`);
    } else {
      step('no sign-in link found — already on a sign-in page?');
    }

    // CHECK BEFORE TYPING. A submit attempt behind a challenge overlay is what burned
    // three retries on 2026-08-07 while the button reported visible and enabled.
    if (await captchaChallenge(page)) {
      if (!humanPresent) {
        return { ok: false, reason: 'ReserveCalifornia is showing a CAPTCHA — it needs you to sign in by hand' };
      }
      step('a CAPTCHA is on screen — SOLVE IT IN THE WINDOW, waiting up to 5 minutes…');
      const solved = await findIn(page, EMAIL_SELECTORS, 300_000);
      if (!solved) return { ok: false, reason: 'the CAPTCHA was not solved in time' };
    }

    // ASK FOR THE PASSWORD FIRST. Okta may serve the password step with NO email field on
    // the page at all: the `ln` cookie remembers the username, so Identity Engine skips the
    // identifier screen entirely. Demanding the email field and bailing when it is absent
    // is what failed the 2026-08-11 07:30 login with "the sign-in form did not load" — the
    // form had loaded, it just was not the one this code insisted on, and the site was lost
    // over a selector. The old code even knew the password could come first; it made that
    // lookup two lines AFTER the check that had already returned.
    let pw = await findIn(page, PASSWORD_SELECTORS, 3000);
    let user = pw ? null : await findIn(page, EMAIL_SELECTORS);

    // NEVER TYPE OUR PASSWORD AT SOMEBODY ELSE'S IDENTITY. A remembered-account screen names
    // the account; a mismatch means going back to the email step rather than spending a
    // bad-password strike on a profile RC can lock. Only a POSITIVE mismatch counts —
    // see looksLikeAnotherAccount.
    if (pw && looksLikeAnotherAccount(await page.content().catch(() => ''), email)) {
      step('the remembered account is not ours — returning to the email step');
      const back = await findIn(page, BACK_TO_SIGNIN_SELECTORS, 5_000);
      if (back) {
        await back.loc.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
      pw = null;
      user = await findIn(page, EMAIL_SELECTORS);
    }

    if (!user && !pw) {
      // ASK AGAIN BEFORE CALLING THIS A FAILURE.
      //
      // "No form appeared" has TWO meanings and they are opposites: RC refused us, or we
      // are already signed in and there is nothing to fill. The `isLive()` check above runs
      // right after the page load, but RC's SPA re-authenticates from a live Okta session
      // and can finish AFTER it — so a session that was dead when we looked is live by the
      // time we hunt for the form.
      //
      // The nightly rehearsal hit exactly this on 2026-08-11 and reported a FAILURE for a
      // perfectly healthy session, quoting RC's own banner: "You have a reservation arriving
      // on today's date". That banner is only ever rendered to a SIGNED-IN user. It is
      // evidence of success, and this is the second time it has been read as the obstacle —
      // the first cost a morning on 2026-08-09 and sent the owner to sign in by hand over
      // the session that carted a site fifteen minutes later.
      //
      // `provedNothing` and NOT a plain ok: nothing was typed and no sign-in was exercised,
      // so recording it as a pass would be a green mark for a test that never ran. That is
      // the rule rehearsal.mjs already states — a pass that proved nothing is worse than a
      // skip, because it reads as evidence.
      // ASKED REPEATEDLY, NOT ONCE — the re-authentication finishes AFTER the banner.
      //
      // 2026-08-14 03:01, the third time this trap has been sprung: the rehearsal recorded a
      // FAILURE quoting RC's "You have a reservation arriving on today's date ... Pre Check
      // In", which RC renders only to a SIGNED-IN user. So the session was fine and the one
      // question this test exists to answer was reported backwards, on the check the 07:40
      // pre-flight reads.
      //
      // The single `isLive()` above was already the fix for the same trap, and it was not
      // enough: RC's SPA paints that banner as soon as it knows who you are, and stores the
      // access token a moment later. Asking once lands in the gap. Nothing has been typed at
      // this point and no credential is at risk, so the only cost of waiting is a few seconds
      // on a path that is about to report a failure — and the cost of not waiting is a false
      // alarm that sends somebody to the box at 07:40.
      //
      // Deliberately NOT matched on the banner's words: RC rewords its own copy whenever it
      // likes, and a rule built on that sentence would fail silently the day they change it.
      // A live token is the fact; the banner is only what tipped us off.
      //
      // `acceptable()` and not a bare `isLive()`: a caller with a deadline must not be told
      // "already signed in" about a session that expires before its release — that is the
      // 2026-08-15 failure, and it would simply move here if only the first check were fixed.
      for (let i = 0; i < 8; i++) {
        if (await acceptable()) {
          return {
            ok: true,
            provedNothing: true,
            reason: 'already signed in — RC re-authenticated before any form appeared, so no sign-in was exercised',
          };
        }
        await page.waitForTimeout(1000);
      }
      return {
        ok: false,
        reason: await withBanner(link
          ? 'neither an email nor a password field appeared'
          : 'could not find the "Log in" link — RC may have reworded it'),
      };
    }

    if (user) {
      step(`email field: ${user.sel}`);
      if (!(await typeEmail(user.loc, email))) step('⚠ the email field did not hold what we typed');
    } else {
      step('Okta skipped the email step — it remembers this account');
    }
    if (await keepSignedIn(page)) step('ticked "Keep me signed in"');

    // THREE ROUNDS, ENTER FIRST, RELOAD BETWEEN. See the header: Okta disables the button
    // mid-transaction, so this step is flaky rather than blocked, and a reload is what
    // clears a half-finished transaction. Not three logins — three attempts to make one
    // form advance, before any credential has been submitted.
    for (let attempt = 1; attempt <= 3 && !pw; attempt++) {
      if (await captchaChallenge(page)) {
        if (!humanPresent) {
          return { ok: false, reason: 'a CAPTCHA appeared during sign-in — it needs you to sign in by hand' };
        }
        step('a CAPTCHA appeared — SOLVE IT IN THE WINDOW, waiting up to 5 minutes…');
        pw = await findIn(page, PASSWORD_SELECTORS, 300_000);
        break;
      }
      if (attempt > 1) {
        step(`reloading and retrying the email step (attempt ${attempt})`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(3000);
        const again = await findIn(page, EMAIL_SELECTORS, 15_000);
        if (!again) break;
        user = again;
        await typeEmail(user.loc, email);
        await keepSignedIn(page);
      }
      step(`submitting the email (attempt ${attempt}) — Enter`);
      await user.loc.press('Enter').catch((e) => step(`⚠ Enter failed: ${String(e.message).split('\n')[0]}`));
      pw = await findIn(page, PASSWORD_SELECTORS, 10_000);
      if (pw) break;

      const next = await findIn(page, SUBMIT_SELECTORS, 5000);
      if (next) {
        step(`Enter did not advance — clicking ${next.sel} (${await describeButton(next.loc)})`);
        try {
          await next.loc.click({ timeout: 8000 });
        } catch (err) {
          step(`⚠ the click FAILED: ${String(err.message).split('\n')[0]}`);
          // Last resort: fire the DOM click directly, bypassing actionability checks. If
          // THIS advances the page, the button was fine and Playwright's hit-testing was
          // the obstacle — a very different problem from Okta refusing the submission.
          step('trying a direct DOM click (bypasses actionability checks)…');
          await next.loc.evaluate((el) => el.click()).catch((e) => step(`⚠ DOM click threw: ${e.message}`));
        }
      } else {
        step('no Next button found either');
      }
      pw = await findIn(page, PASSWORD_SELECTORS, 12_000);
    }

    if (!pw) return { ok: false, reason: await withBanner('the password screen never appeared') };
    step(`password field: ${pw.sel}`);
    await pw.loc.fill(password);
    await keepSignedIn(page);
    step('password entered, submitting');

    const submit = await findIn(page, SUBMIT_SELECTORS, 5000);
    if (submit) await submit.loc.click().catch(() => {});
    else await pw.loc.press('Enter').catch(() => {});

    // Wait for a session, checking for a challenge as we go. 90s is generous for a
    // redirect chain and still far short of anything that looks like a stuck retry.
    const deadline = Date.now() + 90_000;
    let waited = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      waited += 3;
      if (waited % 15 === 0) step(`waiting for the session… ${waited}s`);
      if (await captchaChallenge(page)) {
        return { ok: false, reason: 'a CAPTCHA appeared after the password — it needs you to sign in by hand' };
      }
      if ((await isLive()) === true) return { ok: true, reason: 'signed in' };
    }
    // No session and no CAPTCHA. Ask RC why before guessing.
    return { ok: false, reason: await withBanner('sign-in did not complete') };
  } catch (err) {
    return { ok: false, reason: `sign-in error: ${String(err.message).slice(0, 120)}` };
  }
}
