/**
 * ReserveCalifornia session keep-warm — the FOUNDATION of RC auto-cart, not a tune-up.
 *
 * WHY THIS HAS TO EXIST. On 2026-08-07 RC's Okta sign-in started serving a reCAPTCHA
 * image challenge to the bot's browser. Earlier the same day an unattended login worked
 * with no MFA and no CAPTCHA, so this is an escalation — most plausibly from repeated
 * fresh-profile logins during testing. The consequence is blunt: **the bot can no longer
 * log itself in.** Everything downstream (hold the site, release on demand, the user's
 * own session recaptures it) assumes an authenticated bot, so without this there is no
 * RC auto-cart at all.
 *
 * The design that survives it is the one the rec.gov bot already runs: a HUMAN signs in
 * ONCE with "Keep me signed in", and the session is never allowed to lapse. A bot that
 * can re-login on demand is off the table. A bot that never needs to is not.
 *
 * WHAT IT DOES. Every KEEPALIVE_MS it opens the persistent profile, loads RC, and checks
 * the session is still real. Loading the app is *meant* to be what makes this work rather
 * than merely observe: the theory is that RC's own JS silently renews the Okta token, so a
 * page load inside the token's lifetime is the renewal, where polling an API with the
 * token would prove liveness while doing nothing to extend it.
 *
 * **THAT THEORY IS UNDER INVESTIGATION AND MAY BE WRONG (2026-08-08).** It was written as
 * fact and never measured. The first real measurement — sign-in to death, from
 * `session_since`/`session_live_since` — came back **1h20m**, with this loop running the
 * whole time and "Keep me signed in" confirmed ticked. That is about one Okta access
 * token, i.e. exactly what a session that is NEVER renewed looks like. Earlier "8-9 hour"
 * figures were not measurements; nobody looked in between, so they bounded when we
 * NOTICED, not when it died.
 *
 * `tokenExpiry` below now records the token's `exp` and whether it CHANGED on each pass,
 * and reports both to camphawk.app. If `exp` marches forward, the theory holds and the
 * deaths have another cause. If it stays put and the session dies when it lapses, no
 * cadence of page loads can save this and the 8am flow needs a different shape — most
 * likely a sign-in shortly before the release rather than a permanent session.
 *
 * RUN IT ON THE MINI-PC, alongside the rec.gov bot:
 *   node rc-keepwarm.mjs                 # RESIDENT: holds RC open, yields to the runner
 *   node rc-keepwarm.mjs --once          # single pass, for a cron or a smoke test
 *   node rc-keepwarm.mjs --login         # headful, for the ONE human sign-in
 *
 * IT NEVER TYPES A PASSWORD. Deliberate: the only way in is `--login`, with a human at
 * the keyboard. That removes the pattern (repeated automated logins from one address)
 * that we believe provoked the challenge in the first place, and it means this file
 * needs no credentials at all — nothing to store, nothing to leak.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForProfileLock, releaseProfileLockIfMine, renewProfileLock, profileLockHolder,
  profileRequested,
} from './profile-lock.mjs';
import { loadEnv } from './load-env.mjs';
import { exitWhenDrained } from './exit-clean.mjs';

// No secrets here, but RC_PROFILE_DIR / RC_KEEPALIVE_MS / RC_HEADLESS are read the same
// way as everywhere else. A process that silently ignores the config file is the bug
// this file's sibling just shipped.
loadEnv(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC_HOME = 'https://www.reservecalifornia.com/';

/** ONE profile, reused forever. Never delete it — deleting it is what forces a login,
 *  and a login is the thing we can no longer do unattended. */
const PROFILE_DIR = path.resolve(HERE, process.env.RC_PROFILE_DIR || '.rc-bot-profile');
const WARM_MARKER = path.join(PROFILE_DIR, '.camphawk-rc-warmed');

