// CampHawk personal auto-cart bot — multi-account, on-demand.
//   node bot.mjs --login            → pick an enrolled user and sign them in once
//   node bot.mjs --login <email>    → sign in a specific enrolled user
//   node bot.mjs                    → watch CampHawk; when a site opens for an enrolled
//                                     user, spin up their browser, add it to their cart,
//                                     then close the browser. Idle = no browsers open.
//
// Each user opts in via the CampHawk app ("Auto-cart" toggle). The bot pulls the roster
// with one master token (AUTOCART_TOKEN) and routes each opening to that user's own
// browser profile (profiles/<userId>). No passwords are stored — each person signs into
// their own profile once. rec.gov's cart is account-tied, so it syncs to their phone —
// that's why we can close the window right after carting. RC is alert-only (phone link).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cartRecGov } from './recgov.mjs';
import { noteReserveCalifornia } from './reservecalifornia.mjs';
import { recgovLoginState } from './session.mjs';
import { attemptLoginWithCreds } from './recgov-login.mjs';
import { hasCreds, loadCreds, deleteCreds, bumpReloginFails, resetReloginFails } from './credstore.mjs';
import { planRetry, retryDue, repairOwed, giveUpState, shouldBootstrapRepair } from './relogin-retry.mjs';
import { acquireProfileLock, releaseProfileLock, profileLockHolder } from './profile-lock.mjs';
import { makeControlChannel } from './control-channel.mjs';
import { createSampler } from './memory-sample.mjs';
import { loadEnv } from './load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv(import.meta.url);

const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const TOKEN = process.env.AUTOCART_TOKEN; // master token
// Tight poll: auto-cart openings are a race, so react within ~2s of a job landing.
const POLL_MS = Number(process.env.POLL_MS || 2000);
// Keep each signed-in rec.gov session warm this often, so it never dies from
// inactivity between (rare) cart events — the fix for "re-sign-in every few days".
// Tightened 4h → 90m → 30m as rec.gov's idle session TTL kept proving shorter than
// the refresh gap. The 30m step is evidence-based: on 2026-07-22 a session was kept
// warm at 21:04 and the next keepalive at 22:35 (~90m later) found it already dead
// (confirmed-twice 'out'), i.e. the idle TTL is under 90m. Refreshing every 30m stays
// inside any TTL ≳40m with margin. A stale gap is also when the app still reads
// "connected" while the session is dead, so an opening gets routed into the silent
// auto-cart lane and never alerts. The box is on 24/7; the only cost is the headed
// keepalive window flashing a bit more often. Override with KEEPALIVE_MS if needed.
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 30 * 60 * 1000); // 30m
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 15);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 1)); // browsers open at once
const PROFILES_DIR = path.resolve(__dirname, process.env.PROFILES_DIR || 'profiles');
const HANDLED_FILE = path.join(__dirname, 'handled.json');
const CARTED_FILE = path.join(__dirname, 'carted.json');
// How long a successful cart mutes re-carting the SAME site for the same person.
// This was 30 DAYS, and that cost a real cart on 2026-08-01: rec.gov cart holds
// expire after 15 minutes, the user missed the window, the site re-opened an hour
// later, and the bot silently skipped it — for what would have been a month. Just
// past the hold window is long enough to stop churn while someone is checking out,
// and short enough that a re-opened site gets carted again.
const CARTED_TTL_MS = Number(process.env.CARTED_TTL_MS || 20 * 60 * 1000);
const CHANNEL = process.env.CHROME_CHANNEL || undefined; // e.g. "chromium" on a Pi
// 'local'  → the bot pops a login window on this machine when someone enrolls.
// 'remote' → sign-in is done through the web broker (broker.mjs); the bot never
//            opens its own login window (it just waits for the ready-marker).
const LOGIN_MODE = (process.env.LOGIN_MODE || 'local').toLowerCase();
// WSLg/VM compositors often can't paint Chromium's GPU output (window opens but
// stays blank/won't focus). Software rendering + an explicit on-screen position
// fixes it. Override with CHROME_ARGS if needed.
const LAUNCH_ARGS = (process.env.CHROME_ARGS ??
  '--disable-gpu --window-position=40,40 --window-size=1200,860').split(' ').filter(Boolean);

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Flip a user's auto-cart enrollment on the CampHawk side (master token).
async function setEnrollment(userId, enabled) {
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/enrollment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, enabled }),
  });
}

