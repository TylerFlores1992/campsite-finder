/**
 * ReserveCalifornia bot probe — answers the LAST open question before RC auto-cart
 * can be built: can the bot log into RC and cart WITHOUT a human, or do Okta MFA /
 * reCAPTCHA stop it?
 *
 * Everything else is already proven (2026-08-05, see docs/CONTEXT.md):
 *   • the whole RC session lives in localStorage — token, identity, cart key;
 *   • copying that blob into a fresh browser makes it logged in AND carted;
 *   • it works CROSS-MACHINE and cross-IP (PC → mini-PC, incognito, never logged in).
 * So the hand-off works. What is NOT proven is the bot end: an unattended login.
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
  } catch (err) {
    log(`   (could not capture the failure state: ${err.message})`);
  }
}

const ctx = await chromium.launchPersistentContext(path.join(HERE, '.rc-probe-profile'), {
  headless: !HEADFUL,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  step(1, 'Loading ReserveCalifornia…');
  await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Already signed in from a previous probe run? The persistent profile keeps it.
  let blob = await readBlob(page);
  let signedIn = blob.some(([k]) => k === 'ssoAccessToken' || k === 'accessToken');

  if (signedIn) {
    step(2, 'Already signed in (persistent profile) — skipping login.');
  } else {
    step(2, 'Signing in…');
    // A run that previously said "Already signed in" and now doesn't means the session
    // was DROPPED, not that it never existed. That distinction matters: an expiring
    // session is the design working (log in once, ride it), while a revoked one is RC
    // pushing back on this machine. The profile dir is the evidence either way.
    if (fs.existsSync(path.join(HERE, '.rc-probe-profile'))) {
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

    const user = await findIn(page, EMAIL_SELECTORS, { label: 'the email field' });
    if (!user) {
      const d = await diagnose(page);
      log('   Page says:', d.snippet);
      if (d.error) log(`   Okta error banner: "${d.error}"`);
      await captureFailure(page, 'login-no-form');
      throw new Error('login form not found — rerun with --headful and watch the page');
    }
    log(`   email field: ${user.sel}`);
    await user.loc.fill(EMAIL);
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
      for (let attempt = 1; attempt <= 2 && !pass; attempt++) {
        const next = await findIn(page, SUBMIT_SELECTORS, { timeout: 5000, label: 'the Next button' });
        if (next) {
          log(`   submitting the email (attempt ${attempt}, ${next.sel})`);
          try {
            await next.loc.click({ timeout: 5000 });
          } catch (err) {
            log(`   ⚠ the Next click FAILED: ${err.message.split('\n')[0]}`);
          }
        } else {
          log(`   no Next button found (attempt ${attempt}) — pressing Enter in the field`);
          await user.loc.press('Enter').catch(() => {});
        }
        pass = await findIn(page, PASSWORD_SELECTORS, { timeout: 8000, label: 'the password field' });
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

    blob = await readBlob(page);
    signedIn = blob.some(([k]) => k === 'ssoAccessToken' || k === 'accessToken');
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
      const result = await page.evaluate(
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
      if (okSubmit) {
        const key = result.submitted.v.cartKey || result.finalKey;
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
        const check = await (async () => {
          try {
            const r = await page.context().request.post(CART_LOAD, {
              headers: result.replay.headers,
              data: { shoppingCartKey: key },
              timeout: 30_000,
            });
            const raw = await r.text();
            // A cart entry names its unit; find one matching what we asked for, anywhere
            // in the response, rather than assuming a shape we haven't pinned down.
            let hit = false, count = 0;
            try {
              const seen = new Set();
              (function walk(n) {
                if (!n || typeof n !== 'object' || seen.has(n)) return;
                seen.add(n);
                const arr = Array.isArray(n) ? n : Array.isArray(n.$values) ? n.$values : null;
                if (arr) { for (const it of arr) walk(it); return; }
                if ('unitId' in n || 'UnitId' in n) {
                  count++;
                  if (Number(n.unitId ?? n.UnitId) === unitId) hit = true;
                }
                for (const [k, v] of Object.entries(n)) { if (k !== '$type' && k !== '$id') walk(v); }
              })(JSON.parse(raw));
            } catch { /* fall through — raw is reported */ }
            return { status: r.status(), hit, count, raw: raw.slice(0, 400).replace(/\s+/g, ' ') };
          } catch (err) {
            return { status: 0, hit: false, count: 0, raw: `network error: ${err.message}` };
          }
        })();
        log(`   cart read → HTTP ${check.status}, ${check.count} entr${check.count === 1 ? 'y' : 'ies'}, unit ${unitId} present: ${check.hit ? 'YES' : 'NO'}`);
        if (check.hit) {
          log('   → BOT-SIDE CARTING WORKS, confirmed by reading the cart back.');
          log('     Open the cart page in this window to see it with your own eyes:');
          log(`     ${RC_CART_PAGE}`);
          log('     (the probe has written the key to localStorage, so the page will find it)');
        } else {
          log('   → RC ACCEPTED the submit but the cart does not contain that unit.');
          log(`     Raw: ${check.raw}`);
          log('     Do NOT record this as a working cart — an accepted request and a held');
          log('     site are different claims, and this is the gap between them.');
        }
      } else if (result.loaded.netError || result.submitted.netError) {
        log('   → NOT carted, and NOT because of our payload — the request never got a');
        log('     readable answer. Read the replayed status above before changing code:');
        log('     a 403 there means RC is blocking this machine, and no payload edit');
        log('     will fix that.');
      } else {
        log('   → NOT carted. HTTP 200 with IsSuccess=false is still a failure.');
        log('     If ErrorMessage names a required field, it is our payload (fixable);');
        log('     a captcha or challenge would be RC actually defending.');
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
