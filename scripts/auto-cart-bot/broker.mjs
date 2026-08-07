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
import { openLoginModalAndFill } from './recgov-login.mjs';
import { waitForProfileLock, releaseProfileLock, releaseProfileLockIfMine, profileLockHolder } from './profile-lock.mjs';
import { saveCreds } from './credstore.mjs';
import { loadEnv } from './load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv(import.meta.url);

const SECRET = process.env.AUTOCART_TOKEN;
const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const PORT = Number(process.env.BROKER_PORT || 8787);
const PROFILES_DIR = path.resolve(__dirname, process.env.PROFILES_DIR || 'profiles');
const CHANNEL = process.env.CHROME_CHANNEL || undefined;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Headless by default: nobody watches the mini PC directly (the whole point is
// remote streaming), and headless makes screencast + background login-checks
// reliable — a headed browser throttles/steals focus when a check tab opens.
// HEADED BY DEFAULT, and this is not a preference — it is the documented rule for
// every rec.gov browser path (docs/CONTEXT.md, "Hard-won gotchas"): rec.gov flags
// headless Chromium, a real headed browser on the residential mini PC passes. The
// bot has always passed `headless: false` for carting and the keepalive; the broker
// defaulted the other way, so remote sign-in ran headless and rec.gov answered with
// a reCAPTCHA that could never be satisfied — solving it just produced another one,
// because the browser itself was what failed the check (observed 2026-07-29).
// Set BROKER_HEADLESS=1 to force headless for debugging; nothing else should.
const HEADLESS = /^(1|true|yes|on)$/i.test(process.env.BROKER_HEADLESS ?? '');
// `--disable-blink-features=AutomationControlled` clears navigator.webdriver, which
// reCAPTCHA reads directly. Note --disable-gpu is dropped: it is a headless-era flag
// and a real headed browser has no reason to run without the GPU.
const LAUNCH_ARGS = (process.env.CHROME_ARGS ??
  '--disable-blink-features=AutomationControlled --window-position=-3000,-3000 --window-size=1000,760')
  .split(' ').filter(Boolean);

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
        // A throw after the lock was taken (browser launch, CDP attach) would
        // otherwise leave the profile locked until it goes stale, blocking the bot's
        // keepalive and carting for ten minutes over a session that never started.
        releaseProfileLockIfMine(profileDir(userId), 'broker');
        log(`  session start failed: ${e.message}`);
        sendJson({ t: 'error', message: 'could not start sign-in session' });
        ws.close();
        return null;
      });
      return;
    }

    // Post-auth: forward input events to the live page.
    // NOT `.catch(() => {})`. Swallowing here meant a throw inside doLogin produced
    // no log line and no message to the browser, so the page just sat there until it
    // timed out — the failure looked identical to "the helper never got the request",
    // which is unknowable from the outside. Log it, and tell the client something
    // happened.
    if (session?.onInput) {
      await session.onInput(msg).catch((e) => {
        log(`  input handler failed on '${msg?.t}': ${e?.message || e}`);
        try { session.sendJson({ t: 'error', message: 'The sign-in helper hit an error. Please try again.' }); } catch {}
      });
    }
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
  // Take the profile before opening Chromium on it. The bot uses the same directory
  // and its keepalive has landed mid-sign-in — one profile with two browsers on it
  // means they disagree about whether the account is signed in, which is exactly the
  // "form filled, never confirms" failure. The bot's jobs are short, so a short wait
  // clears almost every collision.
  if (!(await waitForProfileLock(profileDir(userId), 'broker'))) {
    const held = profileLockHolder(profileDir(userId));
    log(`  profile busy (held by ${held?.owner ?? 'unknown'}) — cannot start sign-in for ${userId}`);
    sendJson({ t: 'error', message: 'The helper is busy with another job right now. Please try again in a minute.' });
    throw new Error('profile locked');
  }
  const ctx = await chromium.launchPersistentContext(profileDir(userId), {
    headless: HEADLESS,
    viewport: null,
    args: LAUNCH_ARGS,
    // Playwright adds --enable-automation, which sets navigator.webdriver and is one
    // of the first things reCAPTCHA looks at.
    ignoreDefaultArgs: ['--enable-automation'],
    ...(CHANNEL ? { channel: CHANNEL } : {}),
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  // rec.gov has NO /sign-in page (it 404s "Please Bear With Us") — login is a modal
  // opened from the header "Sign Up / Log In". Land on the homepage, which has that
  // button, so both the auto-fill and the streamed fallback work.
  await page.goto('https://www.recreation.gov/').catch(() => {});

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
    releaseProfileLock(profileDir(userId));
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

  // Type the user's credentials into rec.gov's login modal (the primary path — the
  // viewer sends them from its own fields instead of tapping the streamed page). Uses
  // the shared login helper. On ANY problem (form not found, wrong password, CAPTCHA/
  // 2FA, or login just doesn't land) we tell the viewer to fall back to the live window
  // ('manual'), where the screencast is already running to finish by hand. On success
  // the existing login-detection loop writes the ready-marker and sends 'done' — and if
  // `remember` was set, we persist the credentials ENCRYPTED so the bot can auto-relogin.
  const doLogin = async (email, password, remember) => {
    // These used to return in silence, which from the browser is indistinguishable
    // from the request never arriving at all.
    if (done || closed || !email || !password) {
      log(`  login ignored for ${userId} (done=${done} closed=${closed} creds=${!!email && !!password})`);
      if (!done && !closed) sendJson({ t: 'manual', message: 'Please finish signing in in the window below.' });
      return;
    }
    try {
      log(`  filling the rec.gov login form for ${userId}…`);
      // HARD CEILING. openLoginModalAndFill can hang rather than throw — a page
      // mid-navigation, a browser busy with the bot's keepalive, a profile lock.
      // A hang here produced NOTHING: no error, no 'manual', just a browser sitting
      // there until the user gave up. Losing the race is treated exactly like a
      // failure, which hands over to the streamed window the user can finish by hand.
      await Promise.race([
        openLoginModalAndFill(page, email, password),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out filling the login form')), 30000)),
      ]);
      log(`  form filled for ${userId}, waiting for rec.gov to confirm…`);
    } catch (e) {
      log(`  couldn't fill the login form for ${userId}: ${e?.message || e}`);
      sendJson({ t: 'manual', message: 'Please finish signing in in the window below.' });
      return;
    }
    // Wait for a confirmed logged-in state; store creds on success, else hand off.
    //
    // BOUNDED BY THE CLOCK, NOT BY A COUNT — this is what left the browser hanging.
    // The old loop ran 15 iterations and read like "poll for 15 seconds", but each
    // recgovLoggedIn() opens a page, navigates to /account/profile (25s timeout),
    // waits 2s, then settles for up to 9s. That is up to ~36s PER CHECK, so fifteen
    // of them is up to nine minutes. The browser gives up after 90s, so the user saw
    // a timeout while this was still patiently working. Confirmed from the mini-PC
    // log: "form filled … waiting for rec.gov to confirm" and then nothing.
    //
    // 45s total, and each check capped, so an answer always arrives before the page
    // stops listening. Ending early is safe: the background poll above keeps
    // checking and sends 'done' if the sign-in did land, which the client honours
    // even after a 'manual'.
    const saveIfWanted = () => {
      if (!remember) return;
      try { saveCreds(profileDir(userId), email, password); log(`🔒 saved encrypted login for ${userId} (auto-relogin enabled)`); }
      catch (e) { log(`  couldn't save login for ${userId}: ${e.message}`); }
    };

    const deadline = Date.now() + 45000;
    while (!done && !closed && Date.now() < deadline) {
      const confirmed = await Promise.race([
        recgovLoggedIn(ctx).catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 12000)),
      ]);
      if (confirmed) {
        saveIfWanted();
        return; // the background poll writes the marker + sends 'done'
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // The background poll got there first — a success, not a failure, and the
    // credentials still need saving. The old code fell through to the hand-off
    // branch here and silently skipped saving them.
    if (done) { saveIfWanted(); return; }

    if (!closed) {
      // WHY it didn't finish matters to the person reading it. rec.gov throws a
      // reCAPTCHA at logins it suspects of automation ("Additional Verification
      // Required"), and no amount of retrying clears that — a human has to tick the
      // box. Saying "couldn't finish automatically" sends them to look for a problem
      // with their password instead of at the checkbox sitting in the window.
      const captcha = await page
        .evaluate(() => {
          const text = document.body?.innerText || '';
          return (
            /additional verification required|i'm not a robot|recaptcha/i.test(text) ||
            !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha')
          );
        })
        .catch(() => false);
      log(`  rec.gov never confirmed the sign-in for ${userId} within 45s${captcha ? ' — reCAPTCHA challenge on the page' : ''} — handing over to the window`);
      sendJson({
        t: 'manual',
        message: captcha
          ? "rec.gov is asking for a CAPTCHA. Tick \u201cI\u2019m not a robot\u201d in the window below and press Log In \u2014 we\u2019ll take it from there."
          : "Couldn't finish sign-in automatically — please complete it in the window below.",
      });
    }
  };

  // Map viewer input (canvas-space) onto the real page.
  const onInput = async (m) => {
    if (done || closed) return;
    if (m.t === 'login') {
      // Ack FIRST. The browser cannot otherwise tell "the helper never received
      // this" from "the helper is working on it" — doLogin can legitimately stay
      // silent for ~34s, and that ambiguity is what made this hard to diagnose.
      log(`  ↩ login request received for ${userId}`);
      try { sendJson({ t: 'ack' }); } catch {}
      await doLogin(m.email, m.password, m.remember);
      return;
    }
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
