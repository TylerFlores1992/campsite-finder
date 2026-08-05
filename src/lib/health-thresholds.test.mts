// The SMS delivery verdict.
//
// Run: npm test   (pure — no network, no DB)
//
// This is a threshold function feeding the admin banner, so both failure directions
// are real and neither throws: too sensitive and the banner cries wolf until its only
// reader stops looking (which already happened once here — see the note at the top of
// health-thresholds.ts); too lax and texts stop arriving with the dashboard still
// green. The cases below are the boundaries where those two meet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsLevel, SMS_MIN_SAMPLE } from './health-thresholds';

const d = (delivered: number, dropped: number, pending = 0, untracked = 0) => ({
  delivered,
  dropped,
  pending,
  untracked,
});

test('a clean month is ok', () => {
  assert.equal(smsLevel(d(200, 0)), 'ok');
  assert.equal(smsLevel(d(198, 2)), 'ok'); // 1% — ordinary carrier noise
});

test('refuses to judge a small sample', () => {
  // 2 of 3 undelivered is 67% and means nothing at all. Warning on it would put a red
  // banner over the first three texts of every quiet week.
  assert.equal(smsLevel(d(1, 2)), 'ok');
  assert.equal(smsLevel(d(0, SMS_MIN_SAMPLE - 1)), 'ok');
  // ...but exactly at the sample size it does judge, and that is 100% dropped.
  assert.equal(smsLevel(d(0, SMS_MIN_SAMPLE)), 'fail');
});

test('warns in the few-percent band and fails past 10%', () => {
  assert.equal(smsLevel(d(96, 4)), 'warn'); // 4%
  assert.equal(smsLevel(d(89, 11)), 'fail'); // 11%
  // Exactly on each threshold, the worse verdict wins — a boundary that rounds toward
  // "probably fine" is how a slow regression stays invisible.
  assert.equal(smsLevel(d(97, 3)), 'warn');
  assert.equal(smsLevel(d(90, 10)), 'fail');
});

test('never divides by zero when no receipt has ever come back', () => {
  // THE bug this branch exists for: `delivered / (delivered + dropped)` on an all-
  // pending window is 0/0 = NaN, every comparison against NaN is false, and the panel
  // reports perfect health while measuring nothing. A broken StatusCallback URL — a
  // typo, a signature check rejecting Twilio — looks exactly like this.
  assert.equal(smsLevel(d(0, 0, 50)), 'warn');
  assert.equal(smsLevel(d(0, 0, 0)), 'ok'); // nothing sent at all is not a problem
  assert.equal(smsLevel(d(0, 0, 3)), 'ok'); // three in flight is just three in flight
});

test('untracked history never affects the verdict', () => {
  // Rows from before delivery receipts existed have no outcome. Counting them as
  // delivered would flatter every rate; counting them as dropped would fail forever.
  assert.equal(smsLevel(d(96, 4, 0, 5000)), 'warn');
  assert.equal(smsLevel(d(200, 0, 0, 5000)), 'ok');
});

test('pending messages do not dilute a real drop rate', () => {
  // 20 answered, half of them dropped, with 500 still in flight. The verdict is about
  // what we KNOW, not about how much we are still waiting on.
  assert.equal(smsLevel(d(10, 10, 500)), 'fail');
});