/**
 * How often to refresh. 20 minutes against an Okta access token that lives ~1h.
 *
 * The rec.gov keepalive learned this the expensive way — 4h, then 90m, then 30m, each
 * step because the real idle TTL turned out shorter than the gap, and each gap cost a
 * silently dead session that still read as connected. Start tighter here rather than
 * repeat that walk: a wasted page load costs nothing, a lapsed session costs a human
 * sign-in that may now face a CAPTCHA.
 */
const KEEPALIVE_MS = Number(process.env.RC_KEEPALIVE_MS || 20 * 60 * 1000);

/** Headful by default. RC/Okta fingerprints headless Chromium — the same rule the
 *  rec.gov bot follows, and the reason its cart path is headed too. */
const HEADLESS = process.env.RC_HEADLESS === 'true';

/**
 * Where to report the session verdict, and the same master token the sibling processes
 * already use. STILL NO RC CREDENTIALS — the header above says this file needs none and
 * that remains true; `AUTOCART_TOKEN` authorises talking to camphawk.app, not to RC.
 *
 * Optional on purpose. A missing token must not stop the keep-warm, which is the job that
 * actually matters — but it is announced at startup, because a health report nobody
 * receives is worse than none: it looks like the box is fine.
 */
const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const TOKEN = process.env.AUTOCART_TOKEN;

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const LOGIN = args.has('--login');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The session IS these localStorage keys — see docs/CONTEXT.md. A token that exists
 *  is necessary but not sufficient; `load/enterprise` answering 200 is the proof. */
async function readToken(page) {
  return page.evaluate(() => {
    try {
      return localStorage.getItem('ssoAccessToken') || localStorage.getItem('accessToken');
    } catch {
      return null;
    }
  });
}

/**
 * When does this token expire, and is it being renewed?
 *
 * THE PREMISE OF THIS WHOLE FILE IS UNPROVEN. The header says "RC's own JS silently renews
 * the Okta token, so a page load inside the token's lifetime is the renewal." That was
 * never measured — and on 2026-08-08 the first real measurement came back **1h20m** from a
 * fresh human sign-in to a dead session, with this loop running every 20 minutes
 * throughout and "Keep me signed in" confirmed ticked. 1h20m is about one Okta access
 * token, which is what you would see if the renewal simply is not happening.
 *
 * (The earlier "8-9 hours" figures were not measurements. Nobody looked in between, so
 * they were upper bounds on when we NOTICED, which is a different quantity. That is
 * exactly why `session_since` exists.)
 *
 * So stop asserting and start recording. If `exp` marches forward across passes the
 * renewal is real and the death has another cause; if it stays put and the session dies
 * when it lapses, the design premise is false and no cadence of page loads can save it —
 * the 8am flow needs a different shape. Two or three passes answer it either way.
 *
 * Best-effort by construction: not every token is a JWT, and a token we cannot decode
 * must never be treated as a token that has expired.
 */
