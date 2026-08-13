/**
 * ReserveCalifornia bot probe — answers the LAST open question before RC auto-cart
 * can be built: can the bot log into RC and cart WITHOUT a human, or do Okta MFA /
 * reCAPTCHA stop it?
 *
 * ANSWERED, 2026-08-06 — and then some. See docs/CONTEXT.md for the full write-up.
 *   • Unattended login WORKS, but only HEADFUL. Every headless attempt failed at the
 *     email step; every headful one succeeded on the first press of Enter.
 *   • Bot-side carting WORKS, verified by reading the cart back by name:
 *     "Leo Carrillo SP - Canyon Campground - Hook Up (E) Campsite - 006,
 *      Thu 08/27/2026 - Fri 08/28/2026", placeId 665 / facilityId 539.
 *   • THE CART KEY IS NOT ENOUGH. A second session, freshly logged into the SAME
 *     account with a different token, reads that cart as EMPTY (--handoff, 2026-08-06).
 *     The cart is bound to the SESSION that made it, not to the account.
 *   • The whole session lives in localStorage, and copying that blob DOES carry both
 *     the login and the cart to another machine. That is the only hand-off that works,
 *     and it moves a live credential.
 *
 * This is deliberately a PROBE, not the feature. It runs one login, reports exactly
 * what blocked it if anything, and (optionally) does one cart + blob export so we can
 * confirm the full chain. Nothing is enqueued, nothing is checked out, no money moves.
 *
 * RUN IT ON THE MINI-PC (it needs Playwright + a real residential IP):
 *   cd scripts/auto-cart-bot
 *   RC_EMAIL=you@example.com RC_PASSWORD=... node rc-probe.mjs
 *
 * Optional, to also prove carting end-to-end (values come from a CampHawk RC alert
 * link's #camphawk-rc fragment — unitId_arrival_nights_sleepingUnitId):
 *   ... RC_UNIT_ID=12345 RC_ARRIVAL=2026-09-04 RC_NIGHTS=1 node rc-probe.mjs --cart
 *
 * --headful shows the browser (use it the first time; MFA prompts are visible).
 * --keep-open leaves it open at the end so you can eyeball the cart.
 * --capture   waits for YOU to add a site to the cart in the browser and records the
 *             exact request RC's own UI sends. Use it when --cart is rejected for a
 *             field we can't guess — a recording beats another round of enumeration:
 *               ... node rc-probe.mjs --headful --capture
 * --handoff   THE architecture question. Carts, then logs a SECOND, independent
 *             session into the same account and asks it to read that cart by key.
 *             ANSWERED 2026-08-06: it cannot. The cart is session-bound.
 *               ... RC_UNIT_ID=… RC_ARRIVAL=… node rc-probe.mjs --cart --handoff
 * --release   Whether PATH B works: bot holds the site, releases on demand, and the
 *             user's own session takes it. Logs a second session in FIRST (as the
 *             user's device already would be), releases, re-carts, and MEASURES the
 *             exposure window. Needs --headful, like every RC login:
 *               ... RC_UNIT_ID=… RC_ARRIVAL=… node rc-probe.mjs --cart --release --headful
 *
 * SECURITY: the exported blob is a LIVE RC session — full account access until the
 * token expires (~1h). It is written to rc-blob.json in this directory and gitignored.
 * Delete it when you are done. Never paste it anywhere, and never put it in a link.
 *
 * ⚠️ RC served 403 to the owner's household for ~12h on 2026-08-06, then stopped on its
 * own. Nothing ties it to these runs — that was a guess, and two confident diagnoses
 * during it (a WAF block, then an IPv6 problem) both turned out wrong. Still: prefer
 * plain `--cart`, which reuses the persistent profile, over `--handoff`/`--release`,
 * which delete theirs and force a fresh Okta login every run. Space them out. A 403
 * costs the household its own ability to book, whatever caused it. docs/CONTEXT.md has
 * the full write-up, including why a cached CloudFront error can fake any hypothesis.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC_HOME = 'https://www.reservecalifornia.com/';
// RC does precart in TWO steps — its own bundle exposes both, and a live trace shows
// them back to back (a big `load` response, then a small `submit`). Calling only
// `submit` is what made the first --cart run fail.
import { precartInPage, findCartEntry, releaseEntry, PRECART_LOAD, PRECART_SUBMIT, NO_CART } from './rc-cart.mjs';
import { hasCreds, loadCreds } from './credstore.mjs';
const RC_CART_PAGE = 'https://www.reservecalifornia.com/Customers/ShoppingCart';
/** Reads a cart's CONTENTS by key. This is how "is it really in the cart?" is answered
 *  with evidence rather than with RC's own IsSuccess flag. */
const CART_LOAD = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart';

const args = new Set(process.argv.slice(2));
const HEADFUL = args.has('--headful');
const DO_CART = args.has('--cart');
const KEEP_OPEN = args.has('--keep-open');
/** --capture: stop guessing, RECORD. Opens RC signed in and waits for YOU to add a site
 *  to the cart by hand, then writes the exact `submit/precartdataforbookingmodify` body
 *  RC's own UI sent. Five rounds of guessing `extraValues` cost more than one recording
 *  would have; when a payload is unknown, capture it rather than enumerate it. */
const CAPTURE = args.has('--capture');
/**
 * --handoff: THE question that decides the whole RC auto-cart architecture.
 *
 * We know the cart key alone does NOT transfer to a fresh session, and that copying the
 * entire localStorage blob DOES (cross-machine, cross-IP). The blob contains the token
 * and the key does not, so the binding is to the TOKEN — but that leaves the decisive
 * case untested: can a DIFFERENT session, freshly logged into the SAME RC account, read
 * that cart by key?
 *
 *   YES → the alert carries only the cart KEY. Harmless, no session ever moves, the
 *         user signs into RC themselves. The clean design.
 *   NO  → we must transfer a live session blob — full account access — and everything
 *         downstream (delivery, TTL, revocation, the native webview) gets heavier.
 *
 * The earlier incognito test pointed at NO, but it cannot settle it: we do not know
 * whether that window was actually signed in when the key was written. This runs both
 * halves itself, in one process, with a genuinely separate profile — no copy-paste, no
 * ambiguity about what state the second browser was in.
 */
const HANDOFF = args.has('--handoff');
/**
 * --release: does path B work? The whole of it, measured end to end.
 *
 * The key cannot hand a cart over (--handoff proved that), so the remaining design
 * without moving a credential is: the bot HOLDS the site — which is the real value, it
 * is off the market while the user gets to their phone — and when the user acts, the
 * bot releases and the user's OWN session takes it immediately.
 *
 * That rests on one assumption nobody has tested: **that releasing frees the unit at
 * once.** If RC applies any cooldown to a just-released unit, path B is dead and the
 * only remaining option moves a live session.
 *
 * So this measures the actual race rather than reasoning about it: log session B in
 * FIRST (as the user's device would already be), release from A, and have B try to cart
 * the same unit as fast as it can. It reports whether B won and how many milliseconds
 * the site was exposed.
 */