// Tell CampHawk whether the user's one-time rec.gov sign-in is good (drives app UI:
// connected=true after a successful sign-in; false when we detect the session died).
async function reportConnected(userId, connected = true) {
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/enrollment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, connected }),
  }).catch(() => {});
}

// Report the outcome of a cart attempt back to CampHawk. This is what gates the
// user's alert: 'carted' → "it's in your cart" text; anything else → the server
// re-verifies and only alerts if the site is genuinely still open (no false hope).
async function reportResult(jobId, outcome) {
  if (!jobId) return;
  try {
    await fetch(`${CAMPHAWK_URL}/api/auto-cart/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, outcome }),
    });
  } catch (e) {
    log(`  couldn't report cart result: ${e.message}`);
  }
}
const profileDir = (userId) => path.join(PROFILES_DIR, String(userId).replace(/[^A-Za-z0-9_-]/g, '_'));
const siteKey = (userId, bookingUrl) => `${userId}::${bookingUrl.split('#')[0]}`;

function loadMap(file) { try { return new Map(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return new Map(); } }
function saveMap(file, map, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, t] of map) if (t < cutoff) map.delete(k);
  fs.writeFileSync(file, JSON.stringify([...map]));
}

const handled = loadMap(HANDLED_FILE); // notification id -> ts (avoid re-processing a notification)
const carted = loadMap(CARTED_FILE);   // userId::site -> ts  (one cart per site per person per CARTED_TTL_MS)

// Freshness is checked at READ time, not just pruned on save: an existing carted.json
// written by the old 30-day build carries stale entries, and they must stop muting
// sites the moment this version starts.
const cartedRecently = (key) => {
  const t = carted.get(key);
  return typeof t === 'number' && Date.now() - t < CARTED_TTL_MS;
};

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}

async function fetchRoster() {
  const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/roster?windowMin=${WINDOW_MIN}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const body = await res.json();
  return { users: body.users || [], control: body.control || null };
}

/**
 * Report a diagnostic answer back. Shares the hold feed's POST because that is where
 * `recordBotCommandResult` already lives — the channel moved because of WHICH PROCESS polls
 * it, not which URL works, and this process can reach either.
 */
async function reportControl(body) {
  const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`report ${res.status}`);
  return res.json().catch(() => ({}));
}

/**
 * Chromium memory sampling — see memory-sample.mjs for why this is recorded rather than
 * asked for. It rides `reportControl`, i.e. the POST this process already makes, so a sample
 * costs one PowerShell spawn every two minutes and no new plumbing, no new credential and no
 * new endpoint.
 */
const sampleMemory = createSampler({
  post: (memory, source = 'bot') => reportControl({ memory, source }),
  log,
});

/**
 * THE REMOTE LEVER THAT SURVIVES (2026-08-11). Same handler the RC hold runner uses — see
 * control-channel.mjs. This process polls every ~2s and has stayed up through every outage
 * the RC pair has had, including the one that made this necessary, so as long as the rec.gov
 * bot is alive the box can be asked questions and told to update or restart the RC pair.
 */
const control = makeControlChannel({
  dir: __dirname, actor: 'bot', log, report: reportControl,
});

// One browser per profile at a time — the persistent profile dir has a singleton
// lock, so a keepalive refresh must never overlap a cart/login on the same user.
const inUse = new Set();

