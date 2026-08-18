// MAKING OKTA SHOW THE FORM — and, far more importantly, never leaving the rewrite behind.
//
// The login rehearsal has produced one PASS in its life. Not because the login is broken, but
// because it is handed a condition in which there is nothing to prove: it drops the token,
// clicks sign-in, and Okta answers from the `idx` cookie with no form — `provedNothing`,
// correctly recorded as inconclusive. And that cookie never idles out, because `checkAndReport`
// probes Okta on every keepalive tick and the expiry comes back as exactly check-time + 12h,
// measured twelve consecutive times.
//
// `prompt=login` asks Okta to re-authenticate anyway. It is the NON-DESTRUCTIVE half of the
// two candidates: nothing is deleted, so a failed rehearsal costs a live session nothing, and
// if Okta declines we land back on `provedNothing` — exactly where we already are.
//
// ── THE HAZARD THESE TESTS EXIST FOR ──────────────────────────────────────────────────────
// The rehearsal runs on the RESIDENT page the keep-warm holds open for hours. A route left
// installed would rewrite EVERY later authorize on that page — including the silent re-mints
// that appear to be keeping the session alive on their own. Forcing `prompt=login` onto those
// turns a free background renewal into an unattended login that cannot succeed, which would
// kill the session hourly and drive real sign-ins from an address that has been blocked
// before. So the disarming is tested harder than the rewriting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withPromptLogin, alreadyForced, withForcedLoginPrompt, AUTHORIZE_PATH, MAX_REWRITES,
} from '../scripts/auto-cart-bot/force-login-prompt.mjs';

const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = KEEPWARM.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const AUTH = 'https://signin.reservecalifornia.com/oauth2/v1/authorize';

/**
 * A stand-in for Playwright's page that records what was routed and lets a test fire requests
 * at whatever handler is currently installed — including AFTER the wrapper has finished, which
 * is the case that matters.
 */
function fakePage({ unrouteThrows = false } = {}) {
  const handlers: Function[] = [];
  return {
    routed: 0,
    unrouted: 0,
    async route(_glob: string, h: Function) { handlers.push(h); this.routed++; },
    async unroute(_glob: string, h: Function) {
      this.unrouted++;
      if (unrouteThrows) throw new Error('page is closed');
      const i = handlers.indexOf(h);
      if (i > -1) handlers.splice(i, 1);
    },
    /** Fire a request at every installed handler and report what happened to it. */
    async fire(url: string) {
      const seen: { continued: boolean; location?: string } = { continued: false };
      for (const h of handlers) {
        await h({
          request: () => ({ url: () => url }),
          continue: async () => { seen.continued = true; },
          fulfill: async (r: { status: number; headers: Record<string, string> }) => {
            seen.location = r.headers.location;
          },
        });
      }
      return { ...seen, handlers: handlers.length };
    },
    handlerCount: () => handlers.length,
  };
}

test('the parameter is added without corrupting the rest of the URL', () => {
  // The query already carries a PKCE challenge and a percent-encoded redirect URI. Splicing
  // `&prompt=login` on by hand is how one of those gets broken.
  const url = `${AUTH}?client_id=0oaqwot3&code_challenge=abc%3D%3D&redirect_uri=https%3A%2F%2Fwww.reservecalifornia.com%2Flogin%2Fcallback`;
  const out = withPromptLogin(url);
  assert.ok(out.includes('prompt=login'));
  assert.ok(out.includes('code_challenge=abc%3D%3D'), 'the PKCE challenge must survive intact');
  assert.ok(out.includes('%2Flogin%2Fcallback'), 'the redirect URI must stay encoded');
  assert.equal(alreadyForced(out), true);
  assert.equal(alreadyForced(url), false);
});

test('an already-forced request is passed straight through, so it cannot loop', async () => {
  const page = fakePage();
  await withForcedLoginPrompt(page as never, async () => {
    const first = await page.fire(`${AUTH}?a=1`);
    assert.ok(first.location?.includes('prompt=login'), 'the first request is redirected');
    // The redirect re-enters the handler. If it rewrote again it would bounce for ever.
    const second = await page.fire(first.location!);
    assert.equal(second.continued, true, 'the redirected request must be let through');
    assert.equal(second.location, undefined);
  });
});

test('rewrites are bounded, so a redirect loop cannot hang the browser', async () => {
  const page = fakePage();
  await withForcedLoginPrompt(page as never, async () => {
    // Fire distinct un-forced URLs past the cap; the surplus must be let through untouched.
    for (let i = 0; i < MAX_REWRITES; i++) await page.fire(`${AUTH}?n=${i}`);
    const over = await page.fire(`${AUTH}?n=over`);
    assert.equal(over.continued, true, `past ${MAX_REWRITES} rewrites it must stop rewriting`);
  });
});

test('anything that is not an authorize request is untouched', async () => {
  const page = fakePage();
  await withForcedLoginPrompt(page as never, async () => {
    const other = await page.fire('https://www.reservecalifornia.com/api/search');
    assert.equal(other.continued, true);
    assert.equal(other.location, undefined, 'only the authorize endpoint may be rewritten');
  });
});

test('the count is reported, so "Okta ignored it" and "we never asked" stay apart', async () => {
  const page = fakePage();
  const a = await withForcedLoginPrompt(page as never, async () => {
    await page.fire(`${AUTH}?a=1`);
    return 'done';
  });
  assert.equal(a.result, 'done');
  assert.equal(a.rewrites, 1, 'a rewrite that happened must be counted');

  const page2 = fakePage();
  const b = await withForcedLoginPrompt(page2 as never, async () => 'done');
  assert.equal(b.rewrites, 0, 'no interception means the run says nothing about the password');
});

