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
const PRECART_ENDPOINT =
  'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';

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

    const user = page.locator('input[name="username"], input[type="email"], #okta-signin-username').first();
    const pass = page.locator('input[name="password"], input[type="password"], #okta-signin-password').first();
    if (!(await user.count())) {
      const d = await diagnose(page);
      log('   Could not find a username field. Page says:', d.snippet);
      throw new Error('login form not found — run with --headful to see the page');
    }
    await user.fill(EMAIL);
    if (await pass.count()) await pass.fill(PASSWORD);
    else {
      // Okta identifier-first: submit the email, then the password appears.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3500);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
    }
    await page.keyboard.press('Enter');
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
      step(4, `Carting unit ${unitId} on ${arrival} for ${nights} night(s)…`);
      // Fire the same request the site fires, from inside the page so it carries the
      // session automatically. Mirrors extension/content-rc.js buildPayload().
      const result = await page.evaluate(
        async ({ endpoint, unitId, arrival, nights }) => {
          const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
          const token = ls('ssoAccessToken') || ls('accessToken');
          const cartKey = ls('shoppingCartKey') || '';
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
            selectedClassification: null, shoppingCartKey: cartKey, sleepingUnit: null,
            timeDuration: null, unitPriceType: 1, vehicleCount: 0, vehicleLength: '0',
            vehiclePlates: null, vehicleTypeIds: null, vehicles: [],
          };
          const res = await fetch(endpoint, {
            method: 'POST', credentials: 'include',
            headers: {
              'Content-Type': 'application/json', accesstoken: token,
              authorization: 'Bearer ' + token, installationsidentity: 'cali', storeid: '111',
            },
            body: JSON.stringify(body),
          });
          const raw = await res.text();
          return { status: res.status, ok: res.ok, raw: raw.slice(0, 400) };
        },
        { endpoint: PRECART_ENDPOINT, unitId, arrival, nights }
      );
      log(`   HTTP ${result.status} ${result.ok ? 'OK' : 'FAILED'}`);
      log(`   ${result.raw}`);
      if (result.ok) log('   → Bot-side carting WORKS. This is the whole feature.');
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