// Launch a browser on a user's persistent profile, run fn, always close it.
// Headed by default, and everything that touches rec.gov should stay that way —
// it fingerprints headless Chromium. The {headless} option is kept for local
// dry runs against other sites, not for rec.gov work.
async function withBrowser(userId, fn, { headless = false } = {}) {
  for (let i = 0; inUse.has(userId) && i < 240; i++) await sleep(500); // wait up to ~2 min
  if (inUse.has(userId)) throw new Error('profile busy');
  // `inUse` is in-process and cannot see the BROKER, which drives the same profile
  // directory during a remote sign-in. Skipping here costs one keepalive or one cart
  // attempt (both retry on the next tick); not skipping corrupts a sign-in a user is
  // sitting in front of.
  if (!acquireProfileLock(profileDir(userId), 'bot')) {
    const held = profileLockHolder(profileDir(userId));
    throw new Error(`profile busy (${held?.owner ?? 'locked'})`);
  }
  inUse.add(userId);
  try {
    // The rec.gov session lives in the persistent profile on disk — Chromium keeps
    // it across launches, so we do NOT snapshot/re-inject it. (An earlier attempt to
    // save & restore storageState here actively CORRUPTED the profile: saves ran on
    // logged-out closes too, and restoring that stale snapshot overwrote the good
    // session. The keepalive is what prevents the profile's session from expiring.)
    const ctx = await chromium.launchPersistentContext(profileDir(userId), {
      headless,
      viewport: null,
      args: LAUNCH_ARGS,
      // See the broker: --enable-automation sets navigator.webdriver, which rec.gov's
      // reCAPTCHA reads. Same site, same gate, same treatment.
      ignoreDefaultArgs: ['--enable-automation'],
      ...(CHANNEL ? { channel: CHANNEL } : {}),
    });
    try { return await fn(ctx); }
    finally { await ctx.close().catch(() => {}); }
  } finally {
    releaseProfileLock(profileDir(userId));
    inUse.delete(userId);
  }
}

// A user is "ready" once they've completed a sign-in (marker written on success).
const readyMarker = (userId) => path.join(profileDir(userId), '.camphawk-ready');
// When this profile was last confirmed warm. On DISK, not in memory, precisely so a
// restart doesn't re-warm everyone: the startup pass fires 30s after every launch,
// and during an evening of update.bat runs that is a burst of rec.gov logins from one
// residential IP each time — which is what its anti-bot scoring reacts to.
const warmMarker = (userId) => path.join(profileDir(userId), '.camphawk-warmed');

function warmedRecently(userId) {
  try {
    const at = new Date(fs.readFileSync(warmMarker(userId), 'utf8')).getTime();
    return Number.isFinite(at) && Date.now() - at < KEEPALIVE_MS * 0.75;
  } catch { return false; }
}
function stampWarmed(userId) {
  try { fs.writeFileSync(warmMarker(userId), new Date().toISOString()); } catch { /* best effort */ }
}
const isLoggedIn = (userId) => fs.existsSync(readyMarker(userId));
const loggingIn = new Set();

/**
 * A pending auto-relogin: `{kind, attempts, nextAt}`, or null.
 *
 * SEPARATE FROM `.camphawk-ready` ON PURPOSE. That marker means "this profile has a live
 * session", which the cart path reads — after a failed relogin it is honestly false. This
 * one means "an automatic repair is still owed", which is honestly true. Conflating them
 * is what broke: `keepSessionsWarm` gated on the session flag, so clearing it (correctly)
 * also cancelled the retry (incorrectly), and the log line promising a retry was written
 * three lines before the delete that made it impossible.
 */
