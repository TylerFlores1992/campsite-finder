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
export async function recgovLoginState(ctx) {
  let p;
  try {
    p = await ctx.newPage();
    await p.goto('https://www.recreation.gov/account/profile', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3500); // let the SPA render the header (login button vs account menu)
    const u = (p.url() || '').toLowerCase();
    if (/\/sign-?in|\/login/.test(u)) return 'out';
    return await p.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const labels = Array.from(document.querySelectorAll('button, a')).map((e) => (e.textContent || '').trim());
      if (!labels.length) return 'unknown';
      return labels.some((t) => re.test(t)) ? 'out' : 'in';
    }, LOGIN_LABELS.source);
  } catch {
    return 'unknown';
  } finally {
    if (p) await p.close().catch(() => {});
  }
}
