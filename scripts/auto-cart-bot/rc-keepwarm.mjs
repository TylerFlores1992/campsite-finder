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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForProfileLock, releaseProfileLockIfMine, renewProfileLock, profileLockHolder,
  profileRequested,
} from './profile-lock.mjs';
import { sweepOrphanChromium } from './orphan-sweep.mjs';
import { withForcedLoginPrompt } from './force-login-prompt.mjs';
import { withNetworkTrace, describeTrace } from './okta-net-trace.mjs';
import {
  startNativeSampling, readNativeProfile, diffProfiles, renderProfile, LONG_LIVED_INTERVAL,
} from './rc-native-sampler.mjs';
import { createAllocTrail, describeAllocTrail } from './rc-alloc-trail.mjs';
import { takeStorageCensus, takeIdbCensus, describeCensus } from './storage-census.mjs';
import {
  installTokenCapture, readLiveToken, readTokenAnyOrigin, primeToken, renewSession, tokenSecondsLeft,
  dropStoredToken,
  readAuthFacts, oktaSessionAlive, authCookieSummary,
  // Bounded page.evaluate — the census runs inside a page we already suspect of hanging.
  evaluateWithin,
} from './rc-token.mjs';
import { hasCredentials, attemptLogin, clickSignInControl } from './rc-autologin.mjs';
import { shouldRehearse, shouldRehearseOnDemand, rehearsalSlot } from './rehearsal.mjs';
import { tokenSecondsNeeded } from './session-coverage.mjs';
import { planRenewal, recordRenewal, newRenewalState, makeSkipLogger } from './renewal-schedule.mjs';
import { settleBudget, budgetForRelease, MAX_KILL_REFUNDS } from './autologin-budget.mjs';
import { warmupPlan, warmupWindowOpen } from './autologin-warmup.mjs';
// The same two clock helpers the update guard decides with. Both are pure and both already
// get the Pacific / zone-less-wall-clock handling right, which is the part that has been
// got wrong before — a second implementation here would be a second chance to get it wrong.
import { pacificHour, hoursUntilRelease } from './update-guard.mjs';
import { loadEnv } from './load-env.mjs';
import { exitWhenDrained } from './exit-clean.mjs';
import { takeSample } from './memory-sample.mjs';
import {
  attachHeapProbe, collectHeapFacts, describeHeapFacts, writeHeapSnapshot,
  sampleHeap, describeTrail, describeRamTrail, TRAIL_KEEP,
} from './rc-heap.mjs';

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
 * Written by the watchdog when it kills the browser, read by the rehearsal gate after the
 * supervisor restarts us. A FILE and not a variable, because the whole point is that the
 * process which knows does not survive to tell the process which needs to know.
 */
const ABNORMAL_EXIT_MARKER = path.join(PROFILE_DIR, '.camphawk-abnormal-exit');

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
 * REMOVED 2026-08-18: `RENEW_BEFORE_S`, the "renew when the token is this close to expiry"
 * threshold. `planRenewal` no longer acts on a live token at all — it waits for the token to
 * lapse and renews from empty, because the near-expiry path is where the Chromium leak begins
 * (RAM trail, `renew:prime-after-reload`) and it has never once produced a fresher token.
 * The constant is gone rather than left unused so nobody wires it back in by accident.
 */
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
 * The margin covers a login that takes a while and the token's life being ~60 rather than
 * exactly 60. It is `AUTOLOGIN_MARGIN_MIN`, derived immediately below — a literal here
 * would let the two disagree, which is how a dead constant starts teaching the wrong
 * number to whoever reads it next.
 *
 * IT IS ALSO UNREAD BY ANY CODE PATH, and is kept as the written form of the inequality the
 * live calculation obeys. Deriving it from the margin is what stops it becoming a second,
 * disagreeing number sitting next to the real one.
 */

/**
 * ── THE HEADROOM, AND WHY TEN IS NOT A CHOSEN NUMBER (2026-08-30) ──────────────────────
 * It was 5, and 5 is not a margin — it is a coin flip with extra steps. The stand-down band
 * is only ten minutes wide, and here is the whole derivation:
 *
 *   A token lives ~60 minutes. Coverage needs it alive until release + CART_HOLD + margin,
 *   i.e. minted no earlier than T−(60 − CART_HOLD − margin). At T−LEAD the token exists at
 *   all, so it was minted in (T−90, T−30]. With margin 5 that makes it "covering" only when
 *   it was minted in [T−40, T−30] — TEN MINUTES OUT OF SIXTY, so roughly one release morning
 *   in six — and inside that band the real slack is uniform on 0 to 10 minutes.
 *
 * So half of the stand-downs this branch produces have under five minutes of slack, and on
 * 2026-08-30 one had TWO SECONDS. There is no number between 5 and 15 that makes the band
 * safe; there is only a number that makes it narrower. Fifteen is exactly
 * `60 − CART_HOLD − LEAD + margin` at today's constants — it closes the band rather than
 * shrinking it, which is the only version of this decision that cannot be lost by seconds.
 *
 * WHAT IT COSTS, STATED: on ~1 morning in 6 the bot signs in at T−30 where it used to stand
 * down. It NEVER adds a second sign-in to a morning — the other five in six already sign in
 * there, so the per-release budget is untouched and the household IP (twelve-hour block,
 * 2026-08-06) sees no more logins than before. Measured cost of that sign-in: −422 MB
 * (2026-08-24), −412 MB (08-25), −408 MB (the 08-30 warm-up).
 *
 * AND THE ARGUMENT DELIBERATELY DOES NOT REST ON PREDICTING THAT COST. A password sign-in
 * was 32 seconds and no memory on 08-26; the 08-30 one took 39 GB of COMMIT. What is
 * predictable is WHERE the unpredictable act lands: at T−30 a guard kill has thirty minutes
 * and a supervisor restart to recover from (2026-08-20 did exactly that and still carted at
 * T+2s); at T−8 it has eight minutes, and on 08-30 it had none.
 */
const AUTOLOGIN_MARGIN_MIN = Number(process.env.RC_AUTOLOGIN_MARGIN_MIN || 15);

const AUTOLOGIN_MIN_TOKEN_MIN = Number(
  process.env.RC_AUTOLOGIN_MIN_TOKEN_MIN || AUTOLOGIN_LEAD_MIN + CART_HOLD_MIN + AUTOLOGIN_MARGIN_MIN,
);

/**
 * How many sign-ins one release may cost, and how far apart.
 *
 * IT WAS ONE, AND ONE WAS A SINGLE POINT OF FAILURE (2026-08-15). The decision was taken
 * once at T−30 and never revisited, through thirty minutes in which the token visibly died:
 * the attempt was spent on a no-op short-circuit at 07:30 and nothing looked again before
 * the 08:00 release. A budget of one means the FIRST answer is the ONLY answer, and a wrong
 * first answer costs the morning.
 *
 * Two, not more, and the gap is what keeps it honest. The rule being protected is that
 * repeated logins from this address cost twelve hours of IP block on 2026-08-06 — so this
 * is deliberately not "retry until it works". Two attempts a few times a month is a
 * different thing from a retry loop, and the second one is what covers a token that dies
 * early or a first attempt that proved nothing.
 */
const AUTOLOGIN_MAX_ATTEMPTS = Number(process.env.RC_AUTOLOGIN_MAX_ATTEMPTS || 2);
const AUTOLOGIN_RETRY_GAP_MS = Number(process.env.RC_AUTOLOGIN_RETRY_GAP_MS || 8 * 60_000);

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
  // `readTokenAnyOrigin`, NOT `readToken`. During a sign-in the page is parked on
  // `signin.reservecalifornia.com`, whose localStorage is a different origin from the
  // `www.` one RC writes its token to — so the page-scoped read returned nothing and this
  // function answered "dead" WITHOUT ASKING RC, for the whole 90s `attemptLogin` waits.
  // Three successful sign-ins were reported as rejected credentials on 2026-08-18 that
  // way. See readTokenAnyOrigin for the measurement.
  const token = (await readTokenAnyOrigin(ctx, page)).token;
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

/**
 * ── A CRASH AND A BAIL WERE THE SAME EXIT CODE (2026-08-30) ────────────────────────────
 * `process.exit(1)` appears exactly once in this file, inside the watchdog's `bail()`. So an
 * exit of 1 read as "a guard fired" — and Node exits 1 on an unhandled throw too, with no
 * handler registered anywhere in this process to say otherwise.
 *
 * On 2026-08-30 the keep-warm exited 1 at 07:59:42, eighteen seconds before a release, and
 * neither bail arm could have fired: RUNAWAY needs free RAM under 2000 MB and the box had
 * 4768 MB; WEDGED needs a 720s stall and the loop had logged 526s earlier. The box was at
 * 97–99% COMMIT for eight minutes, which is the state in which spawning fails — so an
 * unhandled throw is the leading candidate and there was NO WAY TO TELL, because the only
 * record was a stack on stderr in a log the hold runner's retry loop then overwrote.
 *
 * The handlers do not change what happens; they change what it says. Same three steps as
 * `bail()`, in the same order and for the same reasons:
 *
 *   • the ABNORMAL-EXIT MARKER, so the next process knows it is coming up after a kill and
 *     the login rehearsal stands down instead of testing our own restart and reporting it
 *     as a broken sign-in;
 *   • RELEASE THE PROFILE LOCK. This is the half a crash never did. An unhandled throw left
 *     the lock held for STALE_MS (10 minutes) with nothing alive to renew it, so a crash at
 *     07:53 keeps the hold runner off the profile past 08:00 — the documented way to lose a
 *     cart to a repair;
 *   • exit 1, preserving the supervisor's restart behaviour exactly.
 *
 * REGISTERING A HANDLER STOPS NODE EXITING BY ITSELF, so the exit is explicit. Everything
 * before it is wrapped: a handler that throws while reporting a throw is a silent hang.
 */