const RELEASE = args.has('--release');
/**
 * --cart-cap: is the "maximum 2" a limit on the CART, or on the ACCOUNT?
 *
 * On 2026-08-13 a third hold for one 08:00 release came back in RC's own words: *"Your
 * request violates the 'Maximum Reservations in Cart' restriction. The maximum number of
 * reservations allowed in the cart is '2'."* That was read as a hard ceiling of two sites
 * per release — which would make the bot's single RC account the thing that caps growth,
 * and it is why "should we collect users' RC logins?" came up at all.
 *
 * BUT THE MESSAGE SAYS *CART*, AND WE ONLY EVER USE ONE. `rc-hold-runner` reads
 * `localStorage["shoppingCartKey"]` and passes `existing || NO_CART`, and `precartInPage`
 * writes each successful key straight back — so the first hold mints a cart and every hold
 * after it is funnelled into that same cart, forever. The database agrees: 15 holds in the
 * system's life, **two distinct cart keys**, and all three of the 08-13 holds on one.
 *
 * The cart is a free-floating GUID-keyed object with `CustomerId: 0` (docs/CONTEXT.md), and
 * `load` mints a fresh one for the asking. So there is an obvious cheap possibility — N
 * carts of 2, one session, one account, no new login and no new credential anywhere — and
 * no evidence either way. That is exactly the shape of thing this file exists to settle:
 * cross-session adoption, the keep-warm, and `renewByReload` were all plausible and all
 * false, and each cost more by being assumed than it would have to measure.
 *
 * THE EXPERIMENT, and the third step is the whole point:
 *   1. cart unit A into a FRESH cart      → expect ok, key K1
 *   2. cart unit B into K1                → expect ok, K1 now holds two
 *   3. cart unit C into K1                → expect RC's cap refusal. The control: without
 *                                           it, step 4 succeeding proves nothing, because
 *                                           we would not know the cap was live right now.
 *   4. cart unit C into a FRESH cart      → THE ANSWER.
 *
 *   ok  → the ceiling is per cart and self-inflicted. One line in the hold runner.
 *   no  → the ceiling is the ACCOUNT, and only more identities can lift it.
 *
 * SAFETY — it locks three real campsites for the length of the run:
 *   • It only ever removes entry keys it created, and NEVER `empty/shoppingcart`. A real
 *     hold sitting in the bot's own cart is untouched, because step 1 starts a new one.
 *   • `localStorage["shoppingCartKey"]` is saved and restored. `precartInPage` repoints it
 *     on every success, so without that the hold runner's next `existing` read would find
 *     the probe's cart.
 *   • Everything is released in a `finally`, including on a throw.
 *   • Still: pick sites nobody wants — far-future dates, midweek, off-peak — and do not run
 *     it near 08:00 or with a hold queued. Three locks is three sites off the market.
 *
 * THE CONFOUND TO CLEAR FIRST, because it can fake the pessimistic answer: this probe signs
 * in as `RC_EMAIL`, which is almost certainly the SAME RC account the hold runner uses, from
 * a different session (`.rc-probe-profile`). If the cap turns out to be per ACCOUNT, then a
 * real hold already sitting in the bot's cart counts against it — and step 4 would be
 * refused for a reason that has nothing to do with the cart it was asked about. **Run this
 * with the bot's cart empty**, i.e. no hold in `carted`/`claiming`, or a "not per cart"
 * verdict is not one. `scripts/rc-holds-readout.mts` says which.
 *
 *   RC_CAP_UNITS=111,222,333 RC_ARRIVAL=2026-12-15 RC_NIGHTS=1 \
 *     node rc-probe.mjs --cart-cap --headful
 */
const CART_CAP = args.has('--cart-cap');
/** Releases ONE entry, leaving the rest of the cart alone — what a bot holding several
 *  sites needs. Both shapes read out of RC's bundle (2026-08-06). */
const CART_REMOVE_ENTRY = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/remove/cartentry';
const CART_EMPTY = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/empty/shoppingcart';

/**
 * THE ENCRYPTED STORE FIRST, the env vars second — the same order `rc-autologin.mjs` uses.
 *
 * This read env vars only, so running the probe on the mini-PC meant typing a live RC
 * password into a cmd window: it lands in the console scrollback and in the shell history,
 * on a machine that is routinely screen-shared. `rc-save-password.bat` exists precisely so
 * that never has to happen, and the password has been in the DPAPI store since 2026-08-09.
 *
 * The creds come out of `.rc-bot-profile` — the ACCOUNT's directory — while the browser
 * still runs on `.rc-probe-profile`. That separation is the whole point of the probe (a
 * second session on one account), so the credential dir must not follow the browser dir.
 *
 * The env vars stay as the override for a dev box that has no DPAPI, which is the case the
 * header's usage line was written for.
 */
const CRED_DIR = path.resolve(HERE, '.rc-bot-profile');
const stored = (() => {
  try { return hasCreds(CRED_DIR) ? loadCreds(CRED_DIR) : null; } catch { return null; }
})();
const EMAIL = stored?.email || process.env.RC_EMAIL;
const PASSWORD = stored?.password || process.env.RC_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error(
    'No RC credentials. On the mini-PC run mini-pc\\rc-save-password.bat once;\n' +
    'elsewhere set RC_EMAIL and RC_PASSWORD. See the header of this file.',
  );
  process.exit(2);
}

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n[${n}] ${s}`);

/** Read the whole RC localStorage — this IS the session (see docs/CONTEXT.md). */
async function readBlob(page) {
  return page.evaluate(() => Object.entries(localStorage));
}

// RC signs in through OKTA IDENTITY ENGINE (observed 2026-08-05), not Okta Classic.
// OIE names the fields `identifier` and `credentials.passcode`; Classic used `username`
// and `password`. It is also IDENTIFIER-FIRST: email + "Next", then password on a
// second screen. Both vocabularies are listed so a hosted-widget swap doesn't break us.
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

/**
 * Find the first visible match for any selector, ACROSS ALL FRAMES.
 *
 * Okta is frequently served in an iframe, and a main-frame-only lookup reports
 * "field not found" for a field that is plainly on screen — which is exactly how the
 * first run of this probe failed. Polls, because the widget renders after load.
 */
async function findIn(page, selectors, { timeout = 20_000, label = 'field' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel).first();
          if ((await loc.count()) && (await loc.isVisible())) return { loc, sel };
        } catch { /* frame detached mid-poll — try the next */ }
      }
    }
    await page.waitForTimeout(500);
  }
  log(`   (could not find ${label}; tried: ${selectors.join(', ')})`);
  return null;
}

/** Tick "Keep me signed in" when present. Load-bearing for the whole design: the bot
 *  should need at most ONE human login, and this is what makes the session stick. */
async function keepSignedIn(page) {
  for (const frame of page.frames()) {
    for (const sel of ['input[type="checkbox"][name*="rememberMe" i]', 'input[type="checkbox"]']) {
      try {
        const box = frame.locator(sel).first();
        if ((await box.count()) && (await box.isVisible()) && !(await box.isChecked())) {
          await box.check({ timeout: 3000 });
          log('   ticked "Keep me signed in"');
          return;
        }
      } catch { /* not the box, or not checkable */ }
    }
  }
}

/** The signals that tell us WHY an unattended login failed. Distinguishing "MFA asked
 *  for an email code" from "reCAPTCHA blocked us" from "wrong password" is the entire
 *  point of the probe — they have completely different answers. */
async function diagnose(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const has = (re) => re.test(text);
    return {
      url: location.href,
      mfa: has(/verification code|verify your identity|enter the code|multifactor|authenticator/i),
      captcha:
        !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha') ||
        has(/captcha|are you a robot|verify you are human/i),
      badCreds: has(/incorrect|invalid|does not match|unable to sign/i),
      locked: has(/locked|too many attempts|temporarily unavailable/i),
      // Okta puts the real reason in a dedicated banner, and it is frequently a
      // sentence none of the regexes above would match. Read it rather than infer it.
      error: Array.from(
        document.querySelectorAll('[role="alert"], .okta-form-infobox-error, .infobox-error, .o-form-error-container'),
      ).map((el) => el.textContent?.trim()).filter(Boolean).join(' | ').slice(0, 300),
      snippet: text.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
}

/**
 * Write down what the page actually looked like when a step failed.
 *
 * Every login failure so far has been diagnosed from a 300-character text snippet,
 * which is how "the Next button didn't work" and "Okta showed a challenge we don't
 * recognise" ended up indistinguishable. A screenshot and the full text cost nothing
 * and settle it. Both are gitignored — the screenshot can contain a signed-in session.
 */
async function captureFailure(page, name) {
  const shot = path.join(HERE, `rc-probe-${name}.png`);
  const txt = path.join(HERE, `rc-probe-${name}.txt`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
    const body = await page.evaluate(() => {
      const frames = [document, ...Array.from(document.querySelectorAll('iframe'))
        .map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
      return frames.map((d, i) => `--- frame ${i} (${d.location?.href ?? '?'}) ---\n${d.body?.innerText ?? ''}`).join('\n\n');
    });
    fs.writeFileSync(txt, `url: ${page.url()}\n\n${body}`, { mode: 0o600 });
    log(`   captured: ${shot}`);
    log(`             ${txt}`);
    // PRINT it too. A file on the mini-PC is a round trip away from whoever is reading
    // the output, and every round trip here has cost more than the information did.
    const flat = body.replace(/\n{2,}/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    log('   ── what the page actually said ──');
    for (const line of flat.slice(0, 25)) log(`   | ${line.slice(0, 160)}`);
    if (flat.length > 25) log(`   | …${flat.length - 25} more lines in the .txt`);
  } catch (err) {
    log(`   (could not capture the failure state: ${err.message})`);
  }
}

/**
 * Type the email as real keystrokes, and CHECK IT LANDED.
 *
 * `fill()` sets the value and dispatches one input event. Widgets that track their own
 * validity can miss that and keep the submit button disabled — which presents as a
 * CLICK TIMEOUT, because Playwright waits for an enabled, stable, hittable element and
 * never gets one. That is indistinguishable from "the site blocked us" in the log, and
 * it is what three identical failures looked like.
 *
 * So: click, type character by character, then read the value back. If the field does
 * not hold what we typed, say so — that is the whole answer, not a symptom.
 */
async function typeEmail(loc) {
  await loc.click({ timeout: 5000 }).catch(() => {});
  await loc.fill('').catch(() => {});
  await loc.pressSequentially(EMAIL, { delay: 25 }).catch(async () => { await loc.fill(EMAIL); });
  const got = await loc.inputValue().catch(() => null);
  if (got !== EMAIL) log(`   ⚠ the email field holds ${JSON.stringify(got)}, not the address we typed`);
  return got === EMAIL;
}

/**
 * Every login attempt so far separates perfectly on ONE variable: headless.
 *
 *   headless  --cart --keep-open      → failed at the email step
 *   HEADFUL   --cart --headful        → signed in
 *   headless  --cart --handoff        → failed, 3 identical attempts
 *
 * Three failures and one success is not proof, and the mechanism is unknown — Okta may
 * be refusing a headless client, or the button may simply never become hittable without
 * a real compositor. But the correlation is clean enough to act on, and it matters far
 * beyond this script: if RC's Okta will not accept a headless browser, the PRODUCTION
 * bot cannot run headless either. On the mini-PC that is free (it has a desktop);
 * anywhere else it means a virtual display.
 *
 * Do not treat a headless failure here as "RC blocked us" until it has been retried
 * with --headful. That mistake costs a day.
 */
function warnHeadless() {
  log('   ⚠ running HEADLESS. Every failed login in this chain has been headless and');
  log('     the only success was --headful. If this fails, retry with --headful before');
  log('     concluding anything about RC.');
}

/**
 * Is a reCAPTCHA challenge on screen?
 *
 * Checked across ALL frames, because the challenge renders in its own iframe — and the
 * badge alone is not enough: RC shows a passive reCAPTCHA badge on pages that are
 * perfectly automatable. What matters is an actual CHALLENGE (the image grid), which
 * lives in a `bframe` iframe, or a visible challenge container.
 */
async function captchaPresent(page) {
  // PRESENCE IS NOT A CHALLENGE. reCAPTCHA injects its `bframe` iframe on every page
  // that loads the widget, sized 0x0 and hidden, and RC loads the widget on sign-in
  // pages that automate perfectly well. The first version of this checked only that the
  // iframe EXISTED and so fired on a login with no challenge at all — it made the probe
  // sit waiting five minutes for a human who had nothing to solve, and I then repeated
  // that false reading back as "you had to solve two CAPTCHAs".
  //
  // A real challenge is VISIBLE and has real size. Measure that.
  try {
    return await page.evaluate(() => {
      const frames = Array.from(
        document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]'),
      );
      return frames.some((f) => {
        const r = f.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) return false;
        const st = getComputedStyle(f);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
        // The challenge sits in a wrapper that is toggled hidden between uses; an
        // ancestor with visibility:hidden means it is loaded but not being asked.
        for (let el = f.parentElement; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.visibility === 'hidden' || s.display === 'none') return false;
        }
        return true;
      });
    });
  } catch {
    return false;
  }
}

/** Why can't we click it? Playwright's timeout says "not actionable" and stops there;
 *  disabled / invisible / zero-sized / covered need completely different responses. */
async function describeButton(loc) {
  try {
    const [visible, enabled, box, html] = await Promise.all([
      loc.isVisible().catch(() => null),
      loc.isEnabled().catch(() => null),
      loc.boundingBox().catch(() => null),
      loc.evaluate((el) => el.outerHTML.slice(0, 160)).catch(() => ''),
    ]);
    return `visible=${visible} enabled=${enabled} box=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none'} ${html}`;
  } catch (err) {
    return `(could not inspect: ${err.message})`;
  }
}

