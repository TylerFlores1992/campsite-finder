// How fast does a user learn we could not hold their site?
//
// Reported by the owner 2026-08-17: *"if we can't cart it the user needs to know
// immediately, not an hour later. That is an issue."*
//
// It was 79 minutes that morning — released 08:00:53, reported 09:19:04 — and the worst
// case was 105: a 45-minute grace plus up to an hour waiting for the next hourly sweep.
//
// THE OLD COMMENT GAVE THE REASON AND THE REASON WAS FALSE: "nothing here is urgent — the
// moment is already lost". It is not lost. ReserveCalifornia's cancelled sites routinely sit
// unbooked after release, which is why `hold_missed` carries the provider link and says "it
// may still be free". The alert exists so the user can go and take the site themselves, and
// its value decays by the minute.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPIRE_HOLDS_INTERVAL_MS,
  HOLD_MISS_GRACE_MIN,
  HOLD_MISS_GRACE_NO_RUNNER_MIN,
} from './expire-holds.ts';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('worker/expire-holds.ts', 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the sweep runs often enough that cadence is not the delay', () => {
  // A hold cannot be reported sooner than the next tick, so an hourly sweep put up to 60
  // minutes on top of whatever grace was chosen — which made tuning the grace pointless.
  assert.ok(EXPIRE_HOLDS_INTERVAL_MS <= 2 * 60 * 1000,
    `sweep interval is ${EXPIRE_HOLDS_INTERVAL_MS}ms — cadence must not dominate the grace`);
});

test('a live runner keeps the full grace — "narrower is a lie" is not overruled', () => {
  // dueHolds keeps offering a hold for 20 minutes past its release, so a runner that is
  // alive may still legitimately cart it. Sweeping inside that window would produce "we
  // couldn't" followed by "we did", which trains people to ignore both messages.
  assert.ok(HOLD_MISS_GRACE_MIN > 20,
    'the alive-runner grace must exceed dueHolds\' 20-minute window');
  assert.equal(HOLD_MISS_GRACE_MIN, 45, 'the conservative branch is unchanged');
});

test('a dead runner gets a short grace, because there is no retry to protect', () => {
  // The 45 minutes is bought entirely by "the runner might still take it". With a stale
  // heartbeat that justification does not apply: nothing is asking for work.
  assert.ok(HOLD_MISS_GRACE_NO_RUNNER_MIN < HOLD_MISS_GRACE_MIN);
  assert.ok(HOLD_MISS_GRACE_NO_RUNNER_MIN >= 3,
    'not zero — supervise.ps1 backs off up to 5 min, and a mid-restart runner still carts');
  assert.ok(HOLD_MISS_GRACE_NO_RUNNER_MIN <= 10,
    'and short enough that the user still has the morning');
});

test('the branch is chosen from the heartbeat, once per sweep', () => {
  // BOTH HALVES. The liveness became injectable so a real-DB test would stop depending on
  // whether the owner's actual mini-PC was up — and that extraction invalidated the original
  // form of this assertion, which pinned the bare `await rcBotUsable()`. Pinning only the
  // injection would go green against a function that never reads the real heartbeat at all;
  // pinning only the call would go green against one that ignores the override and is
  // therefore untestable. Same trap as the `isLive()`/`acceptable()` guards on 2026-08-15.
  assert.match(code, /await rcBotUsable\(\)/,
    'production must still read the real heartbeat');
  assert.match(code, /deps\?\.runnerAbsent == null/,
    'and a test must be able to pin it, or this function depends on live weather');
  assert.match(code, /const graceMin = runnerAbsent \? HOLD_MISS_GRACE_NO_RUNNER_MIN : HOLD_MISS_GRACE_MIN/);
  assert.match(code, /\[String\(graceMin\), onlyIds \?\? null\]/,
    'the chosen grace must reach the query — a constant here makes the branch inert');
  // Read once, outside the statement, so two holds in one pass cannot get different answers.
  assert.ok(!/RETURNING[\s\S]*rcBotUsable/.test(code), 'not read per row');
});

test('an unreadable heartbeat keeps the LONG grace', () => {
  // `rcBotUsable` returns ok:false when it cannot read the row at all, and that is "we could
  // not tell", not "the runner is dead" — the same rule as `unknown` never rounding to
  // `signed-out`. A DB blip must never start declaring live holds missed after 5 minutes.
  assert.match(code, /beat\.beatAgeMs != null && !beat\.ok/,
    'a null age must NOT count as an absent runner');
  assert.match(code, /catch\(\(\) => \(\{ ok: true, beatAgeMs: null \}\)\)/,
    'a thrown read must fall back to the conservative branch');
});
