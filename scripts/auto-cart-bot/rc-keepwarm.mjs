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
 * **AND THE EVIDENCE AGAINST IT WAS OUR OWN BUG (2026-08-08).** This file spent a day
 * reporting "RC REJECTED the session — a human must sign in", and the numbers built on
 * that — a 1h20m session lifetime, then a 13-minute one, `renewed=no` every pass — were
 * measurements of a STALE READ, not of RC.
 *
 * `readToken` used to take `localStorage.ssoAccessToken` directly. That is not the
 * credential the app sends: RC's token is AES-encrypted by Okta and only decrypted in page
 * memory. `extension/rc-inject.js` has said so since it was written, and the extension has
 * to run a MAIN-world script wrapping fetch/XHR precisely because localStorage cannot be
 * trusted here. So the liveness probe POSTed a stale token, got a 401, and blamed the
 * session. The giveaway was in the data all along: a token whose own `exp` was already
 * three hours in the past AT the moment we called the session live.
 *
 * It now captures the live token off RC's own requests (`rc-token.mjs`), and a 401 on a
 * localStorage FALLBACK is reported as INCONCLUSIVE rather than dead — same rule as a 403
 * or a network error. Sending someone to do a human sign-in over a healthy session is the
 * expensive mistake here, not the noise.
 *
 * **So the renewal theory is untested again, not disproven.** Do not repeat the 1h20m
 * figure; it measured our own bug.
 *
 * RUN IT ON THE MINI-PC, alongside the rec.gov bot:
 *   node rc-keepwarm.mjs                 # RESIDENT: holds RC open, yields to the runner
 *   node rc-keepwarm.mjs --once          # single pass, for a cron or a smoke test
 *   node rc-keepwarm.mjs --login         # headful, for a human sign-in (the fallback)
 *   node rc-keepwarm.mjs --save-login    # store the RC password, encrypted, once
 *   node rc-keepwarm.mjs --test-login    # prove the unattended login works, NOW
 *
 * IT DOES TYPE A PASSWORD NOW, AND THAT REVERSED A RULE THIS FILE USED TO STATE.
 * The old header said "it never types a password — the only way in is `--login`, with a
 * human at the keyboard", on the reasoning that repeated automated logins from one address
 * are what provoked the CAPTCHA. That reasoning still holds; what changed is the discovery
 * (2026-08-09) that there is no session to keep warm at all — RC issues no Okta session
 * cookie, so the ~1h access token IS the session and no cadence of page loads extends it.
 * "Never log in" and "be signed in at 08:00 without a human" turned out to be incompatible,
 * so the rule became a budget instead of a ban: `maybeAutoLogin` signs in ONCE, within
 * AUTOLOGIN_LEAD_MIN of a real hold, one attempt per release forever, from the PERSISTENT
 * profile whose `DT` cookie is what tells Okta this is a known machine. A few times a
 * month, never on a timer, never in a loop. See rc-autologin.mjs for the full argument.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForProfileLock, releaseProfileLockIfMine, renewProfileLock, profileLockHolder,
  profileRequested,
} from './profile-lock.mjs';
import {
  installTokenCapture, readLiveToken, primeToken, renewByReload, tokenSecondsLeft,
  readAuthFacts, oktaSessionAlive, authCookieSummary,
} from './rc-token.mjs';
import { hasCredentials, attemptLogin } from './rc-autologin.mjs';
import { shouldRehearse, rehearsalSlot } from './rehearsal.mjs';
// The same two clock helpers the update guard decides with. Both are pure and both already
// get the Pacific / zone-less-wall-clock handling right, which is the part that has been
// got wrong before — a second implementation here would be a second chance to get it wrong.
import { pacificHour, hoursUntilRelease } from './update-guard.mjs';
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

/**
 * Renew when the token has less than this left — the SILENT-AUTH trigger.
 *
 * Ten minutes against an ~1h token: comfortably before expiry, and far enough out that a
 * reload which fails can be retried twice before anything is lost. The old loop reloaded
 * every twenty minutes regardless of the clock, which is not the same thing at all — it
 * renewed by accident when the timing happened to line up, and not otherwise.
 */
const RENEW_BEFORE_S = Number(process.env.RC_RENEW_BEFORE_S || 10 * 60);
/** How often to look at the clock. Cheap — one page.evaluate against an open tab. */
const EXPIRY_POLL_MS = 60_000;

/**
 * How long RC holds a carted unit before it lapses back to the public.
 *
 * MIRRORS `RC_CART_HOLD_MINUTES` in src/lib/limits.ts, which cannot be imported here — the
 * bot is plain .mjs and that is TypeScript. `worker/autologin-lead.test.mts` asserts the
 * two agree, so a change on one side fails the build rather than drifting quietly.
 */
const CART_HOLD_MIN = 15;