function tokenExpiry(token) {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Is the session actually usable — not merely present?
 *
 * Asks RC a question only an authenticated session can answer. A stale token still sits
 * in localStorage long after it stops working, so "the key is there" reports a dead
 * session as healthy. That exact mistake (status vs. reality) has cost this project a
 * day more than once: a Twilio 2xx that was never delivered, an IsSuccess:true on a cart
 * that held nothing.
 */
async function sessionLive(ctx, page) {
  const token = await readToken(page);
  if (!token) return { live: false, why: 'no token in localStorage' };
  try {
    const r = await ctx.request.post(
      'https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart',
      {
        headers: {
          'Content-Type': 'application/json',
          accesstoken: token,
          authorization: 'Bearer ' + token,
          installationsidentity: 'cali',
          storeid: '111',
        },
        data: { shoppingCartKey: '00000000-0000-0000-0000-000000000000' },
        timeout: 20_000,
      },
    );
    // 401 is the unambiguous "this token is dead". Anything 2xx means RC accepted it.
    // A 403 is RC's edge refusing us (it did that for ~12h on 2026-08-06) and says
    // nothing about the session — do not destroy a good session over it.
    if (r.status() === 401) return { live: false, why: 'RC rejected the token (401)' };
    if (r.status() === 403) return { live: null, why: 'RC edge returned 403 — inconclusive, leaving the session alone' };
    return { live: r.ok(), why: `load/shoppingcart → HTTP ${r.status()}` };
  } catch (err) {
    return { live: null, why: `network error: ${err.message} — inconclusive` };
  }
}

/**
 * Returned instead of a result when another process holds the profile.
 *
 * A distinct value, not `false` and not a throw, because the ONE thing that must never
 * happen is a busy profile being read as a dead session — that would tell the owner to
 * go and do a human sign-in over a session that is perfectly healthy.
 */
export const BUSY = Symbol('rc-profile-busy');

const LOCK_OWNER = 'rc-keepwarm';
/** Comfortably inside STALE_MS, so a long sign-in never reads as abandoned. */
const RENEW_MS = 2 * 60_000;

/**
 * `rc-hold-runner.mjs` drives the SAME profile directory, and two Chromium instances on
 * one user-data-dir do not fail cleanly — they disagree about what is in the profile
 * (observed on the rec.gov bot, 2026-07-29, see profile-lock.mjs).
 *
 * The keep-warm yields, and the runner waits. That is the right way round: the runner is
 * carting at an exact minute or handing a site to someone watching a spinner, while a
 * skipped keep-warm pass costs nothing — the token lives ~1h and there is another pass in
 * 20 minutes. The runner also loads RC itself, so a pass we skip because it is working is
 * a pass it renewed the token for us.
 */
async function withProfile(fn, { headless = HEADLESS, waitMs = 15_000 } = {}) {
  if (!(await waitForProfileLock(PROFILE_DIR, LOCK_OWNER, waitMs))) {
    return BUSY;
  }
  const renew = setInterval(() => renewProfileLock(PROFILE_DIR, LOCK_OWNER), RENEW_MS);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: null,
    // navigator.webdriver is set by --enable-automation and reCAPTCHA reads it. The
    // rec.gov bot strips it for exactly this reason; RC gates on the same signal.
    ignoreDefaultArgs: ['--enable-automation'],
  }).catch((err) => {
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
    throw err;
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(ctx, page);
  } finally {
    await ctx.close().catch(() => {});
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
  }
}

/** One refresh pass. Returns 'warm' | 'dead' | 'unknown' — three outcomes on purpose,
 *  because "we could not tell" must never be actioned as "it is dead". */
async function warmOnce() {
  /** Carried out of withProfile so it can be reported alongside the verdict. */
  let renewalNote = '';
  const state = await withProfile(async (ctx, page) => {
    await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // BEFORE the wait, so the comparison below is "did loading the app change it?" and
    // not "is it different from twenty minutes ago?".
    const before = await readToken(page);
    // Let RC's app boot and run its silent token renewal. This wait IS the keep-warm;
    // navigating and leaving immediately would prove the session without extending it.
    await page.waitForTimeout(8000);

    // DID THE RENEWAL ACTUALLY HAPPEN? See tokenExpiry — this file has always ASSERTED
    // that loading the app renews the Okta token, and the one real measurement we have
    // says a session dies after about one token lifetime. Record it rather than argue.
    const after = await readToken(page);
    const exp = tokenExpiry(after);
    const changed = before != null && after != null && before !== after;
    renewalNote =
      (exp ? `token exp in ${Math.round((exp - Date.now()) / 60000)}m` : 'token exp unknown') +
      `; renewed=${changed ? 'YES' : 'no'}`;
    log(`   ${renewalNote}`);

    const { live, why } = await sessionLive(ctx, page);
    if (live === true) {
      try { fs.writeFileSync(WARM_MARKER, new Date().toISOString()); } catch { /* best effort */ }
      log(`♻ RC session kept warm (${why})`);
      return 'warm';
    }
    if (live === null) {
      log(`… RC keep-warm inconclusive: ${why}`);
      return 'unknown';
    }
    log(`⚠ RC SESSION IS DEAD: ${why}`);
    log('  A human must sign in once — the bot cannot, since RC started serving a');
    log('  reCAPTCHA challenge on 2026-08-07. On this machine, run:');
    log('    node rc-keepwarm.mjs --login');
    log('  Tick "Keep me signed in". Until then RC auto-cart is off; alerts are');
    log('  unaffected (the poller detects from Fly, not from here).');
    return 'dead';
  });

  if (state === BUSY) {
    const held = profileLockHolder(PROFILE_DIR);
    log(`… profile busy (${held?.owner ?? 'another process'}) — skipping this pass, NOT a dead session`);
    return 'unknown';
  }
  await reportSession(state, renewalNote);
  return state;
}

