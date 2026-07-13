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
const POLL_MS = Number(process.env.POLL_MS || 20000);
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 15);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 1)); // browsers open at once
const PROFILES_DIR = path.resolve(__dirname, process.env.PROFILES_DIR || 'profiles');
const HANDLED_FILE = path.join(__dirname, 'handled.json');
const CARTED_FILE = path.join(__dirname, 'carted.json');
const CHANNEL = process.env.CHROME_CHANNEL || undefined; // e.g. "chromium" on a Pi
// WSLg/VM compositors often can't paint Chromium's GPU output (window opens but
// stays blank/won't focus). Software rendering + an explicit on-screen position
// fixes it. Override with CHROME_ARGS if needed.
const LAUNCH_ARGS = (process.env.CHROME_ARGS ??
  '--disable-gpu --window-position=40,40 --window-size=1200,860').split(' ').filter(Boolean);

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
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

// Launch a fresh headed browser for a user, run fn, always close it afterward.
async function withBrowser(userId, fn) {
  const ctx = await chromium.launchPersistentContext(profileDir(userId), {
    headless: false,
    viewport: null,
    args: LAUNCH_ARGS,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
  });
  try { return await fn(ctx); }
  finally { await ctx.close().catch(() => {}); }
}

// A user is "ready" once they've completed a sign-in (marker written on success).
const readyMarker = (userId) => path.join(profileDir(userId), '.camphawk-ready');
const isLoggedIn = (userId) => fs.existsSync(readyMarker(userId));
const loggingIn = new Set();

// Auto-open a rec.gov login window for a newly-enrolled user and detect completion
// (rec.gov redirects away from /sign-in once you're in). No CLI, no "press Enter".
async function ensureLogin(user) {
  const who = user.email || user.userId;
  if (isLoggedIn(user.userId) || loggingIn.has(user.userId)) return;
  loggingIn.add(user.userId);
  log(`🔐 ${who} enabled auto-cart but isn't signed in — opening a recreation.gov login window. Sign in; I'll detect it automatically.`);
  try {
    let signedIn = false;
    await withBrowser(user.userId, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto('https://www.recreation.gov/sign-in').catch(() => {});
      log(`   → Sign in for ${who} in the window that opened, then CLOSE that window. (I'll also auto-detect a redirect.)`);
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        ctx.once('close', finish);   // user closed the window → treat as done
        page.once('close', finish);
        const timer = setInterval(() => {
          let u;
          try { u = page.url(); } catch { clearInterval(timer); return finish(); }
          if (u && u.includes('recreation.gov') && !u.includes('/sign-in')) { clearInterval(timer); finish(); }
        }, 3000);
        setTimeout(() => { clearInterval(timer); finish(); }, 10 * 60 * 1000); // safety
      });
      signedIn = true;
    });
    if (signedIn) {
      fs.writeFileSync(readyMarker(user.userId), new Date().toISOString());
      log(`✅ ${who} is set up — auto-cart is now active for them.`);
    }
  } catch (e) {
    log(`  login error for ${who}: ${e.message}`);
  } finally {
    loggingIn.delete(user.userId);
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
    return;
  }
  log(`  ⧉ opening browser for ${who}…`);
  const ok = await withBrowser(user.userId, (ctx) => cartRecGov(ctx, job, log));
  if (ok) { carted.set(key, Date.now()); saveMap(CARTED_FILE, carted, 30 * 864e5); }
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
  await withBrowser(user.userId, async (ctx) => {
    await (await ctx.newPage()).goto('https://www.recreation.gov/sign-in').catch(() => {});
    await ask('Press Enter once signed in… ');
    fs.writeFileSync(readyMarker(user.userId), new Date().toISOString());
  });
  log(`Saved session for ${user.email || user.userId}.`);
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
}

const li = process.argv.indexOf('--login');
if (li !== -1) loginMode(process.argv[li + 1] && !process.argv[li + 1].startsWith('-') ? process.argv[li + 1] : undefined);
else runMode();
