// The Chromium profile lock — pure filesystem, no DB, no browser.
//
// It guards ONE thing: two processes must never open `chromium.launchPersistentContext`
// on the same user-data-dir. On the RC profile that would put the session at risk, and
// the session is the one thing here we cannot rebuild without a human at the keyboard
// (RC serves a reCAPTCHA on sign-in since 2026-08-07).
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  profileHolderNote,
  acquireProfileLock, releaseProfileLock, releaseProfileLockIfMine,
  renewProfileLock, profileLockHolder,
  requestProfile, profileRequested, clearProfileRequest, forceProfileLock, pidAlive,
} from '../scripts/auto-cart-bot/profile-lock.mjs';
import { spawn } from 'node:child_process';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lock-'));
const LOCK = '.camphawk-profile-lock';

test('a second owner cannot take a held profile', () => {
  const dir = tmp();
  assert.equal(acquireProfileLock(dir, 'rc-keepwarm'), true);
  assert.equal(acquireProfileLock(dir, 'rc-hold-runner'), false,
    'both processes running means two browsers on one profile — the bug this exists to stop');
  releaseProfileLock(dir);
  assert.equal(acquireProfileLock(dir, 'rc-hold-runner'), true, 'released means takeable');
});

test('a stale lock reads as free — a crash must not lock the profile out forever', () => {
  const dir = tmp();
  acquireProfileLock(dir, 'rc-hold-runner');
  const file = path.join(dir, LOCK);
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 11 minutes old, past STALE_MS.
  fs.writeFileSync(file, JSON.stringify({ ...held, at: new Date(Date.now() - 11 * 60_000).toISOString() }));
  assert.equal(profileLockHolder(dir), null);
  assert.equal(acquireProfileLock(dir, 'rc-keepwarm'), true);
});

test('renewing keeps a long job from going stale underneath itself', () => {
  // The failing case is concrete: `rc-keepwarm --login` waits up to ten minutes for a
  // person to sign in and solve a CAPTCHA, which lands exactly on the staleness
  // boundary — and a stale lock reads as free, so the runner would open the same profile
  // while the human is mid-login.
  const dir = tmp();
  acquireProfileLock(dir, 'rc-keepwarm');
  const file = path.join(dir, LOCK);
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...held, at: new Date(Date.now() - 9 * 60_000).toISOString() }));

  assert.equal(renewProfileLock(dir, 'rc-keepwarm'), true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Date.now() - new Date(after.at).getTime() < 5_000, 'the timestamp must move forward');
  assert.equal(acquireProfileLock(dir, 'rc-hold-runner'), false, 'still held after renewal');
});

test('renewing someone else’s lock is refused — that would be stealing it', () => {
  const dir = tmp();
  acquireProfileLock(dir, 'rc-keepwarm');
  assert.equal(renewProfileLock(dir, 'rc-hold-runner'), false);
  assert.equal(profileLockHolder(dir)?.owner, 'rc-keepwarm');
});

test('the error path never strips another process’s lock', () => {
  // `releaseProfileLockIfMine` runs on failure, and the failure may BE "someone else
  // holds this". Deleting blindly there would reintroduce the exact race.
  const dir = tmp();
  acquireProfileLock(dir, 'rc-keepwarm');
  releaseProfileLockIfMine(dir, 'rc-hold-runner');
  assert.equal(profileLockHolder(dir)?.owner, 'rc-keepwarm', 'the real holder must survive');
  releaseProfileLockIfMine(dir, 'rc-keepwarm');
  assert.equal(profileLockHolder(dir), null);
});