test('THE ROUTE IS REMOVED when the callback finishes', async () => {
  const page = fakePage();
  await withForcedLoginPrompt(page as never, async () => {});
  assert.equal(page.unrouted, 1, 'unroute must be called');
  assert.equal(page.handlerCount(), 0, 'and the handler must actually be gone');
});

test('THE ROUTE IS REMOVED when the callback throws', async () => {
  // A rehearsal that fails is the ordinary case — attemptLogin throwing must not leave the
  // rewrite installed on a page that lives for hours.
  const page = fakePage();
  await assert.rejects(
    () => withForcedLoginPrompt(page as never, async () => { throw new Error('login blew up'); }),
    /login blew up/,
  );
  assert.equal(page.handlerCount(), 0, 'the handler must be gone even on the throw path');
});

test('AND IT IS INERT EVEN IF unroute FAILS — the flag, not the library', async () => {
  // THE PROPERTY THAT CARRIES THE RISK. `page.unroute` can throw (the page navigated, or
  // closed), and a route that survives would force prompt=login onto every later silent
  // re-mint — turning a free background renewal into an unattended login that cannot succeed.
  // The `armed` flag is the half that does not depend on Playwright doing anything.
  const page = fakePage({ unrouteThrows: true });
  await withForcedLoginPrompt(page as never, async () => {});
  assert.equal(page.handlerCount(), 1, 'this fixture deliberately leaves the handler installed');
  const after = await page.fire(`${AUTH}?a=1`);
  assert.equal(after.continued, true, 'a leaked handler must pass requests through');
  assert.equal(after.location, undefined,
    'a leaked handler must NOT rewrite — it would break the silent re-mint that keeps the ' +
    'session alive, and drive real logins from a previously blocked address');
});

test('a failure to install the route is not fatal', async () => {
  // A rehearsal that cannot intercept is exactly as informative as one that runs without it,
  // which is to say inconclusive — and that is reported, never thrown.
  const lines: string[] = [];
  const page = {
    async route() { throw new Error('no'); },
    async unroute() {},
  };
  const r = await withForcedLoginPrompt(page as never, async () => 'ok', { log: (m) => lines.push(m) });
  assert.equal(r.result, 'ok');
  assert.equal(r.rewrites, 0);
  assert.ok(lines.some((l) => /could not intercept/.test(l)), 'and it says so');
});

test('only the REHEARSAL forces the prompt — never maybeAutoLogin', () => {
  // maybeAutoLogin runs at T−30 of a real release and is the only thing between a queued hold
  // and a missed cart. Putting an unproven parameter in front of it would risk a campsite to
  // improve a dashboard. Pinned by position: the wrapper must appear inside runLoginRehearsal
  // and nowhere else in the file.
  const rehearsal = code.indexOf('async function runLoginRehearsal(');
  const nextFn = code.indexOf('\nasync function ', rehearsal + 10);
  assert.ok(rehearsal > -1 && nextFn > rehearsal);
  const body = code.slice(rehearsal, nextFn);
  assert.match(body, /withForcedLoginPrompt\(page,/, 'the rehearsal must force the form');

  const uses = code.split('withForcedLoginPrompt(').length - 1;
  assert.equal(uses, 1,
    'exactly one call site — a second one would almost certainly be the release-critical login');
  const autoLogin = code.slice(code.indexOf('async function maybeAutoLogin('),
    code.indexOf('\nasync function ', code.indexOf('async function maybeAutoLogin(') + 10));
  assert.ok(!/withForcedLoginPrompt/.test(autoLogin),
    'maybeAutoLogin must never force the prompt — it is the path that carts a campsite');
});

test('the rehearsal says whether it actually asked', () => {
  // Zero rewrites and Okta-ignored-it produce the same inconclusive verdict otherwise, and
  // they have different next moves: fix the interception, or abandon this approach for the
  // destructive cookie drop.
  const rehearsal = code.indexOf('async function runLoginRehearsal(');
  const body = code.slice(rehearsal, code.indexOf('\nasync function ', rehearsal + 10));
  // ANCHOR ON THE LOG CALL, NOT ON THE TOKEN. The first version asserted `rewrites > 0`
  // appeared anywhere in the body — and it appears twice, so replacing the LOG's condition
  // with a constant left the other occurrence (in the provedNothing branch) matching, and the
  // mutation passed. Verified. Pin the comparison inside the call it guards.
  assert.match(body, /log\(rewrites > 0/,
    'the log line must branch on the count, not merely mention it');
  assert.match(body, /never intercepted/, 'and the zero case must say what it means');
  // ANCHORED ON THE ASSIGNMENT, for the same reason as the line above: `rewrites > 0` occurs
  // twice in this body, so a loose regex matched the LOG's condition and passed against a
  // detail line replaced by a constant. Verified. Two guards, two specific anchors.
  assert.match(body, /const detail = rewrites > 0/,
    'the provedNothing detail must distinguish "Okta declined" from "we never asked"');
  assert.match(body, /Okta\s*\n?\s*.*declined to re-prompt|declined to re-prompt/,
    'and say which, in words that survive into rc_login_rehearsal_log');
});

test('the endpoint is matched on its path, not a hardcoded origin', () => {
  const SRC = readFileSync('scripts/auto-cart-bot/force-login-prompt.mjs', 'utf8');
  assert.equal(AUTHORIZE_PATH, '/oauth2/v1/authorize');
  assert.ok(!/signin\.reservecalifornia\.com/.test(SRC.replace(/^\s*(\/\/|\*).*$/gm, '')),
    'pinning the origin would break silently if RC moves its Okta tenant');
});