/**
 * Sign in, on whatever page it is handed. Extracted so the HAND-OFF test can drive a
 * SECOND, completely independent session through the same flow — that test is worthless
 * if the two sessions do not log in identically.
 */
async function signIn(page, { profileDir } = {}) {
    // A run that previously said "Already signed in" and now doesn't means the session
    // was DROPPED, not that it never existed. That distinction matters: an expiring
    // session is the design working (log in once, ride it), while a revoked one is RC
    // pushing back on this machine. The profile dir is the evidence either way.
    if (profileDir && fs.existsSync(profileDir)) {
      log('   (the persistent profile exists but holds no token — a previous session was lost)');
    }
    // RC hands off to Okta at signin.reservecalifornia.com. Selectors are best-effort
    // across their hosted-widget variants; --headful shows what actually appeared.
    const signIn = page
      .getByRole('link', { name: /sign in|log in/i })
      .or(page.getByRole('button', { name: /sign in|log in/i }))
      .first();
    if (await signIn.count()) {
      await signIn.click().catch(() => {});
      await page.waitForTimeout(4000);
    }

    let user = await findIn(page, EMAIL_SELECTORS, { label: 'the email field' });
    if (!user) {
      const d = await diagnose(page);
      log('   Page says:', d.snippet);
      if (d.error) log(`   Okta error banner: "${d.error}"`);
      await captureFailure(page, 'login-no-form');
      throw new Error('login form not found — rerun with --headful and watch the page');
    }
    log(`   email field: ${user.sel}`);
    await typeEmail(user.loc);
    await keepSignedIn(page);

    // Identifier-first: the password field usually isn't on this screen yet. Submit
    // the email, then look again. If a password field IS already present (Classic
    // one-page widget), this second lookup just finds it immediately.
    let pass = await findIn(page, PASSWORD_SELECTORS, { timeout: 2000, label: 'password (same screen)' });
    if (!pass) {
      // TWO attempts, and the click's failure is REPORTED. `.catch(() => {})` used to
      // make "clicked, and Okta ignored it" and "the click itself threw" the same
      // outcome — so a run that never submitted anything reported "password step not
      // reached", which points at Okta for something that was ours.
      // THREE attempts, ENTER FIRST, and a reload between rounds.
      //
      // This step is flaky rather than blocked: the same code got through on the main
      // profile minutes earlier and failed here. The observed signature — the first
      // click reporting nothing, the second timing out at 5s — is Okta DISABLING the
      // button while a transaction is in flight, so the retry fights a widget that is
      // mid-request rather than a widget that refused us.
      //
      // Enter goes first because it submits the form Okta is actually listening to,
      // without needing the button to be enabled and hittable. A reload between rounds
      // clears a half-finished transaction, which clicking again never does.
      for (let attempt = 1; attempt <= 3 && !pass; attempt++) {
        // A reCAPTCHA challenge is not something to retry harder at. Observed
        // 2026-08-07: RC's Okta page served an image challenge ("select all images with
        // bicycles"), and the Next button reported visible=true enabled=true while every
        // click timed out — the challenge's overlay was swallowing the pointer events.
        // That is what three rounds of "the click failed" actually were, and no amount
        // of clicking gets past it.
        //
        // The right move is the one production makes anyway: let a HUMAN solve it once,
        // then ride the session. So pause and wait instead of failing.
        if (await captchaPresent(page)) {
          log('\n   ⚠ reCAPTCHA challenge on the sign-in page.');
          if (!HEADFUL) {
            log('   Running headless, so nobody can solve it. Re-run with --headful.');
            break;
          }
          log('   SOLVE IT IN THE BROWSER WINDOW — this probe will wait up to 5 minutes.');
          log('   (Then it carries on by itself. "Keep me signed in" is already ticked,');
          log('    so the persistent profile should hold the session for later runs.)');
          pass = await findIn(page, PASSWORD_SELECTORS, { timeout: 300_000, label: 'the password field (after your solve)' });
          if (pass) { log('   thank you — continuing.'); break; }
          log('   still no password field after 5 minutes.');
          break;
        }
        if (attempt > 1) {
          log(`   reloading and retrying the email step (attempt ${attempt})`);
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
          const again = await findIn(page, EMAIL_SELECTORS, { timeout: 15_000, label: 'the email field' });
          if (!again) break;
          user = again;
          await typeEmail(user.loc);
          await keepSignedIn(page);
        }
        log(`   submitting the email (attempt ${attempt}) — Enter`);
        await user.loc.press('Enter').catch((e) => log(`   ⚠ Enter failed: ${e.message.split('\n')[0]}`));
        pass = await findIn(page, PASSWORD_SELECTORS, { timeout: 10_000, label: 'the password field' });
        if (pass) break;

        const next = await findIn(page, SUBMIT_SELECTORS, { timeout: 5000, label: 'the Next button' });
        if (next) {
          log(`   Enter did not advance — clicking ${next.sel}`);
          log(`   button state: ${await describeButton(next.loc)}`);
          try {
            await next.loc.click({ timeout: 8000 });
          } catch (err) {
            log(`   ⚠ the Next click FAILED: ${err.message.split('\n')[0]}`);
            log(`   button state after: ${await describeButton(next.loc)}`);
            // Last resort: fire the DOM click directly, bypassing every actionability
            // check. If THIS advances the page, the button was fine and Playwright's
            // hit-testing was the obstacle (an overlay, a zero-size hit area) — a very
            // different problem from Okta refusing the submission.
            log('   trying a direct DOM click (bypasses actionability checks)…');
            await next.loc.evaluate((el) => el.click()).catch((e) => log(`   ⚠ DOM click threw: ${e.message}`));
          }
        }
        pass = await findIn(page, PASSWORD_SELECTORS, { timeout: 12_000, label: 'the password field' });
      }
    }
    if (!pass) {
      const d = await diagnose(page);
      log('   No password field appeared. Page says:', d.snippet);
      if (d.error) log(`   Okta error banner: "${d.error}"`);
      if (d.mfa) log('   → looks like Okta went straight to an MFA challenge.');
      await captureFailure(page, 'login-no-password');
      throw new Error('password step not reached');
    }
    log(`   password field: ${pass.sel}`);
    await pass.loc.fill(PASSWORD);
    await keepSignedIn(page);

    const submit = await findIn(page, SUBMIT_SELECTORS, { timeout: 5000, label: 'the submit button' });
    if (submit) await submit.loc.click().catch(() => {});
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);

    const after = await readBlob(page);
    return after.some(([k]) => k === 'ssoAccessToken' || k === 'accessToken');
}

