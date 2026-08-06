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
const PRECART_LOAD =
  'https://rdapi.reservecalifornia.com/api/webaccessfacility/load/precartdataforbookingmodify';
const PRECART_SUBMIT =
  'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';
/** RC's own sentinel for "I have no cart yet" — its `emptyCart` falls back to exactly
 *  this when localStorage has no key. An EMPTY STRING is rejected by validation. */
const NO_CART = '00000000-0000-0000-0000-000000000000';
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
/** Releases ONE entry, leaving the rest of the cart alone — what a bot holding several
 *  sites needs. Both shapes read out of RC's bundle (2026-08-06). */
const CART_REMOVE_ENTRY = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/remove/cartentry';
const CART_EMPTY = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/empty/shoppingcart';

const EMAIL = process.env.RC_EMAIL;
const PASSWORD = process.env.RC_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set RC_EMAIL and RC_PASSWORD. See the header of this file.');
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

/**
 * Run RC's two-step precart in whatever session this page holds, and report everything.
 *
 * Extracted so the RELEASE probe can drive a SECOND session through the identical
 * request. A hand-off test where the two sessions cart differently proves nothing about
 * the hand-off.
 */
async function precartInPage(page, { unitId, arrival, nights, cartKey }) {
return page.evaluate(
  async ({ loadUrl, submitUrl, unitId, arrival, nights, cartKey, NO_CART }) => {
    const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const token = ls('ssoAccessToken') || ls('accessToken');
    let occupant = ls('customerName') || ls('ssoCustomerName') || '';
    if (!occupant) {
      try { const c = JSON.parse(ls('customerDetail') || '{}'); occupant = [c.FirstName, c.LastName].filter(Boolean).join(' '); } catch {}
    }
    const body = {
      arrivalDate: arrival, nights, confirmation_number: null, reservationId: 0,
      unitId, IsReservationDrawing: false, accessTypeId: 0, accountPassNumber: null,
      adults: 1, allowSpecialBenefits: false, children: 0, customerClassificationId: 1,
      discountPromoCode: null, dynamicOccupancyByNight: {}, extraValues: [],
      fdUsageClassificationId: 1, fdUsageClassificationName: 'Regular', isCheckIn: false,
      isDiscount: false, isModifyPreCart: false, isOrganization: false,
      occupantName: occupant, occupantPhoneNumber: null, optionalAuthorizedPerson: null,
      padLength: '0', preCartReservationComments: null, precartComments: null,
      prevSelectedClassification: null, promoCode: null, reservationVehicles: [],
      selectedClassification: null, shoppingCartKey: cartKey || NO_CART,
      sleepingUnit: null, timeDuration: null, unitPriceType: 1, vehicleCount: 0,
      vehicleLength: '0', vehiclePlates: null, vehicleTypeIds: null, vehicles: [],
    };
    const headers = {
      'Content-Type': 'application/json', accesstoken: token,
      authorization: 'Bearer ' + token, installationsidentity: 'cali', storeid: '111',
    };
    // NEVER let a network rejection throw out of here. A browser `fetch` that
    // rejects with "Failed to fetch" has NOT told us the request failed to
    // arrive — CORS forbids reading a response the browser did receive, so a WAF
    // 403 and an unreachable host are the same exception. Throwing killed the
    // whole probe and reported the one thing we can be sure isn't the answer.
    // Record it and let the Node-side replay (outside CORS) get the real status.
    const call = async (url) => {
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
        const raw = await res.text();
        return { status: res.status, ok: res.ok, raw };
      } catch (e) {
        return { status: 0, ok: false, raw: '', netError: String((e && e.message) || e) };
      }
    };
    // RC ANSWERS HTTP 200 WITH IsSuccess:false. Judging by status code reports a
    // failed cart as a success — the same "a 200 is not success" trap as
    // empty-grid-means-booked. Always read the payload.
    const verdict = (r) => {
      try {
        const j = JSON.parse(r.raw);
        const res = j?.Result ?? j;
        return { isSuccess: res?.IsSuccess === true, error: res?.ErrorMessage || '', cartKey: res?.ShoppingCartKey || '' };
      } catch { return { isSuccess: false, error: '(unparseable body)', cartKey: '' }; }
    };

    const loaded = await call(loadUrl);
    let loadRes = null;
    try { const j = JSON.parse(loaded.raw); loadRes = j?.Result ?? j; } catch {}
    // If `load` handed back a cart key, use it — that is how a fresh session is
    // supposed to acquire one.
    if (loadRes?.ShoppingCartKey) body.shoppingCartKey = loadRes.ShoppingCartKey;

    // THE EXTRAS — no longer guessed. RC's own web bundle was read
    // (assets/FacilityPreCart-*.js), and it settles both halves of the question:
    //
    //   xs = (s) => { ... a.UnitDetail.Extras.$values.forEach((n) => {
    //          if (n.IsWebViewable) { let r = {...n};
    //            r.value = r.ExtraType === ke.CheckBox
    //              ? (r.Value ? r.Value.toString() === "true"
    //                         : !!(r.DefaultValue?.toLowerCase() === "checked"))
    //              : (r.Value ? r.Value : r.DefaultValue);
    //            if (r.ExtraType === ke.Choice && !r.value) r.value = "-- None --";
    //   ... and on submit:
    //     l.extraValues.forEach(h => u.extraValues.push({
    //       extraId: h.ExtraId, extraValue: h.value }))
    //
    // TWO facts, and the first is why five rounds of guessing all failed:
    //  1. THE KEYS ARE lowerCamel — `extraId` / `extraValue`. Every earlier attempt
    //     sent `ExtraId` + `Value`, which the API ignores, so the answer never
    //     landed and the SAME "required field" error came back each time. The
    //     error was honest; our key names were wrong.
    //  2. ExtraType 0 = CheckBox (assets/extraTypes-*.js), and the tick handler is
    //     `u(e.ExtraId, checked ? "true" : "false")` — a checkbox answers with the
    //     STRING "true", not "Checked". DefaultValue "Unchecked" describes the
    //     starting state, not the wire value.
    // Source of truth: RC's shipped code, re-asserted by scripts/rc-cart-canary.mts.
    const extras = [];
    const paths = [];
    const seen = new Set();
    (function walk(node, at) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      const arr = Array.isArray(node) ? node : Array.isArray(node.$values) ? node.$values : null;
      if (arr) {
        for (const item of arr) {
          if (item && typeof item === 'object' && 'ExtraId' in item) {
            extras.push(item);
            paths.push(at);
          }
          walk(item, at);
        }
        return;
      }
      for (const [kk, vv] of Object.entries(node)) {
        if (kk === '$type' || kk === '$id') continue;
        walk(vv, at ? `${at}.${kk}` : kk);
      }
    })(loadRes, '');

    // RC's own value derivation, transcribed. Only IsWebViewable extras are sent,
    // and every one of them is — not just the required ones, because that is what
    // the UI does and a missing optional extra is a difference we'd rather not have.
    const CHECKBOX = 0, CHOICE = 4;
    const rcValue = (e) => {
      if (e.ExtraType === CHECKBOX) {
        // A REQUIRED checkbox must end up ticked or RC's own validator rejects it
        // (`IsWebRequired && !value` → "…is required"). An optional one keeps its
        // default. This is the human ticking the box, which is the only way the
        // real UI ever gets past this screen.
        if (e.IsWebRequired) return 'true';
        return String(e.Value ?? '').toString() === 'true' ||
          String(e.DefaultValue ?? '').toLowerCase() === 'checked' ? 'true' : 'false';
      }
      const v = e.Value ? e.Value : e.DefaultValue;
      if (e.ExtraType === CHOICE && !v) return '-- None --';
      return v ?? '';
    };
    const viewable = extras.filter((e) => e.IsWebViewable !== false);
    const needed = extras.filter((e) => e.IsWebRequired || e.Required || e.IsCRSRequired);

    const attempts = [];
    if (viewable.length) {
      body.extraValues = viewable.map((e) => ({ extraId: e.ExtraId, extraValue: rcValue(e) }));
    }
    let submitted = await call(submitUrl);
    attempts.push({
      shape: viewable.length
        ? `RC's own shape: ${JSON.stringify(body.extraValues).slice(0, 200)}`
        : 'extraValues: [] (no viewable extras declared)',
      v: verdict(submitted),
    });

    // ONE fallback, and only one: the initializer reads a checkbox's stored answer
    // as a real boolean, so a server that type-checks might want `true` rather than
    // "true". Trying both is cheap; trying twelve was the mistake.
    if (!verdict(submitted).isSuccess && viewable.length) {
      body.extraValues = viewable.map((e) => {
        const v = rcValue(e);
        return { extraId: e.ExtraId, extraValue: e.ExtraType === CHECKBOX ? v === 'true' : v };
      });
      const r = await call(submitUrl);
      attempts.push({ shape: 'same, checkbox as a real boolean', v: verdict(r) });
      if (verdict(r).isSuccess) submitted = r;
    }

    // ADOPT THE CART WE JUST MADE. The submit happens over HTTP and the page never
    // hears about it — `localStorage["shoppingCartKey"]` is still whatever it was
    // (empty, on a fresh session), so the RC cart page shows EMPTY and the run
    // looks like a failure it isn't. The app's sole source of truth is this one
    // value, so write it. Same session, so this is the adoption case that works.
    const newKey = verdict(submitted).cartKey;
    if (verdict(submitted).isSuccess && newKey) {
      try { localStorage.setItem('shoppingCartKey', newKey); } catch { /* ignore */ }
    }

    return {
      loaded: { status: loaded.status, ok: loaded.ok, raw: loaded.raw.slice(0, 600), v: verdict(loaded), netError: loaded.netError },
      submitted: { status: submitted.status, ok: submitted.ok, raw: submitted.raw.slice(0, 1200), v: verdict(submitted), netError: submitted.netError },
      loadedFull: loaded.raw,
      // Handed back so Node can replay the EXACT request outside the browser's
      // CORS rules when the in-page fetch is rejected without a status.
      replay: { headers, body },
      usedKey: body.shoppingCartKey,
      finalKey: ls('shoppingCartKey'),
      attempts,
      // Every extra definition we found and where it lived, so a failed run still
      // teaches us the shape rather than only that four guesses missed.
      extrasFound: extras.map((e, i) => ({
        at: paths[i],
        ExtraId: e.ExtraId,
        Name: String(e.Name ?? '').slice(0, 90),
        DefaultValue: e.DefaultValue,
        ExtraType: e.ExtraType,
        required: Boolean(e.IsWebRequired || e.Required || e.IsCRSRequired),
        keys: Object.keys(e).filter((k) => k !== '$type' && k !== '$id').join(','),
      })),
      neededCount: needed.length,
      // Diagnostics for the "required field" hunt.
      occupantName: occupant,
      occupantKeys: ['customerName', 'ssoCustomerName', 'customerDetail'].map((k) => `${k}=${ls(k) ? 'set' : 'EMPTY'}`).join(' '),
    };
  },
  { loadUrl: PRECART_LOAD, submitUrl: PRECART_SUBMIT, unitId, arrival, nights, cartKey, NO_CART }
);
}

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