const retryMarker = (userId) => path.join(profileDir(userId), '.camphawk-relogin');
function readRetry(userId) {
  try { return JSON.parse(fs.readFileSync(retryMarker(userId), 'utf8')); } catch { return null; }
}
function writeRetry(userId, state) {
  try { fs.writeFileSync(retryMarker(userId), JSON.stringify(state)); } catch { /* best effort */ }
}
function clearRetry(userId) {
  try { fs.unlinkSync(retryMarker(userId)); } catch { /* already gone */ }
}
/**
 * Is an automatic repair still owed for this profile, whether or not it is due yet?
 *
 * A saved password counts on its own. The retry state is only ever written by a FAILURE,
 * so a profile whose session simply lapsed has none - and escalating that to a human, when
 * the bot is holding a password the user saved so they would not be asked again, is the
 * whole complaint. A GIVEN-UP repair is owed by nobody, and the escalation is correct then.
 */
const reloginPending = (userId) => {
  const state = readRetry(userId);
  if (state) return repairOwed(state);
  return hasCreds(profileDir(userId));
};

// Confirm a real recreation.gov session (DOM-based; see session.mjs). The old
// URL check was fooled by rec.gov's modal login and false-reported logged-out as
// logged-in.
async function recgovLoggedIn(ctx) {
  return (await recgovLoginState(ctx)) === 'in';
}

async function ensureLogin(user) {
  const who = user.email || user.userId;
  if (LOGIN_MODE === 'remote') return; // sign-in handled by the web broker (broker.mjs)
  if (isLoggedIn(user.userId) || loggingIn.has(user.userId)) return;
  // NOT WHILE AN AUTOMATIC REPAIR IS OWED. This opens an interactive window and, if nobody
  // signs in within ten minutes, calls setEnrollment(false) - it turns the user's auto-cart
  // OFF. Firing it during a pending auto-relogin would un-enrol somebody over a CAPTCHA the
  // bot was already going to retry past, which is a far larger consequence than the missing
  // retry that led here. keepSessionsWarm gives up loudly and clears the marker when the
  // retries are exhausted; that is when this escalation is correct.
  if (reloginPending(user.userId)) return;
  loggingIn.add(user.userId);
  log(`🔐 ${who}: opening a one-time recreation.gov sign-in window — sign in there and I finish automatically. (Closing it without signing in turns auto-cart back off; just toggle it on again to retry.)`);
  let ok = false;
  try {
    await withBrowser(user.userId, async (ctx) => {
      const page = await ctx.newPage();
      let closed = false;
      page.on('close', () => { closed = true; });   // wake up the instant they close it
      await page.goto('https://www.recreation.gov/sign-in').catch(() => {});
      const deadline = Date.now() + 10 * 60 * 1000; // 10 min to sign in
      await sleep(6000);                            // brief head start before first check
      while (Date.now() < deadline && !closed) {
        if (await recgovLoggedIn(ctx)) { ok = true; return; }
        for (let i = 0; i < 4 && !closed; i++) await sleep(1000); // ~4s, wakes early on close
      }
    });
  } catch (e) {
    log(`  login check error for ${who}: ${e.message}`);
  } finally {
    loggingIn.delete(user.userId);
  }
  if (ok) {
    fs.writeFileSync(readyMarker(user.userId), new Date().toISOString());
    await reportConnected(user.userId);
    log(`✅ ${who} signed in — auto-cart is now active.`);
  } else {
    log(`↩︎ ${who} didn't finish signing in — turning their auto-cart back OFF. Toggle it on again to retry.`);
    await setEnrollment(user.userId, false).catch((e) => log(`  couldn't reset toggle for ${who}: ${e.message}`));
  }
}

