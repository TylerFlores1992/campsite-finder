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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // ANCHORED ON THE STAND-DOWN, not the open: a stamp between `newPage()` and `if (!tab)` still
  // spends tonight on a tab that never opened (mutation-found).
  const standDown = body.indexOf('if (!tab) return false;');
  assert.ok(open > 0 && standDown > open, 'the failed-open stand-down follows the open');
  assert.ok(stamp > standDown, 'tonight is stamped only after the tab is known to exist');
  assert.ok(end > stamp && login > end, 'the session is ended, then the login runs');
  assert.ok(!/attemptLogin\(ctx, page\b/.test(body), 'never the resident page');
  assert.ok(fin > login && close > fin, 'the tab is closed in the finally');
  assert.match(body.slice(fin, close), /reportNativeAlloc\('evening'/, 'and the reading is sent before the close');
});

test('DT is safe across the WHOLE bot directory: exactly one clearCookies call, and it names idx', () => {
  // WIDENED FROM ONE FUNCTION (Fable review, 2026-09-26): a second `clearCookies` added anywhere
  // under scripts/auto-cart-bot/ must fail here, not only one inside endOktaSession. An unfiltered
  // call — or a filtered one on Playwright < 1.43, which ignores the filter — clears DT too.
  const root = fileURLToPath(new URL('../scripts/auto-cart-bot/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js|mts|ts)$/.test(name)) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 20, `expected the bot's source files, found ${files.length}`);
  const calls = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\.clearCookies\(([^)]*)\)/g)]
    .map((m) => ({ f, args: m[1] })));
  assert.equal(calls.length, 1, `exactly one clearCookies call in the bot, found: ${JSON.stringify(calls)}`);
  assert.match(calls[0].args, /^\{ name: 'idx', domain: 'signin\.reservecalifornia\.com' \}$/);
  assert.match(calls[0].f, /rc-keepwarm\.mjs$/);
});

test('a session that survived the DELETE and the idx clear is never signed into: the stand-down RETURNS', () => {
  // The module's one stated invariant. A password typed into a surviving session reuses it —
  // buys nothing, spends a login from the household IP. Deleting this `return true` passed every
  // test until this one (Fable review, 2026-09-26).
  const kw = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  const start = kw.indexOf('async function maybeEveningSignin(ctx, page) {');
  assert.ok(start > 0, 'maybeEveningSignin not found');
  const body = kw.slice(start, kw.indexOf('\n}\n', start));
  const gate = body.indexOf('if (after?.alive !== false) {');
  const login = body.indexOf('attemptLogin(ctx, tab,');
  assert.ok(gate > 0 && login > gate, 'the survived-session gate sits before the login');
  // The gate's own block, found by its closing brace at the same indentation.
  const blockEnd = body.indexOf('\n      }\n', gate);
  assert.ok(blockEnd > gate && blockEnd < login, 'the gate block closes before the login');
  const block = body.slice(gate, blockEnd);
  assert.match(block, /\n\s*return true;\s*$/, 'the gate block must END in a return, or it falls through to the password');
});

test('the evening path does no I/O before its cheap local gates (the done-tonight stamp, credentials)', () => {
  // ~55 extra Okta `sessions/me` probes a night otherwise, each refreshing Okta's idle timer.
  const kw = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  const start = kw.indexOf('async function maybeEveningSignin(ctx, page) {');
  const body = kw.slice(start, kw.indexOf('\n}\n', start));
  const early = body.indexOf('if (eveningDoneTonight(slot) || !hasCredentials()) return false;');
  const feed = body.indexOf('await feedFacts()');
  const probe = body.indexOf('await oktaSessionAlive(ctx)');
  assert.ok(early > 0, 'the early local gate must exist');
  assert.ok(feed > early && probe > early, 'the feed fetch and the Okta probe come after it');
});

test('the rc-signin rows have a reader: the readout fetches the kind and prints idx persistence', () => {
  // A kind nobody reads is the fix-present-and-inert shape (Fable review, 2026-09-26).
  const ro = readFileSync(new URL('../scripts/bot-events-readout.mts', import.meta.url), 'utf8');
  assert.match(ro, /recentBotEvents\('rc-signin', hours,/, 'the readout must fetch rc-signin');
  const head = ro.indexOf('RC SIGN-INS:');
  assert.ok(head > 0, 'the section must exist');
  const sec = ro.slice(head, ro.indexOf('RAMP SCANS:', head));
  assert.ok(sec.length > 0 && sec.length < 3000, 'the section is bounded by the next one');
  assert.match(sec, /for \(const r of signins\)/, 'it iterates the fetched rows');
  assert.match(sec, /PERSISTENT/, 'it prints the idx persistence');
  assert.match(sec, /x\.outcome === 'captcha'/, 'and flags a CAPTCHA');
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
