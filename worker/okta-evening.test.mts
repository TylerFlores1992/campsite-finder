/**
 * THE EVENING SIGN-IN AND THE UPDATE WINDOW THAT MUST NOT KILL IT (2026-09-26).
 *
 * Three things are pinned here, and each is a way the flag-gated work could change live
 * behaviour or destroy a session nobody meant to touch:
 *
 *   1. FLAG OFF IS TODAY. The guard's window stays 02:00-05:00, the keep-warm's evening path
 *      does nothing before any I/O, and the flag parses "1"/"true" and nothing else.
 *   2. FLAG ON, THE WINDOW ENDS BEFORE THE SIGN-IN and never overlaps [sign-in, release).
 *   3. THE DECISION NEVER ENDS A SESSION ON A GUESS: unknown Okta, unknown creation time, a
 *      cap that already covers the release, no hold — all stand down.
 *
 * Plus the sign-in outcome words (signin-telemetry.mjs), because the CAPTCHA page keys on
 * `captcha` and a classifier that loses that flag would silence it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  eveningSigninEnabled, shouldEveningSignin, updateWindow, windowOverlapsSession,
  EVENING_SIGNIN_HOUR, EVENING_UPDATE_WINDOW, OKTA_SESSION_CAP_H, CAP_MARGIN_AFTER_RELEASE_H,
} from '../scripts/auto-cart-bot/okta-evening.mjs';
import { DEFAULTS, safeToUpdate } from '../scripts/auto-cart-bot/update-guard.mjs';
import { classifySignin, idxFacts, signinEventDetail } from '../scripts/auto-cart-bot/signin-telemetry.mjs';

const NOW = new Date('2026-09-26T03:00:00Z'); // 20:00 PDT
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A night where the evening sign-in should run: session alive, created at T−30 this morning. */
const ready = {
  enabled: true,
  pacificHour: EVENING_SIGNIN_HOUR,
  hoursToRelease: 12,
  hasCredentials: true,
  doneTonight: false,
  minutesSinceAbnormalExit: null,
  // created 13h ago → cap lapses 11h from now, before the release at 12h (+1h margin)
  okta: { alive: true, createdAt: iso(NOW.getTime() - 13 * H), expiresAt: iso(NOW.getTime() + 12 * H) },
  now: NOW,
};

// ── 1. FLAG OFF IS TODAY ────────────────────────────────────────────────────────────────