// precartInPage now lives in rc-cart.mjs — shared with the production hold runner so
// the payload contract cannot drift between them.

const ctx = await chromium.launchPersistentContext(path.join(HERE, '.rc-probe-profile'), {
  headless: !HEADFUL,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  step(1, 'Loading ReserveCalifornia…');
  log(`   a Chromium window ${HEADFUL ? 'should have opened' : 'is running hidden (--headful to watch it)'}`);
  // A bare goto with a 60s timeout looks identical to a hung script for a full minute,
  // and the first thing anyone does is kill it — losing the error that would have said
  // why. Report before waiting, shorten the wait, and say what the page ACTUALLY was.
  {
    let loaded = false;
    for (let attempt = 1; attempt <= 2 && !loaded; attempt++) {
      try {
        await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        loaded = true;
      } catch (err) {
        log(`   attempt ${attempt}: ${err.message.split('\n')[0]}`);
        log(`   current url: ${page.url() || '(none)'}`);
      }
    }
    if (!loaded) {
      await captureFailure(page, 'load-home');
      log('   RC did not load. This machine got a 403 from RC on 2026-08-06, so a WAF');
      log('   block is a live possibility — check whether reservecalifornia.com opens in');
      log('   your normal browser on this box before assuming the probe is at fault.');
      throw new Error('could not load reservecalifornia.com');
    }
  }
  await page.waitForTimeout(3000);

  // Already signed in from a previous probe run? The persistent profile keeps it.
  let blob = await readBlob(page);
  let signedIn = blob.some(([k]) => k === 'ssoAccessToken' || k === 'accessToken');

  if (signedIn) {
    step(2, 'Already signed in (persistent profile) — skipping login.');
  } else {
    step(2, 'Signing in…');
    if (!HEADFUL) warnHeadless();
    signedIn = await signIn(page, { profileDir: path.join(HERE, '.rc-probe-profile') });
    blob = await readBlob(page);
  }

  const d = await diagnose(page);
  step(3, 'Login result');
  log(`   signed in : ${signedIn ? 'YES' : 'NO'}`);
  log(`   url       : ${d.url}`);
  log(`   MFA prompt: ${d.mfa ? 'YES  ← blocks unattended login' : 'no'}`);
  log(`   CAPTCHA   : ${d.captcha ? 'YES  ← blocks unattended login' : 'no'}`);
  if (d.badCreds) log('   ⚠ page mentions bad credentials');
  if (d.locked) log('   ⚠ page mentions a lockout / too many attempts');
  if (!signedIn) log(`   page text : ${d.snippet}`);

  if (!signedIn) {
    await captureFailure(page, 'login-failed');
    log('\nVERDICT: the bot could NOT log in unattended.');
    log(d.mfa
      ? '  Cause: Okta MFA. Options: an app-password/trusted-device flow, or a one-time\n  human login on the mini-PC whose persistent profile the bot then reuses.'
      : d.captcha
        ? '  Cause: CAPTCHA on login.'
        : '  Cause: unclear — rerun with --headful and watch.');
    log('  NOTE: the persistent profile means a SINGLE human login on the mini-PC may be\n  enough — rerun this probe afterwards and it should report "already signed in".');
  } else {
    log('\nVERDICT: unattended login WORKS. (Or the profile was already authenticated —\nif this is the first run, that distinction matters; check the MFA/CAPTCHA lines.)');
  }

  if (signedIn && CAPTURE) {
    step(4, 'CAPTURE mode — waiting for a real add-to-cart from the RC UI.');
    log('   In the browser window: find any available site, pick dates, and click');
    log('   "Add to cart" the way a normal user would. Nothing is charged — a cart is');
    log('   only a hold, and you can empty it afterwards.');
    log('   This records what RC ITSELF sends, which is the answer our guesses are');
    log('   circling. Up to 15 minutes; Ctrl-C to give up.\n');

    let captured = null;
    page.on('request', (req) => {
      const u = req.url();
      if (!u.startsWith(PRECART_SUBMIT) && !u.startsWith(PRECART_LOAD)) return;
      const which = u.startsWith(PRECART_SUBMIT) ? 'submit' : 'load';
      let parsed = null;
      try { parsed = JSON.parse(req.postData() ?? 'null'); } catch { /* not JSON */ }
      const file = path.join(HERE, `rc-ui-${which}.json`);
      fs.writeFileSync(file, req.postData() ?? '', { mode: 0o600 });
      log(`   ✓ captured ${which} → ${file}`);
      if (which === 'submit') captured = parsed ?? {};
    });

    await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    const deadline = Date.now() + 15 * 60_000;
    while (!captured && Date.now() < deadline) await page.waitForTimeout(1000);

    if (!captured) {
      log('\n   Nothing captured. Either no add-to-cart happened, or RC changed the');
      log('   endpoint — check DevTools → Network for what the button actually calls.');
    } else {
      log('\n   THE REAL PAYLOAD (this is ground truth, not a guess):');
      log(`   extraValues: ${JSON.stringify(captured.extraValues)}`);
      // Everything our bot's body differs on, named. These are the fields to copy.
      const interesting = [
        'extraValues', 'customerClassificationId', 'sleepingUnit', 'occupantName',
        'unitPriceType', 'fdUsageClassificationId', 'selectedClassification',
        'dynamicOccupancyByNight', 'adults', 'children', 'shoppingCartKey',
      ];
      for (const k of interesting) {
        if (k in captured) log(`     ${k}: ${JSON.stringify(captured[k]).slice(0, 300)}`);
      }
      log('   Full body saved above. Copy extraValues into the bot payload verbatim.');
    }
  }

  // Carried out of the cart block for the hand-off test below.
  let cartedKey = null;
  let cartedUnit = null;
  let cartedEntryKey = null;
  let cartedPlace = null;
  let cartedFacility = null;
  let cartedArrival = null;
  let cartedNights = 1;

  if (signedIn && DO_CART) {
    const unitId = Number(process.env.RC_UNIT_ID);
    const arrival = process.env.RC_ARRIVAL;
    const nights = Number(process.env.RC_NIGHTS ?? 1);
    if (!unitId || !arrival) {
      log('\nSkipping --cart: set RC_UNIT_ID and RC_ARRIVAL (see header).');
    } else {
      // A brand-new session has NO cart key, and RC's validation rejects an empty
      // string for it (that is what the first --cart run hit — a .NET
      // ValidationProblemDetails on `shoppingCartKey`, NOT a CAPTCHA). RC's UI gets a
      // key by starting a cart, which is why the extension asks the human to click the
      // 🛒 icon. Here we do the machine equivalent: visit the cart page to let RC mint
      // one, and fall back to RC's own "no cart yet" sentinel if it still hasn't.
      step(4, 'Ensuring a shopping-cart key…');
      let cartKey = await page.evaluate(() => localStorage.getItem('shoppingCartKey'));
      if (!cartKey) {
        await page.goto(RC_CART_PAGE, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
        await page.waitForTimeout(5000);
        cartKey = await page.evaluate(() => localStorage.getItem('shoppingCartKey'));
      }
      log(`   cart key: ${cartKey ?? `(none — using RC's no-cart sentinel ${NO_CART})`}`);

      step(5, `Carting unit ${unitId} on ${arrival} for ${nights} night(s)…`);
      // Mirror the real app: LOAD the precart, then SUBMIT it. A live trace shows both,
      // back to back. `load` is also where RC takes the unit lock, so skipping it may be
      // why a submit-only call is rejected.
      const result = await precartInPage(page, { unitId, arrival, nights, cartKey });

      // `Settings.IsOccupantNameRequiredForReservations: true` on this facility, and we
      // derive occupantName from localStorage — so an empty one is a live suspect for
      // the "required field" rejection regardless of what the label says.
      log(`   occupantName: ${result.occupantName ? `"${result.occupantName}"` : 'EMPTY  ← required by this facility'}  (${result.occupantKeys})`);
      const okLoad = result.loaded.v.isSuccess;
      const okSubmit = result.submitted.v.isSuccess;
      log(`   load   → ${result.loaded.netError ? `NETWORK: ${result.loaded.netError}` : `HTTP ${result.loaded.status}, IsSuccess=${okLoad}${result.loaded.v.error ? ` — ${result.loaded.v.error}` : ''}`}`);
      log(`   submit → ${result.submitted.netError ? `NETWORK: ${result.submitted.netError}` : `HTTP ${result.submitted.status}, IsSuccess=${okSubmit}  (key ${result.usedKey})`}`);
      if (result.submitted.v.error) log(`     ErrorMessage: ${result.submitted.v.error.replace(/<br\/?>/g, ' ')}`);

      // THE STATUS THE BROWSER WOULDN'T SHOW US. Playwright's request context shares the
      // browser's cookie jar but is NOT a page, so CORS does not apply and we can read
      // whatever RC actually answered. This is the difference between "RC is blocking
      // this machine" and "RC is unreachable", which the in-page error cannot tell apart.
      if (result.loaded.netError || result.submitted.netError) {
        log('\n   The browser refused to show the status (CORS hides it on a rejected');
        log('   fetch). Replaying the same request from Node, where CORS does not apply…');
        for (const [name, url] of [['load', PRECART_LOAD], ['submit', PRECART_SUBMIT]]) {
          try {
            const r = await page.context().request.post(url, {
              headers: result.replay.headers,
              data: result.replay.body,
              timeout: 30_000,
            });
            const text = (await r.text()).slice(0, 300).replace(/\s+/g, ' ');
            log(`     ${name} → HTTP ${r.status()}  ${text}`);
          } catch (err) {
            log(`     ${name} → still failed at the network layer: ${err.message}`);
          }
        }
        log('   Reading of the result:');
        log('     403 → RC\'s WAF is blocking this machine. Not our payload; back off,');
        log('           and note the ShoppingCart page 403 on this host as the same event.');
        log('     401 → the session token expired mid-run; re-run and it should pass.');
        log('     a real HTTP status at all → the origin is reachable and the in-page');
        log('           failure was CORS on an error response, not a dead network.');
      }

      // The load response carries the facility's REQUIRED "extra values" (per-park
      // questions like "confirm your booking dates"). We send extraValues: [] and RC
      // rejects the submit for the missing answer — so dump the shape and surface the
      // candidates rather than guessing at them.
      const dump = path.join(HERE, 'rc-precart-load.json');
      fs.writeFileSync(dump, result.loadedFull, { mode: 0o600 });
      log(`   load response saved → ${dump}`);
      try {
        const j = JSON.parse(result.loadedFull);
        const res = j?.Result ?? j;
        log(`   load Result keys: ${Object.keys(res).join(', ')}`);
        // By NAME, not by pattern. The previous /custom/ regex matched
        // "CustomerClassificationId" and missed `Waivers` — the one field that
        // actually mattered. Naming them is the whole lesson.
        for (const k of ['Settings', 'ErrorMessages', 'LockedShoppingCart']) {
          if (k in res) log(`   ▸ ${k}: ${JSON.stringify(res[k]).slice(0, 900)}`);
        }

        // THE DECISIVE ONE. The submit is rejected naming a label — "Please confirm
        // your booking dates before finalizing your reservation." Rather than guess
        // which structure declares it, find that phrase IN the load response and show
        // its surroundings: whatever object contains it is the field we must answer.
        const needle = /confirm your booking dates/i;
        const hay = result.loadedFull;
        let at = hay.search(needle);
        if (at === -1) {
          log('   ▸ the rejected label does NOT appear in the load response.');
          log('     → it is not a facility field we can read here; likely a client-side');
          log('       confirmation the UI adds, or a global setting.');
        } else {
          let shown = 0;
          while (at !== -1 && shown < 3) {
            log(`   ▸ label found at ${at}: …${hay.slice(Math.max(0, at - 420), at + 260).replace(/\s+/g, ' ')}…`);
            const next = hay.slice(at + 1).search(needle);
            at = next === -1 ? -1 : at + 1 + next;
            shown++;
          }
        }

        // Every top-level key with its type, so an array of field definitions can't
        // hide from us again the way Waivers did behind a regex.
        log('   ▸ Result shape: ' + Object.keys(res).map((k) => {
          const v = res[k];
          const n = Array.isArray(v?.$values) ? `[${v.$values.length}]` : Array.isArray(v) ? `[${v.length}]` : typeof v;
          return `${k}:${n}`;
        }).join(' '));
      } catch { log('   (could not parse the load response)'); }

      // Every `ExtraId`-bearing object the load response carries, whether or not the
      // submit needed it. If all four shapes miss, THIS is the evidence for the next
      // attempt — the field's own key list tells us what RC expects back.
      if (result.extrasFound?.length) {
        log(`   ▸ ${result.extrasFound.length} extra definition(s) found (${result.neededCount} required):`);
        for (const e of result.extrasFound) {
          log(`     ${e.required ? 'REQ ' : '    '}ExtraId=${e.ExtraId} type=${e.ExtraType} default=${JSON.stringify(e.DefaultValue)} at "${e.at}" — ${e.Name}`);
          if (e.required) log(`         keys: ${e.keys}`);
        }
      } else if (result.loaded.netError) {
        log('   ▸ no extras read — the load request never returned a body (see above).');
      } else {
        log('   ▸ NO ExtraId-bearing objects anywhere in the load response.');
        log('     → the required answer is not declared here; look at what the real UI');
        log('       POSTs (DevTools → Network → submit/precartdataforbookingmodify).');
      }

      if (result.attempts?.length > 1) {
        log(`   tried ${result.attempts.length} extraValues shapes against ${result.neededCount} required extra(s):`);
        for (const a of result.attempts) {
          const err = a.v.error ? ` — ${a.v.error.replace(/<br\/?>/g, ' ').slice(0, 120)}` : '';
          log(`     ${a.v.isSuccess ? 'OK  ' : 'no  '} ${a.shape}${err}`);
        }
      }
      // ALWAYS read the cart back — success or failure. Gating this on `okSubmit`
      // skipped it in the one case that mattered most: RC answered "cart is already
      // added", which is not a failure to cart, it is proof the site is ALREADY held
      // from a previous run. The run reported "NOT carted" while holding the site.
      // A check you only run when you expect to pass tells you nothing you didn't
      // already assume.
      {
        const key = result.submitted.v.cartKey || result.finalKey || cartKey;
        log(`   Cart key now: ${key}`);

        // READ THE CART BACK. `IsSuccess: true` is RC's word for "I accepted the
        // request"; it is not the same claim as "the site is in the cart", and this
        // probe has already once reported a success that wasn't one. So ask RC for the
        // cart's CONTENTS and look for the unit we asked for. The whole promise of
        // auto-cart is that "it's in your cart" is verifiable — verify it.
        step(6, 'Reading the cart back to confirm the site is really in it…');
        // Deliberately NOT an in-page fetch. The verification step must not be capable of
        // failing the way the thing it verifies just did — a rejected browser fetch hides
        // its status behind CORS, and a verifier that can only say "something went wrong"
        // is no better than the claim it is checking. Playwright's request context shares
        // the browser's cookies and session but is not a page, so we always get a status.
        // Match the way RC's DATA lets us, not the way we wish it did.
        //
        // Two false negatives came out of this check before I stopped trusting it.
        // First a walker that counted objects carrying a `unitId` key — RC's cart
        // entries have NO unit field at all (CartEntryType, CartEntryKey, SummaryLines,
        // TransactionEntry, PlaceId, FacilityId, …). Then a bare numeric match, which
        // needs the unit number to appear literally somewhere in the response.
        //
        // The load response's `LockedShoppingCart` names the hold as
        // (placeId, facilityId, unitId, arrivalDate), and PlaceId/FacilityId ARE fields
        // the cart entry has. That is a fingerprint we can actually check.
        //
        // And it PRINTS what each entry says about itself either way. A check that
        // answers "no" without showing its working has now been wrong twice; showing
        // the entries costs four lines and ends the guessing.
        const locked = (() => {
          try { return (JSON.parse(result.loadedFull)?.Result ?? {}).LockedShoppingCart ?? null; }
          catch { return null; }
        })();
        const place = locked?.placeId ?? null;
        const facility = locked?.facilityId ?? null;
        if (place != null) log(`   looking for placeId=${place} facilityId=${facility} (from LockedShoppingCart)`);

        const readCart = async (cartKeyToRead) => {
          try {
            const r = await page.context().request.post(CART_LOAD, {
              headers: result.replay.headers,
              data: { shoppingCartKey: cartKeyToRead },
              timeout: 30_000,
            });
            const raw = await r.text();
            let count = 0, hit = false, keys = '', entries = [];
            try {
              const res = JSON.parse(raw)?.Result ?? {};
              const list = res.CartEntry?.$values ?? (Array.isArray(res.CartEntry) ? res.CartEntry : []);
              count = list.length;
              keys = list[0] ? Object.keys(list[0]).filter((k) => k !== '$type' && k !== '$id').join(',') : '';
              const textOf = (v, d = 0) => {
                const out = [];
                (function w(n, depth) {
                  if (!n || depth > 4) return;
                  if (typeof n === 'string' && n.trim()) out.push(n.trim());
                  else if (typeof n === 'object') for (const [k, x] of Object.entries(n)) { if (k !== '$type' && k !== '$id') w(x, depth + 1); }
                })(v, d);
                return out.join(' | ').slice(0, 200);
              };
              entries = list.map((e) => ({
                entryKey: e.CartEntryKey,
                type: e.CartEntryType,
                placeId: e.PlaceId,
                facilityId: e.FacilityId,
                summary: textOf(e.SummaryLines) || textOf(e.TransactionEntry),
              }));
              hit = list.some(
                (e) =>
                  (place != null && Number(e.PlaceId) === Number(place) &&
                   facility != null && Number(e.FacilityId) === Number(facility)) ||
                  JSON.stringify(e).includes(String(unitId)),
              );
            } catch { /* the full body goes to disk */ }
            return { status: r.status(), hit, count, keys, entries, raw };
          } catch (err) {
            return { status: 0, hit: false, count: 0, keys: '', entries: [], raw: `network error: ${err.message}` };
          }
        };

        // BOTH keys. The submit answered with a DIFFERENT ShoppingCartKey than the one
        // it was given, so "the cart" is ambiguous — reading only one of them is how a
        // held site gets reported as missing.
        const candidates = [...new Set([key, cartKey, result.usedKey].filter(Boolean))];
        let check = null;
        for (const k of candidates) {
          const c = await readCart(k);
          log(`   cart ${k} → HTTP ${c.status}, ${c.count} entr${c.count === 1 ? 'y' : 'ies'}, ours present: ${c.hit ? 'YES' : 'NO'}`);
          for (const e of c.entries) {
            log(`      · type=${e.type} placeId=${e.placeId} facilityId=${e.facilityId}${e.summary ? ` — ${e.summary}` : ''}`);
          }
          if (!check || c.hit) check = c;
          if (c.hit) {
            cartedKey = k;
            // The handle RC uses to release ONE entry — see remove/cartentry.
            cartedEntryKey = (c.entries.find((e) => Number(e.placeId) === Number(place)) ?? c.entries[0])?.entryKey ?? null;
            break;
          }
        }
        const cartDump = path.join(HERE, 'rc-cart-read.json');
        fs.writeFileSync(cartDump, check?.raw ?? '', { mode: 0o600 });
        log(`   full cart response saved → ${cartDump}`);
        if (check?.keys) log(`   entry fields: ${check.keys}`);

        // The verdict comes from the CART, not from the submit. "cart is already added"
        // is a rejected submit on top of a held site — the strongest possible evidence
        // that carting works, and the previous version called it "NOT carted".
        const already = /already added/i.test(result.submitted.v.error ?? '');
        if (check?.hit) {
          // cartedKey was set to the key that actually held it, in the loop above.
          cartedUnit = unitId;
          cartedPlace = place;
          cartedFacility = facility;
          cartedArrival = arrival;
          cartedNights = nights;
          log('   → BOT-SIDE CARTING WORKS, confirmed by reading the cart back.');
          if (already) {
            log('     (the submit was REJECTED with "cart is already added" — because a');
            log('      previous run already put this site in the cart. A rejected submit');
            log('      on top of a held site is proof, not failure.)');
          }
          log('     Open the cart page in this window to see it with your own eyes:');
          log(`     ${RC_CART_PAGE}`);
          log('     (the probe has written the key to localStorage, so the page will find it)');
          log('     To re-test from scratch, empty the cart first or pick another unit.');
        } else if (result.loaded.netError || result.submitted.netError) {
          log('   → NOT carted, and NOT because of our payload — the request never got a');
          log('     readable answer. Read the replayed status above before changing code:');
          log('     a 403 there means RC is blocking this machine, and no payload edit');
          log('     will fix that.');
        } else if (okSubmit) {
          log('   → RC ACCEPTED the submit but no cart we can read contains our site.');
          log('     Do NOT record this as a working cart — an accepted request and a held');
          log('     site are different claims, and this is the gap between them.');
          log('     BUT read the entries printed above first. This check has produced a');
          log('     false negative twice; if an entry names our placeId/facilityId, the');
          log('     cart is fine and the matcher is what is wrong.');
        } else {
          log('   → NOT carted. HTTP 200 with IsSuccess=false is still a failure.');
          log('     If ErrorMessage names a required field, it is our payload (fixable);');
          log('     a captcha or challenge would be RC actually defending.');
        }
      }
    }
  }

  // ── THE RELEASE / RECAPTURE PROBE (path B) ──────────────────────────────────────
  if (RELEASE) {
    if (!cartedKey) {
      log('\n--release needs a confirmed cart to release. Run with --cart and make sure');
      log('the read-back said YES — there is nothing to hand over otherwise.');
    } else {
      step(9, 'RELEASE PROBE — can the user\'s own session take the site the instant we drop it?');
      if (!HEADFUL) warnHeadless();
      const dirC = path.join(HERE, '.rc-probe-profile-c');
      fs.rmSync(dirC, { recursive: true, force: true });
      const ctxC = await chromium.launchPersistentContext(dirC, {
        headless: !HEADFUL,
        viewport: { width: 1280, height: 900 },
      });
      try {
        const pageC = ctxC.pages()[0] ?? (await ctxC.newPage());
        await pageC.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pageC.waitForTimeout(3000);
        // Log in BEFORE releasing. In production the user's device is already signed in
        // when they tap the alert; making them wait for a login here would measure our
        // test harness rather than the race.
        log('   signing in the "user" session (before the release, as in production)…');
        let okC = false;
        try { okC = await signIn(pageC); } catch (err) { log(`   login threw: ${err.message}`); }
        log(`   user session signed in: ${okC ? 'YES' : 'NO'}`);

        if (!okC) {
          await captureFailure(pageC, 'release-login');
          log('   → cannot measure the race without a second session. Retry with --headful.');
        } else {
          const headers = {
            'Content-Type': 'application/json',
            accesstoken: blob.find(([k]) => k === 'ssoAccessToken' || k === 'accessToken')?.[1],
            authorization: 'Bearer ' + blob.find(([k]) => k === 'ssoAccessToken' || k === 'accessToken')?.[1],
            installationsidentity: 'cali',
            storeid: '111',
          };

          // RELEASE. Prefer remove/cartentry — a real bot holds several sites and must
          // drop exactly one. Fall back to emptying if RC gave us no entry key.
          const t0 = Date.now();
          let releaseStatus = 0;
          if (cartedEntryKey) {
            const r = await page.context().request.post(CART_REMOVE_ENTRY, {
              headers, data: { shoppingCartKey: cartedKey, cartEntryKey: cartedEntryKey }, timeout: 30_000,
            });
            releaseStatus = r.status();
            log(`   released entry ${cartedEntryKey} → HTTP ${releaseStatus} (${Date.now() - t0}ms)`);
          } else {
            const r = await page.context().request.post(CART_EMPTY, {
              headers, data: { shoppingCartKey: cartedKey }, timeout: 30_000,
            });
            releaseStatus = r.status();
            log(`   no entry key — emptied the whole cart → HTTP ${releaseStatus} (${Date.now() - t0}ms)`);
          }

          // RECAPTURE, immediately, from the user's session.
          const grab = await precartInPage(pageC, {
            unitId: cartedUnit, arrival: cartedArrival, nights: cartedNights, cartKey: null,
          });
          const elapsed = Date.now() - t0;
          const ok = grab.submitted?.v?.isSuccess === true;
          log(`   user session re-cart → ${ok ? 'SUCCESS' : 'FAILED'} after ${elapsed}ms`);
          if (!ok) log(`     ${grab.submitted?.v?.error || `HTTP ${grab.submitted?.status}`}`);

          // VERIFY AGAINST THE CART, not the flag. `IsSuccess: true` has already lied
          // once in this chain, and a release probe that reports a capture it did not
          // make would send us to build path B on nothing.
          let verified = false;
          if (ok) {
            const newKey = grab.submitted.v.cartKey || grab.finalKey;
            try {
              const rr = await ctxC.request.post(CART_LOAD, {
                headers: grab.replay.headers, data: { shoppingCartKey: newKey }, timeout: 30_000,
              });
              const raw = await rr.text();
              fs.writeFileSync(path.join(HERE, 'rc-release-read.json'), raw, { mode: 0o600 });
              const res = JSON.parse(raw)?.Result ?? {};
              const list = res.CartEntry?.$values ?? [];
              verified = list.some((e) => Number(e.PlaceId) === Number(cartedPlace) && Number(e.FacilityId) === Number(cartedFacility));
              log(`   user's cart now → ${list.length} entr${list.length === 1 ? 'y' : 'ies'}, ours present: ${verified ? 'YES' : 'NO'}`);
            } catch (err) {
              log(`   (could not read the user's cart back: ${err.message})`);
            }
          }

          if (ok && verified) {
            log('\n   ★ PATH B WORKS, verified by reading the new cart back. The unit was');
            log(`     free the instant we let go, and the user's own session took it in`);
            log(`     ${elapsed}ms — that is the whole window in which someone else could`);
            log('     have grabbed it. No credential moved, and the bot needs ONE account');
            log('     rather than one per user.');
          } else if (ok) {
            log('\n   ~ RC accepted the re-cart but the site is not in the user\'s cart.');
            log('     Do not count this as working; read rc-release-read.json.');
          } else {
            log('\n   ✗ The user session could NOT take it straight after the release.');
            log('     Either RC holds a just-released unit for a cooldown — which kills');
            log('     path B — or this is our payload again. Read the error above: a');
            log('     named field is ours, a lock/availability message is RC\'s.');
          }
        }
      } finally {
        await ctxC.close();
      }
    }
  }

  // ── THE HAND-OFF TEST ───────────────────────────────────────────────────────────
  // A SECOND browser, a genuinely separate profile, logging into the SAME RC account,
  // asked to read the cart the first one just made. Nothing is copied between them
  // except the cart key — which is exactly the thing we want to know is sufficient.
  if (HANDOFF) {
    if (!cartedKey) {
      log('\n--handoff needs a confirmed cart to hand off. Run it with --cart, and');
      log('make sure the cart read-back said YES — there is nothing to test otherwise.');
    } else {
      step(8, 'HAND-OFF TEST — can a different session of the same account read this cart?');
      // Deleted, not reused: a leftover profile would still hold the FIRST session's
      // token and the test would "pass" by reading its own cart. That failure mode is
      // silent and would send us down the wrong architecture, so start from nothing.
      const dirB = path.join(HERE, '.rc-probe-profile-b');
      fs.rmSync(dirB, { recursive: true, force: true });
      log(`   fresh profile: ${dirB} (deleted first — a reused one would hold the FIRST`);
      log('   session\'s token and the test would pass by reading its own cart)');

      const ctxB = await chromium.launchPersistentContext(dirB, {
        headless: !HEADFUL,
        viewport: { width: 1280, height: 900 },
      });
      try {
        const pageB = ctxB.pages()[0] ?? (await ctxB.newPage());
        await pageB.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pageB.waitForTimeout(3000);
        log('   signing the second session in…');
        if (!HEADFUL) warnHeadless();
        // Contained. A flaky login in the SECOND session must not throw away the FIRST
        // session's result — that is exactly what happened on the first --handoff run:
        // the cart was confirmed, then the probe died before it could report anything
        // else. The hand-off is one question among several, not the whole run.
        let okB = false;
        try {
          okB = await signIn(pageB);
        } catch (err) {
          log(`   second session login threw: ${err.message}`);
        }
        log(`   second session signed in: ${okB ? 'YES' : 'NO'}`);
        if (!okB) {
          await captureFailure(pageB, 'handoff-login');
          log('   → cannot conclude anything: the second session never logged in.');
          log('     This is the flaky Okta email step, not a verdict — the SAME code');
          log('     signs in fine on the main profile. Re-run; the cart survives, and');
          log('     "cart is already added" on the next --cart is the proof it did.');
        } else {
          const tokenB = await pageB.evaluate(
            () => localStorage.getItem('ssoAccessToken') || localStorage.getItem('accessToken'),
          );
          const tokenA = blob.find(([k]) => k === 'ssoAccessToken' || k === 'accessToken')?.[1];
          log(`   tokens differ: ${tokenA !== tokenB ? 'YES (as they must)' : 'NO ← same token, test is void'}`);

          const r = await ctxB.request.post(CART_LOAD, {
            headers: {
              'Content-Type': 'application/json',
              accesstoken: tokenB,
              authorization: 'Bearer ' + tokenB,
              installationsidentity: 'cali',
              storeid: '111',
            },
            data: { shoppingCartKey: cartedKey },
            timeout: 30_000,
          });
          const raw = await r.text();
          fs.writeFileSync(path.join(HERE, 'rc-handoff-read.json'), raw, { mode: 0o600 });
          let hit = false, count = 0;
          try {
            const res = JSON.parse(raw)?.Result ?? {};
            const entries = res.CartEntry?.$values ?? (Array.isArray(res.CartEntry) ? res.CartEntry : []);
            count = entries.length;
            const seen = new Set();
            (function walk(n) {
              if (hit || !n || typeof n !== 'object' || seen.has(n)) return;
              seen.add(n);
              for (const [k, v] of Object.entries(n)) {
                if (k === '$type' || k === '$id') continue;
                if (Number(v) === cartedUnit) { hit = true; return; }
                walk(v);
              }
            })(entries);
          } catch { /* the full body is on disk */ }

          log(`   cart read by session B → HTTP ${r.status()}, ${count} entr${count === 1 ? 'y' : 'ies'}, unit ${cartedUnit} present: ${hit ? 'YES' : 'NO'}`);
          log(`   full response saved → ${path.join(HERE, 'rc-handoff-read.json')}`);
          if (hit) {
            log('\n   ★ THE KEY IS ENOUGH. A different session of the same account can read');
            log('     the cart. The alert can carry just the shoppingCartKey — no session');
            log('     blob ever has to move, and the user signs into RC themselves.');
            log('     Next: confirm the UI shows it (write the key to localStorage and');
            log('     open the cart page in THIS second browser).');
          } else {
            log('\n   ✗ THE KEY IS NOT ENOUGH. The cart is bound to the session that made');
            log('     it, not to the account. A bot-made cart cannot be claimed by the');
            log('     user\'s own login, so "bot holds, user checks out" needs either a');
            log('     full session transfer (live token — treat as a credential) or the');
            log('     bot completing checkout (spends money — a different product).');
          }
        }
      } finally {
        await ctxB.close();
      }
    }
  }

  if (signedIn && CART_CAP) {
    const units = String(process.env.RC_CAP_UNITS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const arrival = process.env.RC_ARRIVAL;
    const nights = Number(process.env.RC_NIGHTS ?? 1);
    if (units.length !== 3 || !arrival) {
      log('\nSkipping --cart-cap: set RC_CAP_UNITS=a,b,c and RC_ARRIVAL (see the header).');
    } else {
      step(6, 'Is the cap on the CART or on the ACCOUNT?');
      log('   This locks three real campsites for the length of the run and releases them');
      log('   again. Do not run it near a release, or with a hold queued.\n');

      // SAVE THE CART POINTER. `precartInPage` writes the winning key into localStorage on
      // every success, and this run makes several — so without this the profile is left
      // aimed at whichever probe cart happened to be last.
      //
      // This is `.rc-probe-profile`, NOT the hold runner's `.rc-bot-profile`, so nothing
      // here can repoint production. Restored anyway: the next `--cart` run reads it, and
      // a probe that quietly changes the state it measures is the shape of bug this file
      // has caught three times in other people's code.
      const savedKey = await page.evaluate(() => {
        try { return localStorage.getItem('shoppingCartKey'); } catch { return null; }
      });
      log(`   saved the probe profile's cart pointer: ${savedKey ? 'present' : '(none)'}`);

      /** Everything we lock, so the finally can let go of precisely that and nothing else. */
      const made = [];
      let headers = null;

      // ONE CART ATTEMPT, judged the way the runner judges it: never on `IsSuccess`, always
      // by reading the cart back. "cart is already added" is a REJECTED submit on top of a
      // site we already hold, so the flag and the truth disagree in both directions.
      const attempt = async (unitId, cartKey, label) => {
        const r = await precartInPage(page, { unitId: Number(unitId), arrival, nights, cartKey });
        headers ??= r?.replay?.headers ?? null;
        const key = r?.submitted?.v?.cartKey || r?.finalKey || (cartKey === NO_CART ? null : cartKey);
        const locked = (() => {
          try { return (JSON.parse(r.loadedFull)?.Result ?? {}).LockedShoppingCart ?? null; }
          catch { return null; }
        })();
        const found = key && r?.replay?.headers
          ? await findCartEntry(ctx.request, r.replay.headers, key, {
              placeId: locked?.placeId, facilityId: locked?.facilityId, unitId,
            })
          : { found: false, entryKey: null, count: 0 };
        const err = r?.submitted?.v?.error || (r?.submitted?.status ? `HTTP ${r.submitted.status}` : '');
        if (found.found) made.push({ unitId, cartKey: key, entryKey: found.entryKey });
        log(`   ${label}`);
        log(`     asked with ${cartKey === NO_CART ? 'a FRESH cart' : `cart ${String(cartKey).slice(0, 8)}…`}` +
            ` → in cart: ${found.found ? 'YES' : 'no'}, cart now holds ${found.count}` +
            `${key ? `, key ${String(key).slice(0, 8)}…` : ''}`);
        if (!found.found && err) log(`     RC said: ${String(err).replace(/<br\/?>/g, ' ').slice(0, 160)}`);
        return { ok: found.found, key, count: found.count, err };
      };

      /** RC's own wording for the cap, so a DIFFERENT refusal is never read as this one. */
      const isCapRefusal = (e) => /Maximum Reservations in Cart|maximum number of reservations/i.test(String(e || ''));

      try {
        const a = await attempt(units[0], NO_CART, `1. unit ${units[0]} → a fresh cart`);
        if (!a.ok) {
          log('\n   ✗ INCONCLUSIVE — the first cart failed, so nothing below was ever tested.');
          log('     That is a plain carting problem, not an answer about the cap. Check the');
          log('     unit is genuinely available on that date before reading anything into it.');
        } else {
          const b = await attempt(units[1], a.key, `2. unit ${units[1]} → the SAME cart`);
          const c1 = await attempt(units[2], a.key, `3. unit ${units[2]} → the same cart again (the control)`);

          if (!b.ok) {
            log('\n   ✗ INCONCLUSIVE — the second site never went in, so the cart never reached');
            log('     two and step 3 was not a test of the cap at all.');
          } else if (c1.ok) {
            log('\n   ! THE CAP DID NOT FIRE at three in one cart. Either it is not 2, or it is');
            log('     not applied here. Re-read the 08-13 hold that reported it before acting');
            log('     — this run did not reproduce the thing it exists to work around.');
          } else if (!isCapRefusal(c1.err)) {
            log('\n   ✗ INCONCLUSIVE — the third add was refused, but NOT with the cap message.');
            log('     Some other rejection (availability, a required extra) is not evidence');
            log('     about the cap, and counting it as such is how a wrong ceiling gets');
            log('     written down as measured.');
          } else {
            // THE QUESTION. The cap is live, the cart is full, and the only thing that
            // changes is which cart we ask for.
            const c2 = await attempt(units[2], NO_CART, `4. unit ${units[2]} → a FRESH cart (the question)`);
            log('');
            if (c2.ok && c2.key && c2.key !== a.key) {
              log('   ✓ THE CAP IS PER CART, AND ONE SESSION MAY HOLD MORE THAN ONE.');
              log(`     Two carts live at once on this account: ${String(a.key).slice(0, 8)}… and ${String(c2.key).slice(0, 8)}….`);
              log('     So the ceiling is ours, not RC\'s: the hold runner reuses one cart key');
              log('     and need not. Give each hold its own cart and the limit stops being 2.');
              log('     NOT yet proven: how many carts a session may hold. This showed two.');
            } else if (c2.ok && c2.key === a.key) {
              log('   ? RC PUT IT BACK IN THE SAME CART — asking for a fresh one did not make');
              log('     one. A second cart is not obtainable this way; treat the cap as binding');
              log('     until some other route to a second cart is found.');
            } else {
              log('   ✗ THE CAP IS NOT PER CART. A fresh cart was refused too, so the limit');
              log('     lives on the SESSION or the ACCOUNT and no amount of cart juggling');
              log('     lifts it. More concurrent holds then means more identities — which is');
              log('     a much more expensive answer, and now an evidenced one.');
              if (c2.err) log(`     RC said: ${String(c2.err).replace(/<br\/?>/g, ' ').slice(0, 160)}`);
            }
          }
        }
      } finally {
        // LET GO OF EXACTLY WHAT WE TOOK. Never empty/shoppingcart — the bot's own cart may
        // be holding a site somebody is on their way to claim, and emptying it would hand
        // that site to whoever else is watching.
        log('');
        for (const m of made) {
          try {
            const r = await releaseEntry(ctx.request, headers, m.cartKey, m.entryKey);
            log(`   released unit ${m.unitId} from ${String(m.cartKey).slice(0, 8)}… → HTTP ${r.status}`);
          } catch (err) {
            log(`   ✗ COULD NOT RELEASE unit ${m.unitId}: ${err.message}`);
            log(`     Remove it by hand — cart ${m.cartKey}, entry ${m.entryKey} — or it sits`);
            log('     locked until RC drops the cart (~15 min).');
          }
        }
        await page.evaluate((k) => {
          try { if (k) localStorage.setItem('shoppingCartKey', k); else localStorage.removeItem('shoppingCartKey'); }
          catch { /* the runner falls back to NO_CART, which is the safe direction */ }
        }, savedKey);
        log(`   restored the session's cart pointer${savedKey ? '' : ' (there was none)'}.`);
      }
    }
  }

  if (signedIn) {
    blob = await readBlob(page);
    const out = path.join(HERE, 'rc-blob.json');
    fs.writeFileSync(out, JSON.stringify(blob), { mode: 0o600 });
    step(7, `Session blob written to ${out} (${blob.length} keys, mode 600).`);
    log('   This is a LIVE login. Delete it when done; never put it in a link.');
    log('   To verify the hand-off: paste its contents on another machine as');
    log('     const d = <contents>; d.forEach(([k,v])=>localStorage.setItem(k,v)); location.reload();');
  }

  if (KEEP_OPEN) { log('\n--keep-open: leaving the browser up. Ctrl-C when done.'); await page.waitForTimeout(10 * 60_000); }
} catch (err) {
  console.error('\nProbe failed:', err.message);
  process.exitCode = 1;
} finally {
  if (!KEEP_OPEN) await ctx.close();
}