// Keep every signed-in user's rec.gov session alive. The bot only opens a browser
// when there's a cancellation to cart — which can be days apart — so an idle
// session dies and the user is forced to re-sign-in. Since the mini PC is on 24/7,
// we load an authenticated page every few hours: that rolls the session's expiry
// server-side and lets the SPA refresh its token. If the session
// has genuinely died, we clear it and flip the app to "reconnect" NOW (during the
// day) instead of the user discovering it on a missed cancellation.
async function keepSessionsWarm() {
  let users;
  try { ({ users } = await fetchRoster()); } catch { return; }
  let warmedThisPass = 0;
  for (const user of users) {
    if (inUse.has(user.userId)) continue;
    // A profile with no session is normally none of this pass's business. The ONE exception
    // is a profile that owes an automatic relogin — and that exception is the whole fix:
    // gating on the session flag alone is what made "will retry next cycle" a lie for
    // twelve days. `retryDue` paces it, so a stuck account is not retried every 30 minutes
    // forever from a residential IP.
    if (!isLoggedIn(user.userId)) {
      const state = readRetry(user.userId);
      const bootstrap = shouldBootstrapRepair({
        hasSession: false, hasCredentials: hasCreds(profileDir(user.userId)), state,
      });
      if (!bootstrap && !retryDue(state, Date.now())) continue;
    }
    // Still fresh — nothing to refresh, so don't open a browser at all. This is what
    // makes a restart nearly free instead of a burst.
    if (warmedRecently(user.userId)) continue;
    const who = user.email || user.userId;
    // STAGGER. The loop is already sequential (one window at a time), but back to
    // back it means N sign-in-shaped page loads from one IP inside a few seconds.
    // A jittered gap makes the pass look like people rather than a script. Same
    // reasoning as the Fly worker's paced probe roster.
    if (warmedThisPass > 0) await sleep(15_000 + Math.floor(Math.random() * 30_000));
    warmedThisPass++;
    try {
      // HEADED, like the cart path. rec.gov fingerprints headless Chromium (see
      // processJob), and this runs against the same profile the cart depends on —
      // a keepalive that gets gated refreshes nothing and can misread the session.
      // A window flashes on the mini PC every few hours; that's expected.
      //
      // Clearing a login is destructive (it forces the user to re-sign-in), so it
      // takes TWO independent settled reads. One read is not enough: a single 'out'
      // from a slow hydration or a transient gate used to nuke a live session, which
      // the user only discovered on a missed cancellation.
      const state = await withBrowser(user.userId, async (ctx) => {
        const first = await recgovLoginState(ctx);
        // THE ONLY MOMENT THE REC.GOV FAMILY IS VISIBLE — see memory-sample.mjs. The two
        // browsers this pass opens live a few seconds each, so the 2-minute series samples
        // them essentially never (175 consecutive rows read `recgov 0`, which is the
        // EXPECTED reading and not a lead). This process knows the browser is open because
        // it opened it, so it is the one that can take the reading.
        //
        // AWAITED, NOT FIRE-AND-FORGET. The scan runs in a separate PowerShell process and
        // the browser must still exist while it runs; unawaited, `withBrowser` closes the
        // context first and the sample measures precisely the thing it was added to see.
        // The cost is ~1s on a path that is not latency-critical — unlike the cart, nothing
        // is racing a release here.
        //
        // Taken AFTER the first login check so the page has actually loaded: a browser
        // sampled mid-launch reports a baseline that no later reading can be compared with.
        await sampleMemory({ force: true, source: 'bot-keepalive' });
        if (first !== 'out') return first;
        await sleep(5000);
        return await recgovLoginState(ctx); // confirm before we destroy anything
      }, { headless: false });
      if (state === 'in') {
        // Refresh the server-side freshness marker (autocart_verified_at) so the
        // poller keeps this user in the auto-cart lane. Without a recent stamp the
        // poller fails open to normal alerts — which is what we want if a keepalive
        // ever stops landing (dead box / network drop), but on a healthy keepalive
        // we must re-assert the session is live.
        await reportConnected(user.userId, true);
        // Local stamp too, so the next pass (and any restart) can skip this profile
        // while it is still fresh. The server stamp drives the poller's lane; this
        // one only decides whether to open a browser at all.
        stampWarmed(user.userId);
        log(`♻ ${who}: rec.gov session kept warm`);
      } else if (state === 'out') {
        // Session died. If the user saved their login, try to re-login automatically
        // instead of forcing a manual reconnect.
        const dir = profileDir(user.userId);
        if (hasCreds(dir)) {
          const creds = loadCreds(dir);
          // Ask WHY it failed, not just whether. A reCAPTCHA is not a credential
          // problem, and treating it as one destroys a perfectly good saved login.
          const attempt = creds
            ? await withBrowser(user.userId, async (ctx) => {
                const okNow = await attemptLoginWithCreds(ctx, creds.email, creds.password);
                if (okNow) return { ok: true, captcha: false };
                const page = ctx.pages()[0];
                const captcha = page
                  ? await page
                      .evaluate(() => {
                        const text = document.body?.innerText || '';
                        return (
                          /additional verification required|i'm not a robot|recaptcha/i.test(text) ||
                          !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha')
                        );
                      })
                      .catch(() => false)
                  : false;
                return { ok: false, captcha };
              }, { headless: false }).catch(() => ({ ok: false, captcha: false }))
            : { ok: false, captcha: false };
          const ok = attempt.ok;
          if (ok) {
            fs.writeFileSync(readyMarker(user.userId), new Date().toISOString());
            await reportConnected(user.userId, true);
            resetReloginFails(dir);
            clearRetry(user.userId);
            log(`🔓 ${who}: session had expired — auto-relogin from saved login succeeded, session restored`);
            continue;
          }
          // A CAPTCHA IS NOT A BAD PASSWORD, and must not count toward the purge.
          // The two-strike rule exists to stop us hammering rec.gov with credentials
          // it keeps rejecting — a real lockout risk. But rec.gov throws reCAPTCHA at
          // this browser for its own reasons (see the headless gotcha in
          // docs/CONTEXT.md), and two of those in a row would have deleted a login
          // that was never wrong, forcing the user through a manual reconnect and the
          // very CAPTCHA wall that blocked us. Back off and keep the credentials; the
          // challenge lifts on its own.
          // SCHEDULE THE RETRY THIS LINE PROMISES. It used to only log the promise, and
          // the unconditional `unlinkSync(readyMarker)` below then disqualified this
          // profile from every future pass — so the retry never came, for anyone, ever.
          const kind = attempt.captcha ? 'captcha' : 'credentials';
          const plan = planRetry({
            kind, attempts: readRetry(user.userId)?.attempts ?? 0, now: Date.now(),
          });
          if (kind === 'credentials') bumpReloginFails(dir);
          if (plan.giveUp) {
            // A TOMBSTONE, not a delete. Saved credentials are enough to start a repair on
            // their own, so an erased state would bootstrap a fresh ladder on the very next
            // pass and retry forever. This is what makes giving up mean giving up.
            writeRetry(user.userId, giveUpState({ kind, attempts: plan.attempts, now: Date.now() }));
            // A password rec.gov keeps rejecting will never fix itself; a CAPTCHA might,
            // so its credentials are KEPT for the manual reconnect to reuse.
            if (kind === 'credentials') deleteCreds(dir);
            log(`  ${who}: giving up on auto-relogin — ${plan.why}. Manual reconnect needed.`);
          } else {
            writeRetry(user.userId, { kind, attempts: plan.attempts, nextAt: plan.nextAt });
            log(`  ${who}: auto-relogin blocked by a rec.gov ${kind === 'captcha' ? 'CAPTCHA' : 'rejection'}` +
                ` — keeping the saved login, ${plan.why}`);
          }
        }
        // The session flag stays HONEST: it is false, and the cart path must see that.
        // The retry lives in its own marker above precisely so this can be true without
        // cancelling the repair.
        try { fs.unlinkSync(readyMarker(user.userId)); } catch {}
        await reportConnected(user.userId, false);
        // Say which actually happened. This line claimed "cleared login" on EVERY path,
        // including the CAPTCHA one that had just explicitly kept the credentials — so the
        // log contradicted itself twice in one pass and read as a dead end either way.
        log(reloginPending(user.userId)
          ? `⚠ ${who}: rec.gov session expired — auto-relogin is still pending; they'll be asked to reconnect meanwhile.`
          : `⚠ ${who}: rec.gov session expired (idle, confirmed twice) — cleared login; they'll be asked to reconnect.`);
      } else {
        log(`  ${who}: keepalive inconclusive — leaving session as-is.`);
      }
    } catch (e) {
      log(`  keepalive error for ${who}: ${e.message}`);
    }
  }
}