test('the flag is ON only for "1" or "true"', () => {
  for (const v of ['1', 'true', 'TRUE', ' True ']) assert.equal(eveningSigninEnabled({ RC_EVENING_SIGNIN: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'yes', 'on', '2']) {
    assert.equal(eveningSigninEnabled({ RC_EVENING_SIGNIN: v }), false, String(v));
  }
  assert.equal(eveningSigninEnabled({}), false);
});

test('flag off → the update window is update-guard DEFAULTS, 02:00-05:00, exactly', () => {
  assert.deepEqual(updateWindow({ eveningSignin: false, defaults: DEFAULTS }), { windowStart: 2, windowEnd: 5 });
  assert.equal(DEFAULTS.windowStart, 2);
  assert.equal(DEFAULTS.windowEnd, 5);
  assert.equal(DEFAULTS.minHoursToRelease, 6);
});

test('flag off → safeToUpdate gives the same verdict it gives with no window passed, every hour', () => {
  const win = updateWindow({ eveningSignin: false, defaults: DEFAULTS });
  for (let h = 0; h < 24; h++) {
    // 07:00Z = 00:00 PDT on this date
    const now = new Date(Date.UTC(2026, 8, 26, 7 + h, 30));
    for (const requested of [false, true]) {
      assert.deepEqual(
        safeToUpdate({ now, requested, ...win }),
        safeToUpdate({ now, requested }),
        `hour ${h} requested=${requested}`,
      );
    }
  }
});

test('flag off → the evening decision stands down whatever else is true', () => {
  const d = shouldEveningSignin({ ...ready, enabled: false });
  assert.equal(d.run, false);
  assert.equal(d.endSession, false);
});

test('the keep-warm checks the flag FIRST, before any I/O, and the guard CLI passes the window', () => {
  const kw = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  const start = kw.indexOf('async function maybeEveningSignin(ctx, page) {');
  assert.ok(start > 0, 'maybeEveningSignin not found');
  const body = kw.slice(start, kw.indexOf('\n}\n', start));
  const firstStmt = body.split('\n')[1].trim();
  assert.equal(firstStmt, 'if (!eveningSigninEnabled(process.env)) return false;');
  // It runs BEFORE the rehearsal in the loop, so one evening spends one login.
  const ev = kw.indexOf('await maybeEveningSignin(ctx, page)');
  const reh = kw.indexOf('await maybeRehearse(ctx, page)');
  assert.ok(ev > 0 && reh > 0 && ev < reh, 'the evening sign-in must be dispatched before the rehearsal');

  const guard = readFileSync(new URL('../scripts/auto-cart-bot/update-guard.mjs', import.meta.url), 'utf8');
  assert.match(guard, /safeToUpdate\(\{ nextRelease, feedReachable, requested, force, \.\.\.win \}\)/);
  assert.match(guard, /updateWindow\(\{ eveningSignin: eveningSigninEnabled\(process\.env\), defaults: DEFAULTS \}\)/);
});

test('ending the session never touches DT: the only cookie cleared is idx', () => {
  const kw = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  const start = kw.indexOf('async function endOktaSession(ctx) {');
  assert.ok(start > 0, 'endOktaSession not found');
  const body = kw.slice(start, kw.indexOf('\n}\n', start));
  const clears = body.match(/clearCookies\([^)]*\)/g) ?? [];
  assert.equal(clears.length, 1, 'exactly one cookie clear');
  assert.match(clears[0], /name: 'idx'/);
  assert.doesNotMatch(body, /\bDT\b.*clear|deleteCookie|clearCookies\(\)/);
});

