// THE REMOTE test-login LEVER — a login the owner can trigger without standing at the box,
// bounded by the box's own clock.
//
// The ask that produced this was "just give me PowerShell or cmd so I don't have to". The
// answer is no — bot-commands.mjs's header is the reasoning: the box holds the live RC
// session, the DPAPI credential store, and a residential IP both providers have blocked, so
// a free-form channel is a shell on a home network for any AUTOCART_TOKEN holder. Levers get
// added by NAME. This file pins the properties that make THIS lever safe to have:
//
//   1. the handler QUEUES and never logs in itself — the rehearsal needs the Chromium
//      profile the keep-warm owns, and a second process driving that profile is the
//      two-browsers-one-user-data-dir corruption every mini-pc script warns about;
//   2. the ration is the BOX's, file-backed, spent BEFORE the attempt — a crash-loop that
//      re-runs logins is the shape that cost the IP twelve hours on 2026-08-06;
//   3. the schedule gates lift and the SAFETY gates do not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KINDS } from '../scripts/auto-cart-bot/bot-commands.mjs';
import { BOT_COMMAND_KINDS, rejectReason } from '../src/lib/bot-commands';
import {
  shouldRehearseOnDemand, ON_DEMAND_REHEARSAL_GAP_H, REHEARSAL_MIN_HOURS_TO_RELEASE,
} from '../scripts/auto-cart-bot/rehearsal.mjs';

const BOX = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const boxCode = code(BOX);
const kwCode = code(KEEPWARM);

test('test-login exists on BOTH sides, and the server accepts it', () => {
  // The admin UI offers what BOT_COMMAND_KINDS lists; the box refuses what KINDS lacks.
  // Either half alone is a button that looks broken.
  assert.ok('test-login' in BOT_COMMAND_KINDS, 'the server must offer the kind');
  assert.ok(KINDS.includes('test-login'), 'the box must implement it');
  assert.equal(rejectReason('test-login', null), null, 'and the validator must accept it');
});