/**
 * How long before a hold's release to make sure we have a token.
 *
 * ── THE ARITHMETIC, because both directions cost something ─────────────────────────────
 * A login at T−L mints a ~60-minute access token, so it dies at T−L+60. The bot needs that
 * token not just to CART at T−0 but to RELEASE at up to T+CART_HOLD_MIN — the user has the
 * full cart hold to tap claim, and `remove/cartentry` is run by the bot with its own
 * session. So the hard ceiling is:
 *
 *     T − L + 60  ≥  T + CART_HOLD_MIN     →     L ≤ 45
 *
 * Below that the trade is: a bigger L buys a human more time to solve a CAPTCHA or run
 * rc-login.bat, and spends token margin at the moment of the cart.
 *
 *   L = 15 (until 2026-08-11)  token has 45m left at the cart, human gets 15 minutes.
 *   L = 30 (now)               token has 30m left at the cart — still twice the cart
 *                              hold — and a human gets 30 minutes, which is the
 *                              difference between "surface, find a computer, sign in"
 *                              being possible and being a coin flip.
 *
 * THE EXTRA FIFTEEN MINUTES ARE FOR A HUMAN, NOT FOR US TO RETRY. One attempt per release
 * still stands: repeated logins from this address are what got it blocked for 12h on
 * 2026-08-06, and a wider window is not permission to spend it.
 */
const AUTOLOGIN_LEAD_MIN = Number(process.env.RC_AUTOLOGIN_LEAD_MIN || 30);

/**
 * Minutes of token life below which a hold is NOT considered covered.
 *
 * DERIVED, NOT CHOSEN — and it was a flat 20 until 2026-08-11, which was already wrong at
 * L = 15. "Covered" has to mean "will still be alive when we RELEASE the unit", i.e. for
 * L + CART_HOLD_MIN minutes, not merely until the cart. At 20 the bot would look at a
 * token with 21 minutes left, decide the hold was covered, skip its one login, cart at
 * T−0 with ~6 minutes of token left, and then fail the claim — the user taps "I'm ready"
 * and the site is released by nobody.
 *
 * Reachable, not theoretical: sign in by hand an hour before a release (say the 07:30
 * pre-flight tells you to) and the token has exactly this much life left when the
 * auto-login looks. Moving L to 30 without moving this would have made it worse — a
 * 25-minute token at T−30 dies at T−5, before the cart itself.
 *
 * The +5 is margin for a login that takes a while and for the token's life being ~60
 * rather than exactly 60.
 */
const AUTOLOGIN_MIN_TOKEN_MIN = Number(
  process.env.RC_AUTOLOGIN_MIN_TOKEN_MIN || AUTOLOGIN_LEAD_MIN + CART_HOLD_MIN + 5,
);

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
const SAVE_LOGIN = args.has('--save-login');
const TEST_LOGIN = args.has('--test-login');

/** Log the app's own authorize URL once, not on every 20-minute pass. */
let warmedAuthLogged = false;
/** Same, for the cookie inventory — it does not change between passes. */
let warmedCookiesLogged = false;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The token the app is ACTUALLY sending — not the localStorage copy.
 *
 * This used to read `localStorage.ssoAccessToken` directly, and that is not the live
 * credential: RC's token is AES-encrypted by Okta and only decrypted in page memory (see
 * rc-token.mjs and extension/rc-inject.js). Probing with the stale copy produced a 401
 * and a confident "RC REJECTED the session — a human must sign in" for a session that
 * may have been fine. `source` is carried so a localStorage fallback is never reported
 * as though it were a live reading.
 */
async function readToken(page) {
  const { token } = await readLiveToken(page);
  return token;
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
 * How long the resident loop may go without advancing before we call it wedged.
 *
 * Generous on purpose: a pass includes a page load, a token read and a network probe, and
 * the silent-auth path deliberately waits. 12 minutes is far longer than any healthy pass
 * and far shorter than the ~45 minutes of lead a hold needs to be rescued.
 */
const HUNG_MS = Number(process.env.RC_KEEPWARM_HUNG_MS || 12 * 60_000);

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
    // The profile is routinely closed by a force-kill (update.bat, rc-login.bat), so
    // Chromium offers to restore pages on every launch. Harmless, but it covers the top
    // of the very window a human is being asked to look at.
    args: ['--hide-crash-restore-bubble'],
  }).catch((err) => {
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
    throw err;
  });
  try {
    // BEFORE the first navigation, or the calls carrying the token have already gone.
    await installTokenCapture(ctx);
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
/**
 * Minutes until an RC-style Pacific wall-clock timestamp. Both sides are compared as
 * wall-clock in the same zone, so the offset cancels; never `new Date()` on a zone-less
 * string, which reads it in whatever zone this box happens to be in.
 */
function minutesUntil(releaseAt) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
    const now = `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
    return Math.round((Date.parse(`${releaseAt}Z`) - Date.parse(`${now}Z`)) / 60000);
  } catch {
    return null;
  }
}

/**
 * What the server knows that this process cannot: when the next hold releases, and when
 * the login was last rehearsed. Null fields mean "we could not find out" — never a
 * fabricated "none", which downstream would read as permission to act.
 *
 * `rehearsal=1` is opt-in because the hold runner polls this same endpoint every 15s and
 * has no use for the extra row. See the route.
 */
async function feedFacts() {
  if (!TOKEN) return { nextRelease: null, lastRehearsalAt: null, reachable: false };
  try {
    const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds?rehearsal=1`, {
      // NOT the hold runner: this GET must not stamp `beat_at`. The keep-warm and the runner
      // are separate processes and die separately - that separation is the whole reason
      // `autocart.rc_runner` exists next to `autocart.rc_session` - so a keep-warm polling
      // every 20 minutes would mask a dead runner exactly when a hold is due.
      headers: { authorization: `Bearer ${TOKEN}`, 'x-bot-role': 'rc-keepwarm' },
    });
    if (!res.ok) return { nextRelease: null, lastRehearsalAt: null, reachable: false };
    const j = await res.json();
    return {
      nextRelease: j?.nextRelease ?? null,
      lastRehearsalAt: j?.lastRehearsalAt ?? null,
      reachable: true,
    };
  } catch {
    return { nextRelease: null, lastRehearsalAt: null, reachable: false };
  }
}