function diedUnhandled(kind, err) {
  try { log(`✗ ${kind} — the keep-warm is exiting: ${err?.stack || err?.message || String(err)}`); }
  catch { /* the log is best effort; the lock is not */ }
  try { fs.writeFileSync(ABNORMAL_EXIT_MARKER, String(Date.now())); } catch { /* ignore */ }
  try { releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER); } catch { /* ignore */ }
  process.exit(1);
}
process.on('uncaughtException', (err) => diedUnhandled('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', (err) => diedUnhandled('UNHANDLED REJECTION', err));

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
 * RECYCLE THE RESIDENT BROWSER WHEN IT STARTS TO RUN AWAY.
 *
 * On 2026-08-17 the box went from 12% COMMIT to 99% in TEN MINUTES, and both of the
 * morning's failures fall inside that window: the Windows Scheduled Tasks stopped at
 * 05:31:03 as commit crossed ~90%, and the hold runner died at 05:36:31 with 0xC0000409 —
 * the fast-fail `abort()` a Node process produces when it cannot allocate. One cause, two
 * silences, and the 08:00 cart lost with them. It was the SEVENTH such event in 24 hours
 * (99-100% at 16:17, 18:41, 21:40, 00:49, 05:34, 06:49, 08:54, 12:24), every one attributed
 * by the sampler to the `rc` family — this browser.
 *
 * WHY A SIZE BOUND AND NOT AN AGE BOUND. The family sits at 220-300 MB for HOURS and then
 * ramps at ~4,160 MB/min. Recycling on age would have to be absurdly aggressive to land
 * inside a ten-minute cliff, and would spend a session every time for nothing on the ~95%
 * of the day that is flat. A size bound fires roughly twenty seconds into the ramp, at
 * one or two GB, which is nowhere near the point where spawning a process starts failing.
 *
 * THE THRESHOLD IS ~5x THE MEASURED NORMAL, and it is a FAMILY total rather than a single
 * process because the 08-12 event and this one both spread across several. `memory-sample`
 * already owns the scan and its attribution rules — including that `rc` is tested before
 * `auto-cart-bot`, since the RC profile lives inside it and the general test first would
 * file every RC process under rec.gov.
 *
 * A RECYCLE IS NOT A LOSS. Closing and reopening is the SAME action this loop already takes
 * when the window is closed or the runner wants the profile, it takes seconds, and the Okta
 * cookie survives in the profile directory — so the session re-mints by `authorize` from a
 * token-less profile with no credential typed, which is proven on this box (`✓ renewed by
 * authorize: none → 3580s`, 2026-08-16 01:53). What is lost is at most one access token.
 *
 * AND IT IS STRICTLY BETTER THAN THE ALTERNATIVE AT ANY HOUR, INCLUDING 07:59. A browser at
 * 1.5 GB climbing 4 GB/min reaches 25 GB inside six minutes and takes the whole box with it,
 * runner included. A five-second reopen cannot cost more than that.
 */
const RC_MAX_FAMILY_MB = Number(process.env.RC_KEEPWARM_MAX_MB || 1500);

/** How often to look. The expiry poll is 60s and the ramp takes minutes, so this is the
 *  same cadence — checking faster would spawn PowerShell for nothing. */
const MEM_CHECK_MS = Number(process.env.RC_KEEPWARM_MEM_CHECK_MS || 60_000);

/**
 * ── THE SIZE BOUND ABOVE COULD NEVER HAVE FIRED, AND THIS IS WHY (2026-08-17, second pass) ──
 *
 * `RC_MAX_FAMILY_MB` is checked in the resident loop's BODY. The leak happens during a WEDGE,
 * and a wedge is by definition that loop not advancing — `renewing the session` at 15:42:58,
 * `WEDGED — the loop has not advanced in 13m` at 15:55:58. So during every one of the twenty
 * observed ramps, control never returned to the check. **A guard placed inside the thing it
 * guards against is not a guard.** It is the watchdog-wired-to-the-thing-it-watches shape for
 * the third time in this repo — after `expireStaleHolds` living in the feed the dead runner
 * polls, and `reclaimLapsedHolds` living inside `withRC`.
 *
 * The wedge watchdog's own comment already worked this out and is quoted here because the fix
 * is to obey it: *"The renew timer is the only code proven to still be executing, which makes
 * it the only place a watchdog can live."*
 *
 * ── AND THE MEASUREMENT HAD TO CHANGE WITH THE LOCATION ──
 *
 * `rcFamilyMb()` spawns PowerShell, and spawning is EXACTLY what fails at 99% COMMIT — it is
 * the mechanism by which `supervise.ps1` could not start a shell on 2026-08-12 and by which
 * the Scheduled Tasks stopped on 08-17. An instrument that stops answering as the emergency
 * peaks is no use in the emergency, so the fast arm uses `os.freemem()`: no child process, no
 * WMI, no allocation, answers in microseconds under any load.
 *
 * Free RAM is a genuine signal here rather than a proxy, and the series proves it — across the
 * 11:08 ramp it read 13,112 → 9,776 → 4,428 → 1,816 → 1,987 → 1,174 → 881 MB. The commit was
 * not being reserved, it was being TOUCHED.
 *
 * ── IT REQUIRES A STALL TOO, AND THAT IS THE WHOLE SAFETY ARGUMENT ──
 *
 * This is somebody's actual desktop PC. Free RAM alone would fire when the owner opens a
 * browser with too many tabs, and killing the RC session over that is the cry-wolf failure
 * this file has already fixed three times — most expensively at 07:33 on 08-16, where the
 * printed remedy would have destroyed the healthy session it was complaining about.
 *
 * Requiring BOTH makes it specific: the loop ticks about once a second when healthy, so a
 * stall of a minute means we are inside a hung Playwright call, and low RAM at that moment
 * means the browser we are hung against is eating the machine. Neither alone acts.
 *
 * ── 4000 KILLED THE REPAIR IT WAS PROTECTING (2026-08-19), SO IT IS 2000 ──
 *
 * At 4000 this arm was structurally guaranteed to kill every Okta renewal, and it did — five
 * firings, five stalls in `renew:click-sign-in`. That is not a coincidence, it is arithmetic:
 * the navigation ALWAYS takes longer than `MEM_STALL_MS`, and it ALWAYS allocates several GB,
 * so both conditions are met every single time by a renewal that is working correctly.
 *
 *     03:58:37 renewing the session — the token has -1m left (src=live)
 *     04:00:36 ✗ RUNAWAY — stalled 117s with only 3630 MB of free RAM (floor 4000 MB)
 *     04:00:36   RAM trail: 7158→3630 MB free @ renew:click-sign-in (x8)
 *
 * The cost is not the wasted browser. The session had re-minted itself silently for nearly
 * eight hours; when that finally stopped, THIS is the repair that would have restored it, and
 * the guard killed it 78 seconds in. The session then sat dead. `maybeAutoLogin` makes the
 * same navigation at T−30 of a real release, so at 4000 the guard could take the login that a
 * campsite depends on.
 *
 * WHY 2000 IS STILL SAFE, from the box's own series rather than from taste. Free RAM maps to
 * COMMIT roughly: 1,875 MB → 74%, 982 MB → 83%, 520 MB → 89%. The number that matters is ~90%,
 * where Windows stops scheduling tasks, and ~99%, where Node aborts. A floor of 2000 acts at
 * about 73% — seventeen points of margin — while leaving room for a renewal whose worst
 * observed peak is 5,688 MB against a ~9,000 MB idle.
 *
 * AND THE CASE THAT JUSTIFIED 4000 HAS ITS OWN REMEDY NOW. The 25 GB event was an ORPHAN —
 * a browser no process owned, ramping without bound — and this arm never fired on it anyway,
 * because the loop kept ticking and there was no stall. That is `orphan-sweep.mjs`'s job, and
 * it does not depend on this threshold at all. What is left here is the BOUNDED case, and a
 * bounded ramp of ~5 GB is one the box survives comfortably.
 */
const LOW_RAM_MB = Number(process.env.RC_KEEPWARM_LOW_RAM_MB || 2000);

/**
 * How long the loop must ALSO have been stalled before low RAM counts as a runaway.
 *
 * Shorter than `HUNG_MS` by design — that one has to tolerate a full unattended sign-in,
 * which is minutes of legitimate silence, so it cannot be tightened without killing real
 * logins. This arm can be short precisely because it carries the second condition: a sign-in
 * that is merely slow does not also drain 9 GB of RAM.
 */
const MEM_STALL_MS = Number(process.env.RC_KEEPWARM_MEM_STALL_MS || 60_000);

/**
 * How often the watchdog timer runs.
 *
 * IT USED TO BE `RENEW_MS` (2 min), AND THAT IS TOO SLOW TO BOUND THIS. The ramp is ~2,400
 * MB/min, so a two-minute tick lets it gain nearly 5 GB between looks — the tick interval is
 * the overshoot. Ten seconds bounds it at ~400 MB. The profile lock is still renewed on its
 * own `RENEW_MS` cadence inside this timer, so writing the lock file has not got 12x more
 * frequent; only the two checks have.
 */
const WATCHDOG_MS = Number(process.env.RC_KEEPWARM_WATCHDOG_MS || 10_000);



/**
 * Don't thrash. If the browser is somehow over the line the instant it opens, recycling in
 * a tight loop would be a busy loop wearing a fix's clothes — the exact shape
 * `supervise.ps1`'s five-exits rule exists to stop, one level down. Two minutes is longer
 * than a reopen and shorter than the ramp.
 */
const RECYCLE_COOLDOWN_MS = Number(process.env.RC_KEEPWARM_RECYCLE_COOLDOWN_MS || 120_000);

/**
 * The `rc` family's total MB, or null when we could not tell.
 *
 * NULL IS NOT ZERO, and here it must never trigger a recycle. `takeSample` returns null on
 * a failed scan and nulls the family counts when the scan was blind — an unreadable
 * measurement is "we could not tell", the same rule as `unknown` never rounding to
 * `signed-out`. Recycling on a failed read would restart the browser every minute on a box
 * where PowerShell is merely busy.
 */
async function rcFamilyMb() {
  const sample = await takeSample({ log: () => {} }).catch(() => null);
  const mb = sample?.rcMb;
  return typeof mb === 'number' && Number.isFinite(mb) ? mb : null;
}

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
  // WE HOLD THE LOCK, SO ANY CHROMIUM STILL ON THIS PROFILE IS OWNED BY NOBODY. See
  // orphan-sweep.mjs: on 2026-08-18 one such orphan reached 25 GB and took the box to 94%
  // COMMIT while the size guard recycled a healthy browser five times over. Must stay AFTER
  // the lock and BEFORE the launch — the hold runner drives this same directory, and a sweep
  // that ran without the lock could land at 08:00:00 on the Chromium that is carting.
  await sweepOrphanChromium({ log });
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
 * SECONDS until an RC-style Pacific wall-clock timestamp. Both sides are compared as
 * wall-clock in the same zone, so the offset cancels; never `new Date()` on a zone-less
 * string, which reads it in whatever zone this box happens to be in.
 *
 * THIS IS THE PRIMITIVE, AND THE ROUNDED VERSION BELOW IS DERIVED FROM IT. It used to be the
 * other way round, and the rounding reached the one comparison that cannot afford it — see
 * `tokenSecondsNeeded`. Anything deciding whether a token COVERS a hold must use this;
 * `minutesUntil` is for window gates and log text, where a rounded minute is what a reader
 * wants and half a minute changes nothing.
 */
function secondsUntil(releaseAt) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
    const now = `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
    return Math.round((Date.parse(`${releaseAt}Z`) - Date.parse(`${now}Z`)) / 1000);
  } catch {
    return null;
  }
}

/** Minutes until the same, for window gates and for printing. Null propagates as null. */
function minutesUntil(releaseAt) {
  const s = secondsUntil(releaseAt);
  return s == null ? null : Math.round(s / 60);
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
/**
 * EVERY GATE SAYS WHY, AND CONSECUTIVE REPEATS COLLAPSE.
 *
 * This function had five `return false` paths and not one of them logged. On 2026-08-15,
 * working out which had fired took a `tail-log` off the box and 120 lines of scrollback —
 * for the single most release-critical decision the bot makes. "No credentials stored",
 * "the feed is unreachable", "already tried" and "the token looks fine" are four different
 * faults with four different fixes, and they all printed the same nothing. That is the same
 * shape as `status = 'sent'` meaning only "Twilio returned 2xx".
 *
 * The dedupe is why this is affordable: the loop asks every 60 seconds, so an un-collapsed
 * line would be 1,440 identical entries a day and the log would become unreadable — which
 * is its own way of hiding the answer.
 */
let lastAutoLoginSkip = null;
function autoLoginSkip(reason) {
  if (reason !== lastAutoLoginSkip) {
    log(`   auto-login stood down: ${reason}`);
    lastAutoLoginSkip = reason;
  }
  return false;
}

/**
 * Per-release sign-in budget, ON DISK. Reset when the release we are watching changes.
 *
 * ## Why a file, and why the naive version of this fix would have broken 2026-08-20
 *
 * It lived in module memory until now, and `supervise.ps1` restarts this process on exit —
 * so every restart re-issued the whole budget. That is the crash-loop-spends-the-login-budget
 * shape, and repeated logins from this address are what cost the household IP twelve hours on
 * 2026-08-06. It became reachable the moment the login path started reliably tripping the RAM
 * guard: the guard kills the process, the supervisor restarts it, the budget is new.
 *
 * **AND THAT ACCIDENTAL REFUND IS WHAT SAVED THE 08:00 CART ON 2026-08-20.**
 *
 *     07:30  attempt 1 → 9.4 GB ramp → the RAM guard killed the browser
 *     07:43  the supervisor restarted the process
 *     07:48  attempt 2 → signed in, 60m token
 *     08:00  carted at T+2s
 *
 * So persisting a plain counter would have made the box strictly worse on the one morning
 * this was measured: attempt 1 would have counted, and with `AUTOLOGIN_MAX_ATTEMPTS` at 2 the
 * margin before "a human must sign in" would have been one attempt instead of two.
 *
 * ## So a killed attempt is INCONCLUSIVE, and is refunded deliberately
 *
 * An attempt that was killed mid-navigation observed no credential outcome — RC was never
 * told yes or no. That is exactly `provedNothing`, which this function already refunds, and
 * the rule this file applies everywhere else: **we could not ask is not the same as being
 * told no.** The difference is that it is now refunded BY THE RECORD rather than by the
 * accident of process memory, so it is bounded and legible instead of unlimited and invisible.
 *
 * The mechanism is `startedAt`: set when an attempt begins, cleared when it reaches a verdict.
 * A file found with `startedAt` still set can only mean the process died mid-attempt, and
 * that attempt is given back — ONCE, tracked by `killed`, so a genuine crash LOOP still
 * exhausts the budget rather than refunding for ever. That single-refund bound is the whole
 * difference between this and the in-memory behaviour it replaces.
 */
const AUTOLOGIN_STATE = path.join(HERE, 'logs', '.autologin-budget.json');

/**
 * Read the budget back off disk. The RULE lives in `autologin-budget.mjs`; this is only the
 * I/O, and the split is the one this file keeps making for the same reason — importing this
 * module starts the keep-warm loop, so a decision left in here cannot be tested at all, and
 * the kill-refund arm only ever runs after a crash.
 */
function loadAutoLogin() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(AUTOLOGIN_STATE, 'utf8'));
  } catch {
    // Missing or unreadable is a FRESH budget. See settleBudget for why this direction.
    raw = null;
  }
  const { budget, refunded } = settleBudget(raw);
  if (refunded) {
    // SAID OUT LOUD. A silent refund is indistinguishable from a budget nothing has spent,
    // and at 07:45 the difference is whether an attempt was killed or never made.
    log(`   the previous sign-in attempt was killed before it reached a verdict — refunded `
      + `(the allowance is ${MAX_KILL_REFUNDS} per release, and it is now used)`);
  }
  return budget;
}

function saveAutoLogin(st) {
  try {
    fs.writeFileSync(AUTOLOGIN_STATE, JSON.stringify(st));
  } catch (e) {
    // Never fatal. Losing the ration's durability is survivable; losing the login is not —
    // the same trade the reporter makes, and the reason this is not awaited into a throw.
    log(`   (could not persist the sign-in budget: ${e.message})`);
  }
}

let autoLogin = loadAutoLogin();

/**
 * The WARM-UP's own ration, in its own file.
 *
 * A SEPARATE FILE, NOT A FIELD ON THE AUTO-LOGIN BUDGET. That budget carries the kill-refund
 * arithmetic (`startedAt`, `killed`, `MAX_KILL_REFUNDS`), which is subtle, release-critical
 * and was got wrong once already; threading a second counter through `settleBudget` would put
 * a new field inside the one piece of state that decides whether an 08:00 cart gets a session.
 * Two small files cannot interfere with each other.
 *
 * PERSISTED, for the reason the auto-login budget is. `supervise.ps1` restarts this process on
 * exit and the warm-up is exactly the kind of long Okta navigation the RAM guard kills — so an
 * in-memory counter would be re-issued by the very event that ends an attempt, and over a
 * 2.5-hour window polled every minute that is an unbounded sign-in loop from an address that
 * has been blocked for less.
 *
 * NO KILL REFUND HERE, deliberately. A killed warm-up leaves us exactly where we started, with
 * `maybeAutoLogin`'s full budget intact at T−30 — the status quo — so forgiving it buys a
 * second password submission for no change in outcome. The auto-login refunds because there
 * the alternative is a missed cart; here it is a slower morning.
 */
const WARMUP_STATE = path.join(HERE, 'logs', '.autologin-warmup.json');

function loadWarmup() {
  try {
    const raw = JSON.parse(fs.readFileSync(WARMUP_STATE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        release: typeof raw.release === 'string' ? raw.release : null,
        spent: Number.isFinite(raw.spent) && raw.spent >= 0 ? raw.spent : 0,
      };
    }
  } catch { /* missing or unreadable */ }
  // UNREADABLE IS A FRESH RATION, matching settleBudget's direction: a diagnostics problem
  // must not become a refusal to prepare for a release. The bound that matters is the
  // per-release one, and a corrupt file is not evidence the turn was taken.
  return { release: null, spent: 0 };
}

function saveWarmup(st) {
  try {
    fs.writeFileSync(WARMUP_STATE, JSON.stringify(st));
  } catch (e) {
    log(`   (could not persist the warm-up ration: ${e.message})`);
  }
}

let warmup = loadWarmup();
let lastWarmupSkip = null;

function warmupSkip(reason) {
  // Collapsed like every other gate here: this is asked every poll, and 1,440 identical
  // lines a day hides the answer as effectively as printing nothing.
  if (reason !== lastWarmupSkip) {
    log(`   warm-up stood down: ${reason}`);
    lastWarmupSkip = reason;
  }
  return false;
}

/**
 * SIGN IN EARLY WHEN THE SIGN-IN IS GOING TO BE THE EXPENSIVE KIND.
 *
 * The rule is `autologin-warmup.mjs`; this is the I/O around it. See that file's header for
 * why this exists at all — briefly: `maybeAutoLogin` acts only inside `AUTOLOGIN_LEAD_MIN`, so
 * a 12-minute, 9.4 GB password sign-in can currently happen at no time EXCEPT the
 * release-critical window, where a RAM-guard kill can hold the profile lock past 08:00 and
 * cost the cart.
 *
 * It returns true when it did something, so the caller can `continue` — the same contract as
 * `maybeAutoLogin` and `maybeRehearse`.
 */
async function maybeWarmupLogin(ctx, page) {
  if (!hasCredentials()) {
    return warmupSkip('no credentials are stored on this box — run mini-pc\\rc-save-password.bat');
  }
  const { nextRelease: release, reachable } = await feedFacts();
  // UNREACHABLE IS NOT "NO HOLD" — the same distinction maybeAutoLogin draws. Being blind is
  // not being idle, and it must not read as a quiet night.
  if (!reachable) {
    return warmupSkip('the hold feed is unreachable, so we cannot tell whether a release is coming');
  }
  if (!release) return warmupSkip('no hold is queued');

  if (warmup.release !== release) {
    warmup = { release, spent: 0 };
    saveWarmup(warmup);
  }

  const mins = minutesUntil(release);
  /**
   * THE WINDOW IS CHECKED BEFORE OKTA IS PROBED, and that ordering is the point of
   * `warmupWindowOpen` being its own export. `oktaSessionAlive` hits
   * `/api/v1/sessions/me`; `checkAndReport` already calls it every poll, and a second
   * unconditional call would double our traffic to that endpoint from an address both
   * providers have blocked — to answer a question that matters for a few minutes a month.
   */
  const win = warmupWindowOpen({
    minutesUntilRelease: mins,
    criticalLeadMin: AUTOLOGIN_LEAD_MIN,
  });
  if (!win.open) return warmupSkip(win.why);

  const okta = await oktaSessionAlive(ctx).catch(() => null);
  const plan = warmupPlan({
    minutesUntilRelease: mins,
    criticalLeadMin: AUTOLOGIN_LEAD_MIN,
    oktaAlive: okta ? okta.alive ?? null : null,
    spent: warmup.spent,
  });
  if (!plan.go) return warmupSkip(plan.why);

  /**
   * A TAB THAT CANNOT OPEN IS A STAND-DOWN, NOT AN ATTEMPT — taken before the ration is
   * spent, exactly as `maybeAutoLogin` does it. A browser too sick to open a page never
   * asked RC anything.
   */
  const tab = await ctx.newPage().catch((e) => {
    log(`  ✗ could not open a warm-up tab: ${e.message}`);
    return null;
  });
  if (!tab) return warmupSkip('could not open a warm-up tab — nothing was spent');

  /**
   * SAMPLE THE ONE OKTA TRIP NOTHING WAS WATCHING — see rc-native-sampler.mjs.
   *
   * THIS PATH IS BY CONSTRUCTION THE EXPENSIVE ONE. `warmupPlan` only says go when Okta is
   * GONE, which is precisely the full password form — the twelve-minute, ~9,434 MB trip of
   * 2026-08-20, the largest event ever measured here. The sampler shipped wired to the
   * renewal (the cheap trip) and 08-20 added the auto-login; this third door was left open
   * and it is the widest.
   *
   * IT COST AN ORDERED EXPERIMENT. A real test hold was queued for 2026-08-24 to MANUFACTURE
   * a ramp at a predictable time. The ramp arrived exactly as predicted — 9,338 MB,
   * 05:00:51→05:11 PT, 89% COMMIT, renderer 90% of it, two minutes after this window opened
   * — and `native_alloc_readings` recorded NOTHING for it, because this function has no
   * instrument. That is the fifth instance of the house shape (an instrument bolted to two of
   * three doors) and the first where it cost a measurement somebody deliberately set up.
   *
   * ON THE TAB'S OWN CDP SESSION, STARTED HERE, for the reason `attachHeapProbe` exists: the
   * expensive negotiation must happen while the browser is healthy, and a tab three lines old
   * is as healthy as it gets. CDP has twice been measured going quiet as a ramp peaks, so only
   * the cheap read may land afterwards.
   *
   * THE BEFORE-READING IS TAKEN AND DIFFED even though a fresh tab has allocated nothing.
   * Whether a new tab gets its own renderer or shares the resident page's is NOT established;
   * if it shares one, an all-time profile carries hours of the resident page's history and
   * would report it as this trip's. Diffing is correct either way.
   */
  const sampler = await ctx.newCDPSession(tab).catch(() => null);
  const sampling = sampler ? await startNativeSampling(sampler) : { ok: false, why: 'no CDP session' };
  const profBefore = sampling.ok ? await readNativeProfile(sampler) : null;
  // AND ON THE TRAIL, which is what sees a trip that never returns. The reading below is taken
  // on the return path and is gated at 400 MB, so a ramp that kills the browser mid-trip
  // reports nothing at all — that is six ramps missed. See rc-alloc-trail.mjs. Unregistered in
  // the `finally`.
  if (sampling.ok) allocTrail.register('warmup', sampler);

  lastWarmupSkip = null;
  warmup.spent += 1;
  saveWarmup(warmup);
  log(`🌅 warming up the session: ${plan.why}`);
  /**
   * DECLARED OUTSIDE THE `try` so the `finally` can read it, exactly as `maybeAutoLogin`
   * does. `attemptLogin` is deliberately not caught here: this function has no `dead`
   * branch to route a throw into, and inventing one is not an instrument's business.
   */
  let trace = null;
  try {
    /**
     * NO `sufficient` DEADLINE, and that is the difference from `maybeAutoLogin`.
     *
     * That caller must prove the token will still be alive at T+15, because it is the last
     * thing between a queued hold and a missed cart. This one is not trying to cover the
     * release and CANNOT — the token lives ~60 minutes and the release is hours away. Its
     * whole product is the OKTA SESSION left behind, which is what makes the T−30 sign-in
     * cookie-answered instead of a password form.
     *
     * Passing a deadline here would be actively wrong: it would report a perfectly
     * successful warm-up as a failure for not covering something it was never aimed at.
     */
    /**
     * COUNT THE BYTES, AND — the part that is not optional — GET THE FREE-RAM PAIR.
     *
     * A sampler reading with no RAM delta is the artifact that nearly retired the buffering
     * candidate on 2026-08-19: a trace of a navigation that never ramped says nothing about
     * the leak, and without the pairing there is no way to tell which kind of reading you are
     * holding. `reportNativeAlloc` refuses to store a reading whose delta is missing or small,
     * so without this wrapper the sampling above would be silently inert — a fix present and
     * doing nothing, which is the shape this repo has shipped three times.
     *
     * ON THE TAB, so the listener dies with the tab rather than accumulating a record per
     * response for the life of the resident page. Responses are counted, never read.
     */
    const { result: r, trace: t } = await withNetworkTrace(tab, () => attemptLogin(ctx, tab, {
      homeUrl: RC_HOME,
      isLive: async () => (await sessionLive(ctx, tab)).live === true,
      log,
    }));
    trace = t;
    // JUDGED ON OKTA, NOT ON THE TOKEN. Re-probed rather than assumed: `ok` means the sign-in
    // returned, and what we actually need to know is whether the thing we came for exists.
    const after = await oktaSessionAlive(ctx).catch(() => null);
    if (after?.alive === true) {
      log('  ✓ Okta session established — the sign-in before the release will be the cheap one');
      // TELL THE RESIDENT PAGE, for the same reason maybeAutoLogin does: the tab minted into
      // the shared profile, but `checkAndReport` reads the resident page, which is still
      // rendered signed-out. Without this every later report announces a dead session over a
      // repair that actually happened.
      await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await primeToken(page, { timeoutMs: 15_000 }).catch(() => {});
    } else {
      // NOT REPORTED AS A SESSION VERDICT. `checkAndReport` owns that, runs moments later on
      // the same tick, and asks RC properly. A warm-up that failed says nothing new about
      // whether RC accepts the current token, and posting `dead` from here would be a second
      // voice on a field that already has an authority.
      log(`  ✗ warm-up did not establish an Okta session: ${r.reason}`);
      log(`    The auto-login still has its full budget at T-${AUTOLOGIN_LEAD_MIN} — this costs `
        + 'nothing but the chance to have done it early.');
      await saveFailureShot(tab, 'autologin-warmup');
    }
  } finally {
    /**
     * IN THE `finally`, so it prints on EVERY path — the same rule the auto-login states.
     * A warm-up that ramps 9 GB is by definition one that struggled, so a reading gated on
     * success would miss the events it exists for. A throw leaves no trace, and that says so
     * rather than printing nothing: silence would be indistinguishable from a trip that moved
     * no bytes, which is the one reading that would falsely eliminate buffering.
     *
     * (It cannot cover a RAM-guard kill: that takes the process, so no `finally` runs. The
     * memory series remains the only witness to those.)
     */
    log(trace
      ? `  ${describeTrace(trace)}`
      : '  network trace: unavailable — the warm-up threw before the trace closed');
    if (sampling.ok) {
      const profAfter = await readNativeProfile(sampler);
      // FROM THE TRACE, so the profile and the RAM delta describe the same window — the
      // correction the auto-login's sampler had to make: a tab-lifetime pair would include
      // the resident-page reload above, which is a renderer this profile cannot see.
      const ram = trace?.ram ? trace.ram.afterMb - trace.ram.beforeMb : null;
      const diff = diffProfiles(profBefore, profAfter);
      log(renderProfile(diff, ram));
      // 'warmup' IS THE ALLOW-LISTED SPELLING (src/lib/native-alloc.ts). The server keeps a
      // CONTEXTS set and stores anything else as NULL, so a plausible-looking 'warmup-login'
      // here would land the reading unattributed — present in the table, useless in the
      // readout, and looking for all the world like the instrument working.
      reportNativeAlloc('warmup', diff, ram);
    } else {
      log(`  native allocation: not sampled (${sampling.why})`);
    }
    // THE CLOSE IS THE CURE, so it is in a `finally`. A renderer's memory dies with its page;
    // this is the same reclaim PR #142 gave the renewal and 08-20 gave the auto-login.
    //
    // AFTER the reporting above, not before: `saveFailureShot` photographs this tab and the
    // profile read needs it alive, so closing first would cost both.
    // OFF THE TRAIL BEFORE THE TAB GOES. The renderer dies with the tab, so a sampler left
    // registered would ask a dead target every 20s for the life of the process. The BUFFER is
    // kept deliberately — `takeRamps` reports a segment once its target is no longer open, so
    // this is exactly what makes the tab's peak final and reportable on the next tick.
    allocTrail.unregister('warmup');
    await tab.close().catch(() => {});
  }
  return true;
}

/**
 * The renewal ration, and it lives at MODULE scope on purpose.
 *
 * `warmResident` reopens its browser constantly — it stands down whenever the hold runner
 * wants the Chromium profile, and on 2026-08-15 that happened ten times in four hours. State
 * held inside the reopen loop would reset on every one of those, so the floor and the backoff
 * would bound nothing at all and a dead Okta session would be re-asked every few minutes from
 * an address that has been IP-blocked for less. `lastCheck`/`lastExpiryPoll` are reset per
 * open deliberately (see their comment); this is the opposite case and the distinction is the
 * whole point of separating them.
 */
let renewal = newRenewalState();

/**
 * Same collapse as `autoLoginSkip` above: the loop asks every 60s and would otherwise print
 * 1,440 lines a day, which hides the answer as thoroughly as printing none.
 *
 * TWO DIFFERENCES FROM ITS NEIGHBOUR, and both were paid for. It compares the STATE and not
 * the sentence — `autoLoginSkip`'s reasons are constant strings, while every reason here
 * carries a minute count that changes on every ask, so the same comparison would collapse
 * nothing at all. And it lives in `renewal-schedule.mjs` rather than here, because as six
 * lines in this file it was guarded by a regex on its own shape and a mutation that
 * reinstated the volatile comparison from inside the body matched that shape and passed.
 */
const renewalSkip = makeSkipLogger((reason) => log(`   renewal stood down: ${reason}`));


/** `null` seconds is "no token", which must not render as the string "null". */
const secsText = (v) => (v == null ? 'none' : `${v}s`);

async function maybeAutoLogin(ctx, page) {
  if (!hasCredentials()) {
    return autoLoginSkip('no credentials are stored on this box — run mini-pc\\rc-save-password.bat');
  }
  const { nextRelease: release, reachable } = await feedFacts();
  // UNREACHABLE IS NOT "NO HOLD". Both produce a null release, and one of them means we are
  // blind rather than idle — the distinction that `hasAvailabilityInRange` returning null
  // exists to preserve. It cannot be acted on (we do not know if a cart is coming) but it
  // must not read as a quiet, healthy night.
  if (!reachable) {
    return autoLoginSkip('the hold feed is unreachable, so we cannot tell whether a release is coming');
  }
  if (!release) return autoLoginSkip('no hold is queued');

  if (autoLogin.release !== release) {
    // A NEW RELEASE IS A NEW BUDGET, and it must be written: otherwise a restart reloads
    // the previous release's spend and applies it to this one.
    autoLogin = budgetForRelease(autoLogin, release);
    saveAutoLogin(autoLogin);
  }

  const mins = minutesUntil(release);
  if (mins == null) return autoLoginSkip(`could not read the release time (${release})`);
  if (mins > AUTOLOGIN_LEAD_MIN) {
    return autoLoginSkip(`the release is ${Math.round(mins)}m away, outside the ${AUTOLOGIN_LEAD_MIN}m lead`);
  }
  if (mins < -20) return autoLoginSkip(`the release was ${Math.round(-mins)}m ago, past the retry window`);

  /**
   * WHAT "COVERED" MEANS, COMPUTED FROM WHERE WE ACTUALLY ARE.
   *
   * `AUTOLOGIN_MIN_TOKEN_MIN` is derived for the moment the lead OPENS (L + cart hold + 5)
   * and was then applied at every moment inside it. At T−30 that is right; at T−5 it demands
   * fifty minutes of token to cover twenty minutes of work, so a perfectly adequate session
   * reads as insufficient and buys a needless sign-in — and the whole point of rationing
   * logins is not to spend them needlessly.
   *
   * The requirement is the same sentence the constant's own comment gives, evaluated now:
   * alive until the release, plus the cart hold, plus margin.
   */
  /**
   * IN SECONDS, NEVER ROUNDED MINUTES — see `tokenSecondsNeeded`. `mins` above is fine for
   * the window gates and the log text; it is not fine here, because rounding turns the
   * requirement into a sixty-second staircase against a token that decays continuously, and
   * a deficit smaller than the step then reads as covered. That cost a campsite on
   * 2026-08-30: a token two to sixteen seconds short was called covered twenty-two times
   * across twenty-one minutes, and the sign-in it deferred ran INTO the release.
   */
  const secs = secondsUntil(release);
  if (secs == null) return autoLoginSkip(`could not read the release time (${release})`);
  const needSec = tokenSecondsNeeded(secs, CART_HOLD_MIN, AUTOLOGIN_MARGIN_MIN);
  const covers = (left) => left != null && left > needSec;

  const { token } = await readLiveToken(page).catch(() => ({ token: null }));
  const left = tokenSecondsLeft(token);
  if (covers(left)) {
    /**
     * THE SLACK IS PRINTED, and it is the number that matters. "50m left, needs 50m" was the
     * whole log record of a decision that was losing by seconds, and it read as comfortable.
     */
    return autoLoginSkip(
      `the token covers this hold (${Math.round(left / 60)}m left, needs ${Math.round(needSec / 60)}m, `
      + `slack ${Math.round((left - needSec) / 60)}m)`);
  }

  if (autoLogin.spent >= AUTOLOGIN_MAX_ATTEMPTS) {
    return autoLoginSkip(
      `all ${AUTOLOGIN_MAX_ATTEMPTS} sign-in attempts for this release are spent — a human must sign in`);
  }
  if (autoLogin.spent > 0 && Date.now() - autoLogin.lastAt < AUTOLOGIN_RETRY_GAP_MS) {
    const wait = Math.ceil((AUTOLOGIN_RETRY_GAP_MS - (Date.now() - autoLogin.lastAt)) / 60_000);
    return autoLoginSkip(`waiting ${wait}m before spending the second sign-in attempt`);
  }

  /**
   * THE SIGN-IN RUNS IN A THROWAWAY TAB — the same cure PR #142 gave the renewal, arriving
   * here because 2026-08-20 measured what this path costs on the resident page.
   *
   *     07:29  12%   rc   300 MB  pid 6360    flat
   *     07:31  64%   rc 2,811 MB  pid 6452    the auto-login's Okta navigation
   *     07:41  76%   rc 9,434 MB  pid 6452
   *     07:43  12%   rc   230 MB  pid 7560    the RAM guard killed it
   *
   * Twelve minutes and 9.4 GB — four times the worst renewal and six times as long, because
   * `okta=GONE` forces a full password sign-in, the longest Okta navigation there is and the
   * one nothing had ever measured. A renderer's memory dies with its page, so the trip gets
   * its own page: same context, same cookies, same localStorage, so the minted token lands
   * in the same profile, and the allocation is reclaimed at close instead of by killing the
   * browser.
   *
   * WHY THIS MATTERS MORE HERE THAN FOR THE RENEWAL. A guard kill leaves the profile lock
   * reading as HELD for `STALE_MS` (10 min), and only a living holder renews it — so nothing
   * can preempt it cooperatively, because nothing is left to read
   * `.camphawk-profile-wanted`. A kill at 07:33 clears by 07:43 and is harmless. A kill at
   * 07:53 holds the lock past 08:00, and the hold runner cannot take the profile for the
   * cart. That is the whole failure this is here to remove.
   *
   * EVERYTHING THAT TOUCHES A PAGE IS BOUND TO THE TAB, and this is where it would silently
   * go wrong: `sufficient` and the post-login read must see the token the TAB minted, since
   * `window.__camphawkRcToken` is per-page; `isLive` must ask about the tab, which during a
   * sign-in sits on `signin.reservecalifornia.com`; and `saveFailureShot` must photograph
   * the tab, or it captures a resident page on which nothing happened. A version that moved
   * only `attemptLogin` would look right, run the navigation in the tab, and still read and
   * photograph the wrong page.
   *
   * WHAT IS NOT CLAIMED: that a tab close reclaims a NINE-gigabyte trip. The renewal's
   * trips are 140-350 MB and drain in place on an unchanged pid; nothing has yet closed a
   * tab that ramped this far, and the 08-20 event put 1,330 MB in a `utility` process,
   * which is not the renderer. The memory series is the reading — a spike that drains at
   * tab close with no `♻ recycling` line is this working — and the RAM arm still contains
   * the case where it does not.
   *
   * A TAB THAT CANNOT OPEN IS A STAND-DOWN, NOT AN ATTEMPT. It is taken BEFORE the budget is
   * spent, because a browser too sick to open a page never asked RC anything — the same rule
   * as `provedNothing`, applied before the fact instead of refunded after it.
   */
  const tab = await ctx.newPage().catch((e) => {
    log(`  ✗ could not open a sign-in tab: ${e.message}`);
    return null;
  });
  if (!tab) {
    return autoLoginSkip('could not open a sign-in tab — the browser may be unwell; nothing was spent');
  }

  /**
   * NAME THE ALLOCATION ON THE BIGGEST TRIP THERE IS — see rc-native-sampler.mjs.
   *
   * The sampler shipped wired to the RENEWAL only, and the renewal is the CHEAP Okta trip:
   * 140-350 MB when it behaves, 2.3 GB at its worst. This path is the expensive one — 9.4 GB
   * over twelve minutes on 2026-08-20, because `okta=GONE` forces the full password form —
   * and it had no instrument on it at all. The single largest measured event in the whole
   * investigation was the one nothing was sampling.
   *
   * ON THE TAB'S OWN CDP SESSION, and started HERE rather than at launch, for the reason
   * `attachHeapProbe` exists: the expensive negotiation must happen while the browser is
   * healthy, and a tab three lines old is as healthy as it gets. Only the cheap read has to
   * land afterwards, and CDP has twice been measured going quiet as a ramp peaks.
   *
   * THE BEFORE-READING IS TAKEN AND DIFFED even though a fresh tab has allocated nothing.
   * Whether a new tab gets its own renderer or shares the resident page's is NOT established;
   * if it shares one, an all-time profile carries hours of the resident page's history and
   * would report it as this trip's. Diffing is correct either way, which beats depending on
   * a fact nobody has measured.
   *
   * AND THE FREE-RAM PAIR COMES FROM THE NETWORK TRACE, which brackets `attemptLogin` alone.
   *
   * CORRECTING WHAT THIS COMMENT SAID WHEN THE SAMPLER LANDED. It argued for a pair bracketing
   * the TAB'S WHOLE LIFE, on the grounds that that is the window the all-time profile covers.
   * That reasoning missed a step: the `r.ok` branch reloads the RESIDENT page, and that
   * navigation is inside the tab-lifetime window while being in a different renderer that the
   * tab's profile does not cover. So the wider window counts RAM the profile cannot see and
   * inflates the delta against it. The login-only pair is the closer match, and it is what the
   * renewal already uses.
   *
   * A RAM PAIR OF SOME KIND IS NOT OPTIONAL: a sampler reading with no delta is the artifact
   * that nearly retired the buffering candidate on 2026-08-19 — a trace of a navigation that
   * never ramped says nothing about the leak, and without the pairing there is no way to tell
   * which kind of reading you are holding. `os.freemem()` is a syscall, so unlike `rcFamilyMb()`
   * it keeps answering under the pressure this is here to observe.
   */
  const sampler = await ctx.newCDPSession(tab).catch(() => null);
  const sampling = sampler ? await startNativeSampling(sampler) : { ok: false, why: 'no CDP session' };
  const profBefore = sampling.ok ? await readNativeProfile(sampler) : null;
  // AND ON THE TRAIL, which is what sees a trip that never returns. The reading below is taken
  // on the return path and is gated at 400 MB, so a ramp that kills the browser mid-trip
  // reports nothing at all — that is six ramps missed. See rc-alloc-trail.mjs. Unregistered in
  // the `finally`.
  if (sampling.ok) allocTrail.register('auto-login', sampler);

  lastAutoLoginSkip = null;
  autoLogin.spent += 1;
  autoLogin.lastAt = Date.now();
  // STAMPED AND WRITTEN BEFORE THE ATTEMPT, not after. Written after, an attempt that never
  // returns is an attempt the budget never saw — which is the in-memory behaviour this
  // replaces, and an unbounded one. `startedAt` is what lets the next process tell "killed
  // mid-navigation" from "tried and was told no"; they need opposite answers and until now
  // they were the same silence.
  autoLogin.startedAt = Date.now();
  saveAutoLogin(autoLogin);
  log(`⏰ hold releases in ${mins}m and the session will not cover it — signing in `
    + `(attempt ${autoLogin.spent} of ${AUTOLOGIN_MAX_ATTEMPTS})`);
  /**
   * DECLARED OUTSIDE THE `try` so the `finally` can read it. `attemptLogin` is not wrapped in
   * a catch here — deliberately, because turning a thrown login into `{ ok: false }` would
   * route it to the `dead` branch, and `dead` is the severity that rings the owner's phone and
   * prints `rc-login.bat`. That is a change to release-critical behaviour and it is not this
   * instrument's business to make. So on a throw the trace never closes, `trace` stays null,
   * and the teardown says so rather than printing a figure it does not have.
   */
  let trace = null;
  try {
  /**
   * COUNT THE BYTES ON THE BIGGEST OKTA NAVIGATION THERE IS — see okta-net-trace.mjs.
   *
   * "Network/IPC buffering" has been the leading explanation in three separate CLAUDE.md
   * entries and has never once been tested, though it is directly observable: non-JS memory
   * growing by gigabytes in the renderer AND the browser process is the shape of a huge or
   * looping response. The renewal has been traced since 2026-08-19; this path — twelve minutes
   * and 9.4 GB on 08-20, the largest event ever measured here — never was.
   *
   * A NEGATIVE IS THE POINT, and it is worth more here than on the renewal: small numbers
   * against a multi-gigabyte ramp eliminate the whole buffering family on the very trip that
   * makes the strongest case for it.
   *
   * ON THE TAB, so the listener dies with the tab and cannot accumulate a record per response
   * for the life of the resident page — a small leak added by the thing investigating a large
   * one. Responses are counted, never read: `response.body()` would buffer the payload into
   * this process, which on a page suspected of moving hundreds of megabytes is the cure
   * arriving as part of the disease.
   */
  const { result: r, trace: t } = await withNetworkTrace(tab, () => attemptLogin(ctx, tab, {
    // THE DEADLINE, HANDED TO THE THING THAT SHORT-CIRCUITS ON IT. Without this,
    // `attemptLogin` accepts any live session and reports the hold covered — which is
    // precisely how 2026-08-15 was lost, with this function's own arithmetic saying the
    // opposite one line earlier.
    //
    // `null` when the token cannot be decoded, never `false`: forcing a sign-in drops a
    // token that may have been fine, and an unknown must not trigger a destructive act.
    sufficient: async () => {
      // THE TAB, because the token this is asking about is the one the tab just minted and
      // `window.__camphawkRcToken` is per-page. Against the resident page this reads the
      // pre-login nothing, decides the session is still short, and drives a second sign-in
      // over a login that had already worked.
      const cur = (await readLiveToken(tab).catch(() => ({ token: null }))).token;
      const secs = tokenSecondsLeft(cur);
      return secs == null ? null : secs > needSec;
    },
    homeUrl: RC_HOME,
    // THE TAB AGAIN. `sessionLive` goes through `readTokenAnyOrigin`, which exists because
    // during a sign-in the page sits on `signin.reservecalifornia.com` — a different origin
    // from the `www.` one RC writes the token to. Asking about the resident page instead
    // would answer for whichever origin IT happens to be on, which is not where the login is.
    isLive: async () => (await sessionLive(ctx, tab)).live === true,
    log,
  }));
  trace = t;
  if (r.ok) {
    // SAY WHAT THE TOKEN ACTUALLY IS, rather than asserting the outcome. "the hold is
    // covered" was printed on 2026-08-15 over a session that died seven minutes before the
    // release — it was a restatement of the intent, not a reading of the result, and it is
    // what made the log look like a success for the next thirty minutes.
    // READ THE TAB. It is where the credential was submitted and where the token was minted;
    // the resident page has not navigated and would report the stale nothing that made us
    // sign in — turning a successful login into "STILL SHORT" and a `dead` verdict.
    const after = tokenSecondsLeft((await readLiveToken(tab).catch(() => ({ token: null }))).token);
    const enough = covers(after);
    // AND TELL THE RESIDENT PAGE. The tab minted into the SHARED profile (localStorage is
    // per-origin, not per-page), but the resident SPA is still rendered signed-out and
    // `checkAndReport` reads THAT page. Without this reload every later report would
    // announce a dead session over a fresh hour of token — a repair that happened and
    // cannot be seen. Exactly the step the tab renewal needed for the same reason.
    if (after != null) {
      await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await primeToken(page, { timeoutMs: 15_000 }).catch(() => {});
    }
    log(after == null
      ? `  ✓ ${r.reason} — but the token could not be decoded, so coverage is UNCONFIRMED`
      : `  ${enough ? '✓' : '✗'} ${r.reason} — token now ${Math.round(after / 60)}m, `
        + `needs ${Math.round(needSec / 60)}m ${enough ? '(covered)' : '(STILL SHORT)'}`);

    // AN ATTEMPT THAT EXERCISED NOTHING IS NOT AN ATTEMPT. `provedNothing` means RC was
    // already signed in and no credential was submitted, so nothing was spent and nothing
    // was learned — refunding it is what lets the T−5 re-check still happen. The retry gap
    // above is what stops this becoming a loop.
    if (r.provedNothing) {
      autoLogin.spent -= 1;
      log('    (no sign-in was exercised, so the attempt is not counted against the budget)');
    }
    await reportSession(enough ? 'warm' : 'dead', enough
      ? 'signed in automatically before a hold'
      : `auto sign-in returned ok but the token is still short of the hold: ${r.reason}`);
  } else if (r.sessionLive) {
    // A LIVE SESSION IS NEVER REPORTED DEAD, WHATEVER THE COVERAGE SAYS.
    //
    // `attemptLogin` reaches its no-form exit for two opposite reasons, and only one of them
    // is a fault: RC refused us, or RC is already signed in and shows no form because there
    // is nothing to fill. `sessionLive` is that second case, and reporting it as `dead` is
    // what rang the owner's phone at 07:33 on 2026-08-16 over a session that carted both
    // holds seventeen minutes later.
    //
    // The severity matters more than the wording. `dead` fails the check, fires `holdAtRisk`,
    // and prints `rc-login.bat` — which force-kills the Chromium the access token lives in.
    // Following that advice destroys the very session the alarm is complaining about, and it
    // is the third time this shape has sent somebody to the box for nothing.
    //
    // `warm`, because the session IS live and RC accepts it — with the shortfall stated
    // rather than hidden, so the pre-flight still shows the risk without calling it an
    // outage. The attempt is refunded for the same reason `provedNothing` is: no credential
    // was submitted, so nothing was spent and the T−5 re-check should still get its turn.
    autoLogin.spent -= 1;
    log(`  … signed in, but coverage is short: ${r.reason}`);
    log('    (no credential was submitted, so this does not count against the budget)');
    await reportSession('warm', `signed in, but the token may not cover the hold: ${r.reason}`);
  } else if (r.provedNothing) {
    /**
     * WE COULD NOT ASK, WHICH IS NOT THE SAME AS BEING TOLD NO.
     *
     * `attemptLogin` returns `provedNothing` when RC's own app never rendered — *"We're
     * having trouble loading the application"* — so there was no sign-in form to find. That
     * detection shipped 2026-08-18 and the REHEARSAL has honoured it ever since; this path
     * did not, because the only refund lived inside the `r.ok` branch and a blank load
     * returns `ok: false`. So the release-critical caller kept treating it as a failed login.
     *
     * WHAT THAT COST, HAD IT FIRED AT 07:30: one of two attempts spent, the session reported
     * `dead`, `holdAtRisk` ringing the owner's phone, and the printed remedy being
     * `rc-login.bat` — which force-kills the Chromium the access token lives in. Following
     * the alarm would have destroyed a session that was very likely healthy. That is the
     * 2026-08-16 07:33 false alarm exactly, in the one place it has not yet been fixed, and
     * two transient loads eight minutes apart would exhaust the budget before the cart.
     *
     * THE ATTEMPT IS REFUNDED because no credential was submitted and nothing was exercised —
     * the same rule as the `r.ok` and `sessionLive` branches. The retry gap is what stops
     * this becoming a loop.
     *
     * AND NOTHING IS REPORTED. `warm` and `dead` are both verdicts, and we do not have one:
     * a page that never rendered says nothing whatever about the session. Posting nothing
     * lets the previous verdict go stale, which is the honest reading and the rule this file
     * already applies to an `unknown` Okta probe. `alarmIfSessionUnusable` still watches the
     * staleness, so a genuinely dead keep-warm is not hidden by this.
     *
     * IT STAYS LOUD, including the screenshot: this is also the documented signature of the
     * 2026-08-14 blank-page fault, where the profile itself was the cause. It is the
     * SEVERITY that changes, never the visibility.
     */
    autoLogin.spent -= 1;
    log(`  ? no sign-in was possible: ${r.reason}`);
    log('    RC\'s app not loading is not a verdict on the session — nothing is reported, and');
    log('    the attempt is not counted. If this repeats, suspect the Chromium profile');
    log('    (2026-08-14): rename .rc-bot-profile and let start-all.bat rebuild it.');
    await saveFailureShot(tab, 'autologin-noload');
  } else {
    log(`  ✗ could not sign in: ${r.reason}`);
    log(`    ${autoLogin.spent} of ${AUTOLOGIN_MAX_ATTEMPTS} attempts used. `
      + 'Repeated logins are what got this address blocked before.');
    // The real 07:45 failure is the one nobody is watching, so it gets the picture too.
    await saveFailureShot(tab, 'autologin');
    await reportSession('dead', `auto sign-in failed: ${r.reason}`);
  }
  return true;
  } finally {
    /**
     * THE ALLOCATION READING, AND IT MUST HAPPEN BEFORE THE CLOSE.
     *
     * `tab.close()` destroys the renderer whose profile this is. Reading after it would ask a
     * dead target and return null on every single trip — an instrument that is silent exactly
     * when it has something to say, which is the shape this file has fixed four times.
     *
     * IN THE `finally`, so it prints on EVERY path. The renewal's version sits after the trip
     * returns and states the rule as "pass or fail"; here the rule has to be stronger, because
     * this path has four verdict branches and a login can also throw — and the 08-20 event
     * that motivates the whole thing did not end in a tidy return, it ended in a guard kill.
     * A reading gated on the login succeeding would miss every expensive trip.
     *
     * (It cannot cover the guard kill itself: that takes the process, so no `finally` runs.
     * The memory series remains the only witness to those.)
     *
     * BEFORE the RAM read too — the screenshot and the reports above have already run, so a
     * few megabytes of theirs are inside this window. Against a trip measured in gigabytes
     * that is noise, and moving the reading earlier would cost the throw path entirely.
     */
    // ALWAYS PRINTED, pass or fail, and for a sharper reason than the renewal's: the login
    // that ramps 9.4 GB is by definition the one that did NOT return a healthy session, so a
    // trace logged only on success would miss every event it was built for.
    //
    // A THROW LEAVES NO TRACE, and that says so rather than printing nothing — silence here
    // would be indistinguishable from a trip that moved no bytes, which is the one reading
    // that would falsely eliminate the buffering candidate.
    log(trace
      ? `  ${describeTrace(trace)}`
      : '  network trace: unavailable — the sign-in threw before the trace closed');
    if (sampling.ok) {
      const profAfter = await readNativeProfile(sampler);
      // FROM THE TRACE, so the profile and the RAM delta describe the same window. See the
      // correction where sampling starts: a tab-lifetime pair would include the resident-page
      // reload, which this profile cannot see.
      const ram = trace?.ram ? trace.ram.afterMb - trace.ram.beforeMb : null;
      const diff = diffProfiles(profBefore, profAfter);
      log(renderProfile(diff, ram));
      // AND SEND IT IF IT RAMPED. The log is where these readings went to die.
      reportNativeAlloc('auto-login', diff, ram);
    } else {
      log(`  native allocation: not sampled (${sampling.why})`);
    }
    // THE RECLAIM, and it is the whole mechanism. A renderer's memory dies with its page, so
    // this close is what hands back whatever the Okta navigation allocated. In a `finally` so
    // a thrown login, a failed screenshot or a failed report can never leave the tab — and on
    // a bad trip its gigabytes — parked for the resident page's lifetime.
    //
    // AFTER the reporting above, not before: `saveFailureShot` photographs this tab, and
    // closing it first would leave the one picture of a failed 07:45 sign-in blank.
    // OFF THE TRAIL BEFORE THE TAB GOES. The renderer dies with the tab, so a sampler left
    // registered would ask a dead target every 20s for the life of the process. The BUFFER is
    // kept deliberately — `takeRamps` reports a segment once its target is no longer open, so
    // this is exactly what makes the tab's peak final and reportable on the next tick.
    allocTrail.unregister('auto-login');
    await tab.close().catch(() => {});
    // THE ATTEMPT REACHED A VERDICT — clear the in-flight mark so the next process does not
    // read it as a kill and refund an attempt that was genuinely spent. In the `finally`
    // because every branch above, including the refunding ones, is a verdict: the thing this
    // distinguishes is the process DYING, and a branch that returned did not die.
    autoLogin.startedAt = 0;
    saveAutoLogin(autoLogin);
  }
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
/**
 * Minutes since the watchdog last killed a browser, or null if it never has.
 *
 * NULL IS "NO RECORD", NOT "LONG AGO" — and the gate treats it as no reason to stand down,
 * because a missing marker is the ordinary case on a box that has never had a runaway.
 */
function minutesSinceAbnormalExit() {
  try {
    const at = Number(fs.readFileSync(ABNORMAL_EXIT_MARKER, 'utf8').trim());
    if (!Number.isFinite(at) || at <= 0) return null;
    return (Date.now() - at) / 60_000;
  } catch {
    return null;
  }
}

/** The remote `test-login` command's signal, written by bot-commands.mjs in a SIBLING
 *  process. The rehearsal must run HERE — this process owns the Chromium profile — which is
 *  why the command is a file and not a function call, the same cooperative mechanism as
 *  `.camphawk-profile-wanted`. */
const REHEARSE_ASK = path.join(HERE, '.camphawk-rehearse-asked');
/** When the last ON-DEMAND rehearsal ran. A FILE, not memory: supervise.ps1 restarts this
 *  process on every exit, and an in-memory ration is re-issued by every restart — the
 *  crash-loop-spends-the-login-budget shape that cost the IP twelve hours on 2026-08-06. */
const REHEARSE_ON_DEMAND_STAMP = path.join(HERE, 'logs', '.rehearse-on-demand-at');

/** Consume the ask. DELETED BEFORE RUNNING, so a crash mid-rehearsal cannot loop the login. */
function takeRehearseAsk() {
  try {
    if (!fs.existsSync(REHEARSE_ASK)) return false;
    fs.unlinkSync(REHEARSE_ASK);
    return true;
  } catch {
    return false;
  }
}

function hoursSinceOnDemandRehearsal() {
  try {
    const at = Number(fs.readFileSync(REHEARSE_ON_DEMAND_STAMP, 'utf8'));
    if (!Number.isFinite(at) || at <= 0) return null;
    return (Date.now() - at) / 3_600_000;
  } catch {
    return null;
  }
}

async function maybeRehearse(ctx, page) {
  // THE ON-DEMAND ASK, checked first and CONSUMED whatever happens next — a refused ask
  // must not sit on disk re-asking every tick. It lifts the schedule gates (the hour, the
  // once-per-20h) and keeps the safety gates; see shouldRehearseOnDemand for which is
  // which and why.
  const asked = takeRehearseAsk();
  const hour = pacificHour();
  // A PACIFIC DATE, NOT AN HOUR NUMBER. This used to hold `hour` and was never reset, so it
  // latched at 20 for the life of the process and every night after the first recorded its
  // skip SILENTLY — see rehearsalSlot. Null outside the rehearsal hour.
  const slot = rehearsalSlot();
  const facts = await feedFacts();
  // UNREACHABLE FEED MEANS NO REHEARSAL. We would not know whether a hold is due, and the
  // rehearsal deliberately ENDS the current session on its way — the same reasoning as the
  // update guard refusing to update blind, and for the same stakes.
  if (!facts.reachable) {
    if (asked) log('on-demand rehearsal refused: the feed is unreachable, so a due hold cannot be ruled out');
    return false;
  }

  const decision = asked
    ? shouldRehearseOnDemand({
        hoursToRelease: hoursUntilRelease(facts.nextRelease),
        hoursSinceLastOnDemand: hoursSinceOnDemandRehearsal(),
        hasCredentials: hasCredentials(),
        minutesSinceAbnormalExit: minutesSinceAbnormalExit(),
      })
    : shouldRehearse({
        pacificHour: hour,
        hoursToRelease: hoursUntilRelease(facts.nextRelease),
        sessionLive: (await sessionLive(ctx, page)).live,
        hoursSinceLastRun: facts.lastRehearsalAt
          ? (Date.now() - Date.parse(facts.lastRehearsalAt)) / 3_600_000
          : null,
        hasCredentials: hasCredentials(),
        // Or the rehearsal tests our own restart. See REHEARSAL_QUIET_AFTER_RESTART_MIN.
        minutesSinceAbnormalExit: minutesSinceAbnormalExit(),
      });

  if (!decision.run) {
    // AN ON-DEMAND REFUSAL IS ALWAYS LOUD — somebody is watching the admin page for it,
    // and a silent refusal is indistinguishable from the signal never arriving, which is
    // the exact ambiguity the rehearsal's own bookkeeping bug taught (rehearsalSlot).
    if (asked) {
      log(`on-demand rehearsal refused: ${decision.why}`);
      await reportRehearsal(null, null, `on-demand refused: ${decision.why}`);
      return false;
    }
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

  // STAMP THE RATION BEFORE ATTEMPTING, same rule as `recordedSlot` below and for the same
  // reason: recording after would leave the ration unspent if the attempt never returns,
  // and a supervisor restart would then run another login. The file survives the restart;
  // that is the point of it being a file.
  if (asked) {
    try {
      fs.mkdirSync(path.dirname(REHEARSE_ON_DEMAND_STAMP), { recursive: true });
      fs.writeFileSync(REHEARSE_ON_DEMAND_STAMP, String(Date.now()));
    } catch { /* the handler's own check is the backstop */ }
  }

  // STAMP `ran_at` BEFORE ATTEMPTING, and this is not defensive noise. The once-a-day gate
  // is the only thing standing between a crash-loop and a login every time the supervisor
  // restarts this process — and a login attempt is exactly what opens Chromium and posts
  // credentials from the household IP. Recording afterwards would leave the gate open for
  // the whole rehearsal hour if the attempt never returned. An interrupted rehearsal
  // therefore reads as ran-but-unknown, which is `stale`: honest, and not a pass.
  recordedSlot = slot;
  await reportRehearsal(null, 'rehearsal started', null);
  log(asked
    ? '── ON-DEMAND login rehearsal (asked from the admin page): proving the sign-in works ──'
    : '── nightly login rehearsal: proving the bot can still sign itself in ──');
  const { result, detail } = await runLoginRehearsal(ctx, page, {
    // Nobody is watching at 20:00 either. A CAPTCHA here is a real finding, reported and
    // acted on this evening, not something to sit in front of for five minutes.
    humanPresent: false,
    tag: asked ? 'on-demand' : 'rehearsal',
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

/**
 * SEND A RAMP'S ALLOCATION READING SOMEWHERE IT CANNOT AGE OUT — see migration 066.
 *
 * The sampler works. Its readings kept vanishing: its only output is this log, and `tail-log`
 * returns the last 16,000 characters. Two nine-gigabyte ramps happened on 2026-08-22 and
 * 08-23 with the sampler running for both, and BOTH attributions were gone before anyone
 * looked. `chromium_memory_samples` survived those same events by being in Postgres.
 *
 * ONLY RAMPS ARE SENT, and the gate is the free-RAM delta the trace already measured for its
 * three-way verdict. The renewal makes an Okta trip roughly hourly and almost all cost
 * 50-350 MB; storing every one would bury the interesting rows exactly as the log does.
 * `ramMb` is negative when the machine LOST memory, so the test is "fell by more than the
 * threshold" — written as a comparison on the raw signed value rather than an abs(), because
 * a trip that FREED a gigabyte is not a ramp and must not be stored as one.
 *
 * Fire-and-forget. A diagnostic that can delay the renewal, or throw into it, is the mistake
 * `rcFamilyMb` would have made in the guard arm.
 */
/**
 * THE ALLOCATION TRAIL. See rc-alloc-trail.mjs for why the return-path reading below has now
 * missed six ramps: it fires after the trip RETURNS and is gated at 400 MB, so a trip killed
 * mid-ramp never reports — the instrument records, by selection, the cheap retry that FOLLOWS
 * a ramp. And the leading candidate for the rest is that the ramping renderer is not the one
 * being sampled at all, which is why this samples the RESIDENT page too.
 *
 * MODULE SCOPE, NOT INSIDE `warmResident`, and that is not tidiness. The three tabs that
 * navigate to Okta live in three different top-level functions — `maybeWarmupLogin`,
 * `maybeAutoLogin` and the renewal inside the resident loop — and a trail reachable from only
 * one of them is the house shape this whole change exists to stop repeating: an instrument
 * bolted to some of the doors. `worker/warmup-sampler.test.mts` enumerates them.
 *
 * It also means the trail OUTLIVES a browser recycle, which is the right way round: a new
 * browser's first sample is small, the total DROPS, and `splitSegments` reads that as exactly
 * what it is — a different renderer.
 */
const allocTrail = createAllocTrail();

/**
 * Store any ramp the trail has finished with.
 *
 * `final` is the difference between an ordinary tick and a teardown. On a tick only segments
 * that have ENDED are taken — a renderer swap has happened, so the peak is known and final. At
 * teardown and in the runaway bail the OPEN segment is taken too, because a browser replaced
 * by a recycle and a process that exits are the two ways a ramp ends without our ever seeing
 * the swap. Without that a nine-gigabyte ramp that kills the box reports nothing, which is the
 * failure this file exists to end.
 *
 * THE CONTEXT NAMES THE RENDERER, and that is the open question it exists to settle: if the
 * gigabytes are on the RESIDENT page rather than the trip's throwaway tab, PR #142's cure is
 * aimed at the wrong renderer, which would explain why ramps continued after it shipped.
 */
function flushAllocRamps({ final = false, describeIfEmpty = false } = {}) {
  const sent = [];
  for (const r of allocTrail.takeRamps({ final })) {
    log(`✱ alloc trail [${r.name}]: ${Math.round(r.growthBytes / 1048576)} MB in that renderer `
      + `over ${Math.round((r.endAt - r.startAt) / 1000)}s, free RAM ${r.ramDeltaMb} MB`);
    for (const site of r.sites.slice(0, 6)) {
      log(`    ${String(Math.round(site.bytes / 1048576)).padStart(6)} MB  ${site.site}`);
    }
    sent.push(reportNativeAlloc(`trail-${r.name}`,
      { totalBytes: r.growthBytes, sites: r.sites }, r.ramDeltaMb));
  }
  // A FINAL FLUSH THAT REPORTS NOTHING MUST SAY WHY. This is the reading that has been
  // missing, and the reason three real ramps have produced zero `trail-*` rows:
  //
  //   08-25 20:22 (~3.6 GB) · 08-26 21:24 (9,112 MB, 100% COMMIT) · 08-28 02:01 (8,981 MB)
  //
  // The obvious explanation — that the segment never ENDS, so it is never taken — is RULED
  // OUT for the last one: `max_pid` went 14596 -> 7812 at 02:15, so the browser really was
  // replaced, this `finally` really did run, and `final: true` really does include the open
  // segment. The trigger fired and stored nothing anyway.
  //
  // Which leaves two possibilities that look identical from here, and need opposite fixes:
  //
  //   * `EMPTY — that renderer answered no CDP call at all` — the browser stopped answering
  //     as it grew, which has happened twice before on two different CDP calls. The trail
  //     then needs a different transport, not a different trigger.
  //   * SEGMENTS PRESENT, growth under the 400 MB bar — the sampling profiler cannot see
  //     these bytes. Every reading ever taken says this is the likely one: 13-109 MB
  //     attributed against events of 5-9 GB. It would mean Track A is measuring a quantity
  //     that structurally excludes the leak, and no threshold tuning can rescue it.
  //
  // SILENT ON THE ORDINARY PATH, because this fires on every reopen — the post-Okta recycle,
  // the size guard, the runner's preemption — which is many times an hour, and `tail-log`
  // returns only the last 16,000 characters. Noise here destroys the record it is meant to
  // preserve, which is exactly how the 08-23 attributions were lost.
  //
  // `describeIfEmpty` rather than always: the BAIL arm already logs `describeAllocTrail`
  // unconditionally, so making this unconditional would print the same text twice, adjacent,
  // and read as a bug.
  if (final && describeIfEmpty && sent.length === 0) {
    log(`  ${describeAllocTrail(allocTrail.buffers(), Date.now())}`);
  }
  // AWAITABLE, because the bail arm calls `process.exit(1)` and a fire-and-forget POST dies
  // with the process — losing exactly the reading a 9 GB ramp produces. Ordinary tick callers
  // ignore it, as they ignore every other diagnostic here.
  return Promise.allSettled(sent);
}

const NATIVE_ALLOC_RAMP_MB = Number(process.env.RC_ALLOC_RAMP_MB || 400);

function reportNativeAlloc(context, diff, ramMb) {
  // NOT A RAMP, OR WE COULD NOT TELL. `null` means the trace never closed, and an unknown
  // must not be stored as a ramp — the rule that keeps `unknown` from rounding to a verdict.
  // RESOLVED, NOT `undefined` — the runaway bail AWAITS this before `process.exit`, and a
  // caller that awaits a refusal must not throw on it. Fire-and-forget callers ignore it.
  if (typeof ramMb !== 'number' || ramMb > -NATIVE_ALLOC_RAMP_MB) return Promise.resolve();
  if (!diff) return Promise.resolve();
  if (!TOKEN) return Promise.resolve();
  return fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      nativeAlloc: {
        context,
        ramDeltaMb: ramMb,
        rendererBytes: diff.totalBytes,
        sites: diff.sites,
      },
    }),
  }).then(
    () => log(`  (allocation reading stored — ${context}, ${ramMb} MB of free RAM)`),
    (e) => log(`  (could not store the allocation reading: ${e.message})`),
  );
}

/**
 * @param {'warm'|'dead'} state
 * @param {string} renewalNote
 * @param {{alive: boolean|null, expiresAt: string|null}|null} [okta]
 *   The STRUCTURED reading from `oktaSessionAlive`, not the sentence built from it.
 *   `checkAndReport` has had this object all along and posted only its stringification,
 *   so the server had to un-parse our own prose to recover a value we already held —
 *   the shape migration 064 fixed for the platform. Optional, because three of the six
 *   callers legitimately have no reading to give (see the POST body).
 */
async function reportSession(state, renewalNote = '', okta = undefined) {
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
        // WHETHER THE NEXT REPAIR IS CHEAP OR EXPENSIVE — see migration 065. Measured on
        // this box: okta ALIVE is answered from the idx cookie in 11s for +24 MB, okta GONE
        // is a full password form at 12 minutes and +9,434 MB, and the RAM guard killed the
        // browser doing the second one on 08-20.
        //
        // OMITTED, NOT NULLED, when this caller has no reading. `undefined` disappears from
        // JSON.stringify, so the server sees no key and leaves the stored value alone —
        // which is what keeps a caller that never probes Okta (the auto-login arms, the
        // rehearsal) from erasing a real reading `checkAndReport` just took. A null here
        // would mean "we looked and could not tell", which is a different fact.
        ...(okta === undefined ? {} : {
          okta: okta === null
            // We asked and the probe itself failed. An unknown must not round to GONE.
            ? { alive: null, expiresAt: null }
            : { alive: okta.alive ?? null, expiresAt: okta.expiresAt ?? null },
        }),
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
  //
  // THROUGH `dropStoredToken`, NOT A THIRD INLINE COPY (2026-08-15). This was a hand-rolled
  // duplicate of the same two `removeItem` calls, and when the real clear was widened to
  // cover okta-auth-js's own storage this copy would have been left behind — still clearing
  // two keys of a blob that carries the session, and still reporting "RC re-authenticated
  // with no credential typed" about a token that had simply never left. That appearance is
  // what the whole renewal question has been resting on.
  log('Dropping the stored token so RC treats this as signed out (cookies untouched)…');
  const dropped = await dropStoredToken(page);
  log(`  cleared ${dropped.cleared.length} key(s): ${dropped.cleared.join(', ') || '(none)'}`);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});

  const gone = await sessionLive(ctx, page);
  if (gone.live === true) {
    log('⚠ RC still accepts a token after clearing it — the test cannot prove anything.');
    log('  Not attempting a login. Nothing was changed; your session is intact.');
    return { result: 'inconclusive', detail: 'RC still accepted a session after clearing the token' };
  }

  log('Signing in with the stored password, exactly as it would at 07:45…');
  // FORCE THE FORM. Without this the sign-in click is answered from the `idx` cookie with no
  // form at all, so no credential is submitted and the run is inconclusive — which is where
  // this test has sat since 2026-08-16, because our own liveness probe keeps that cookie
  // permanently fresh (measured 12 for 12). `prompt=login` asks Okta to re-authenticate
  // anyway. Nothing is deleted, so if Okta declines we land back on `provedNothing`, exactly
  // where we already are. See force-login-prompt.mjs for why the route must not leak.
  //
  // THE REHEARSAL ONLY, NEVER `maybeAutoLogin`. That one runs at T−30 of a real release and
  // is the only thing between a queued hold and a missed cart; putting an unproven parameter
  // in front of it would risk a campsite to improve a dashboard.
  const { result: r, rewrites } = await withForcedLoginPrompt(page, () => attemptLogin(ctx, page, {
    homeUrl: RC_HOME,
    isLive: async () => (await sessionLive(ctx, page)).live === true,
    log,
    // `--test-login` has somebody watching, so a CAPTCHA is worth waiting on rather than
    // failing at — they can solve it and the run carries on. The nightly rehearsal and
    // maybeAutoLogin deliberately do the opposite: unattended, a challenge is a full stop.
    humanPresent,
  }), { log });
  // SAY WHETHER WE ACTUALLY ASKED. Zero rewrites means the interception never fired, which is
  // a different fault from Okta ignoring the parameter — and without this line the two
  // produce the identical inconclusive run, which is the shape this file keeps paying for.
  log(rewrites > 0
    ? `  (asked Okta for a fresh credential — rewrote ${rewrites} authorize request(s))`
    : '  (the authorize request was never intercepted — Okta was NOT asked for a fresh '
      + 'credential, so an inconclusive result here says nothing about the password)');
  if (!r.ok) {
    log(`✗ ${r.reason}`);
    await saveFailureShot(page, tag);
    return { result: 'failed', detail: r.reason };
  }
  // SIGNED IN, BUT NOTHING WAS PROVED. RC re-authenticated from the live Okta session before
  // a form appeared, so no credential was ever submitted. Recording that as a pass would put
  // a green mark against a test that did not run — see rehearsal.mjs.
  if (r.provedNothing) {
    // TWO DIFFERENT INCONCLUSIVES, and they need different next moves. If we DID rewrite the
    // authorize and Okta still answered from the cookie, that is Okta declining `prompt=login`
    // — and it retires this approach in favour of the destructive cookie-drop, which is a
    // decision somebody should make on evidence rather than re-derive. Carried in the detail
    // so `rc_login_rehearsal_log` keeps it.
    const detail = rewrites > 0
      ? `${r.reason} — and this run DID force prompt=login (${rewrites} rewrite(s)), so Okta `
        + 'declined to re-prompt; forcing the form this way does not work'
      : r.reason;
    log(`… ${detail}`);
    return { result: 'inconclusive', detail };
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
  /**
   * THE REASON, NOT A CANNED STRING (2026-08-18).
   *
   * `runLoginRehearsal` computes the real one — Okta's own banner, folded in by
   * `withBanner`, which is what separates "the password was mistyped when you saved it"
   * from "a CAPTCHA is up" from "RC's app never rendered". It RETURNS it as `detail`. This
   * function took `.result` and threw `.detail` away, substituting
   * `'test login failed — a human must sign in'`.
   *
   * The nightly path (line ~934) has always reported the real detail. So the ONE path that
   * a human runs when they are actively trying to find out why — with the answer printed on
   * their screen and nowhere else, because rc-test-login.bat keeps no log — was the one that
   * discarded it. Observed 2026-08-18: the first row this instrument ever wrote said
   * "test login failed" and could not say what failed.
   *
   * Same family as `notifications.status = 'sent'` meaning only "Twilio returned 2xx", and
   * as `claimBotCommands` returning `[]` for both "nobody asked" and "the query threw": the
   * fact was computed and then dropped one step before it was useful.
   */
  const detail = outcome === BUSY || !outcome ? null : outcome.detail ?? null;

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
    await reportRehearsal(true, detail ?? 'verified by --test-login', null);
    return true;
  }
  if (result === 'inconclusive') {
    /**
     * INCONCLUSIVE IS A THIRD ANSWER AND IT MUST BE REPORTED (2026-08-18).
     *
     * This used to `return false` in silence. The nightly path has always reported it as
     * `ok = null` — the singleton's `ok` is three-valued precisely for this — so the hand-run
     * path left the dashboard showing whatever it said BEFORE, which after a real failure is
     * "the bot COULD NOT SIGN IN".
     *
     * Observed today: a test login re-authenticated from the live Okta session before any
     * form appeared, so no credential was submitted and nothing was proved. The owner
     * reasonably read the browser signing itself in as a pass; the dashboard meanwhile went
     * on reporting a four-hour-old FAILURE. Two different wrong answers about the same run,
     * because the run itself reported neither.
     *
     * `ok = null` with the reason is the honest record: we tried, and could not test.
     */
    log('');
    log('… NOTHING WAS PROVED — this run did not exercise the password.');
    log('   RC re-authenticated from the live Okta session before a form appeared. That is');
    log('   the session working, not the unattended LOGIN working. To test the login itself');
    log('   the Okta session has to be gone (it lasts ~12h), which is why the nightly');
    log('   rehearsal only runs when the session is already down.');
    await reportRehearsal(null, detail, null);
    return false;
  }

  log('');
  log('✗✗ THE UNATTENDED LOGIN DOES NOT WORK, and you are now signed OUT.');
  log('   Run mini-pc\\rc-login.bat NOW to sign in by hand — do not leave it.');
  log('   Most likely: the password was mistyped when you saved it (it is hidden, so');
  log('   there is nothing to notice), or RC is showing a CAPTCHA. The line above says');
  log('   which. Re-save with mini-pc\\rc-save-password.bat if it is the password.');
  await reportSession('dead', detail ?? 'test login failed — a human must sign in');
  // A FAILURE IS THE MORE IMPORTANT ONE TO RECORD. It is the state `autocart.rc_login`
  // exists to shout about, and a hand-run failure is no less real than a scheduled one.
  // The real reason first, so the dashboard and the history say WHICH failure this was.
  // The generic sentence stays as the fallback for a run that somehow produced none.
  await reportRehearsal(false, detail ?? 'test login failed — a human must sign in', null);
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
  // OUTSIDE both loops. A reopen resets everything inside them, so a cooldown declared
  // in there would reset on the very event it exists to rate-limit and bound nothing —
  // the same reason renewal-schedule's ration lives at module scope.
  let lastRecycleAt = 0;
  for (;;) {
    if (!(await waitForProfileLock(PROFILE_DIR, LOCK_OWNER, 60_000))) {
      const held = profileLockHolder(PROFILE_DIR);
      log(`… profile busy (${held?.owner ?? 'another process'}) — retrying in 30s, NOT a dead session`);
      await sleep(30_000);
      continue;
    }
    // THE RESIDENT PATH'S SWEEP, and the one that matters most. This loop reopens on every
    // profile yield, every guard trip and every restart — including the restart that ORPHANS
    // a browser in the first place — so it is where an orphan is actually caught, minutes
    // after it is created and long before any 08:00. See orphan-sweep.mjs for why it must sit
    // between the lock and the launch, and nowhere else.
    await sweepOrphanChromium({ log });
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
    /**
     * WHICH AWAIT ARE WE SITTING IN?
     *
     * Four wedges were recorded on 2026-08-17, every one beginning at `renewing the session`
     * and ending twelve minutes later at `the loop has not advanced in 13m` — and NOTHING
     * recorded which of the six awaits inside `renewSession` was the one that never returned.
     * The diagnosis therefore stopped at "somewhere in the renewal", where it sat for a day.
     *
     * `mark()` deliberately does NOT touch `lastTick`. A step beginning is not the loop
     * advancing — if it reset the clock, entering a step would postpone the very watchdog
     * that exists to catch a step never finishing, and a loop that wedged mid-renewal would
     * look healthy for another twelve minutes. That is the bug this whole family keeps
     * producing: an instrument that quietly resets the thing it measures.
     */
    let step = 'starting up';
    let stepSince = Date.now();
    const mark = (s) => { step = s; stepSince = Date.now(); };
    let lastLockRenew = 0;
    // Re-entrancy guard. The timer fires every ten seconds and the runaway arm is async, so
    // without this a slow heap read would queue a second and a third bail behind the first.
    let bailing = false;
    // The timer needs a page to ask, and `page` is declared inside the try below. Assigned
    // there; null until then, which `collectHeapFacts` reports as "no page to ask" rather
    // than throwing inside a setInterval where nothing would catch it.
    let residentPage = null;
    // Opened at launch while the browser is healthy — see collectHeapFacts. Negotiating a new
    // CDP session at trip time is what produced `no answer in 3000ms` on the first real firing.
    let heapProbe = null;
    // The trail. Sampled on the watchdog tick while the browser still answers, printed when
    // the guard fires — see rc-heap's sampleHeap for why it cannot be taken at the trip.
    let heapTrail = [];
    let heapInFlight = false;
    /**
     * THE FREE-RAM TRAIL, AND WHY IT IS THE ONE THAT CAN TIME THE ONSET.
     *
     * The heap trail froze the instant the ramp began — its newest sample was 123s old against
     * a 121s stall — because CDP stops answering. `os.freemem()` never stops answering: it is a
     * syscall, not a request to the browser, and it is already being read on this tick.
     *
     * Pairing each reading with the STEP the loop is in turns "the ramp happened somewhere in
     * the renewal" into "free RAM was still 9 GB twenty seconds into renew:click-sign-in and
     * 4 GB ten seconds later". That is what separates the reload from the click, which is
     * currently a candidate on three matching firings and not a finding.
     */
    let ramTrail = [];
    const renew = setInterval(() => {
      const stalledMs = Date.now() - lastTick;
      const bail = (why) => {
        log(why);
        // BEFORE the exit, and best-effort. The next process reads this to know it is coming
        // up after a kill rather than a clean start — which is what stops the login rehearsal
        // testing our own restart and reporting it as a broken sign-in.
        try { fs.writeFileSync(ABNORMAL_EXIT_MARKER, String(Date.now())); } catch { /* ignore */ }
        // THE BREADCRUMB, printed before anything else can go wrong. It is the whole reason
        // the next wedge is diagnosable and this one was not.
        log(`  Stalled in: ${step} (${Math.round((Date.now() - stepSince) / 1000)}s in that step).`);
        log('  Releasing the profile and exiting so the hold runner can use it.');
        try { clearInterval(renew); } catch {}
        releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
        process.exit(1);
      };
      if (stalledMs > HUNG_MS) {
        bail(`✗ WEDGED — the keep-warm loop has not advanced in ${Math.round(stalledMs / 60_000)}m.`);
      }
      /**
       * THE RUNAWAY ARM. See LOW_RAM_MB: the size bound in the loop body cannot fire while the
       * loop is wedged, which is every occasion it was written for, so the fast check lives
       * here — in the timer the wedge watchdog above already identifies as the only code
       * proven to still be executing.
       *
       * BOTH CONDITIONS, ALWAYS. Low RAM on its own is the owner using their own computer.
       * A stall on its own is an unattended sign-in doing its job. Together they are a hung
       * Playwright call against a browser that is eating the machine, which is the shape of
       * all twenty ramps in the series.
       *
       * `os.freemem()` and not `rcFamilyMb()` deliberately: the latter spawns PowerShell, and
       * spawning is the thing that fails first at 99% COMMIT. An instrument that goes quiet as
       * the emergency peaks reports the emergency as calm.
       */
      /**
       * SAMPLED HERE, IN THE TIMER, FOR THE SAME REASON THE GUARD IS. This is the only code
       * proven to keep executing while the loop is stalled — and the stall is precisely the
       * window we need readings from.
       *
       * Fire-and-forget with an in-flight flag: the timer must not await anything, and once
       * the browser stops answering, every attempt costs its full timeout. Without the flag
       * those would pile up one per tick.
       */
      if (!heapInFlight && heapProbe) {
        heapInFlight = true;
        void sampleHeap(heapProbe)
          .then((v) => { if (v) heapTrail = [...heapTrail, { ...v, at: Date.now() }].slice(-TRAIL_KEEP); })
          .catch(() => {})
          .finally(() => { heapInFlight = false; });
      }
      const freeMb = os.freemem() / (1024 * 1024);
      // Recorded on EVERY tick, including the healthy ones, because the sample before the ramp
      // is what gives the one during it a baseline to be a change from.
      ramTrail = [...ramTrail, { at: Date.now(), freeMb: Math.round(freeMb), step }].slice(-TRAIL_KEEP);
      // The allocation trail rides the same tick and carries the same free-RAM reading, so the
      // profile and the delta describe ONE window. A delta measured over a different window is
      // the 2026-08-19 false elimination with extra steps. Fire-and-forget; never awaited.
      allocTrail.sample(Date.now(), Math.round(freeMb));
      // ENDED segments only here — see flushAllocRamps. A ramp whose renderer has been swapped
      // away is final, and this is the moment its peak would otherwise be discarded.
      flushAllocRamps();
      if (stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB && !bailing) {
        bailing = true;
        const why = `✗ RUNAWAY — stalled ${Math.round(stalledMs / 1000)}s with only ${Math.round(freeMb)} MB `
                  + `of free RAM (floor ${LOW_RAM_MB} MB). Normal here is ~13,000 MB free and this `
                  + 'browser has taken the box to 99% COMMIT twenty times in five days.';
        /**
         * ASK THE RENDERER WHAT IT IS HOLDING, ON THE WAY OUT.
         *
         * This is the one moment the answer exists. `describeHeapFacts` splits JS heap from
         * everything else, which is the fact that halves the candidate space — and the trip
         * is the only occasion it can be sampled, because ten minutes later the process is
         * gone and an hour later a healthy browser has nothing to say.
         *
         * BOUNDED, AND THE EXIT DOES NOT DEPEND ON IT. `collectHeapFacts` resolves rather
         * than throws and cannot exceed a few seconds; whatever it returns, `bail` runs. A
         * diagnostic that can delay the thing that saves the box has inverted the priority,
         * which is the mistake `rcFamilyMb` in this same guard would have made.
         */
        void (async () => {
          const facts = await collectHeapFacts(ctx, residentPage, heapProbe).catch(() => null);
          log(why);
          log(`  ${describeHeapFacts(facts, null)}`);
          // THE READING THAT ACTUALLY ARRIVES. The line above has failed twice, both times
          // because the browser will not answer once it is this large; the trail is what was
          // captured on the way in.
          log(`  ${describeTrail(heapTrail, Date.now())}`);
          // The trail that never stops answering. See ramTrail.
          log(`  ${describeRamTrail(ramTrail, Date.now())}`);
          // WHAT WAS ALLOCATING, not merely how much. This is the reading the whole Track A
          // investigation has been waiting for, and this arm is one of the two places a ramp
          // ends without our seeing the renderer swap — so the OPEN segment is taken too.
          log(`  ${describeAllocTrail(allocTrail.buffers(), Date.now())}`);
          // AWAITED, AND BOUNDED. `bail` calls process.exit, which kills an in-flight POST —
          // so the one reading this arm exists to capture would be lost to the exit that
          // captures it. Bounded because a diagnostic that can delay releasing the profile
          // lock has inverted the priority, which is the mistake `rcFamilyMb` would have made
          // in this same arm: the lock staying held past 08:00 is what loses a cart.
          await Promise.race([
            flushAllocRamps({ final: true }),
            new Promise((r) => setTimeout(r, 4000)),
          ]).catch(() => {});
          bail('  (see the runaway line above)');
        })();
        return;
      }
      // Unchanged cadence. The timer got 12x faster so the checks above could bound a
      // ~2,400 MB/min ramp; the lock file has no such need and rewriting it every ten
      // seconds would be churn for nothing.
      if (Date.now() - lastLockRenew >= RENEW_MS) {
        lastLockRenew = Date.now();
        renewProfileLock(PROFILE_DIR, LOCK_OWNER);
      }
    }, WATCHDOG_MS);
    let ctx = null;
    try {
      mark('launching Chromium');
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS, viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        /**
         * THE THREE THROTTLING FLAGS ARE GONE, AND THE REASON THEY WERE ADDED IS THE REASON.
         *
         * They arrived 2026-08-08 under: *"the renewal we are staying open to catch is a timer
         * inside RC's app; a throttled timer is a timer that does not fire."* That premise was
         * falsified by this repo's own later work and the entry was never revisited:
         *
         *   • 2026-08-09 — okta-auth-js fires `authorize?prompt=none` on its autoRenew timer,
         *     fails, and DELETES the tokens. The timer we were staying open to catch does not
         *     produce a renewal; it produces a signed-out app.
         *   • 2026-08-15 — `hasRefreshToken: false`, read off the grant. There is nothing to
         *     silently refresh with, so no timer of RC's could have renewed anything.
         *   • What does re-mint is `renewSession`'s CLICK, which we drive ourselves through
         *     Playwright. `page.evaluate` and `page.goto` are devtools-driven and are not
         *     subject to background throttling at all, so nothing we rely on needs these.
         *
         * So they bought nothing, and what they cost is specific: they remove every brake
         * Chrome has on an occluded tab, and this tab spends hours occluded running an SPA in
         * a permanently-401 state — a token that expired 44 hours ago, retried against RC
         * forever. Twenty ramps in five days, each ~2,400 MB/min of real RAM.
         *
         * THIS IS A HYPOTHESIS ABOUT THE CAUSE, NOT A PROVEN FIX, and it is deliberately
         * shipped alongside the containment above rather than instead of it — the two are
         * distinguishable in `chromium_memory_samples` because they act at different points.
         * If ramps stop appearing at all, the flags were the cause. If ramps still appear but
         * stop short of taking the box down, the containment is what worked and this was not
         * it. Crediting a repair to the wrong mechanism has cost this file three times.
         */
        args: ['--hide-crash-restore-bubble'],
      });
      await installTokenCapture(ctx);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      residentPage = page;
      mark('initial RC load');
      await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // Before anything can go wrong with it. A failure returns null and the trip falls back
      // to negotiating one, which is strictly the old behaviour rather than a new risk.
      heapProbe = await attachHeapProbe(ctx, page).catch(() => null);
      /**
       * SAMPLE THE RESIDENT RENDERER TOO, AND THIS IS THE POINT OF THE WHOLE CHANGE.
       *
       * Every existing sampler call site is on the TRIP's own tab. On 2026-08-25 02:31 the
       * renewal's tab reported 17 MB while the family's renderers reached 8,052 MB and went on
       * climbing for eight minutes after the reading was stored. The obvious explanation —
       * that the navigation resets CDP's all-time profile — was MEASURED AND DOES NOT APPLY
       * here: Chromium isolates by site, and RC's www -> signin hop is a subdomain, which
       * keeps its renderer (see rc-alloc-trail.mjs). What is left is that the allocation is on
       * the RESIDENT page's renderer, which nothing has ever sampled — and if so, PR #142's
       * throwaway-tab cure is aimed at the wrong renderer, which would explain why ramps
       * continued after it shipped. Sampling both is what settles it.
       *
       * ON `heapProbe`'s SESSION rather than a second one: it is already attached to this
       * page, already negotiated while the browser is healthy, and the Memory domain rides it
       * as happily as Performance does. A second session would double the thing that has twice
       * been measured failing under load.
       */
      // COARSER THAN THE TRIP TABS, and see LONG_LIVED_INTERVAL for the measurement. This one
      // is read every 20s for the life of the browser, and the response grows with every byte
      // the renderer has ever allocated — so at 9 GB the fine setting would have us asking a
      // dying renderer to serialize 16 MB, over and over, at the peak.
      const residentSampling = heapProbe
        ? await startNativeSampling(heapProbe, { intervalBytes: LONG_LIVED_INTERVAL })
        : { ok: false, why: 'no CDP session on the resident page' };
      if (residentSampling.ok) allocTrail.register('resident', heapProbe);
      /**
       * IT SAYS IT IS RUNNING, ON THE HEALTHY PATH TOO.
       *
       * The first version logged only on FAILURE, which makes "armed and quietly working" and
       * "this code never ran" the same silence — the shape that made `status = 'sent'` mean only
       * "Twilio returned 2xx", and that hid a watchdog which produced nothing through thirty
       * consecutive firings. An instrument nobody can confirm is running is one nobody should
       * believe when it reports nothing, which is exactly what this one will do most days.
       *
       * ONE LINE PER BROWSER OPEN, which is roughly hourly — cheap enough not to bury the log,
       * and a recycle is precisely when you want to know the trail came back up with it.
       */
      log(`  alloc trail: ${residentSampling.ok
        ? `resident renderer armed, ${residentSampling.why}`
        : `resident renderer NOT sampled — ${residentSampling.why}`}`);
      mark('priming the token');
      const primed = await primeToken(page);
      log(`RC loaded and STAYING OPEN — token source: ${primed.source}`);
      log('Leave this browser window ALONE. Closing it stops the renewal; it will reopen.');

      // 0, so the first check fires IMMEDIATELY on every open. After a restart or a yield
      // to the runner, waiting twenty minutes to say anything would leave
      // `autocart.rc_session` stale — reading "we have not confirmed this recently" when
      // in fact we just did, on the one dashboard that decides whether to wake someone.
      let lastCheck = 0;
      let lastExpiryPoll = 0;
      /**
       * ── WHAT JUST TOOK THIS BROWSER THROUGH OKTA, IF ANYTHING ────────────────────────────
       *
       * Null on every ordinary pass. Set to a short human phrase by the three places that
       * navigate to `signin.reservecalifornia.com`, and read at the TOP of the loop, which is
       * the one place all three reach — the auto-login and the rehearsal both `continue`, so a
       * check beside each call site would be three chances to forget one.
       *
       * WHY IT EXISTS. See `oktaTrip`'s consumer below. Short version: an Okta round trip in
       * this Chromium costs ~2 GB that is never given back, and the only mechanism ever
       * observed to return this profile to its 200 MB baseline is a new process.
       */
      let oktaTrip = null;
      // 0 so the first look happens immediately on every open — a browser that comes back
      // already huge is exactly the case worth catching before it ramps again.
      let lastMemCheck = 0;
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

        /**
         * ── RECYCLE AFTER AN OKTA ROUND TRIP (2026-08-18) ─────────────────────────────────
         *
         * THE CONTROLLED COMPARISON, off one ten-minute window on the box. Three token-less
         * renewals, same code, same profile, same browser generation, differing only in
         * whether RC's sign-in control was found and clicked:
         *
         *     19:04:04  token-less → `no-signin-control` (never clicked)  →   200 MB
         *     19:10:43  token-less → `authorize` ✓ (clicked)              → 2,331 MB
         *     19:13:46  token-less → `no-signin-control` (never clicked)  →   237 MB
         *
         * The two that never navigated ran the identical clear, reload and prime and allocated
         * NOTHING. The one that navigated allocated 2.3 GB. That is a natural experiment
         * rather than a correlation over days, and it moves the onset off `renew:reload` —
         * where the RAM trail had put it — onto the Okta navigation itself.
         *
         * IT ALSO CORRECTS THE PLAN THAT SHIPPED THIS MORNING. `planRenewal` now stands down
         * on a live token, on the evidence that every ramp began in a near-expiry renewal and
         * that the token-less cell "works and does not ramp". The first half stands. The
         * second is FALSE: 19:10:43 is token-less, cleared 0 keys, succeeded, and cost 2.3 GB.
         * The stand-down halves the leak — a near-expiry renewal makes TWO Okta trips (the
         * SPA's own hidden `prompt=none` after a real clear, then our click) and lands at
         * ~4-5 GB, against ~2.3 GB for one — and it cannot cure it, because the cell we moved
         * TO navigates as well. So does `attemptLogin`, which is release-critical and cannot
         * be removed at all.
         *
         * WHY RECYCLE RATHER THAN WAIT FOR THE GUARD. The 2.3 GB does not trip anything: it
         * leaves ~6,500 MB free, well above the 4,000 MB floor, and the renewal COMPLETES, so
         * there is no stall either. It simply sits there. Across twenty ramps in five days
         * every single one was followed by a NEW pid — the memory has never once been observed
         * coming back down in place — and nothing has ever run two renewals in one browser
         * life, because the guard always killed it first. So whether it accumulates hour on
         * hour is UNKNOWN, and the honest options are to find out at 3 a.m. or to make the
         * question moot. This makes it moot.
         *
         * WHY THIS IS NOT THE AGE RECYCLE THAT WAS REMOVED. That one fired on a clock, and its
         * premise was false: `localStorage` survives a browser restart, so it came back
         * `token source: live`, landed in the same near-expiry cell, and changed neither the
         * cell nor the timing. Here that same fact is what makes this SAFE — the freshly minted
         * token survives the reopen, `planRenewal` stands down for the next 59 minutes, and the
         * browser sits at its 200 MB baseline until the token lapses. One recycle per token
         * lifetime, at the moment the allocation has just happened.
         *
         * NOT GATED ON `RECYCLE_COOLDOWN_MS`, THOUGH IT SETS IT. The cooldown exists to stop
         * the size arm thrashing on a browser that is over the line the instant it opens; here
         * we KNOW two gigabytes were just allocated, so standing down would leave them
         * standing. Pacing comes from `planRenewal` instead — a floor of 5 minutes, a gap of
         * 10, and a backoff after three failures — which bounds a failing renewal to a reopen
         * every few minutes. That is what the guard already does on those, more expensively.
         *
         * AFTER the runner's preemption and the closed-window check, deliberately: a cart at
         * 08:00:00 outranks tidying up memory, and a window somebody closed needs the reopen
         * for its own reasons. BEFORE the size scan, so this costs no PowerShell spawn.
         */
        if (oktaTrip) {
          lastRecycleAt = Date.now();
          log(`♻ recycling the browser — ${oktaTrip} took it through Okta.`);
          log('  Measured 2026-08-18: one Okta round trip costs this renderer and browser');
          log('  process ~2 GB between them, and nothing here has ever been seen to give it');
          log('  back. The reopen takes seconds and the minted token survives it.');
          break;
        }

        // IS THIS BROWSER RUNNING AWAY? See RC_MAX_FAMILY_MB. Placed here on purpose: after
        // the runner's preemption, so a cart never waits behind a PowerShell spawn, and
        // BEFORE the expiry poll, because a browser this large will hang the renewal's
        // evaluates anyway and recycling first is what makes the next poll meaningful.
        if (Date.now() - lastMemCheck >= MEM_CHECK_MS) {
          lastMemCheck = Date.now();
          mark('memory scan');
          const mb = await rcFamilyMb();
          if (mb != null && mb > RC_MAX_FAMILY_MB) {
            if (Date.now() - lastRecycleAt < RECYCLE_COOLDOWN_MS) {
              log(`⚠ RC Chromium at ${Math.round(mb)} MB — over the ${RC_MAX_FAMILY_MB} MB line, ` +
                  'but a recycle is still cooling down. Not restarting again yet.');
            } else {
              lastRecycleAt = Date.now();
              log(`✗ RC Chromium at ${Math.round(mb)} MB (limit ${RC_MAX_FAMILY_MB}) — RECYCLING the browser.`);
              /**
               * THE GOOD MOMENT TO ASK, and the only one. This trip happens EARLY in a ramp
               * — the loop is still advancing, the browser is ~1.5 GB, and the objects that
               * are growing are already there. By the time the RAM arm fires the process is
               * many GB and the box cannot spawn, so a snapshot then would be part of the
               * problem. Same reading, taken while it is cheap.
               */
              mark('heap facts');
              const facts = await collectHeapFacts(ctx, page, heapProbe).catch(() => null);
              log(`  ${describeHeapFacts(facts, mb)}`);
              mark('heap snapshot');
              const snap = await writeHeapSnapshot(ctx, page, path.join(HERE, 'logs'))
                .catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
              if (snap?.ok) log(`  heap snapshot written: ${snap.file} (${Math.round(snap.bytes / (1024 * 1024))} MB)`);
              else if (snap?.reason && snap.reason !== 'not enabled') log(`  no heap snapshot: ${snap.reason}`);
              log('  Normal is 220-300 MB. On 2026-08-17 this family took the box from 12% to 99%');
              log('  COMMIT in ten minutes and killed the hold runner. The session re-mints itself.');
              break;
            }
          }
        }
        // SILENT AUTH, on the clock rather than on a fixed cadence. A reload re-runs the
        // app's own OIDC exchange against the persistent "Keep me signed in" cookie —
        // correct client_id, correct redirect_uri, correct PKCE verifier, none of which we
        // would have to guess — and never shows a CAPTCHA, because the challenge lives on
        // the password form, not on a cookie exchange. See renewSession.
        if (Date.now() - lastExpiryPoll >= EXPIRY_POLL_MS) {
          lastExpiryPoll = Date.now();
          // Before anything else: is a hold about to need a session we do not have?
          mark('auto-login');
          if (await maybeAutoLogin(ctx, page).catch((e) => { log(`auto-login error: ${e.message}`); return false; })) {
            // NO `oktaTrip` HERE ANY MORE. A true return still means an attempt was made and
            // every branch of one has been through Okta — but the trip now happens in a
            // throwaway tab that `maybeAutoLogin` closes in a `finally`, and that close is
            // what reclaims the renderer. Recycling the whole browser on top would spend a
            // restart to free memory that is already freed, and restarts are not free: one
            // turned the login rehearsal red on 08-18, and every one churns the profile lock
            // — at T−28 of a release, which is the worst possible moment for it.
            //
            // The REHEARSAL still navigates the resident page and still sets `oktaTrip`;
            // reinstating it here would quietly put a browser restart back into the critical
            // window while looking like caution. Same reasoning, and the same warning, as the
            // renewal's tab.
            continue;
          }
          /**
           * AFTER the auto-login, and the ordering is a safety property rather than taste.
           *
           * The two windows are disjoint by construction — `warmupWindowOpen` stands down at
           * or inside `AUTOLOGIN_LEAD_MIN`, which is the whole point of it — so they cannot
           * both fire. Calling the release-critical one FIRST anyway means that if that
           * disjointness is ever broken by a future edit, the caller that can lose a campsite
           * is the one that wins, and the warm-up is what gets skipped. A guard whose
           * correctness depends on a condition elsewhere should still fail in the safe
           * direction when that condition is wrong.
           */
          mark('warm-up login');
          if (await maybeWarmupLogin(ctx, page).catch((e) => { log(`warm-up error: ${e.message}`); return false; })) {
            // NO `oktaTrip`, for the same reason the auto-login no longer sets it: the trip
            // ran in a throwaway tab that is closed in a `finally`, and that close is what
            // reclaims the renderer. Recycling the browser on top would spend a restart to
            // free memory that is already freed.
            continue;
          }
          // AFTER the auto-login, never before. If a hold is close enough that the bot is
          // signing in for it, that login is the real thing and a rehearsal on top would be
          // a second sign-in from this address for one release — which is the budget the
          // one-attempt-per-release rule exists to protect. (rehearsal.mjs also refuses
          // within six hours of a release, so this ordering is a belt on top of a brace.)
          mark('login rehearsal');
          if (await maybeRehearse(ctx, page).catch((e) => { log(`rehearsal error: ${e.message}`); return false; })) {
            oktaTrip = 'the login rehearsal';
            continue;
          }
          mark('reading the token');
          const { token, source } = await readLiveToken(page).catch(() => ({ token: null, source: 'none' }));
          const left = tokenSecondsLeft(token);
          // WHEN IS `planRenewal`'S JOB, AND IT NOW SAYS YES TO THE CASE THIS REFUSED.
          //
          // The condition here used to be `left != null && left > 0 && left < RENEW_BEFORE_S`,
          // i.e. act on a token that is nearly out and NEVER on one that is already gone. The
          // reasoning was sound and the consequence was not: a signed-out profile is precisely
          // where a re-mint is both free (nothing to clear, nothing to restore) and most
          // needed. On 2026-08-15 that refusal cost ninety dead minutes in one evening, twice
          // over, with `okta=ALIVE` printed on every line — see renewal-schedule.mjs.
          //
          // The other half of the old condition — one attempt per token, because sixteen
          // reloads in sixteen minutes on 2026-08-08 is a request storm from an address whose
          // WAF has 403'd us — is kept, and is now a floor plus a gap plus a backoff rather
          // than a single equality that could not pace the signed-out case at all.
          // NO `renewBeforeS` ANY MORE — see planRenewal. It waits for the token to LAPSE
          // rather than acting ten minutes out, because the near-expiry cell is where the
          // Chromium leak lives and it has never once produced a fresher token.
          const plan = planRenewal({ token, leftS: left, now: Date.now(), state: renewal });
          if (!plan.go) {
            renewalSkip(plan.key, plan.reason);
          } else {
            log(`renewing the session — ${plan.reason} (src=${source})`);
            // ASK OKTA ONLY WHEN THERE IS SOMETHING TO LOSE.
            //
            // This probe guards a DESTRUCTIVE act: the clear trades a token that may have had
            // ten minutes left for nothing if no Okta session is behind it. With no token in
            // the app there is nothing to trade, so the probe protects nothing and is skipped
            // — and skipping it matters, because `/api/v1/sessions/me` REFRESHES Okta's own
            // idle timer. Asking on every attempt would extend the very window we are trying
            // to measure the length of, which is the one thing that would make a working
            // schedule impossible to distinguish from a lucky one.
            //
            // The attempt is self-diagnosing anyway: a dead Okta session lands us on the form
            // and comes back `stage: 'none'`, which is a reading obtained without touching
            // the timer. An errored probe returns null — "we could not tell" — and does NOT
            // refuse, or one hiccup would switch renewal off for good.
            const okta = token ? await oktaSessionAlive(ctx).catch(() => null) : null;
            mark('renewal');
            /**
             * ── THE RENEWAL RUNS IN A THROWAWAY TAB (2026-08-19) — the first CURE ─────────
             *
             * Every instrument so far has been aftermath — a size guard, a RAM arm, a heap
             * trail, a post-Okta recycle, an orphan sweep — and the attribution work they
             * bought is what makes this fix possible: the ramp is NON-JS memory, in the
             * RENDERER (+1,237 MB of the measured 2,046) and the browser process, allocated
             * during the Okta navigation, and **never once seen to come back down in place**
             * — across twenty ramps, every recovery was a new pid.
             *
             * A renderer's memory dies with its page. So the Okta round trip now happens in
             * a tab opened for exactly that purpose and closed in a `finally` — same
             * context, same cookies, same localStorage, so the minted token lands in the
             * same profile — and whatever the navigation allocated is reclaimed
             * deterministically at close, instead of by killing the browser.
             *
             * WHAT THIS REPLACES: the post-Okta recycle FOR THIS PATH. The recycle restarts
             * the whole browser once per renewal, and a restart is not free — one turned the
             * login rehearsal red on 08-18, and every restart is a window where the profile
             * lock churns. `maybeAutoLogin` and the rehearsal still navigate the RESIDENT
             * page and keep the recycle; this path no longer needs it.
             *
             * WHAT IT DOES NOT CLAIM: that the allocation stops. A ramping trip still ramps
             * while it runs, and the RAM arm still guards that. The claim is only that the
             * memory is handed back seconds later, every time, without costing the browser.
             * The memory series is the A/B: spikes that drain at tab close with no
             * `♻ recycling` line are this working; rc-family growth ACROSS renewals would
             * mean the browser-process share does not drain, and that residual is the next
             * investigation, already contained by the RAM arm.
             *
             * A TAB THAT CANNOT OPEN IS A READING, NOT AN ERROR: a browser too sick to open
             * a page is not going to renew anything either. The attempt is recorded so
             * `planRenewal`'s floor and backoff pace the retries — an unrecorded attempt
             * would retry every tick, which is the request storm the schedule exists to
             * prevent.
             */
            mark('renew:open-tab');
            const tab = await ctx.newPage().catch((e) => {
              log(`  ✗ could not open a renewal tab: ${e.message} — the browser may be unwell; retrying at the schedule's pace`);
              return null;
            });
            if (!tab) {
              renewal = recordRenewal(renewal, { token, now: Date.now(), renewed: false });
            } else try {
            /**
             * NAME THE ALLOCATION — see rc-native-sampler.mjs.
             *
             * ON THE TAB'S OWN CDP SESSION, because `Memory.startSampling` is per-renderer and
             * the trip runs in this tab, not on the resident page. Started here rather than at
             * launch for the reason `attachHeapProbe` exists: the expensive negotiation must
             * happen while the browser is healthy, and a tab one line old is as healthy as it
             * gets. Only the cheap read has to land afterwards.
             *
             * A BEFORE-READING IS TAKEN AND DIFFED even though a fresh tab has allocated almost
             * nothing. Whether a new tab gets its own renderer or shares the resident page's is
             * NOT established, and if it shares one, an all-time profile carries hours of the
             * resident page's history and would report it as this trip's. Diffing is correct
             * either way, which is better than depending on a fact nobody has measured.
             */
            const sampler = await ctx.newCDPSession(tab).catch(() => null);
            const sampling = sampler ? await startNativeSampling(sampler) : { ok: false, why: 'no CDP session' };
            const profBefore = sampling.ok ? await readNativeProfile(sampler) : null;
            // AND ON THE TRAIL — see the identical registration in `maybeWarmupLogin`, and
            // rc-alloc-trail.mjs for why the return-path reading below has missed six ramps.
            // Unregistered in the `finally` that closes the tab.
            if (sampling.ok) allocTrail.register('renewal', sampler);
            // COUNT THE BYTES. This is the first instrument that goes at the CAUSE rather than
            // the aftermath — see okta-net-trace.mjs. "Network/IPC buffering" has been the
            // leading candidate three times and was never once tested, though it is directly
            // observable: non-JS memory growing by gigabytes in the renderer AND the browser
            // process is the shape of a huge or looping response. A negative eliminates the
            // whole family, which is why it is worth the listener.
            const { result: r, trace } = await withNetworkTrace(tab, () => renewSession(tab, RC_HOME, {
              oktaAlive: okta?.alive ?? null,
              // INJECTED, so `rc-token.mjs` stays incapable of signing in — see its header.
              // Only whether a control was pressed crosses the boundary, never a locator.
              clickSignIn: (p) => clickSignInControl(p).then((l) => l != null),
              // Names the exact await inside the renewal, which is what four wedges could
              // not say. Never resets the stall clock — see `mark`.
              onStep: mark,
            }).catch((e) => {
              log(`  renew failed: ${e.message}`);
              return null;
            }));
            // ALWAYS PRINTED, pass or fail. The failing renewals are the ones that ramp — all
            // five guard firings were mid-renewal — so a trace only logged on success would
            // miss every event it was built for.
            log(`  ${describeTrace(trace)}`);
            /**
             * READ AFTER THE TRIP RETURNS, not at the guard. CDP goes quiet as a ramp peaks —
             * measured twice, `newCDPSession` on the first firing and `Performance.getMetrics`
             * on the second — which together established that the reading cannot be taken at
             * the trip at all. The renewals that ramp 2.3 GB mostly COMPLETE, so this is the
             * common case; the guard's heap facts remain the fallback for the ones that die.
             *
             * PRINTED PASS OR FAIL, like the trace above it and for the same reason: the
             * failing renewals are the ones that ramp.
             */
            if (sampling.ok) {
              const profAfter = await readNativeProfile(sampler);
              const ram = trace?.ram ? trace.ram.afterMb - trace.ram.beforeMb : null;
              const diff = diffProfiles(profBefore, profAfter);
              log(renderProfile(diff, ram));
              // AND SEND IT IF IT RAMPED. The log is where these readings went to die.
              reportNativeAlloc('renewal', diff, ram);
            } else {
              log(`  native allocation: not sampled (${sampling.why})`);
            }
            // RECORDED BEFORE ANYTHING ELSE CAN THROW. `checkAndReport` below is wrapped but
            // the logging is not, and an attempt that is made and not recorded is an attempt
            // the floor cannot see — which turns the ration into no ration at all.
            renewal = recordRenewal(renewal, { token, now: Date.now(), renewed: r?.renewed === true });
            // NO `oktaTrip` HERE ANY MORE, DELIBERATELY. This line used to hand the renewal's
            // Okta trip to the recycle — a full browser restart per renewal, because the
            // allocation had never been seen to come back down in place. The trip now happens
            // in the throwaway tab above, and the tab's `finally` close is what reclaims the
            // renderer; restarting the browser on top of that would spend a restart (they are
            // not free — one turned the rehearsal red on 08-18) to free memory that is already
            // freed. `maybeAutoLogin` and the rehearsal still navigate the RESIDENT page and
            // still set `oktaTrip`; reinstating it here would quietly reintroduce a
            // once-per-renewal browser restart that looks like caution and buys nothing.
            if (r?.skipped) {
              log(`  · skipped: ${r.skipped} — the token is untouched`);
            } else if (r) {
              log(r.renewed
                // WHICH STAGE, ALWAYS. `reload` would mean the SDK's own bootstrap has started
                // working and this can be simplified back down; `authorize` is the expected
                // success. Printing "renewed" without saying how is how a mechanism gets
                // credited for something a different mechanism did.
                ? `  ✓ renewed by ${r.stage}: ${secsText(r.before)} → ${secsText(r.after)}`
                // NOT "the Okta cookie may be gone" — that was printed for three days with
                // `okta=ALIVE` on the very next line, and the real cause was this function
                // reading its own token back. Say what happened and leave the diagnosis to
                // the fields that actually carry it.
                : `  ✗ no fresher token (${secsText(r.before)} → ${secsText(r.after)}), `
                  + `got as far as: ${r.stage}`
                  + `${r.restored ? ' — the previous token was put back' : ''}`);
              // WHICH KEYS WERE ACTUALLY EMPTIED. Until 2026-08-15 the clear covered RC's two
              // copies and not okta-auth-js's own store, so the SDK handed the same token
              // straight back and every reading was a survivor rather than a re-mint. If a
              // failure ever prints only those two names again, the SDK's storage has moved
              // and the `okta-` prefix assumption is what needs revisiting — that is a fact
              // the next run hands over instead of another round of guessing.
              log(`    cleared ${r.cleared?.length ?? 0} storage key(s): `
                + `${(r.cleared ?? []).join(', ') || '(none — nothing was there to drop)'}`);
              // ── WHERE IS THE STALE TOKEN COMING FROM? (2026-08-19) ──────────────────────
              // Fires ONLY on the pathology: the renewal failed AND handed back a token that
              // is already expired. Four runs in a row produced `none → -267960s` — no token
              // before, a 74-hour-old one after — while the clear reported nothing to drop.
              // Something is restoring a corpse from a store `dropStoredToken` does not cover.
              //
              // Narrow on purpose: this reads every key name in both web stores, and doing it
              // on every renewal would be noise on the one log a human reads at 07:30.
              if (!r.renewed && r.after != null && r.after < 0) {
                // WHERE THE TOKEN WAS FOUND, WHICH IS TWO DIFFERENT INVESTIGATIONS.
                // `live` means it came off RC's own outbound Authorization header — the SPA
                // was holding it in memory, having restored it from somewhere the clear
                // cannot see. `localStorage` would mean the census below simply ran too late
                // and the store is the answer after all. The field was already computed by
                // `primeToken` and thrown away; it costs nothing and it splits the hunt.
                log(`    the expired token was found via: ${r.afterSource ?? '(not reported)'}`);
                // THE TAB, NOT THE RESIDENT PAGE. The corpse — if it exists — was restored
                // into the page that made the trip, and localStorage is shared anyway; what
                // is NOT shared is `window.__camphawkRcToken`, which lives where the trip ran.
                const evaluate = (fn, arg) => evaluateWithin(tab, fn, arg, { fallback: null });
                const census = await takeStorageCensus(evaluate);
                // TWO EVALUATES, NOT ONE. The IndexedDB body is async and talks to a
                // subsystem that can block; the web-store census has already produced a
                // finding, and a hung database must not be able to take it down.
                const idb = await takeIdbCensus(evaluate);
                log(`    ${describeCensus(census, { idb })}`);
                // ── THE OTHER HALF OF "A COOKIE OR THE SERVER" ─────────────────────────
                // The census can say the corpse is not in any web store and not in
                // IndexedDB; it cannot see cookies, and a cookie is the half we can look
                // at. `authCookieSummary` decodes the expiry INSIDE itself and returns a
                // number — no value ever reaches this log line.
                //
                // A token-shaped cookie whose expiry matches the corpse IS the answer, and
                // `dropStoredToken` could then be taught to reach it. NONE of them being
                // token-shaped is just as useful: it leaves the server, which is a
                // different investigation and not one a clear can ever fix.
                const cookies = await authCookieSummary(ctx).catch(() => []);
                const carrying = cookies.filter((c) => c.jwtExp != null);
                log(carrying.length
                  ? `    TOKEN-SHAPED COOKIE(S) — the corpse may live here: ${carrying
                      .map((c) => `${c.name}@${c.domain} (${c.chars} chars, exp `
                        + `${Math.round((c.jwtExp * 1000 - Date.now()) / 3600_000)}h)`)
                      .join(', ')}`
                  : `    cookies: ${cookies.length} on the RC origins, NONE token-shaped — `
                    + 'so the stale token is coming from the server, not from this profile');
              }
            }
            // THE RESIDENT PAGE DOES NOT KNOW YET. The tab minted the token into the SHARED
            // profile (localStorage is per-origin, not per-page), but the resident SPA is
            // still rendered signed-out and `window.__camphawkRcToken` is per-page — and
            // `checkAndReport` below reads THIS page. Without this reload, every report
            // after a tab renewal would read the resident's stale nothing and announce a
            // dead session over a fresh hour of token — `status = 'sent'` inverted: a
            // repair that happened and cannot be seen.
            if (r?.renewed) {
              mark('renew:refresh-resident');
              await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
              await primeToken(page, { timeoutMs: 15_000 }).catch(() => {});
            }
            // Report immediately either way: this is the event worth seeing on the
            // dashboard, not something to sit on until the next 20-minute tick.
            lastCheck = Date.now();
            mark('reporting session health');
            await checkAndReport(ctx, page).catch((e) => log(`check failed: ${e.message}`));
            } finally {
              // THE RECLAIM. A renderer's memory dies with its page, and this close is the
              // whole mechanism — in a `finally` so a thrown renewal, a failed census or a
              // failed report can never leave the tab (and its gigabytes, on a bad trip)
              // parked in the browser for the resident page's lifetime.
              mark('renew:close-tab');
              // OFF THE TRAIL BEFORE THE TAB GOES — see the same line in `maybeWarmupLogin`.
              allocTrail.unregister('renewal');
              await tab.close().catch(() => {});
            }
          }
        }
        if (Date.now() - lastCheck >= KEEPALIVE_MS) {
          lastCheck = Date.now();
          mark('keepalive check');
          await checkAndReport(ctx, page).catch((e) => log(`check failed: ${e.message}`));
        }
        mark('idle');
        await sleep(1000);
      }
    } catch (err) {
      log(`resident keep-warm error: ${err.message} — reopening in 30s`);
    } finally {
      // BEFORE THE CONTEXT CLOSES AND BEFORE THE TIMER STOPS. Every `break` in the loop above
      // lands here — the post-Okta recycle, the size guard, the runner's preemption — and each
      // one replaces the browser, which is the other way a ramp ends without our ever seeing
      // the renderer swap. The trail is per-`warmResident` and does not survive this point, so
      // a reading not taken here is a reading lost. Bounded for the same reason as the bail.
      //
      // `describeIfEmpty` because THIS is the arm a real ramp actually lands in. The bail
      // needs a stall AND free RAM under 2,000 MB, and the 08-28 ramp bottomed at 4,191 MB —
      // so it never fired, and this `finally` is where that browser was replaced. Without the
      // description a 9 GB ramp leaves nothing but silence here, which is indistinguishable
      // from a quiet night.
      await Promise.race([
        flushAllocRamps({ final: true, describeIfEmpty: true }),
        new Promise((r) => setTimeout(r, 4000)),
      ]).catch(() => {});
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
      await reportSession('dead', `no token at all — signed out; ${verdict}`, okta);
      return;
    }
    log(`… no token when first read, but one arrived on priming (${again.source}) — not reporting`);
    return;
  }

  if (live === true) {
    try { fs.writeFileSync(WARM_MARKER, new Date().toISOString()); } catch { /* best effort */ }
    log(`♻ RC session kept warm (${why}) — ${note}`);
    await reportSession('warm', note, okta);
  } else if (live === null) {
    log(`… RC keep-warm inconclusive: ${why} — reporting nothing, unknown is not dead`);
  } else {
    log(`⚠ RC SESSION IS DEAD: ${why} — ${note}`);
    log('  A human must sign in once: node rc-keepwarm.mjs --login');
    await reportSession('dead', note, okta);
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
