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

const args = new Set(process.argv.slice(2));
const HEADFUL = args.has('--headful');
const DO_CART = args.has('--cart');
const KEEP_OPEN = args.has('--keep-open');

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
      snippet: text.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
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
      const next = await findIn(page, SUBMIT_SELECTORS, { timeout: 5000, label: 'the Next button' });
      if (next) await next.loc.click().catch(() => {});
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      pass = await findIn(page, PASSWORD_SELECTORS, { label: 'the password field' });
    }
    if (!pass) {
      const d = await diagnose(page);
      log('   No password field appeared. Page says:', d.snippet);
      if (d.mfa) log('   → looks like Okta went straight to an MFA challenge.');
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
          const call = async (url) => {
            const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
            const raw = await res.text();
            return { status: res.status, ok: res.ok, raw };
          };
          const loaded = await call(loadUrl);
          // If `load` handed back a cart key, use it for the submit — that is how a
          // fresh session is supposed to acquire one.
          try {
            const j = JSON.parse(loaded.raw);
            const k = j?.Result?.ShoppingCartKey || j?.ShoppingCartKey;
            if (k) body.shoppingCartKey = k;
          } catch {}
          const submitted = await call(submitUrl);
          return {
            loaded: { status: loaded.status, ok: loaded.ok, raw: loaded.raw.slice(0, 600) },
            submitted: { status: submitted.status, ok: submitted.ok, raw: submitted.raw.slice(0, 1200) },
            usedKey: body.shoppingCartKey,
            finalKey: ls('shoppingCartKey'),
          };
        },
        { loadUrl: PRECART_LOAD, submitUrl: PRECART_SUBMIT, unitId, arrival, nights, cartKey, NO_CART }
      );

      log(`   load   → HTTP ${result.loaded.status} ${result.loaded.ok ? 'OK' : 'FAILED'}`);
      if (!result.loaded.ok) log(`     ${result.loaded.raw}`);
      log(`   submit → HTTP ${result.submitted.status} ${result.submitted.ok ? 'OK' : 'FAILED'}  (key ${result.usedKey})`);
      log(`     ${result.submitted.raw}`);
      if (result.submitted.ok) {
        log('   → BOT-SIDE CARTING WORKS. That is the whole feature.');
        log('     Open the cart page in this browser to see it, and note the cart key');
        log(`     now in localStorage: ${result.finalKey}`);
      } else {
        log('   → Still failing. Read the body above: a validation error names the bad');
        log('     field (our payload); a captcha/challenge would name that instead.');
      }
    }
  }

  if (signedIn) {
    blob = await readBlob(page);
    const out = path.join(HERE, 'rc-blob.json');
    fs.writeFileSync(out, JSON.stringify(blob), { mode: 0o600 });
    step(5, `Session blob written to ${out} (${blob.length} keys, mode 600).`);
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
