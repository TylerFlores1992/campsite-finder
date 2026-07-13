// CampHawk personal auto-cart bot — multi-account.
//   node bot.mjs --login            → pick an enrolled user and sign them in once
//   node bot.mjs --login <email>    → sign in a specific enrolled user
//   node bot.mjs                    → watch CampHawk and auto-cart openings for all
//                                     enrolled users, each in their own browser profile
//
// Each user opts in via the CampHawk app ("Auto-cart" toggle in Watches). The bot
// pulls the roster with one master token (AUTOCART_TOKEN) and routes each opening to
// that user's own logged-in browser profile (profiles/<userId>). Nobody's password is
// ever stored — each person signs into their own profile once. rec.gov only (RC is
// session-bound and handled by the phone alert). Stops at the cart; users check out.

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
const PROFILES_DIR = path.resolve(__dirname, process.env.PROFILES_DIR || 'profiles');
const HANDLED_FILE = path.join(__dirname, 'handled.json');
const CHANNEL = process.env.CHROME_CHANNEL || undefined; // e.g. "chromium" on a Raspberry Pi

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const profileDir = (userId) => path.join(PROFILES_DIR, String(userId).replace(/[^A-Za-z0-9_-]/g, '_'));

function loadHandled() {
  try { return new Map(JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf8'))); } catch { return new Map(); }
}
function saveHandled(map) {
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [k, t] of map) if (t < cutoff) map.delete(k);
  fs.writeFileSync(HANDLED_FILE, JSON.stringify([...map]));
}

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

// Reuse one persistent context per user for the session.
const contexts = new Map();
async function getContext(userId) {
  if (contexts.has(userId)) return contexts.get(userId);
  const ctx = await chromium.launchPersistentContext(profileDir(userId), {
    headless: false,
    viewport: null,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
  });
  contexts.set(userId, ctx);
  return ctx;
}

async function loginMode(target) {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }
  let users = [];
  try { users = await fetchRoster(); } catch (e) { log(`Could not reach roster: ${e.message}`); process.exit(1); }
  if (users.length === 0) {
    log('No enrolled users yet. Have each person toggle "Auto-cart" ON in the CampHawk app (Watches panel), then re-run.');
    process.exit(0);
  }
  let user = target
    ? users.find((u) => u.userId === target || (u.email || '').toLowerCase() === target.toLowerCase())
    : null;
  if (!user) {
    console.log('\nEnrolled users:');
    users.forEach((u, i) => console.log(`  ${i + 1}. ${u.email || u.userId}`));
    const pick = await ask('\nNumber to sign in: ');
    user = users[Number(pick) - 1];
  }
  if (!user) { log('No user selected.'); process.exit(1); }

  log(`Opening a browser for ${user.email || user.userId}. Sign in to recreation.gov, then press Enter here.`);
  const ctx = await getContext(user.userId);
  await (await ctx.newPage()).goto('https://www.recreation.gov/sign-in').catch(() => {});
  await ask('Press Enter once signed in… ');
  await ctx.close();
  contexts.delete(user.userId);
  log(`Saved session for ${user.email || user.userId}.`);
  process.exit(0);
}

async function runMode() {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }
  const handled = loadHandled();
  log(`Watching ${CAMPHAWK_URL} for all enrolled users, every ${POLL_MS / 1000}s. Ctrl+C to stop.`);

  async function tick() {
    let users = [];
    try { users = await fetchRoster(); } catch (e) { log(`poll error: ${e.message}`); return; }
    for (const user of users) {
      for (const job of user.jobs || []) {
        if (handled.has(job.id)) continue;
        handled.set(job.id, Date.now());
        saveHandled(handled);
        const who = user.email || user.userId;
        log(`🔔 [${who}] ${job.campgroundName} (${job.startDate}→${job.endDate}) [${job.source}]`);
        try {
          if (job.source === 'reservecalifornia') { await noteReserveCalifornia(job, log); continue; }
          if (!fs.existsSync(profileDir(user.userId))) {
            log(`  ⚠ no saved login for ${who} — run: npm run login -- "${user.email || user.userId}"`);
            continue;
          }
          const ctx = await getContext(user.userId);
          await cartRecGov(ctx, job, log);
        } catch (e) { log(`  handler error: ${e.message}`); }
      }
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

const loginIdx = process.argv.indexOf('--login');
if (loginIdx !== -1) loginMode(process.argv[loginIdx + 1] && !process.argv[loginIdx + 1].startsWith('-') ? process.argv[loginIdx + 1] : undefined);
else runMode();