/**
 * Send the verdict to camphawk.app.
 *
 * THIS PROCESS HAS ALWAYS KNOWN AND NEVER TOLD ANYONE. `sessionLive` asks RC a question
 * only an authenticated session can answer, every 20 minutes, and the answer went to a
 * console on a box in someone's house. Meanwhile the server's only RC signal was the hold
 * runner's feed poll, which proves network reach and nothing else — so on 2026-08-07 the
 * dashboard was green while the session behind it was useless.
 *
 * The value is LEAD TIME. A dead RC session needs a human (RC serves a reCAPTCHA on
 * sign-in now, so there is no unattended re-login). Knowing at 21:00 that tomorrow's
 * 08:00 hold has nothing behind it is a fixable evening; knowing at 08:00:10 is a
 * post-mortem. See migration 046.
 *
 * `unknown` REPORTS NOTHING, deliberately. A busy profile, a 403 from RC's edge and a
 * network blip are all "we could not tell", and writing them as `false` would send the
 * owner to do a human sign-in over a perfectly healthy session. The server sees the
 * previous verdict go stale instead, which is the honest reading: we have not confirmed
 * this recently. Same rule as `hasAvailabilityInRange` returning null — the absence of a
 * reading is not a negative reading.
 */
async function reportSession(state, renewalNote = '') {
  if (state !== 'warm' && state !== 'dead') return;
  if (!TOKEN) return;
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      session: {
        live: state === 'warm',
        // Carry the renewal measurement into the dashboard, not just the mini-PC console.
        // "token exp in 43m; renewed=no" counting DOWN across passes is the proof that
        // loading the app does not renew the session — and it is visible at 07:30 on the
        // pre-flight, where it can still be acted on.
        why: [state === 'dead' ? 'keep-warm probe: RC rejected the session' : null, renewalNote]
          .filter(Boolean).join(' — ') || null,
      },
      source: 'keepwarm',
    }),
    // A health report must never be able to break the keep-warm. Reaching camphawk.app is
    // not this process's job; keeping the session alive is.
  }).catch((e) => log(`  (could not report session health: ${e.message})`));
}

/** The one human step. Opens the profile headful and waits for a real session. */
async function humanLogin() {
  log('Opening ReserveCalifornia for a ONE-TIME human sign-in.');
  log('Sign in, TICK "Keep me signed in", and solve the CAPTCHA if it appears.');
  log('This window closes by itself once the session is confirmed (up to 10 min).');
  const ok = await withProfile(async (ctx, page) => {
    await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const { live } = await sessionLive(ctx, page);
      if (live === true) {
        try { fs.writeFileSync(WARM_MARKER, new Date().toISOString()); } catch {}
        log('✓ Signed in. The keep-warm loop can take it from here.');
        log(`  Profile: ${PROFILE_DIR}  — do NOT delete this directory.`);
        return true;
      }
    }
    log('✗ No session after 10 minutes. Re-run when you have a moment.');
    return false;
    // Waits longer than a keep-warm pass would: a person is at the keyboard, so making
    // them re-run the command because a background pass happened to be mid-flight is a
    // worse outcome than sixty seconds of nothing.
  }, { headless: false, waitMs: 60_000 });

  if (ok === BUSY) {
    const held = profileLockHolder(PROFILE_DIR);
    log(`✗ The profile is in use by ${held?.owner ?? 'another process'} and did not come free.`);
    log('  Stop the keep-warm loop / hold runner in the other window, then re-run this.');
    return false;
  }
  return ok;
}

