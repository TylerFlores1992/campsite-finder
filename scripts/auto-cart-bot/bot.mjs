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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();

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
const carted = loadMap(CARTED_FILE);   // userId::site -> ts  (one successful cart per site per person)

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
  return (await res.json()).users || [];
}

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
      ...(CHANNEL ? { channel: CHANNEL } : {}),
    });
    try { return await fn(ctx); }
    finally { await ctx.close().catch(() => {}); }
  } finally {
    inUse.delete(userId);
  }
}

// A user is "ready" once they've completed a sign-in (marker written on success).
const readyMarker = (userId) => path.join(profileDir(userId), '.camphawk-ready');
const isLoggedIn = (userId) => fs.existsSync(readyMarker(userId));
const loggingIn = new Set();

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
  try { users = await fetchRoster(); } catch { return; }
  for (const user of users) {
    if (!isLoggedIn(user.userId) || inUse.has(user.userId)) continue;
    const who = user.email || user.userId;
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
        if (first !== 'out') return first;
        await sleep(5000);
        return await recgovLoginState(ctx); // confirm before we destroy anything
      }, { headless: false });
      if (state === 'in') {
        log(`♻ ${who}: rec.gov session kept warm`);
      } else if (state === 'out') {
        try { fs.unlinkSync(readyMarker(user.userId)); } catch {}
        await reportConnected(user.userId, false);
        log(`⚠ ${who}: rec.gov session expired (idle, confirmed twice) — cleared login; they'll be asked to reconnect.`);
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
  if (carted.has(key)) return; // already carted this site for this person
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
    saveMap(CARTED_FILE, carted, 30 * 864e5);
  } else if (outcome === 'session-expired') {
    // The cart page bounced to sign-in — the session really died. Clear the marker
    // and flip the app's connected state off so the user is prompted to reconnect.
    try { fs.unlinkSync(readyMarker(user.userId)); } catch {}
    await reportConnected(user.userId, false);
    log(`  ⚠ ${who}: rec.gov session expired — cleared the saved login; they'll be asked to reconnect.`);
  }
  log(`  ⧉ closed browser for ${who}`);
}

async function loginMode(target) {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }
  let users = [];
  try { users = await fetchRoster(); } catch (e) { log(`Could not reach roster: ${e.message}`); process.exit(1); }
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
    let users;
    try { users = await fetchRoster(); } catch (e) { log(`poll error: ${e.message}`); return; }
    for (const user of users) {
      // Newly enrolled + not signed in yet → auto-open a login window (non-blocking).
      if (!isLoggedIn(user.userId)) ensureLogin(user);
      for (const job of user.jobs || []) {
        if (handled.has(job.id)) continue;
        handled.set(job.id, Date.now());
        saveMap(HANDLED_FILE, handled, 2 * 3600 * 1000);
        if (job.source === 'reservecalifornia') { await noteReserveCalifornia(job, log); continue; }
        if (carted.has(siteKey(user.userId, job.bookingUrl))) continue;
        log(`🔔 [${user.email || user.userId}] ${job.campgroundName} (${job.startDate}→${job.endDate})`);
        enqueue({ user, job });
      }
    }
  }

  await tick();
  setInterval(tick, POLL_MS);

  // Keep signed-in sessions alive so nobody has to re-sign-in every few days.
  log(`Session keepalive every ${Math.round(KEEPALIVE_MS / 3600000)}h.`);
  setTimeout(keepSessionsWarm, 30_000); // once shortly after startup
  setInterval(keepSessionsWarm, KEEPALIVE_MS);
}

const li = process.argv.indexOf('--login');
if (li !== -1) loginMode(process.argv[li + 1] && !process.argv[li + 1].startsWith('-') ? process.argv[li + 1] : undefined);
else runMode();
