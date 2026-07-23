// CampHawk remote sign-in broker (Option C) — runs on the mini PC alongside bot.mjs.
//   node broker.mjs
//
// Lets a friend complete their one-time recreation.gov sign-in from ANY computer,
// with the resulting session landing in this machine's browser profile (where the
// bot reads it). No cookie files, no remote-desktop app.
//
// Flow: the CampHawk /connect page opens a websocket here (through a Cloudflare
// Tunnel), sends a short-lived HMAC token as its first message; we verify it,
// launch that user's own browser profile at rec.gov/sign-in, and stream the live
// page to their browser (CDP screencast) while forwarding their clicks/keys back.
// The instant a real session exists we write the ready-marker and close — exactly
// like the local sign-in, just driven remotely.

import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyConnectToken } from './token.mjs';
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

const SECRET = process.env.AUTOCART_TOKEN;
const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const PORT = Number(process.env.BROKER_PORT || 8787);
const PROFILES_DIR = path.resolve(__dirname, process.env.PROFILES_DIR || 'profiles');
const CHANNEL = process.env.CHROME_CHANNEL || undefined;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Headless by default: nobody watches the mini PC directly (the whole point is
// remote streaming), and headless makes screencast + background login-checks
// reliable — a headed browser throttles/steals focus when a check tab opens.
// Set BROKER_HEADLESS=0 to watch the real window while debugging.
const HEADLESS = !/^(0|false|no|off)$/i.test(process.env.BROKER_HEADLESS ?? '');
const LAUNCH_ARGS = (process.env.CHROME_ARGS ??
  '--disable-gpu --window-position=-3000,-3000 --window-size=1000,760').split(' ').filter(Boolean);

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = (userId) => path.join(PROFILES_DIR, String(userId).replace(/[^A-Za-z0-9_-]/g, '_'));
const readyMarker = (userId) => path.join(profileDir(userId), '.camphawk-ready');

// Confirm a real recreation.gov session via the DOM (shared with the bot — see
// session.mjs). The previous URL-based check was fooled by rec.gov's modal login
// (the URL never becomes /sign-in when logged out), so it could write the
// ready-marker for a session that was never actually established.
async function recgovLoggedIn(ctx) {
  return (await recgovLoginState(ctx)) === 'in';
}

if (!SECRET) { log('ERROR: AUTOCART_TOKEN (master) not set. See .env.example.'); process.exit(1); }

// One in-flight session per user (a reconnect replaces the old one).
const sessions = new Map(); // userId -> { close }

const wss = new WebSocketServer({ port: PORT });
log(`Remote sign-in broker listening on ws://0.0.0.0:${PORT} (expose via a tunnel). Ctrl+C to stop.`);

wss.on('connection', (ws) => {
  let session = null;
  let authed = false;

  const sendJson = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // First message must be the auth token; nothing else is honored until then.
    if (!authed) {
      const userId = msg?.token ? verifyConnectToken(msg.token, SECRET) : null;
      if (!userId) { sendJson({ t: 'error', message: 'bad or expired token' }); ws.close(); return; }
      authed = true;
      session = await startSession(userId, ws, sendJson).catch((e) => {
        log(`  session start failed: ${e.message}`);
        sendJson({ t: 'error', message: 'could not start sign-in session' });
        ws.close();
        return null;
      });
      return;
    }

    // Post-auth: forward input events to the live page.
    if (session?.onInput) await session.onInput(msg).catch(() => {});
  });

  ws.on('close', () => { if (session?.close) session.close('client disconnected'); });
  ws.on('error', () => { if (session?.close) session.close('socket error'); });
});

