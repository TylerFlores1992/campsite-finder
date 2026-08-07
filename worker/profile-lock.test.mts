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
