// CampHawk personal auto-cart bot.
//   node bot.mjs --login   → open a browser, sign in once (session is saved)
//   node bot.mjs           → watch CampHawk for openings and auto-cart them
//
// Runs entirely on YOUR machine, in YOUR logged-in browser session, on YOUR IP.
// It stops at the cart — you review and pay. rec.gov is fully automatic;
// ReserveCalifornia opens the page for you to finish (see reservecalifornia.mjs).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cartRecGov } from './recgov.mjs';
import { cartReserveCalifornia } from './reservecalifornia.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependency).
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
const TOKEN = process.env.AUTOCART_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 20000);
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 15);
const PROFILE_DIR = path.resolve(__dirname, process.env.PROFILE_DIR || 'chrome-profile');
const HANDLED_FILE = path.join(__dirname, 'handled.json');

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function loadHandled() {
  try { return new Map(JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf8'))); } catch { return new Map(); }
}
function saveHandled(map) {
  const cutoff = Date.now() - 2 * 3600 * 1000; // prune > 2h old
  for (const [k, t] of map) if (t < cutoff) map.delete(k);
  fs.writeFileSync(HANDLED_FILE, JSON.stringify([...map]));
}

async function loginMode() {
  log('Login mode. A browser will open — sign in to recreation.gov and/or reservecalifornia.com.');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
  await (await context.newPage()).goto('https://www.recreation.gov/sign-in').catch(() => {});
  await (await context.newPage()).goto('https://www.reservecalifornia.com/').catch(() => {});
  await new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nPress Enter here once you are signed in… ', () => { rl.close(); res(); });
  });
  await context.close();
  log('Session saved to ' + PROFILE_DIR + '. Now run: npm start');
}

async function runMode() {
  if (!TOKEN) { log('ERROR: AUTOCART_TOKEN is not set. Copy .env.example to .env and fill it in.'); process.exit(1); }
  const handled = loadHandled();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null });
  log(`Watching ${CAMPHAWK_URL} every ${POLL_MS / 1000}s. Keep this window and the browser open. Ctrl+C to stop.`);

  async function tick() {
    let jobs = [];
    try {
      const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/pending?windowMin=${WINDOW_MIN}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok) { log(`poll ${res.status}`); return; }
      jobs = (await res.json()).jobs || [];
    } catch (e) { log(`poll error: ${e.message}`); return; }

    for (const job of jobs) {
      if (handled.has(job.id)) continue;
      handled.set(job.id, Date.now());
      saveHandled(handled);
      log(`🔔 opening: ${job.campgroundName} (${job.startDate}→${job.endDate}) [${job.source}]`);
      try {
        if (job.source === 'reservecalifornia') await cartReserveCalifornia(context, job, log);
        else await cartRecGov(context, job, log);
      } catch (e) { log(`  handler error: ${e.message}`); }
    }
  }

  await tick();
  setInterval(tick, POLL_MS);
}

if (process.argv.includes('--login')) loginMode();
else runMode();