// ONE chain, not a sequence of early exits. `exitWhenDrained` sets the exit code and
// lets the loop finish — it does NOT stop execution the way process.exit() does — so a
// `--login` run written as a bare `if` would fall straight through and start the
// keep-warm loop on top of the sign-in it just did.
if (LOGIN) {
  const ok = await humanLogin();
  exitWhenDrained(ok ? 0 : 1);
} else if (!fs.existsSync(PROFILE_DIR)) {
  log(`No RC profile at ${PROFILE_DIR}.`);
  log('Run `node rc-keepwarm.mjs --login` once, with a human at the keyboard.');
  // Safe as a hard exit: nothing async has run yet, so there is no handle mid-close.
  process.exit(2);
} else if (ONCE) {
  const state = await warmOnce().catch((err) => { log(`keep-warm error: ${err.message}`); return 'unknown'; });
  exitWhenDrained(state === 'dead' ? 1 : 0);
} else {
  await runForever();
}

/**
 * RESIDENT MODE — the page stays open, and that is the whole fix.
 *
 * WHY THE OLD LOOP COULD NOT WORK. It opened a tab for eight seconds every twenty
 * minutes. RC's SPA renews its Okta token on its own schedule, somewhere inside the
 * token's ~1h life — so the chance of the tab being open at the moment the renewal fires
 * is about 8s in 20min, under one percent. The loop was not renewing the session; it was
 * observing it, occasionally, and reporting a token that had never been extended. That is
 * precisely the 1h20m sign-in-to-death we measured on 2026-08-08: one access token, and
 * then nothing.
 *
 * A real user's browser stays open. So does this one now. The keep-warm holds the profile
 * and keeps RC loaded continuously, re-checking liveness every KEEPALIVE_MS, and YIELDS
 * the moment the hold runner asks for the profile (see profile-lock's preemption). One
 * Chromium on the profile at a time, still — that invariant is not negotiable, because
 * two of them corrupt the session this exists to protect.
 *
 * If `renewed=YES` starts appearing in the log, that is the theory confirmed. If the token
 * still never changes with a page open for hours, the renewal is not time-based and the
 * next move is to drive the OIDC silent-auth endpoint explicitly.
 */