test('a resident holder can be asked to stand down, and the request expires on its own', async () => {
  // The RC keep-warm holds the profile RESIDENT — it has to, because RC's SPA only renews
  // its Okta token while a page is loaded, and an 8-second visit every 20 minutes has
  // under a 1% chance of being open when that fires. (Measured: 1h20m from sign-in to
  // death, i.e. one access token and then nothing.)
  //
  // A permanent holder and a short-job holder cannot share a plain mutex: the hold runner
  // would time out every time, at 08:00:00, on the one job that matters. So the resident
  // yields on request.
  const dir = tmp();
  try {
    assert.equal(profileRequested(dir), null, 'nothing pending on a fresh profile');

    requestProfile(dir, 'rc-hold-runner');
    const req = profileRequested(dir);
    assert.equal(req?.owner, 'rc-hold-runner', 'the resident can see WHO wants it');

    clearProfileRequest(dir);
    assert.equal(profileRequested(dir), null, 'and the resident may take it back');

    // A requester that dies before taking the lock must not stand the keep-warm down
    // forever — that would kill the session the whole thing exists to preserve.
    requestProfile(dir, 'rc-hold-runner');
    fs.writeFileSync(
      path.join(dir, '.camphawk-profile-wanted'),
      JSON.stringify({ owner: 'rc-hold-runner', at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    );
    assert.equal(profileRequested(dir), null, 'a stale request reads as no request');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing a request is safe when there is none', () => {
  // Called in a `finally` on every runner pass, including the ones that never asked.
  const dir = tmp();
  try {
    clearProfileRequest(dir);
    clearProfileRequest(dir);
    assert.equal(profileRequested(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a holder that ignores the request is forced out, but only after the wait', () => {
  // THE 2026-08-10 WEDGE. rc-keepwarm's loop hung while its renew setInterval kept
  // running, so the lock never went stale and `profileRequested` was never read. A
  // cooperative protocol cannot survive a partner that has stopped cooperating, and the
  // 08:00 cart failed against a profile nothing could take.
  const dir = tmp();
  // A WEDGED holder is ALIVE, so it is modelled by a real live process: a child we spawn
  // and own. This used to be a pid that did not exist, which stopped modelling the case on
  // 2026-09-24 — a dead pid's lock now reads as free (next test), so forcing it is moot.
  // Never an invented pid: one that happened to exist would be killed.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid, 'the stand-in holder must have started');
    fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({
      owner: 'rc-keepwarm', pid: child.pid, at: new Date().toISOString(),
    }));
    assert.equal(profileLockHolder(dir)?.owner, 'rc-keepwarm', 'a LIVE holder still holds');

    // Too soon: the holder must be given the whole wait before we kill anything.
    assert.equal(forceProfileLock(dir, 'rc-hold-runner', Date.now(), 45_000), null,
      'forcing before the wait has elapsed would break cooperative preemption for everyone');

    const reason = forceProfileLock(dir, 'rc-hold-runner', Date.now() - 60_000, 45_000);
    assert.ok(reason, 'after the wait, the profile is taken');
    assert.match(String(reason), /rc-keepwarm/, 'and says who it was taken from');
    assert.match(String(reason), /killed/, 'a live wedged holder is stopped before its lock is taken');
    assert.equal(profileLockHolder(dir)?.owner, 'rc-hold-runner');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone is the goal */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock whose writer is GONE is free at once — no wait on nobody (2026-09-24)', async () => {
  // Measured twice. 2026-09-16: the keep-warm printed "profile busy (rc-keepwarm)" for seven
  // and a half minutes against its own dead predecessor's lock, RC session down throughout.
  // 2026-09-24: the hold runner waited its full 60s before forcing `rc-keepwarm (pid 10928,
  // already gone)`, so a user's hand-over took 65 seconds and they lost the campsite.
  const dir = tmp();
  // A pid that certainly existed and certainly does not now: a child we started and waited out.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  try {
    assert.ok(child.pid, 'the stand-in must have had a pid');
    assert.equal(pidAlive(child.pid!), false, 'an exited process must read as gone');
    fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({
      owner: 'rc-keepwarm', pid: child.pid, at: new Date().toISOString(),
    }));
    assert.equal(profileLockHolder(dir), null, 'a dead writer holds nothing');
    assert.equal(acquireProfileLock(dir, 'rc-hold-runner'), true, 'so the next process takes it immediately');
    assert.equal(profileLockHolder(dir)?.owner, 'rc-hold-runner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable pid fails towards HELD, never towards free', () => {
  // A wrong "free" opens a second Chromium on a profile in use, which corrupts the session;
  // a wrong "held" only costs the old wait. So anything we cannot read counts as alive.
  for (const pid of [0, -1, 1.5, NaN, undefined as unknown as number]) {
    assert.equal(pidAlive(pid), true, String(pid));
  }
  assert.equal(pidAlive(process.pid), true, 'we are alive');
});

test('forcing never touches a free lock or our own', () => {
  const dir = tmp();
  try {
    assert.equal(forceProfileLock(dir, 'rc-hold-runner', Date.now() - 60_000), null, 'nothing to force');
    acquireProfileLock(dir, 'rc-hold-runner');
    assert.equal(forceProfileLock(dir, 'rc-hold-runner', Date.now() - 60_000), null,
      'our own lock is not something to kill ourselves over — literally');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The busy line says WHO, WHICH PID and HOW LONG ────────────────────────────────────────
//
// THE DEFECT (measured 2026-09-16). The keep-warm exited silently at 00:03 UTC taking its
// Chromium with it; the supervisor restarted it at 00:04; and it then printed
//
//     … profile busy (rc-keepwarm) — retrying in 30s, NOT a dead session
//
// five times over seven and a half minutes against a lock whose recorded pid no longer
// existed — while `rc_procs` read 0 and the RC session was down. Two facts that would have
// explained it were in hand and thrown away: the PID (`profileLockHolder` returns it) and the
// lock's AGE, which is what says "this is stale and will clear itself in N minutes".
//
// It is the same complaint already recorded against `rc-check.bat`: a line that is reassuring
// in exactly the fatal case, because it cannot tell "mid-pass, fine" from "the holder died"
// from "a live holder is wedged". Those need three different responses.

test('the busy note carries the pid and the age, and survives a missing or bad one', () => {
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  assert.equal(profileHolderNote(null), 'another process');

  const full = profileHolderNote({ owner: 'rc-keepwarm', pid: 14996, at: ago(452) });
  assert.match(full, /rc-keepwarm/);
  assert.match(full, /pid 14996/, 'the pid is what says the holder is gone');
  assert.match(full, /held 45[012]s/, 'the age is what says the lock is about to go stale');

  // An absent field is omitted, never printed as a placeholder.
  assert.doesNotMatch(profileHolderNote({ owner: 'x', at: ago(3) }), /pid/);
  assert.doesNotMatch(profileHolderNote({ owner: 'x', pid: 1 }), /held/);
  // AND A BAD DATE MUST NOT RENDER AS `held NaNs` — an unreadable lock is an absent age, not a
  // number. Same rule as every other absent reading in this repo.
  assert.doesNotMatch(profileHolderNote({ owner: 'x', pid: 2, at: 'not-a-date' }), /NaN|held/);
});

test('the retry cadence printed is the one actually waited', () => {
  // IT SAID 30s AND THE REAL GAP WAS 90. `waitForProfileLock` spends its own timeout before
  // the sleep, so the cadence is their SUM — observed at 00:05:00, 00:06:30, 00:08:00,
  // 00:09:30, 00:11:00. A three-fold understatement in the one line somebody reads while the
  // RC session is down and they are deciding whether to drive to the box.
  const src = readFileSync(
    new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
  assert.match(src, /const PROFILE_WAIT_MS = /, 'the wait must be a named constant');
  assert.match(src, /const PROFILE_RETRY_MS = /, 'and so must the sleep');
  assert.match(src, /waitForProfileLock\(PROFILE_DIR, LOCK_OWNER, PROFILE_WAIT_MS\)/,
    'the wait constant must be the one actually passed');
  assert.match(src, /await sleep\(PROFILE_RETRY_MS\)/,
    'and the sleep constant the one actually slept');
  // The printed number must be DERIVED from both, or it drifts from the behaviour again.
  assert.match(src, /PROFILE_WAIT_MS \+ PROFILE_RETRY_MS\) \/ 1000\)}s, NOT a dead session/,
    'the printed cadence must be computed from both waits, never a literal');
  assert.doesNotMatch(src, /retrying in 30s/, 'the literal is the bug');
});
