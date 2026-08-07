/**
 * RC day-before holds — the bot half.
 *
 * CampHawk tells a subscriber the night before that a site releases at 8am. If they tap
 * "hold it for me", this carts that exact unit at that exact minute and hands it over.
 *
 * Two jobs, one pass, both from `GET /api/auto-cart/rc-holds`:
 *   cart[]    holds that were REQUESTED and are due now
 *   release[] holds we carted that nobody claimed — the bot must LET GO
 *
 * The release half is not housekeeping. Sitting on a site the user never came for takes
 * it off the market for every other camper, which is the exact behaviour the opt-in
 * design exists to avoid. It is as much the job as the carting is.
 *
 * RUN IT ON THE MINI-PC, next to rc-keepwarm.mjs:
 *   AUTOCART_TOKEN=... node rc-hold-runner.mjs
 *   AUTOCART_TOKEN=... node rc-hold-runner.mjs --once   # one pass, for a smoke test
 *
 * IT DOES NOT LOG IN. It drives the profile rc-keepwarm.mjs keeps alive, and if that
 * session is dead it says so and skips. RC now serves a reCAPTCHA on sign-in, so an
 * automatic login is not available — and attempting one is what we believe provoked the
 * challenge in the first place.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { precartInPage, findCartEntry, releaseEntry, NO_CART } from './rc-cart.mjs';
import {
  waitForProfileLock, releaseProfileLockIfMine, renewProfileLock, profileLockHolder,
} from './profile-lock.mjs';
import { loadEnv } from './load-env.mjs';

// The token lives in scripts/auto-cart-bot/.env alongside the rec.gov bot's. Without
// this the runner answered `feed 401` — which reads exactly like a wrong token, not a
// config file nobody opened — and start-all.bat, which passes no environment of its own,
// would have failed that way on every boot.
loadEnv(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC_HOME = 'https://www.reservecalifornia.com/';
const PROFILE_DIR = path.resolve(HERE, process.env.RC_PROFILE_DIR || '.rc-bot-profile');

const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const TOKEN = process.env.AUTOCART_TOKEN;
/**
 * How often to ask for work. RC releases on the minute and the feed already looks 90s
 * ahead, so a 20s poll means we are always inside the window with time to open a
 * browser. Tighter would just add requests from an address that has been 403'd once.
 */
const POLL_MS = Number(process.env.RC_HOLD_POLL_MS || 20_000);
/** Overridden by the feed's `pollMs` while a claim is outstanding. */
let nextPollMs = POLL_MS;
const HEADLESS = process.env.RC_HEADLESS === 'true';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error('Set AUTOCART_TOKEN (the same master token the rec.gov bot uses).');
  process.exit(2);
}
if (!fs.existsSync(PROFILE_DIR)) {
  console.error(`No RC profile at ${PROFILE_DIR}. Run: node rc-keepwarm.mjs --login`);
  process.exit(2);
}

async function feed() {
  const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  return res.json();
}

async function report(body) {
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => log(`  report failed for ${body.id}: ${e.message}`));
}

/** RC's rdApi wants the token in BOTH headers, plus two constants. */
const rcHeaders = (token) => ({
  'Content-Type': 'application/json',
  accesstoken: token,
  authorization: 'Bearer ' + token,
  installationsidentity: 'cali',
  storeid: '111',
});

const LOCK_OWNER = 'rc-hold-runner';
const RENEW_MS = 2 * 60_000;
/** Generous, because we are the process that must win. `rc-keepwarm` holds the profile
 *  for ~15s a pass and yields quickly; waiting that out beats colliding. */
const LOCK_WAIT_MS = Number(process.env.RC_PROFILE_LOCK_WAIT_MS || 60_000);

/**
 * `rc-keepwarm.mjs` opens the SAME profile directory every 20 minutes, and two Chromium
 * instances on one user-data-dir do not fail cleanly — they end up disagreeing about what
 * is in the profile (observed on the rec.gov bot, 2026-07-29; see profile-lock.mjs). On
 * this profile that means the session, which is the one thing here we cannot rebuild
 * without a human.
 *
 * If the lock never comes free we do NOT proceed anyway. Nothing is lost by skipping:
 * requested holds stay requested, the feed's 20-minute grace window still returns them,
 * and a claim is retried on the next pass a second later.
 */
async function withRC(fn) {
  if (!(await waitForProfileLock(PROFILE_DIR, LOCK_OWNER, LOCK_WAIT_MS))) {
    const held = profileLockHolder(PROFILE_DIR);
    log(`⚠ profile held by ${held?.owner ?? 'another process'} — skipping this pass, work stays queued`);
    return null;
  }
  const renew = setInterval(() => renewProfileLock(PROFILE_DIR, LOCK_OWNER), RENEW_MS);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  }).catch((err) => {
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
    throw err;
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);
    const token = await page.evaluate(() => {
      try { return localStorage.getItem('ssoAccessToken') || localStorage.getItem('accessToken'); }
      catch { return null; }
    });
    if (!token) {
      log('⚠ RC session is dead — a human must run `node rc-keepwarm.mjs --login`.');
      log('  Skipping this pass. Nothing is lost: holds stay requested and retry.');
      return null;
    }
    return await fn(ctx, page, token);
  } finally {
    await ctx.close().catch(() => {});
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
  }
}