async function startSession(userId, ws, sendJson) {
  // Replace any existing session for this user (e.g. they reopened the page) —
  // tell the stale client so it doesn't sit frozen, then tear it down.
  const prev = sessions.get(userId);
  if (prev) {
    prev.sendJson?.({ t: 'error', message: 'This sign-in was reopened in another tab.' });
    prev.close('replaced by new connection');
  }

  log(`🔐 remote sign-in started for ${userId}`);
  const ctx = await chromium.launchPersistentContext(profileDir(userId), {
    headless: HEADLESS,
    viewport: null,
    args: LAUNCH_ARGS,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.recreation.gov/sign-in').catch(() => {});

  const client = await ctx.newCDPSession(page);
  let dims = { w: 1000, h: 760 };
  client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    if (metadata?.deviceWidth) dims = { w: metadata.deviceWidth, h: metadata.deviceHeight };
    sendJson({ t: 'frame', data, w: dims.w, h: dims.h });
    await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1 });

  let done = false;
  let closed = false;
  const close = async (reason) => {
    if (closed) return;
    closed = true;
    sessions.delete(userId);
    clearInterval(poll);
    await client.send('Page.stopScreencast').catch(() => {});
    await ctx.close().catch(() => {});
    log(`  session ended for ${userId}${reason ? ` (${reason})` : ''}`);
  };

  // Poll the definitive account-page check (invisible in headless). `checking`
  // guards against overlapping checks since each can take a few seconds.
  let checking = false;
  const poll = setInterval(async () => {
    if (done || closed || checking) return;
    checking = true;
    try {
      if (await recgovLoggedIn(ctx)) {
        done = true;
        fs.mkdirSync(profileDir(userId), { recursive: true });
        fs.writeFileSync(readyMarker(userId), new Date().toISOString());
        // The signed-in session now lives in the persistent profile; the bot reads
        // the same profile, so nothing extra to persist here.
        log(`✅ ${userId} signed in remotely — auto-cart active.`);
        // Tell CampHawk the one-time sign-in is done (drives app UI state).
        fetch(`${CAMPHAWK_URL}/api/auto-cart/enrollment`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, connected: true }),
        }).catch(() => {});
        sendJson({ t: 'done' });
        await close('signed in');
      }
    } finally {
      checking = false;
    }
  }, 6000);

  const deadline = setTimeout(() => close('timed out'), LOGIN_TIMEOUT_MS);
  deadline.unref?.();

  // Type the user's credentials into rec.gov's sign-in form (the primary path — the
  // viewer sends them from its own fields instead of tapping the streamed page).
  // Selectors are best-effort; on ANY problem (form not found, wrong password, CAPTCHA/
  // 2FA, or login just doesn't land) we tell the viewer to fall back to the live window
  // ('manual'), where the screencast is already running for them to finish by hand. On
  // success the existing login-detection loop writes the ready-marker and sends 'done'.
  const EMAIL_SEL = 'input[type="email"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input#email';
  const PW_SEL = 'input[type="password"], input[name="password"], input[autocomplete="current-password"], input#password';
  const doLogin = async (email, password) => {
    if (done || closed || !email || !password) return;
    try {
      const em = page.locator(EMAIL_SEL).first();
      await em.waitFor({ state: 'visible', timeout: 8000 });
      await em.fill(email);
      let pw = page.locator(PW_SEL).first();
      if (!(await pw.isVisible().catch(() => false))) {
        // Two-step forms: submit the email, then the password field appears.
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(1200);
        pw = page.locator(PW_SEL).first();
        await pw.waitFor({ state: 'visible', timeout: 8000 });
      }
      await pw.fill(password);
      const btn = page.getByRole('button', { name: /log ?in|sign ?in/i }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
      else await page.keyboard.press('Enter').catch(() => {});
    } catch {
      sendJson({ t: 'manual', message: 'Please finish signing in in the window below.' });
      return;
    }
    // The detection loop flips `done` on success. Give it ~15s; otherwise hand off.
    for (let i = 0; i < 15 && !done && !closed; i++) await new Promise((r) => setTimeout(r, 1000));
    if (!done && !closed) sendJson({ t: 'manual', message: "Couldn't finish sign-in automatically — please complete it in the window below." });
  };

  // Map viewer input (canvas-space) onto the real page.
  const onInput = async (m) => {
    if (done || closed) return;
    if (m.t === 'login') { await doLogin(m.email, m.password); return; }
    const px = Math.round((m.x ?? 0) * dims.w);
    const py = Math.round((m.y ?? 0) * dims.h);
    switch (m.t) {
      case 'move': await page.mouse.move(px, py); break;
      case 'down': await page.mouse.move(px, py); await page.mouse.down({ button: m.button || 'left' }); break;
      case 'up': await page.mouse.up({ button: m.button || 'left' }); break;
      case 'click': await page.mouse.click(px, py, { button: m.button || 'left' }); break;
      case 'wheel': await page.mouse.wheel(m.dx || 0, m.dy || 0); break;
      case 'text': if (m.text) await page.keyboard.insertText(m.text); break;
      case 'key': if (m.key) await page.keyboard.press(m.key); break;
    }
  };

  const session = { close, onInput, sendJson };
  sessions.set(userId, session);
  sendJson({ t: 'ready', w: dims.w, h: dims.h });
  return session;
}