async function warmResident() {
  for (;;) {
    if (!(await waitForProfileLock(PROFILE_DIR, LOCK_OWNER, 60_000))) {
      const held = profileLockHolder(PROFILE_DIR);
      log(`… profile busy (${held?.owner ?? 'another process'}) — retrying in 30s, NOT a dead session`);
      await sleep(30_000);
      continue;
    }
    const renew = setInterval(() => renewProfileLock(PROFILE_DIR, LOCK_OWNER), RENEW_MS);
    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS, viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        // WITHOUT THESE, KEEPING THE PAGE OPEN BUYS NOTHING. Chrome aggressively throttles
        // timers in background, minimised and occluded tabs — and this window will spend
        // its whole life behind something on a desktop the owner actually uses. The
        // renewal we are staying open to catch is a timer inside RC's app; a throttled
        // timer is a timer that does not fire, so the resident tab would sit there looking
        // healthy and renew exactly as little as the old eight-second visit did.
        args: [
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      log('RC loaded and STAYING OPEN — this is what lets the app renew its own token.');
      log('Leave this browser window ALONE. Closing it stops the renewal; it will reopen.');

      // 0, so the first check fires IMMEDIATELY on every open. After a restart or a yield
      // to the runner, waiting twenty minutes to say anything would leave
      // `autocart.rc_session` stale — reading "we have not confirmed this recently" when
      // in fact we just did, on the one dashboard that decides whether to wake someone.
      let lastCheck = 0;
      for (;;) {
        // Yield fast. The runner is asking because a site releases in seconds; making it
        // wait out a 60s lock timeout at 08:00:00 would lose exactly the thing we are
        // keeping the session alive FOR.
        if (profileRequested(PROFILE_DIR)) {
          log('→ hold runner wants the profile — closing and standing down');
          break;
        }
        // A VISIBLE WINDOW GETS CLOSED. It is headful by design (RC fingerprints headless
        // Chromium) and it sits on the owner's desktop, so somebody tidying up will shut
        // it sooner or later. Without this the loop would spin for days on a dead context,
        // logging a caught error every twenty minutes while the session quietly lapsed —
        // a keep-warm that keeps nothing warm and still reports for duty.
        if (!ctx.pages().length || page.isClosed()) {
          log('⚠ the RC window was closed — reopening it');
          break;
        }
        if (Date.now() - lastCheck >= KEEPALIVE_MS) {
          lastCheck = Date.now();
          await checkAndReport(ctx, page).catch((e) => log(`check failed: ${e.message}`));
        }
        await sleep(1000);
      }
    } catch (err) {
      log(`resident keep-warm error: ${err.message} — reopening in 30s`);
    } finally {
      await ctx?.close().catch(() => {});
      clearInterval(renew);
      releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
    }
    // Wait for the requester to finish before grabbing it back, or we would race them for
    // the lock they just asked us to give up.
    while (profileRequested(PROFILE_DIR)) await sleep(1000);
    await sleep(2000);
  }
}

/** Liveness + renewal measurement against an ALREADY-OPEN page. */
async function checkAndReport(ctx, page) {
  const before = await readToken(page);
  const exp = tokenExpiry(before);
  const { live, why } = await sessionLive(ctx, page);
  const after = await readToken(page);
  const changed = before != null && after != null && before !== after;
  const note =
    (exp ? `token exp in ${Math.round((exp - Date.now()) / 60000)}m` : 'token exp unknown') +
    `; renewed=${changed ? 'YES' : 'no'}`;

  if (live === true) {
    try { fs.writeFileSync(WARM_MARKER, new Date().toISOString()); } catch { /* best effort */ }
    log(`♻ RC session kept warm (${why}) — ${note}`);
    await reportSession('warm', note);
  } else if (live === null) {
    log(`… RC keep-warm inconclusive: ${why} — reporting nothing, unknown is not dead`);
  } else {
    log(`⚠ RC SESSION IS DEAD: ${why} — ${note}`);
    log('  A human must sign in once: node rc-keepwarm.mjs --login');
    await reportSession('dead', note);
  }
}

async function runForever() {
  log(`RC session keep-warm every ${Math.round(KEEPALIVE_MS / 60000)}m — profile ${PROFILE_DIR}`);
  log('Ctrl-C to stop. A dead session is reported loudly and needs one human sign-in.');
  if (TOKEN) log(`Reporting session health to ${CAMPHAWK_URL}.`);
  else log('⚠ No AUTOCART_TOKEN — session health will NOT reach camphawk.app, so a dead');
  if (!TOKEN) log('  session will look like silence on the dashboard. Add it to .env.');
  // RESIDENT, not a timer. See warmResident: an 8-second visit every 20 minutes could
  // never coincide with the app's own token renewal, which is why sessions were dying
  // after one token. `--once` keeps the old open-check-close shape, which is right for a
  // smoke test — it answers "is the session alive", not "keep it alive".
  await warmResident();
}