/**
 * Sign in ourselves, but ONLY in the narrow window where it is both necessary and worth
 * the risk. Returns true if an attempt was made.
 *
 * There is no session to keep warm — RC issues no Okta session cookie, so the token IS the
 * session and it lasts about an hour. That leaves exactly one unattended option: obtain a
 * token shortly before a hold needs it.
 *
 * The guards are the whole design, because a login is the act that got the household IP
 * blocked for twelve hours when it was done repeatedly (2026-08-06):
 *   • a hold must actually be due within AUTOLOGIN_LEAD_MIN — a few times a month;
 *   • the current token must be genuinely insufficient, not merely ageing;
 *   • ONE attempt per release, tracked by release time, so a failure never becomes a loop;
 *   • a CAPTCHA aborts and wakes a human rather than retrying (rc-autologin.mjs).
 */
let autoLoginTriedFor = null;
async function maybeAutoLogin(ctx, page) {
  if (!hasCredentials()) return false;
  const { nextRelease: release } = await feedFacts();
  if (!release || autoLoginTriedFor === release) return false;

  const mins = minutesUntil(release);
  if (mins == null || mins > AUTOLOGIN_LEAD_MIN || mins < -20) return false;

  // Already covered? A token with plenty of life left needs no login, and logging in
  // anyway would be exactly the needless repetition we are avoiding.
  const { token } = await readLiveToken(page).catch(() => ({ token: null }));
  const left = tokenSecondsLeft(token);
  if (left != null && left > AUTOLOGIN_MIN_TOKEN_MIN * 60) return false;

  autoLoginTriedFor = release;
  log(`⏰ hold releases in ${mins}m and the session will not cover it — signing in ONCE`);
  const r = await attemptLogin(ctx, page, {
    homeUrl: RC_HOME,
    isLive: async () => (await sessionLive(ctx, page)).live === true,
    log,
  });
  if (r.ok) {
    log('  ✓ signed in unattended — the hold is covered');
    await reportSession('warm', 'signed in automatically before a hold');
  } else {
    log(`  ✗ could not sign in: ${r.reason}`);
    log('    NOT retrying. Repeated logins are what got this address blocked before.');
    // The real 07:45 failure is the one nobody is watching, so it gets the picture too.
    await saveFailureShot(page, 'autologin');
    await reportSession('dead', `auto sign-in failed: ${r.reason}`);
  }
  return true;
}

/**
 * REHEARSE THE SIGN-IN, once a night, hours before it is load-bearing.
 *
 * WHY. Three consecutive 08:00 holds failed and all three failed AT LOGIN — the runner was
 * dead (08-07), the cart fired 85s early (08-08), and `attemptLogin` demanded an email field
 * Okta had stopped showing (08-11). Each was discovered at 07:30 with twenty minutes to act,
 * because the release was being used as the test. It is not the test; it is the exam.
 *
 * `--test-login` could always have proved this. It was never scheduled, so it only ever ran
 * when somebody already suspected a problem — the missing thing was a cadence, not an
 * ability, which is why this is thirty lines and not a new subsystem.
 *
 * The gates live in rehearsal.mjs, tested, because a login is not free: repeated sign-ins
 * from this address cost twelve hours of IP block on 2026-08-06.
 */
let recordedSlot = null;
async function maybeRehearse(ctx, page) {
  const hour = pacificHour();
  // A PACIFIC DATE, NOT AN HOUR NUMBER. This used to hold `hour` and was never reset, so it
  // latched at 20 for the life of the process and every night after the first recorded its
  // skip SILENTLY — see rehearsalSlot. Null outside the rehearsal hour.
  const slot = rehearsalSlot();
  const facts = await feedFacts();
  // UNREACHABLE FEED MEANS NO REHEARSAL. We would not know whether a hold is due, and the
  // rehearsal deliberately ENDS the current session on its way — the same reasoning as the
  // update guard refusing to update blind, and for the same stakes.
  if (!facts.reachable) return false;

  const decision = shouldRehearse({
    pacificHour: hour,
    hoursToRelease: hoursUntilRelease(facts.nextRelease),
    sessionLive: (await sessionLive(ctx, page)).live,
    hoursSinceLastRun: facts.lastRehearsalAt
      ? (Date.now() - Date.parse(facts.lastRehearsalAt)) / 3_600_000
      : null,
    hasCredentials: hasCredentials(),
  });

  if (!decision.run) {
    // Only the ones that happen AT the rehearsal hour are worth recording — "not the
    // rehearsal hour" is true for twenty-three hours a day and would overwrite last
    // night's real result with noise every minute.
    if (slot && recordedSlot !== slot) {
      recordedSlot = slot;
      log(`skipping tonight's login rehearsal: ${decision.why}`);
      await reportRehearsal(null, null, decision.why);
    }
    return false;
  }

  // STAMP `ran_at` BEFORE ATTEMPTING, and this is not defensive noise. The once-a-day gate
  // is the only thing standing between a crash-loop and a login every time the supervisor
  // restarts this process — and a login attempt is exactly what opens Chromium and posts
  // credentials from the household IP. Recording afterwards would leave the gate open for
  // the whole rehearsal hour if the attempt never returned. An interrupted rehearsal
  // therefore reads as ran-but-unknown, which is `stale`: honest, and not a pass.
  recordedSlot = slot;
  await reportRehearsal(null, 'rehearsal started', null);
  log('── nightly login rehearsal: proving the bot can still sign itself in ──');
  const { result, detail } = await runLoginRehearsal(ctx, page, {
    // Nobody is watching at 20:00 either. A CAPTCHA here is a real finding, reported and
    // acted on this evening, not something to sit in front of for five minutes.
    humanPresent: false,
    tag: 'rehearsal',
  });

  if (result === 'inconclusive') {
    await reportRehearsal(null, null, detail);
    return true;
  }
  await reportRehearsal(result === 'ok', detail, null);
  // AND REPORT THE SESSION, because the rehearsal just changed it either way — it signed in
  // (live) or it left us signed out (dead). Saying nothing would leave `autocart.rc_session`
  // quoting a verdict this function has just invalidated.
  //
  // A dead verdict here cannot ring anyone's phone: `holdAtRisk` only fires within 45
  // minutes of a release and the rehearsal refuses to run within six hours of one. That is
  // the gate doing two jobs, and it is why the six hours is not negotiable.
  await reportSession(result === 'ok' ? 'warm' : 'dead', `nightly rehearsal: ${detail}`);
  log(result === 'ok'
    ? '✓ the bot can still sign itself in — tomorrow morning has a session behind it'
    : '✗✗ THE UNATTENDED LOGIN IS BROKEN, and there are hours to fix it. See admin → System Health.');
  return true;
}