// --- on-demand queue (bounded concurrency) --------------------------------
const queue = [];
let active = 0;

function enqueue(item) { queue.push(item); pump(); }
function pump() {
  while (active < MAX_CONCURRENCY && queue.length) {
    const item = queue.shift();
    active++;
    processJob(item).catch((e) => log(`  handler error: ${e.message}`)).finally(() => { active--; pump(); });
  }
}

async function processJob({ user, job }) {
  const who = user.email || user.userId;
  const key = siteKey(user.userId, job.bookingUrl);
  if (cartedRecently(key)) return; // carted this site for this person minutes ago
  if (!isLoggedIn(user.userId)) {
    log(`  ⚠ ${who} isn't signed in yet — skipping this one (login window should be open).`);
    await reportResult(job.id, 'skipped-not-logged-in');
    return;
  }
  log(`  ⧉ opening browser for ${who}…`);
  // Run the cart HEADED. rec.gov's anti-bot gate ("abnormal activity") rejects
  // headless Chromium (fingerprinted as automation) — the add returns 200 with
  // ok:false. A real headed browser on the residential mini PC passes the gate.
  const outcome = await withBrowser(user.userId, (ctx) => cartRecGov(ctx, job, log), { headless: false });
  await reportResult(job.id, outcome);
  if (outcome === 'carted') {
    carted.set(key, Date.now());
    saveMap(CARTED_FILE, carted, CARTED_TTL_MS);
  } else if (outcome === 'session-expired') {
    // The cart page bounced to sign-in — the session really died. Clear the marker
    // and flip the app's connected state off so the user is prompted to reconnect.
    try { fs.unlinkSync(readyMarker(user.userId)); } catch {}
    await reportConnected(user.userId, false);
    log(`  ⚠ ${who}: rec.gov session expired — cleared the saved login; they'll be asked to reconnect.`);
  } else {
    // Every outcome gets a console line. These were reported to the server but printed
    // NOTHING here — on 2026-07-29 a browser opened and closed in 3 seconds with no
    // trace, and the only way to learn why was a database query. The server is the
    // record; this log is how a human watching the box knows what just happened.
    log(`  ⚠ ${who}: not carted — ${outcome}`);
  }
  log(`  ⧉ closed browser for ${who}`);
}