test('the handler QUEUES a signal file and never runs a login itself', () => {
  const at = boxCode.indexOf("'test-login': async ()");
  assert.ok(at > -1);
  const handler = boxCode.slice(at, boxCode.indexOf("'disk-free'", at));
  assert.match(handler, /\.camphawk-rehearse-asked/, 'the signal file is the whole mechanism');
  assert.ok(!/run\(/.test(handler), 'the handler must spawn nothing');
  assert.ok(!/attemptLogin|runLoginRehearsal|chromium/i.test(handler),
    'and must never touch a browser — it runs in a process that does not own the profile');
});

test('the handler refuses inside the ration window, so the asker hears the truth at once', () => {
  const at = boxCode.indexOf("'test-login': async ()");
  const handler = boxCode.slice(at, boxCode.indexOf("'disk-free'", at));
  assert.match(handler, /\.rehearse-on-demand-at/, 'it must read the same stamp the keep-warm writes');
  assert.match(handler, /refused: an on-demand rehearsal ran/,
    'a rationed ask must come back as a refusal, not as a queued request that silently dies');
  const refuseAt = handler.indexOf('refused:');
  const queueAt = handler.indexOf('.camphawk-rehearse-asked');
  assert.ok(refuseAt < queueAt, 'the ration is checked BEFORE the signal is written');
});

test('the stamp filename agrees across the two processes, or the ration is dead', () => {
  // The handler (bot.mjs / hold runner) checks it; the keep-warm spends it. Different
  // processes, one file — a rename on one side quietly disables the box-side bound while
  // both halves still look correct alone.
  for (const src of [boxCode, kwCode]) {
    assert.match(src, /\.rehearse-on-demand-at/);
    assert.match(src, /\.camphawk-rehearse-asked/);
  }
});

test('the ask is CONSUMED before the rehearsal runs — a crash must not loop the login', () => {
  const fn = kwCode.slice(kwCode.indexOf('function takeRehearseAsk'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /unlinkSync/, 'the signal is deleted at pickup');
  // And the delete happens in the reader, not after the run: the call sits before the
  // decision, so an interrupted rehearsal leaves NO pending ask behind.
  const askAt = kwCode.indexOf('const asked = takeRehearseAsk()');
  const runAt = kwCode.indexOf('runLoginRehearsal(ctx, page');
  assert.ok(askAt > -1 && askAt < runAt, 'consume first, attempt after');
});

test('the ration is stamped from a FILE, BEFORE the attempt', () => {
  // supervise.ps1 restarts this process on exit; an in-memory ration is re-issued by every
  // restart. And stamping after the attempt leaves the ration unspent if the attempt never
  // returns — the same rule as recordedSlot, for the same crash-loop reason.
  const stampAt = kwCode.indexOf('fs.writeFileSync(REHEARSE_ON_DEMAND_STAMP');
  const runAt = kwCode.indexOf('runLoginRehearsal(ctx, page');
  assert.ok(stampAt > -1, 'the stamp must be written');
  assert.ok(stampAt < runAt, 'and written BEFORE the login is attempted');
  assert.match(kwCode, /REHEARSE_ON_DEMAND_STAMP = path\.join\(HERE, 'logs', '\.rehearse-on-demand-at'\)/,
    'as a file, never process memory');
});

test('an on-demand refusal is LOUD — reported, not just logged', () => {
  // Somebody is watching the admin page for the verdict; a silent refusal is
  // indistinguishable from the signal never arriving.
  const at = kwCode.indexOf('if (asked) {', kwCode.indexOf('if (!decision.run)'));
  assert.ok(at > -1, 'the on-demand refusal arm must exist');
  const arm = kwCode.slice(at, at + 300);
  assert.match(arm, /reportRehearsal\(null, null, `on-demand refused/,
    'the refusal must reach the server, where the asker is looking');
});

test('shouldRehearseOnDemand lifts the schedule gates and keeps the safety gates', () => {
  const base = { hoursToRelease: 12, hoursSinceLastOnDemand: null, hasCredentials: true, minutesSinceAbnormalExit: null };

  // Lifted: no hour gate, no once-per-20h gate — at 3am with a nightly run 2h ago, it runs.
  assert.equal(shouldRehearseOnDemand(base).run, true);

  // Kept: the release gate. The rehearsal ends the session, and the session within 6h of a
  // cart belongs to the cart — no human intent overrides that.
  const near = shouldRehearseOnDemand({ ...base, hoursToRelease: REHEARSAL_MIN_HOURS_TO_RELEASE - 0.5 });
  assert.equal(near.run, false);
  assert.match(near.why, /releases in/);

  // Kept: the ration, on the box's clock, whoever asks.
  const rationed = shouldRehearseOnDemand({ ...base, hoursSinceLastOnDemand: ON_DEMAND_REHEARSAL_GAP_H - 1 });
  assert.equal(rationed.run, false);
  assert.match(rationed.why, /on-demand rehearsal ran/);

  // Kept: the abnormal-exit quiet window and the credentials gate.
  assert.equal(shouldRehearseOnDemand({ ...base, minutesSinceAbnormalExit: 1 }).run, false);
  assert.equal(shouldRehearseOnDemand({ ...base, hasCredentials: false }).run, false);

  // NO sessionLive gate, deliberately: the body clears the token and forces the form with
  // prompt=login, and its own early exit reports `inconclusive` honestly if RC
  // re-authenticates first. Passing the field must change nothing.
  assert.equal(shouldRehearseOnDemand({ ...base, sessionLive: true } as never).run, true);
});

test('a null ration record does not gate — no record is the ordinary first run', () => {
  // The house rule: unknown never rounds to a verdict. A missing stamp file is a box that
  // has never run one, not a box mid-ration.
  assert.equal(shouldRehearseOnDemand({
    hoursToRelease: null, hoursSinceLastOnDemand: null, hasCredentials: true, minutesSinceAbnormalExit: null,
  }).run, true);
});