async function reportRehearsal(ok, detail, skippedWhy) {
  if (!TOKEN) return;
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rehearsal: { ok, detail, skippedWhy } }),
  }).catch((e) => log(`  (could not report the rehearsal: ${e.message})`));
}

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

/**
 * Read one line with the echo muted.
 *
 * THE FIRST VERSION OF THIS ECHOED THE PASSWORD IN FULL (reported 2026-08-09). It created
 * a `readline` interface for the email prompt and left it OPEN while reading the password
 * raw from stdin — and a readline interface in terminal mode echoes every keypress itself.
 * `setRawMode(true)` stops the TTY driver echoing; it does nothing about another library
 * listening on the same stream and helpfully writing to stdout. Two readers, one of them
 * chatty. So: no readline anywhere near this. It owns stdin, then hands it back.
 *
 * A non-TTY stdin (piped, redirected, no console) CANNOT be muted — there is no raw mode
 * to set. It refuses rather than echoing, because printing the password while promising
 * not to is exactly the bug being fixed.
 */
function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(
      'this window cannot hide typed input — double-click mini-pc\\rc-save-password.bat instead',
    ));
  }
  return new Promise((res, rej) => {
    process.stdout.write(prompt);
    let buf = '';
    const finish = (fn, v) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      fn(v);
    };
    const onData = (chunk) => {
      // CHUNKS, NOT KEYSTROKES. A paste arrives as one buffer and so can fast typing, so
      // every branch has to cope with more than a single character — the old code compared
      // the whole chunk to '\r' and would have appended a pasted password's newline.
      for (const c of String(chunk)) {
        if (c === '\n' || c === '\r' || c === '\u0004') return finish(res, buf);
        if (c === '\u0003') return finish(rej, new Error('cancelled'));
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        // Drop control characters — arrow keys arrive as escape sequences, and letting
        // them into the password makes it invisibly wrong.
        if (c >= ' ') buf += c;
      }
    };
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
  });
}

/** Read one visible line. Opens and CLOSES its own readline — see readHidden. */
async function readLine(prompt) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((res) => rl.question(prompt, res));
  } finally {
    rl.close();
  }
}

/**
 * Store the ReserveCalifornia password so the bot can sign itself in before a hold.
 *
 * TYPED, NOT PASTED INTO A FILE. The password goes straight into the same encrypted store
 * the rec.gov bot uses — DPAPI at CurrentUser scope on Windows, so the blob is worthless
 * on any other machine or under any other login. The alternative I very nearly shipped
 * was two plaintext lines in `.env`, which is a password every process on the box can
 * read and which ends up in screenshots and pasted terminal output. This feature exists
 * to reduce risk, not to move it.
 *
 * ASKED TWICE, because it is invisible. A silently mistyped password is not discovered
 * until the auto-login fails at 07:45 on the one morning it mattered, and the message that
 * produces ("check the password") is indistinguishable from a real password change.
 */
async function saveLogin() {
  const { saveCreds } = await import('./credstore.mjs');

  log('Storing your ReserveCalifornia login, encrypted, on THIS machine only.');
  log('It is never sent to CampHawk and never written in plain text.');
  const email = (await readLine('  RC email: ')).trim();

  let pw;
  try {
    pw = await readHidden('  RC password (hidden as you type): ');
    const again = await readHidden('  Type it once more to confirm: ');
    if (pw !== again) {
      log('✗ The two did not match. Nothing saved — run this again.');
      return false;
    }
  } catch (err) {
    log(`✗ ${err.message}`);
    return false;
  }

  if (!email || !pw) { log('✗ Nothing saved — both fields are required.'); return false; }
  try {
    saveCreds(PROFILE_DIR, email, pw);
    log(`✓ Saved, encrypted, in ${PROFILE_DIR}`);
    log('  The bot will now sign in by itself ~15 minutes before a hold needs it.');
    log('  PROVE IT NOW, do not wait for 07:45:  mini-pc\\rc-test-login.bat');
    log('  To remove it later: delete .camphawk-creds from that folder.');
    return true;
  } catch (err) {
    log(`✗ Could not save: ${err.message}`);
    return false;
  }
}