async function loginMode(target) {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }
  let users = [];
  try { ({ users } = await fetchRoster()); } catch (e) { log(`Could not reach roster: ${e.message}`); process.exit(1); }
  if (users.length === 0) {
    log('No enrolled users. Have each person toggle "Auto-cart" ON in the CampHawk app first.');
    process.exit(0);
  }
  let user = target
    ? users.find((u) => u.userId === target || (u.email || '').toLowerCase() === target.toLowerCase())
    : null;
  if (!user) {
    console.log('\nEnrolled users:');
    users.forEach((u, i) => console.log(`  ${i + 1}. ${u.email || u.userId}`));
    user = users[Number(await ask('\nNumber to sign in: ')) - 1];
  }
  if (!user) { log('No user selected.'); process.exit(1); }
  log(`Opening a browser for ${user.email || user.userId}. Sign in to recreation.gov, then press Enter here.`);
  let ok = false;
  await withBrowser(user.userId, async (ctx) => {
    await (await ctx.newPage()).goto('https://www.recreation.gov/sign-in').catch(() => {});
    await ask('Press Enter once signed in… ');
    ok = await recgovLoggedIn(ctx);
  });
  if (ok) {
    fs.writeFileSync(readyMarker(user.userId), new Date().toISOString());
    await reportConnected(user.userId);
    log(`Saved session for ${user.email || user.userId}.`);
  } else {
    log(`Hmm — you don't look signed in to recreation.gov yet. Re-run once you've signed in.`);
  }
  process.exit(0);
}

