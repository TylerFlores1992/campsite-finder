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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireProfileLock, releaseProfileLock, releaseProfileLockIfMine,
  renewProfileLock, profileLockHolder,
  requestProfile, profileRequested, clearProfileRequest, forceProfileLock,
} from '../scripts/auto-cart-bot/profile-lock.mjs';

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
  try {
    // A live holder with a pid that is not us and does not exist — the safe stand-in for
    // "wedged process": process.kill throws ESRCH, which forceProfileLock treats as
    // already-gone and proceeds. A REAL pid must not be invented in a test.
    fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({
      owner: 'rc-keepwarm', pid: 999_999_998, at: new Date().toISOString(),
    }));

    // Too soon: the holder must be given the whole wait before we kill anything.
    assert.equal(forceProfileLock(dir, 'rc-hold-runner', Date.now(), 45_000), null,
      'forcing before the wait has elapsed would break cooperative preemption for everyone');

    const reason = forceProfileLock(dir, 'rc-hold-runner', Date.now() - 60_000, 45_000);
    assert.ok(reason, 'after the wait, the profile is taken');
    assert.match(String(reason), /rc-keepwarm/, 'and says who it was taken from');
    assert.equal(profileLockHolder(dir)?.owner, 'rc-hold-runner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
