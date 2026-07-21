// Reliable recreation.gov login detection + session persistence, shared by the
// bot and the broker.
//
// Persistence: rec.gov keeps you signed in with a SESSION cookie (no expiry).
// Playwright's persistent profile drops session cookies when the context closes,
// so the broker signs in fine but the bot's next fresh browser is logged out.
// Fix: while logged in, snapshot the cookies to a file (saveSession); on every
// launch, re-inject them before navigating (restoreSession). localStorage already
// survives in the persistent profile, so cookies are all we need to carry over.

import fs from 'node:fs';
import path from 'node:path';
//
// The old check watched the URL ("/account/profile stays put when logged in,
// bounces to /sign-in when out"). That is WRONG: rec.gov signs you in through a
// MODAL, so the URL never becomes /sign-in — a logged-out browser sits on
// /account/profile showing a login prompt, and the URL check falsely reports
// "logged in." That let the bot cart while signed out (rec.gov silently no-ops)
// and let the keepalive report a dead session as warm.
//
// The trustworthy DOM signal: the header shows a "Sign Up or Log In" button ONLY
// when logged out; once you're in, it's replaced by the account menu. So the
// presence of that button = logged out, its absence (on a loaded page) = logged in.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where a user's carried-over session (cookies + localStorage) lives.
export const sessionFile = (profileDir) => path.join(profileDir, 'session-state.json');

// Snapshot the FULL session to disk (call while logged in): cookies + per-origin
// localStorage. rec.gov's logged-in state lives partly in a localStorage token,
// which the persistent profile doesn't reliably carry across a close — so cookies
// alone weren't enough. Returns {cookies, ls} counts.
export async function saveSession(ctx, profileDir) {
  try {
    const state = await ctx.storageState();
    fs.writeFileSync(sessionFile(profileDir), JSON.stringify(state));
    const ls = (state.origins || []).reduce((n, o) => n + (o.localStorage?.length || 0), 0);
    return { cookies: state.cookies?.length || 0, ls };
  } catch {
    return { cookies: 0, ls: 0 };
  }
}

// Re-inject the saved session into a freshly-launched context (call before
// navigating): cookies via addCookies, localStorage via an init script that runs
// on every page before the app's scripts. Returns {cookies, ls} restored.
export async function restoreSession(ctx, profileDir) {
  try {
    const state = JSON.parse(fs.readFileSync(sessionFile(profileDir), 'utf8'));
    let cookies = 0;
    let ls = 0;
    if (Array.isArray(state.cookies) && state.cookies.length) {
      await ctx.addCookies(state.cookies);
      cookies = state.cookies.length;
    }
    for (const o of state.origins || []) {
      if (o.localStorage?.length) {
        await ctx.addInitScript((items) => {
          try { for (const it of items) window.localStorage.setItem(it.name, it.value); } catch { /* cross-origin */ }
        }, o.localStorage);
        ls += o.localStorage.length;
      }
    }
    return { cookies, ls };
  } catch {
    return { cookies: 0, ls: 0 };
  }
}

// The exact header CTA rec.gov shows when logged out (a few label variants).
const LOGIN_LABELS = /^(log\s?in|sign\s?in|sign\s?up or log\s?in|log\s?in or sign\s?up|sign\s?up \/ log\s?in)$/i;

// Returns 'in' | 'out' | 'unknown'. 'unknown' only when the page didn't load, so
// callers can avoid acting on a transient failure (e.g. don't clear a login on it).
//
// 'out' must SETTLE before we believe it. rec.gov's SPA paints the logged-out
// header first and swaps in the account menu on hydration, so a single sample at a
// fixed delay reads a perfectly good session as "logged out" whenever hydration is
// slow (cold profile launch, busy mini PC). That false 'out' is expensive: it's what
// makes the keepalive delete a live login and force the user to re-sign-in. So we
// poll — 'in' is conclusive the moment we see it, 'out' only after it holds for the
// whole settle window.
export async function recgovLoginState(ctx, { settleMs = 9000 } = {}) {
  let p;
  try {
    p = await ctx.newPage();
    await p.goto('https://www.recreation.gov/account/profile', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(2000); // brief head start before the first sample

    let sawSignal = false;
    const deadline = Date.now() + settleMs;
    for (;;) {
      const u = (p.url() || '').toLowerCase();
      if (/\/sign-?in|\/login/.test(u)) return 'out'; // a real redirect is unambiguous

      const s = await p.evaluate((src) => {
        const re = new RegExp(src, 'i');
        const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const btns = Array.from(document.querySelectorAll('button, a'));
        if (!btns.length) return 'unknown'; // nothing rendered yet — keep waiting
        // A VISIBLE "Sign Up or Log In" button means logged out; the SPA also keeps a
        // hidden copy when logged in, which must not count.
        return btns.some((e) => re.test((e.textContent || '').trim()) && visible(e)) ? 'out' : 'in';
      }, LOGIN_LABELS.source).catch(() => 'unknown');

      if (s === 'in') return 'in'; // the account menu only renders for a live session
      if (s !== 'unknown') sawSignal = true;
      if (Date.now() >= deadline) return sawSignal ? 'out' : 'unknown';
      await sleep(1000);
    }
  } catch {
    return 'unknown';
  } finally {
    if (p) await p.close().catch(() => {});
  }
}