/**
 * Photograph a failed sign-in, because the alternative is photographing the screen.
 *
 * The first real `--test-login` failure (2026-08-09) was diagnosed from a phone picture of
 * the mini-PC's monitor. The answer was right there — RC's button says "Log in / Sign up"
 * and the selectors only knew "Sign In" — but nothing in the log said so, because "could
 * not find the sign-in form" is equally true of a missed link and a redesigned Okta page.
 *
 * NOT A CREDENTIAL RISK: password fields render as dots, and the only other thing on screen
 * is the account's own email address, on the owner's own machine. It overwrites one file
 * rather than accumulating — the interesting one is always the most recent.
 */
async function saveFailureShot(page, tag) {
  const dir = path.resolve(HERE, 'logs');
  const file = path.join(dir, `rc-${tag}-failed.png`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: file, fullPage: false });
    log(`  (screenshot of the failure: ${file})`);
    log(`  (page was at: ${page.url().slice(0, 100)})`);
  } catch {
    // Never let a diagnostic break the thing it is diagnosing.
  }
}

/**
 * PROVE THE UNATTENDED LOGIN WORKS — now, with hours to spare, not at 07:45.
 *
 * Everything about `maybeAutoLogin` is built to fire rarely and never retry, which is
 * correct and also means the first time it runs for real is the morning it is load-bearing.
 * That is the worst possible moment to discover a mistyped password. This runs the SAME
 * `attemptLogin`, on the SAME profile, against the real RC.
 *
 * ## It signs you out first, and how it does that matters
 *
 * A login attempt against an already-signed-in session proves nothing — RC shows no sign-in
 * form, `findIn` returns null, and you get "could not find the sign-in form" for a session
 * that is perfectly healthy. So the token has to go.
 *
 * **It clears the localStorage token and NOTHING ELSE. It does not touch cookies, and you
 * should not sign out through RC's own menu either.** `signin.reservecalifornia.com` holds
 * a `DT` device cookie, and that is the one thing telling Okta this is a machine it has
 * seen before. Repeated logins from FRESH profiles — i.e. without `DT` — is what got the
 * household IP blocked for twelve hours on 2026-08-06 and put a reCAPTCHA in front of this
 * browser on 08-07. Clearing cookies to "test properly" would recreate that exact shape.
 * RC's SPA reads the token from localStorage to decide whether you are signed in, so
 * dropping it is a real logout as far as the login flow is concerned, with the device
 * identity intact.
 *
 * ## What it costs
 *
 * One extra real sign-in. That is the point — one now, deliberately, while there is time to
 * recover, instead of finding out during the ninety seconds that decide a campsite.
 */
/**
 * The rehearsal itself, on a profile somebody else has already opened and locked.
 *
 * ONE BODY, TWO CALLERS — `--test-login` at a keyboard and the nightly `maybeRehearse`
 * inside the resident loop. They must not drift: the entire claim being made is "this is
 * the same thing that runs at 07:45", and two copies of it would be two things.
 *
 * @returns {Promise<{ result: 'ok'|'failed'|'inconclusive', detail: string }>}
 */
async function runLoginRehearsal(ctx, page, { humanPresent, tag }) {
  await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await primeToken(page).catch(() => {});

  const before = await sessionLive(ctx, page);
  log(`Session before the test: ${before.live === true ? 'ALIVE' : before.live === false ? 'DEAD' : 'UNKNOWN'} — ${before.why}`);

  // The token only, never the cookies. See the header.
  log('Dropping the stored token so RC treats this as signed out (cookies untouched)…');
  await page.evaluate(() => {
    try {
      localStorage.removeItem('ssoAccessToken');
      localStorage.removeItem('accessToken');
      delete window.__camphawkRcToken;
    } catch {}
  }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});

  const gone = await sessionLive(ctx, page);
  if (gone.live === true) {
    log('⚠ RC still accepts a token after clearing it — the test cannot prove anything.');
    log('  Not attempting a login. Nothing was changed; your session is intact.');
    return { result: 'inconclusive', detail: 'RC still accepted a session after clearing the token' };
  }

  log('Signing in with the stored password, exactly as it would at 07:45…');
  const r = await attemptLogin(ctx, page, {
    homeUrl: RC_HOME,
    isLive: async () => (await sessionLive(ctx, page)).live === true,
    log,
    // `--test-login` has somebody watching, so a CAPTCHA is worth waiting on rather than
    // failing at — they can solve it and the run carries on. The nightly rehearsal and
    // maybeAutoLogin deliberately do the opposite: unattended, a challenge is a full stop.
    humanPresent,
  });
  if (!r.ok) {
    log(`✗ ${r.reason}`);
    await saveFailureShot(page, tag);
    return { result: 'failed', detail: r.reason };
  }
  // SIGNED IN, BUT NOTHING WAS PROVED. RC re-authenticated from the live Okta session before
  // a form appeared, so no credential was ever submitted. Recording that as a pass would put
  // a green mark against a test that did not run — see rehearsal.mjs.
  if (r.provedNothing) {
    log(`… ${r.reason}`);
    return { result: 'inconclusive', detail: r.reason };
  }

  const after = await sessionLive(ctx, page);
  if (after.live !== true) {
    log(`✗ Signed in, but RC will not accept the session: ${after.why}`);
    return { result: 'failed', detail: `signed in, but RC will not accept the session: ${after.why}` };
  }
  try { fs.writeFileSync(WARM_MARKER, new Date().toISOString()); } catch {}
  log(`✓ ${after.why}`);
  return { result: 'ok', detail: after.why };
}