test('the evening trip runs in a throwaway TAB: the login is on the tab, the stamp follows the open, the close is in the finally', () => {
  // The resident page is not the evening sign-in's to navigate: an Okta trip there is what the
  // ramps were attributed to, and it would need the browser recycle that
  // worker/autologin-tab.test.mts forbids in this arm. (That file and warmup-sampler own the
  // no-oktaTrip and the sampler rules; this pins what is specific to the evening path.)
  const kw = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  const start = kw.indexOf('async function maybeEveningSignin(ctx, page) {');
  assert.ok(start > 0, 'maybeEveningSignin not found');
  const body = kw.slice(start, kw.indexOf('\n}\n', start));
  const open = body.indexOf('await ctx.newPage()');
  const stamp = body.indexOf('stampEvening(slot);');
  const end = body.indexOf('await endOktaSession(ctx)');
  const login = body.indexOf('attemptLogin(ctx, tab,');
  const fin = body.indexOf('} finally {');
  const close = body.indexOf("closeTabBounded(tab, { label: 'evening'");
  assert.ok(open > 0 && stamp > open, 'the tab is opened before tonight is stamped (a failed open spends nothing)');
  assert.ok(end > stamp && login > end, 'the session is ended, then the login runs');
  assert.ok(!/attemptLogin\(ctx, page\b/.test(body), 'never the resident page');
  assert.ok(fin > login && close > fin, 'the tab is closed in the finally');
  assert.match(body.slice(fin, close), /reportNativeAlloc\('evening'/, 'and the reading is sent before the close');
});

// ── 2. FLAG ON: THE WINDOW ENDS BEFORE THE SIGN-IN ──────────────────────────────────────

test('flag on → the window ends at or before the evening sign-in and never overlaps [sign-in, release)', () => {
  const win = updateWindow({ eveningSignin: true, defaults: DEFAULTS });
  assert.deepEqual(win, EVENING_UPDATE_WINDOW);
  assert.ok(win.windowStart < win.windowEnd, 'a non-empty window');
  assert.ok(win.windowEnd <= EVENING_SIGNIN_HOUR, 'ends before the sign-in');
  assert.equal(windowOverlapsSession(win, EVENING_SIGNIN_HOUR, 8), false);
  // And every hour it allows really is outside the session, checked through the guard itself.
  for (let h = 0; h < 24; h++) {
    const now = new Date(Date.UTC(2026, 8, 26, 7 + h, 30));
    const ok: boolean = safeToUpdate({ now, ...win }).ok;
    const inSession = h >= EVENING_SIGNIN_HOUR || h < 8;
    if (inSession) assert.equal(ok, false, `unrequested update allowed at ${h}:30 PT, inside [sign-in, release)`);
  }
});

test('the overlap check itself: today\'s 02:00-05:00 window DOES overlap the evening session', () => {
  // Which is the whole reason the window moves with the flag.
  assert.equal(windowOverlapsSession({ windowStart: 2, windowEnd: 5 }, 20, 8), true);
  assert.equal(windowOverlapsSession({ windowStart: 19, windowEnd: 21 }, 20, 8), true);
  assert.equal(windowOverlapsSession({ windowStart: 18, windowEnd: 20 }, 20, 8), false);
});

test('flag on leaves `requested` and the six-hour refusal exactly as they are', () => {
  const win = updateWindow({ eveningSignin: true, defaults: DEFAULTS });
  const at22 = new Date('2026-09-26T05:00:00Z'); // 22:00 PDT
  assert.equal(safeToUpdate({ now: at22, requested: true, ...win }).ok, true, 'requested still bypasses the window');
  assert.equal(safeToUpdate({ now: at22, requested: false, ...win }).ok, false);
  // 04:00 PDT, release 08:00 → 4h: refused whether requested or not.
  const at04 = new Date('2026-09-26T11:00:00Z');
  const r = safeToUpdate({ now: at04, requested: true, nextRelease: '2026-09-26T08:00:00', ...win });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too close/);
});

// ── 3. THE DECISION NEVER ENDS A SESSION ON A GUESS ─────────────────────────────────────

test('runs, and ends the session, when the cap lapses before release + margin', () => {
  const d = shouldEveningSignin(ready);
  assert.equal(d.run, true, d.why);
  assert.equal(d.endSession, true);
});

test('the cap boundary: covered exactly at release + margin stands down; a minute short runs', () => {
  const need = NOW.getTime() + (12 + CAP_MARGIN_AFTER_RELEASE_H) * H;
  const createdCovering = need - OKTA_SESSION_CAP_H * H;
  const covered = shouldEveningSignin({ ...ready, okta: { alive: true, createdAt: iso(createdCovering) } });
  assert.equal(covered.run, false, covered.why);
  const short = shouldEveningSignin({ ...ready, okta: { alive: true, createdAt: iso(createdCovering - 60_000) } });
  assert.equal(short.run, true, short.why);
  assert.equal(short.endSession, true);
});

test('Okta GONE → sign in, nothing to end', () => {
  const d = shouldEveningSignin({ ...ready, okta: { alive: false } });
  assert.equal(d.run, true);
  assert.equal(d.endSession, false);
});

test('Okta UNKNOWN, or alive with no creation time → never end it on a guess', () => {
  // `{ alive: null, createdAt: <stale> }` is the case that separates the unknown-liveness guard
  // from the unknown-createdAt one — without it, deleting the first survives (mutation-found).
  const stale = iso(NOW.getTime() - 20 * H);
  for (const okta of [null, { alive: null }, { alive: null, createdAt: stale }, { alive: true, createdAt: null }, { alive: true, createdAt: 'garbage' }]) {
    const d = shouldEveningSignin({ ...ready, okta });
    assert.equal(d.run, false, JSON.stringify(okta));
    assert.equal(d.endSession, false);
  }
});

test('no hold, a release too close, a release too far → stand down', () => {
  // Okta GONE isolates the band from the cap arithmetic.
  const gone = { ...ready, okta: { alive: false } };
  assert.equal(shouldEveningSignin({ ...gone, hoursToRelease: null }).run, false);
  assert.equal(shouldEveningSignin({ ...gone, hoursToRelease: 5.9 }).run, false);
  assert.equal(shouldEveningSignin({ ...gone, hoursToRelease: 6 }).run, true);
  assert.equal(shouldEveningSignin({ ...gone, hoursToRelease: 20 }).run, true);
  assert.equal(shouldEveningSignin({ ...gone, hoursToRelease: 20.1 }).run, false);
});

test('wrong hour, already tonight, no password, just restarted → stand down', () => {
  assert.equal(shouldEveningSignin({ ...ready, pacificHour: 19 }).run, false);
  assert.equal(shouldEveningSignin({ ...ready, pacificHour: 21 }).run, false);
  assert.equal(shouldEveningSignin({ ...ready, doneTonight: true }).run, false);
  assert.equal(shouldEveningSignin({ ...ready, hasCredentials: false }).run, false);
  assert.equal(shouldEveningSignin({ ...ready, minutesSinceAbnormalExit: 2 }).run, false);
  assert.equal(shouldEveningSignin({ ...ready, minutesSinceAbnormalExit: 30 }).run, true);
});

// ── THE OUTCOME WORDS ───────────────────────────────────────────────────────────────────

test('classifySignin: captcha wins over everything, and the other words are distinct', () => {
  assert.equal(classifySignin({ ok: false, captcha: true, passwordSubmitted: true }), 'captcha');
  assert.equal(classifySignin({ ok: false, captcha: true }), 'captcha');
  assert.equal(classifySignin({ ok: true, passwordSubmitted: true }), 'password-form');
  assert.equal(classifySignin({ ok: true, alreadyLive: true }), 'already-live');
  assert.equal(classifySignin({ ok: true }), 'cookie-answered');
  assert.equal(classifySignin({ ok: true, provedNothing: true }), 'cookie-answered');
  assert.equal(classifySignin({ ok: false, passwordSubmitted: true }), 'failed-after-password');
  assert.equal(classifySignin({ ok: false, provedNothing: true }), 'inconclusive');
  assert.equal(classifySignin({ ok: false }), 'failed');
  assert.equal(classifySignin(null), 'failed');
});

test('attemptLogin carries the flags the classifier reads, on the paths that set them', () => {
  const src = readFileSync(new URL('../scripts/auto-cart-bot/rc-autologin.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/captcha: true/g) ?? []).length, 3, 'all three CAPTCHA exits are flagged');
  assert.match(src, /return \{ ok: true, passwordSubmitted: true, reason: 'signed in' \}/);
  assert.match(src, /return \{ ok: true, alreadyLive: true, reason: 'already signed in' \}/);
});

test('idxFacts reads presence, persistence and expiry — and the event detail carries no value', () => {
  assert.deepEqual(idxFacts([]), { present: false, persistent: null, expiresInMin: null });
  assert.deepEqual(
    idxFacts([{ name: 'DT', persistent: true, expiresInMin: 9 }, { name: 'idx', persistent: true, expiresInMin: 700 }]),
    { present: true, persistent: true, expiresInMin: 700 },
  );
  assert.deepEqual(idxFacts([{ name: 'idx', persistent: false, expiresInMin: null }]),
    { present: true, persistent: false, expiresInMin: null });
  const d = signinEventDetail({
    label: 'evening',
    result: { ok: false, captcha: true, reason: 'x' },
    cookies: [{ name: 'idx', persistent: true, expiresInMin: 5, value: 'SECRET' }],
    okta: { alive: true, createdAt: 'c', expiresAt: 'e' },
  });
  assert.equal(d.outcome, 'captcha');
  assert.equal(d.label, 'evening');
  assert.doesNotMatch(JSON.stringify(d), /SECRET/);
});
