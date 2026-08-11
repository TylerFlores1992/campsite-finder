/**
 * The rec.gov auto-relogin retry, and the gate it feeds.
 *
 * THE BUG (nightly ops review, 2026-08-11). `keepSessionsWarm` skipped any profile without
 * a `.camphawk-ready` marker, and a failed auto-relogin deleted that marker — three lines
 * after logging "keeping the saved login, will retry next cycle". The pass that promised a
 * retry switched off the gate the retry needed. One failure twelve days earlier, and the
 * automatic repair never ran again; from the outside it looked exactly like rec.gov holding
 * a permanent CAPTCHA against the account, when in fact nothing was trying.
 *
 * These tests hold three things: that a CAPTCHA schedules a real retry, that the retry is
 * BOUNDED (an unpaced one is a busy loop posting credentials from a residential IP), and
 * that the two gates in bot.mjs actually honour it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planRetry, retryDue, retryBackoffMs,
  RETRY_BASE_MS, RETRY_MAX_MS, CAPTCHA_MAX_ATTEMPTS, BAD_PASSWORD_MAX_ATTEMPTS,
} from '../scripts/auto-cart-bot/relogin-retry.mjs';

const bot = readFileSync('scripts/auto-cart-bot/bot.mjs', 'utf8');
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

test('a CAPTCHA schedules the retry the log promises', () => {
  const p = planRetry({ kind: 'captcha', attempts: 0, now: NOW });
  assert.equal(p.giveUp, false, 'the first CAPTCHA must never be the end of it');
  assert.equal(p.attempts, 1);
  assert.equal(p.nextAt, NOW + RETRY_BASE_MS, 'first retry one keepalive cycle later');
});

test('the retry is paced, and the pacing is capped', () => {
  // Every attempt opens a headful browser and posts credentials from the household IP.
  // Retrying every 30 minutes forever is a busy loop wearing a service's clothes.
  assert.ok(retryBackoffMs(2) > retryBackoffMs(1), 'backoff grows');
  assert.equal(retryBackoffMs(99), RETRY_MAX_MS, 'and is capped');
  assert.ok(RETRY_MAX_MS <= 6 * 60 * 60_000, 'a cap longer than a working day is not pacing');
});

test('a CAPTCHA is retried many times; a bad password is not', () => {
  // THEY MEAN DIFFERENT THINGS. rec.gov throws reCAPTCHA at this browser for its own
  // reasons and the challenge lifts on its own; a password it keeps rejecting never will,
  // and hammering it risks a real lockout.
  assert.ok(CAPTCHA_MAX_ATTEMPTS > BAD_PASSWORD_MAX_ATTEMPTS);
  assert.equal(planRetry({ kind: 'credentials', attempts: 1, now: NOW }).giveUp, true,
    'the second rejected password gives up');
  assert.equal(planRetry({ kind: 'captcha', attempts: 1, now: NOW }).giveUp, false,
    'the second CAPTCHA does not');
});

test('it gives up eventually rather than retrying forever', () => {
  // The counterpart to the bug: the fix must not become an unbounded loop that never
  // escalates to the human who can actually clear it.
  const last = planRetry({ kind: 'captcha', attempts: CAPTCHA_MAX_ATTEMPTS - 1, now: NOW });
  assert.equal(last.giveUp, true);
  assert.match(last.why, /CAPTCHA/);

  // And the whole ladder spans a useful stretch: long enough to cross a challenge that
  // lifts overnight, short enough to surface the same day.
  let span = 0;
  for (let n = 1; n < CAPTCHA_MAX_ATTEMPTS; n++) span += retryBackoffMs(n);
  assert.ok(span >= 6 * 3600_000 && span <= 24 * 3600_000,
    `retries span ${Math.round(span / 3600_000)}h — want roughly overnight`);
});

test('retryDue honours the schedule, and an unreadable state reads as DUE', () => {
  assert.equal(retryDue(null, NOW), false, 'no pending retry is not a due retry');
  assert.equal(retryDue({ nextAt: NOW + 60_000 }, NOW), false);
  assert.equal(retryDue({ nextAt: NOW - 1 }, NOW), true);
  // The failure being guarded against is SILENCE. A corrupt marker costing one extra
  // attempt is cheap; one that reads as "never due" is the original bug again.
  assert.equal(retryDue({}, NOW), true);
  assert.equal(retryDue({ nextAt: 'garbage' }, NOW), true);
});

test('keepSessionsWarm no longer skips a profile that owes a retry', () => {
  // The one-line gate that caused all of it: `if (!isLoggedIn(...) || inUse...) continue`.
  const warm = bot.slice(bot.indexOf('async function keepSessionsWarm'));
  assert.ok(
    !/if \(!isLoggedIn\(user\.userId\) \|\| inUse\.has\(user\.userId\)\) continue;/.test(warm),
    'the original gate must be gone, not merely commented around',
  );
  // Matched on the CALL, not on a local variable name — the point is that the pass
  // consults the retry schedule at all, and renaming a binding must not read as a fix.
  assert.match(warm, /retryDue\(\w+, Date\.now\(\)\)/, 'a pending retry is admitted to the pass');
});

test('the session flag stays honest and the retry lives apart from it', () => {
  // `.camphawk-ready` is read by processJob, which must not cart on a dead session. So the
  // fix is NOT "stop deleting the marker" — that would trade a missed retry for a cart
  // attempt against a session we know is gone.
  const warm = bot.slice(bot.indexOf('async function keepSessionsWarm'));
  assert.match(warm, /unlinkSync\(readyMarker\(user\.userId\)\)/,
    'the session marker is still cleared when the session is genuinely dead');
  assert.match(bot, /camphawk-relogin/, 'and the retry has its own state');
});

test('a pending auto-relogin does not un-enrol the user', () => {
  // ensureLogin opens an interactive window and, after ten minutes with nobody there,
  // calls setEnrollment(false) — it turns auto-cart OFF. On a LOGIN_MODE=local box the
  // missing marker sent every affected user down that path, which is a much larger
  // consequence than the missing retry that led to it.
  const ensure = bot.slice(bot.indexOf('async function ensureLogin'), bot.indexOf('async function keepSessionsWarm'));
  assert.match(ensure, /if \(reloginPending\(user\.userId\)\) return;/,
    'ensureLogin must stand down while an automatic repair is owed');
  assert.match(bot, /!isLoggedIn\(user\.userId\) && !reloginPending\(user\.userId\)\) ensureLogin/,
    'and the call site says so too');
});

test('a successful relogin clears the pending retry', () => {
  // Otherwise the marker latches: ensureLogin would stay stood down for the life of the
  // profile, so a session that later died for real would never escalate to a human.
  const ok = bot.slice(bot.indexOf('auto-relogin from saved login succeeded') - 400,
                       bot.indexOf('auto-relogin from saved login succeeded'));
  assert.match(ok, /clearRetry\(user\.userId\)/);
});

/**
 * ── BOOTSTRAP: the bot signs the user in, so the user does not have to ─────────────────
 *
 * The retry state is only ever written by a FAILURE. So a profile whose session simply
 * lapsed — or one stranded before the gate bug was fixed — has no state at all, and the
 * fix above still would not have touched it: `ensureLogin` escalates to a human despite
 * the bot holding a password the user saved on /connect precisely so they would not be
 * asked again. The credentials are the mandate.
 */