async function runPass() {
  let work;
  try {
    work = await feed();
  } catch (err) {
    log(`feed error: ${err.message}`);
    return;
  }
  const { claim = [], cart = [], release = [], expired = 0, pollMs } = work;
  // The server sets pollMs while anything is claimable. Somebody is watching a spinner
  // and the site is about to sit unheld — the exposure window is our poll interval plus
  // the release, so this is the one time to come back fast.
  nextPollMs = pollMs || POLL_MS;
  if (expired) log(`(${expired} unanswered offer(s) expired)`);
  if (!claim.length && !cart.length && !release.length) return;

  log(`${claim.length} to hand over, ${cart.length} to cart, ${release.length} to release`);

  await withRC(async (ctx, page, token) => {
    const headers = rcHeaders(token);

    // CLAIMS FIRST, ahead of everything. A user is on the claim page right now and
    // cannot take the site until we let go; every millisecond here is theirs, not ours.
    for (const h of claim) {
      if (!h.cartKey || !h.cartEntryKey) {
        log(`  ${h.unitName ?? h.unitId}: claim with no entry key — reporting released so the user is not stuck`);
        await report({ id: h.id, released: true, forClaim: true });
        continue;
      }
      const r = await releaseEntry(ctx.request, headers, h.cartKey, h.cartEntryKey);
      log(`  → handed over ${h.unitName ?? h.unitId} (HTTP ${r.status})`);
      // Report even on a non-2xx: if we cannot release, the user must not be left
      // watching a spinner over a site they will never get. Better they find it free
      // (or not) on RC than wait on us forever.
      await report({ id: h.id, released: true, forClaim: true });
    }

    // Then release the ones nobody came for. If the browser dies mid-pass, the thing we
    // most want already done is letting go — a hold we keep by accident is worse than a
    // cart we miss, because it denies the site to everyone including the person who
    // asked for it.
    for (const h of release) {
      if (!h.cartKey || !h.cartEntryKey) {
        log(`  ${h.unitName ?? h.unitId}: no cart/entry key recorded — cannot release precisely, leaving it`);
        continue;
      }
      const r = await releaseEntry(ctx.request, headers, h.cartKey, h.cartEntryKey);
      log(`  released ${h.unitName ?? h.unitId} → HTTP ${r.status}`);
      if (r.ok) await report({ id: h.id, released: true });
    }

    for (const h of cart) {
      try {
        const existing = await page.evaluate(() => {
          try { return localStorage.getItem('shoppingCartKey'); } catch { return null; }
        });
        const result = await precartInPage(page, {
          unitId: Number(h.unitId),
          arrival: h.arrivalDate,
          nights: Number(h.nights) || 1,
          cartKey: existing || NO_CART,
        });

        // RC ANSWERS 200 WITH IsSuccess:false, and "cart is already added" is a REJECTED
        // submit on top of a site we already hold — proof, not failure. So the verdict
        // comes from reading the cart back, never from the flag.
        const cartKey = result?.submitted?.v?.cartKey || result?.finalKey || existing;
        const locked = (() => {
          try { return (JSON.parse(result.loadedFull)?.Result ?? {}).LockedShoppingCart ?? null; }
          catch { return null; }
        })();
        const check = cartKey
          ? await findCartEntry(ctx.request, headers, cartKey, {
              placeId: locked?.placeId, facilityId: locked?.facilityId, unitId: h.unitId,
            })
          : { found: false, entryKey: null };

        if (check.found) {
          log(`  ✓ held ${h.unitName ?? h.unitId} (${h.arrivalDate}) — entry ${check.entryKey}`);
          await report({ id: h.id, ok: true, cartKey, cartEntryKey: check.entryKey });
        } else {
          const why = result?.submitted?.v?.error || `HTTP ${result?.submitted?.status}`;
          log(`  ✗ could not hold ${h.unitName ?? h.unitId}: ${why}`);
          await report({ id: h.id, ok: false, error: String(why).slice(0, 300) });
        }
      } catch (err) {
        log(`  ✗ ${h.unitName ?? h.unitId} threw: ${err.message}`);
        await report({ id: h.id, ok: false, error: err.message.slice(0, 300) });
      }
    }
  });
}

log(`RC hold runner → ${CAMPHAWK_URL}, every ${POLL_MS / 1000}s, profile ${PROFILE_DIR}`);
log('It never logs in; rc-keepwarm.mjs owns the session. Ctrl-C to stop.');

if (ONCE) {
  await runPass();
  process.exit(0);
}
for (;;) {
  await runPass().catch((err) => log(`pass error: ${err.message}`));
  await sleep(nextPollMs);
}