async function runMode() {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }
  log(`Watching ${CAMPHAWK_URL} for all enrolled users, every ${POLL_MS / 1000}s (browsers open only on a hit; up to ${MAX_CONCURRENCY} at once). Ctrl+C to stop.`);

  async function tick() {
    let users, ctl;
    try { ({ users, control: ctl } = await fetchRoster()); }
    catch (e) { log(`poll error: ${e.message}`); return; }
    // Before the carting work and never awaited by it. `handleControl` returns
    // synchronously and fires its own background tasks, so a diagnostic — or an update
    // hand-off — cannot delay a job that is a race by design.
    if (ctl) control(ctl);
    // Record what Chromium is costing this box. Not awaited, for the same reason as the line
    // above: a measurement that can delay a cart is not worth taking. Self-throttled to
    // SAMPLE_EVERY_MS, so calling it on a 2s tick is free.
    //
    // IT LIVES HERE, IN bot.mjs, DELIBERATELY. The RC pair have died twice while this process
    // stayed healthy and polling — 2026-08-11, and the 08-14 morning when restart-rc had
    // launched them as bare Node REPLs — and a series with a hole in it at the interesting
    // moment is the thing this whole exercise is trying to stop being.
    void sampleMemory();
    for (const user of users) {
      // Newly enrolled + not signed in yet → auto-open a login window (non-blocking).
      // `ensureLogin` no-ops on a pending auto-relogin; the check is repeated here so the
      // reason is visible at the call site too.
      if (!isLoggedIn(user.userId) && !reloginPending(user.userId)) ensureLogin(user);
      for (const job of user.jobs || []) {
        if (handled.has(job.id)) continue;
        handled.set(job.id, Date.now());
        saveMap(HANDLED_FILE, handled, 2 * 3600 * 1000);
        if (job.source === 'reservecalifornia') { await noteReserveCalifornia(job, log); continue; }
        if (cartedRecently(siteKey(user.userId, job.bookingUrl))) {
          // Say so and REPORT it — this skip used to be a silent `continue`, which left
          // the job with no outcome at all: the server waited out its full reconcile
          // delay before falling back to a plain alert, and the bot log showed nothing.
          log(`  ↻ [${user.email || user.userId}] ${job.campgroundName} — skipped, carted for them in the last ${Math.round(CARTED_TTL_MS / 60000)}m`);
          await reportResult(job.id, 'skipped-already-carted');
          continue;
        }
        log(`🔔 [${user.email || user.userId}] ${job.campgroundName} (${job.startDate}→${job.endDate})`);
        enqueue({ user, job });
      }
    }
  }

  await tick();
  setInterval(tick, POLL_MS);

  // Keep signed-in sessions alive so nobody has to re-sign-in every few days.
  // Math.round(30min / 1h) is 1, so this used to announce "every 1h" for a 30-minute
  // keepalive. Print the real number.
  log(`Session keepalive every ${Math.round(KEEPALIVE_MS / 60000)}m (profiles warmed in the last ${Math.round(KEEPALIVE_MS * 0.75 / 60000)}m are skipped).`);
  setTimeout(keepSessionsWarm, 30_000); // once shortly after startup
  setInterval(keepSessionsWarm, KEEPALIVE_MS);
}

const li = process.argv.indexOf('--login');
if (li !== -1) loginMode(process.argv[li + 1] && !process.argv[li + 1].startsWith('-') ? process.argv[li + 1] : undefined);
else runMode();