import { repairOwed, giveUpState, shouldBootstrapRepair } from '../scripts/auto-cart-bot/relogin-retry.mjs';

test('a saved password with no session is enough to start a repair', () => {
  assert.equal(
    shouldBootstrapRepair({ hasSession: false, hasCredentials: true, state: null }), true,
    'nothing has tried, and the bot can — so it must',
  );
  assert.equal(
    shouldBootstrapRepair({ hasSession: false, hasCredentials: false, state: null }), false,
    'with no saved password there is nothing the bot can do; /connect is the only path',
  );
  assert.equal(
    shouldBootstrapRepair({ hasSession: true, hasCredentials: true, state: null }), false,
    'a live session needs no repair',
  );
});

test('giving up is a tombstone, not a delete — or it loops forever', () => {
  // Saved credentials alone bootstrap a repair. If giving up ERASED the state, the very
  // next pass would see "password, no session, nothing tried" and start a fresh ladder,
  // retrying a CAPTCHA-walled account for the life of the profile.
  const dead = giveUpState({ kind: 'captcha', attempts: 6, now: 1_000 });
  assert.equal(shouldBootstrapRepair({ hasSession: false, hasCredentials: true, state: dead }), false);
  assert.equal(retryDue(dead, 9_999_999), false, 'a given-up repair is never due again');
});

test('a scheduled-but-not-yet-due repair still holds off the human escalation', () => {
  // These are DIFFERENT questions. `ensureLogin` un-enrols the user after ten minutes with
  // nobody at the window, so it must stand down for the whole life of a pending repair —
  // not merely at the instants the repair happens to be due.
  const waiting = { kind: 'captcha', attempts: 2, nextAt: NOW + 2 * 3600_000 };
  assert.equal(retryDue(waiting, NOW), false, 'not due yet');
  assert.equal(repairOwed(waiting), true, 'but still owed, so nobody is un-enrolled');
  assert.equal(repairOwed(giveUpState({ kind: 'captcha', attempts: 6, now: NOW })), false,
    'once given up, escalating to a human is the correct move');
});

test('bot.mjs bootstraps from credentials and tombstones on give-up', () => {
  const warm = bot.slice(bot.indexOf('async function keepSessionsWarm'));
  assert.match(warm, /shouldBootstrapRepair\(\{/, 'the pass admits a credentialed profile with no state');
  assert.match(warm, /writeRetry\(user\.userId, giveUpState\(/, 'and records giving up rather than erasing it');
  assert.ok(!/plan\.giveUp\) \{\s*clearRetry/.test(warm), 'give-up must not clear the state');
  // reloginPending is what ensureLogin consults; credentials alone must count.
  assert.match(bot, /const reloginPending = \(userId\) => \{[\s\S]*?hasCreds\(profileDir\(userId\)\)/,
    'a saved password counts as an owed repair');
});