async function testLogin() {
  if (!hasCredentials()) {
    log('✗ No stored credentials. Run mini-pc\\rc-save-password.bat first.');
    return false;
  }
  const outcome = await withProfile(
    (ctx, page) => runLoginRehearsal(ctx, page, { humanPresent: true, tag: 'test-login' }),
    { headless: false, waitMs: 60_000 },
  );
  const result = outcome === BUSY ? BUSY : outcome.result;

  if (result === BUSY) {
    log('✗ The hold runner has the profile. Wait a minute and re-run — nothing was changed.');
    return false;
  }
  if (result === 'ok') {
    log('');
    log('✓✓ THE BOT CAN SIGN ITSELF IN. Your stored password is correct and RC accepted it.');
    log('   You are signed in right now, and it will do this again ~15 minutes before');
    log('   each hold. You do not need to do anything in the morning.');
    // Tell the server too — this IS a session-liveness measurement, and a green
    // autocart.rc_session is what the 07:30 pre-flight reads.
    await reportSession('warm', 'verified by --test-login');
    // AND RECORD IT AS A REHEARSAL, because that is exactly what it was: the same
    // `runLoginRehearsal` body the nightly one runs, on the same profile, against the real
    // RC. Only `maybeRehearse` reported it at first, which left the two paths running one
    // test and recording half of it — so a login proved by hand at 16:00 did not stop the
    // 20:00 rehearsal spending a SECOND login on the same question, from an address that
    // has been blocked for twelve hours before over exactly that.
    await reportRehearsal(true, 'verified by --test-login', null);
    return true;
  }
  if (result === 'inconclusive') return false;

  log('');
  log('✗✗ THE UNATTENDED LOGIN DOES NOT WORK, and you are now signed OUT.');
  log('   Run mini-pc\\rc-login.bat NOW to sign in by hand — do not leave it.');
  log('   Most likely: the password was mistyped when you saved it (it is hidden, so');
  log('   there is nothing to notice), or RC is showing a CAPTCHA. The line above says');
  log('   which. Re-save with mini-pc\\rc-save-password.bat if it is the password.');
  await reportSession('dead', 'test login failed — a human must sign in');
  // A FAILURE IS THE MORE IMPORTANT ONE TO RECORD. It is the state `autocart.rc_login`
  // exists to shout about, and a hand-run failure is no less real than a scheduled one.
  await reportRehearsal(false, 'test login failed — a human must sign in', null);
  return false;
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
        // THE ONE MOMENT THESE FACTS ARE VISIBLE. The token exchange happens once, at
        // sign-in; after that the app just reuses what it has. Whether a refresh token
        // came back decides whether RC auto-cart can ever be unattended — see
        // rc-token's noteTokenCall. Printed here, and only here, because a keep-warm
        // pass will never see it. Nothing below is a credential.
        const facts = await readAuthFacts(page).catch(() => null);
        if (facts) {
          log('  ── RC AUTH FACTS (local only, no credentials) ──');
          log(`  token call: ${JSON.stringify(facts.tokenCall)}`);
          log(`  grant:      ${JSON.stringify(facts.grant)}`);
          if (facts.authorizeUrl) log(`  authorize:  ${facts.authorizeUrl.slice(0, 240)}`);
          log('  ──────────────────────────────────────────────');
          log('  ^ Send these three lines to CampHawk — hasRefreshToken decides');
          log('    whether the 8am hold can ever run without a human.');
        }
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
if (SAVE_LOGIN) {
  const ok = await saveLogin();
  exitWhenDrained(ok ? 0 : 1);
} else if (TEST_LOGIN) {
  const ok = await testLogin();
  exitWhenDrained(ok ? 0 : 1);
} else if (LOGIN) {
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
    /**
     * THE WATCHDOG, and why it lives in the renew timer.
     *
     * On 2026-08-10 this loop hung and the profile lock stayed held for TEN HOURS. The
     * lock's own STALE_MS could not save it, because this very interval kept renewing:
     * `setInterval` is independent of the `await` that was stuck, so the timer went on
     * announcing "still working" for a loop that had stopped. The preemption flag could
     * not save it either — `profileRequested` is only read INSIDE the hung loop, so the
     * runner's request was never seen and the 08:00 cart failed against a lock nothing
     * could take.
     *
     * The renew timer is therefore the only code proven to still be executing, which
     * makes it the only place a watchdog can live. If the inner loop has not ticked in
     * HUNG_MS, stop asserting liveness we do not have: release the profile and die, so
     * the lock frees, the reports stop being fresh-looking, and the server-side
     * dead-man's switch has something to notice.
     *
     * DYING IS THE POINT. There is no supervisor to restart this — but a dead process
     * that has let go of the profile is strictly better than a live one that holds it
     * and does nothing, and it turns a silent ten-hour failure into a visible one.
     */
    let lastTick = Date.now();
    const tick = () => { lastTick = Date.now(); };
    const renew = setInterval(() => {
      if (Date.now() - lastTick > HUNG_MS) {
        log(`✗ WEDGED — the keep-warm loop has not advanced in ${Math.round((Date.now() - lastTick) / 60_000)}m.`);
        log('  Releasing the profile and exiting so the hold runner can use it.');
        try { clearInterval(renew); } catch {}
        releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
        process.exit(1);
      }
      renewProfileLock(PROFILE_DIR, LOCK_OWNER);
    }, RENEW_MS);
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
          '--hide-crash-restore-bubble',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      });
      await installTokenCapture(ctx);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const primed = await primeToken(page);
      log(`RC loaded and STAYING OPEN — token source: ${primed.source}`);
      log('Leave this browser window ALONE. Closing it stops the renewal; it will reopen.');

      // 0, so the first check fires IMMEDIATELY on every open. After a restart or a yield
      // to the runner, waiting twenty minutes to say anything would leave
      // `autocart.rc_session` stale — reading "we have not confirmed this recently" when
      // in fact we just did, on the one dashboard that decides whether to wake someone.
      let lastCheck = 0;
      let lastExpiryPoll = 0;
      /** The token we last tried to renew. Retrying the SAME one buys nothing — see below. */
      let lastRenewAttemptFor = null;
      for (;;) {
        // The watchdog's heartbeat. Every path through this loop must reach here, so a
        // stall anywhere below it — a Playwright call that never settles, a page that
        // never loads — stops the clock and trips the watchdog above.
        tick();
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
        // SILENT AUTH, on the clock rather than on a fixed cadence. A reload re-runs the
        // app's own OIDC exchange against the persistent "Keep me signed in" cookie —
        // correct client_id, correct redirect_uri, correct PKCE verifier, none of which we
        // would have to guess — and never shows a CAPTCHA, because the challenge lives on
        // the password form, not on a cookie exchange. See renewByReload.
        if (Date.now() - lastExpiryPoll >= EXPIRY_POLL_MS) {
          lastExpiryPoll = Date.now();
          // Before anything else: is a hold about to need a session we do not have?
          if (await maybeAutoLogin(ctx, page).catch((e) => { log(`auto-login error: ${e.message}`); return false; })) {
            continue;
          }
          // AFTER the auto-login, never before. If a hold is close enough that the bot is
          // signing in for it, that login is the real thing and a rehearsal on top would be
          // a second sign-in from this address for one release — which is the budget the
          // one-attempt-per-release rule exists to protect. (rehearsal.mjs also refuses
          // within six hours of a release, so this ordering is a belt on top of a brace.)
          if (await maybeRehearse(ctx, page).catch((e) => { log(`rehearsal error: ${e.message}`); return false; })) {
            continue;
          }
          const { token, source } = await readLiveToken(page).catch(() => ({ token: null, source: 'none' }));
          const left = tokenSecondsLeft(token);
          // `left === null` (no token, or one that will not decode) is NOT a reason to
          // reload on a loop — that would hammer RC every minute on a signed-out page.
          // The 20-minute check reports it; a human decides.
          //
          // ONE ATTEMPT PER TOKEN, and never on an expired one. The first version retried
          // every minute for as long as the token was under the threshold, which on
          // 2026-08-08 meant SIXTEEN reloads between 21:24 and 21:40 — the last five
          // against a token that had already expired, where there is nothing left to
          // renew. That is the request storm the null-guard above was written to avoid,
          // arriving through the other door: a residential address whose WAF has 403'd us
          // before, reloading a site once a minute to no purpose.
          if (left != null && left > 0 && left < RENEW_BEFORE_S && token !== lastRenewAttemptFor) {
            lastRenewAttemptFor = token;
            log(`token has ${Math.round(left / 60)}m left (src=${source}) — renewing by reload`);
            // ASKED FIRST, BECAUSE THE RENEWAL IS DESTRUCTIVE. It clears the stored token to
            // force the app's bootstrap to re-authorize, and with no Okta session behind it
            // that trades a token with minutes left for nothing at all. A probe that errors
            // returns null, which is "we could not tell" and does NOT refuse — refusing on
            // unknown would switch renewal off for good the first time Okta hiccuped.
            const okta = await oktaSessionAlive(ctx).catch(() => null);
            const r = await renewByReload(page, RC_HOME, { oktaAlive: okta?.alive ?? null }).catch((e) => {
              log(`  renew failed: ${e.message}`);
              return null;
            });
            if (r?.skipped) {
              log(`  · skipped: ${r.skipped} — the token is untouched`);
            } else if (r) {
              log(r.renewed
                ? `  ✓ renewed: ${Math.round((r.before ?? 0) / 60)}m → ${Math.round((r.after ?? 0) / 60)}m`
                // NOT "the Okta cookie may be gone" — that was printed for three days with
                // `okta=ALIVE` on the very next line, and the real cause was this function
                // reading its own token back. Say what happened and leave the diagnosis to
                // the fields that actually carry it.
                : `  ✗ no fresher token after the reload (${r.before}s → ${r.after}s)`
                  + `${r.restored ? ' — the previous token was put back' : ''}`);
            }
            // Report immediately either way: this is the event worth seeing on the
            // dashboard, not something to sit on until the next 20-minute tick.
            lastCheck = Date.now();
            await checkAndReport(ctx, page).catch((e) => log(`check failed: ${e.message}`));
          }
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
  const { token: before, source } = await readLiveToken(page);
  const exp = tokenExpiry(before);
  const { live, why } = await sessionLive(ctx, page);
  const after = await readToken(page);
  const changed = before != null && after != null && before !== after;
  // THE OKTA SESSION, separately from the access token. RC's own SDK renews via
  // authorize?prompt=none against this cookie and deletes the tokens when that fails —
  // so a live session with a dead token means the silent exchange is being defeated
  // locally and IS fixable, while both dying together means nothing unattended can work.
  // See oktaSessionAlive.
  const okta = await oktaSessionAlive(ctx).catch(() => null);
  const oktaNote =
    okta?.alive === true ? `okta=ALIVE${okta.expiresAt ? ` (exp ${String(okta.expiresAt).slice(0, 19)})` : ''}`
      : okta?.alive === false ? `okta=GONE(${okta.status})`
      : 'okta=unknown';

  const note =
    (exp ? `token exp in ${Math.round((exp - Date.now()) / 60000)}m` : 'token exp unknown') +
    `; renewed=${changed ? 'YES' : 'no'}; src=${source}; ${oktaNote}`;

  // THE DIAGNOSTIC THAT DECIDES THE NEXT MOVE, logged locally and never reported.
  // Keeping the session warm is finished — the token is never renewed and the app holds
  // nothing once it expires. What remains depends on facts only a sign-in reveals: a
  // refresh token would solve this outright via /oauth2/v1/token, no password and no
  // CAPTCHA; failing that, `authorize?prompt=none` needs the real client_id and
  // redirect_uri. Both cross the wire during `--login`. See rc-token's noteTokenCall.
  // ONCE, next to the first auth facts: what cookies actually back this session. A 404
  // from Okta means "no session" AND "you sent no cookie", and only this tells them
  // apart — which is the difference between "fixable without a human" and "impossible".
  if (!warmedCookiesLogged) {
    warmedCookiesLogged = true;
    const cookies = await authCookieSummary(ctx).catch(() => []);
    const persistent = cookies.filter((c) => c.persistent);
    log(`   cookies: ${cookies.length} total, ${persistent.length} persistent` +
        (persistent.length ? ` → ${persistent.map((c) => `${c.name}@${c.domain}(${c.expiresInMin}m)`).slice(0, 6).join(', ')}` : ''));
    const signin = cookies.filter((c) => String(c.domain).includes('signin.'));
    log(`   signin.reservecalifornia.com: ${signin.length ? signin.map((c) => c.name).join(', ') : 'NONE — no Okta session cookie at all'}`);
  }

  const facts = await readAuthFacts(page).catch(() => null);
  if (facts && (facts.authorizeUrl || facts.tokenCall) && !warmedAuthLogged) {
    warmedAuthLogged = true;
    log('   ── RC AUTH FACTS (local only, no credentials) ──');
    if (facts.tokenCall) log(`   token call: ${JSON.stringify(facts.tokenCall)}`);
    if (facts.grant) log(`   grant:      ${JSON.stringify(facts.grant)}`);
    if (facts.authorizeUrl) log(`   authorize:  ${facts.authorizeUrl.slice(0, 240)}`);
    log('   ────────────────────────────────────────────────');
  }

  // A FAILURE ON A localStorage TOKEN PROVES NOTHING. That copy is not what the app
  // sends, so a 401 from it is our stale read, not RC's verdict — and reporting it as
  // `dead` sends the owner to do a human sign-in over a healthy session. Downgrade to
  // inconclusive, exactly like a 403 or a network error.
  if (live === false && source === 'localStorage') {
    log(`… RC rejected a ${source} token — INCONCLUSIVE, not a dead session (${why})`);
    return;
  }

  // NO TOKEN AT ALL IS NOT "INCONCLUSIVE" — IT IS SIGNED OUT. This branch used to be
  // folded in with the stale-token case above, and the cost was four hours of silence on
  // 2026-08-08: once the session lapsed the app held no token, every 20-minute pass
  // logged "RC rejected a none token — INCONCLUSIVE", and the dashboard was never told
  // again. The last verdict it had was already `false`, so nothing was actively wrong —
  // but a monitor that goes quiet at exactly the moment the thing it watches breaks is
  // the failure mode this whole file exists to remove.
  //
  // Primed first, because a page mid-reload genuinely has nothing to capture yet, and
  // reporting THAT as dead would be the stale-token mistake wearing a different hat.
  if (live === false && source === 'none') {
    const again = await primeToken(page, { timeoutMs: 10_000 }).catch(() => ({ source: 'none' }));
    if (again.source === 'none') {
      // Ask Okta whether the SESSION is gone too. This is the most valuable line in the
      // log: a live session with no token means RC's own silent renew is failing locally
      // and can be fixed; both gone means only a human can help. Without it, "signed out"
      // is a symptom with two completely different cures.
      const okta = await oktaSessionAlive(ctx).catch(() => null);
      const verdict = okta?.alive === true
        ? 'okta session STILL ALIVE — the silent renew is failing, not the login'
        : okta?.alive === false
          ? `okta session GONE (${okta.status}) — only a human sign-in restores it`
          : 'okta session unknown';
      log(`⚠ RC SESSION IS DEAD: the app holds no token at all — signed out`);
      log(`  ${verdict}`);
      log('  A human must sign in once: node rc-keepwarm.mjs --login');
      await reportSession('dead', `no token at all — signed out; ${verdict}`);
      return;
    }
    log(`… no token when first read, but one arrived on priming (${again.source}) — not reporting`);
    return;
  }

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
