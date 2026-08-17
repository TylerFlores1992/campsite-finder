// Recycle the RC keep-warm's resident Chromium before it takes the box down.
//
// MEASURED, 2026-08-17. The mini-PC went from 12% COMMIT to 99% in TEN MINUTES and both of
// that morning's failures fall inside the window: the Windows Scheduled Tasks stopped at
// 05:31:03 as commit crossed ~90%, and the hold runner died at 05:36:31 with 0xC0000409 —
// the fast-fail abort() a Node process produces when it cannot allocate. One cause, two
// silences, one lost 08:00 cart. It was the seventh such event in 24 hours, every one
// attributed by the sampler to the `rc` family: this browser.
//
//   05:24  12%    281 MB          05:32  97%  18,983 MB   <- tasks stop 05:31:03
//   05:26  54%  1,453 MB          05:34  99%  23,636 MB   <- runner dies 05:36:31
//   05:28  77%  7,248 MB          05:40  11%     214 MB   <- process gone
//
// The previous plan treated the hourly keep-warm WEDGE as an unbounded page.evaluate and
// bounded it. That is still worth having, but a Chromium at 25 GB on a box at 99% commit
// will hang any evaluate — so the wedge is plausibly a SYMPTOM of this and the bound turns
// a hang into a fast failure rather than preventing anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the trigger is SIZE, not age', () => {
  // The family sits at 220-300 MB for hours and then ramps ~4,160 MB/min. An age bound
  // would have to be absurdly aggressive to land inside a ten-minute cliff, and would spend
  // a session for nothing across the ~95% of the day that is flat.
  assert.match(code, /const RC_MAX_FAMILY_MB = Number\(process\.env\.RC_KEEPWARM_MAX_MB \|\| 1500\)/);
  assert.match(code, /mb != null && mb > RC_MAX_FAMILY_MB/);
});

test('the threshold sits well above normal and well below the cliff', () => {
  const limit = Number(/RC_KEEPWARM_MAX_MB \|\| (\d+)/.exec(code)?.[1]);
  assert.ok(limit >= 800, `${limit} MB is too close to the measured 220-300 MB normal`);
  assert.ok(limit <= 4000, `${limit} MB is far enough up the ramp to be near the failure`);
});

test('an unreadable measurement never recycles', () => {
  // `takeSample` returns null on a failed scan and nulls the family counts when the scan was
  // blind. NULL IS NOT ZERO and it is not "huge" either — recycling on a failed read would
  // restart the browser every minute on a box where PowerShell is merely busy. Same rule as
  // `unknown` never rounding to `signed-out`.
  assert.match(code, /typeof mb === 'number' && Number\.isFinite\(mb\) \? mb : null/);
  assert.match(code, /mb != null &&/, 'the null case must be excluded before the comparison');
});

test('the cooldown survives a reopen', () => {
  // A recycle re-enters the outer loop, so a cooldown declared inside it would reset on the
  // very event it rate-limits and bound nothing — a busy loop wearing a fix's clothes.
  const outer = code.indexOf('async function warmResident()');
  const decl = code.indexOf('let lastRecycleAt = 0;');
  const forLoop = code.indexOf('for (;;) {', outer);
  assert.ok(decl > outer && decl < forLoop,
    'lastRecycleAt must be declared between the function head and the outer loop');
  assert.match(code, /Date\.now\(\) - lastRecycleAt < RECYCLE_COOLDOWN_MS/);
});

test('the check never delays a cart', () => {
  // It spawns PowerShell, so it must sit AFTER the runner's preemption — a cart at 08:00:00
  // waiting behind a memory scan is the thing the whole keep-warm exists to protect.
  const loop = code.slice(code.indexOf('for (;;) {', code.indexOf('let lastMemCheck')));
  const yieldAt = loop.indexOf('profileRequested(PROFILE_DIR)');
  const memAt = loop.indexOf('lastMemCheck >= MEM_CHECK_MS');
  assert.ok(yieldAt > -1 && memAt > -1 && yieldAt < memAt,
    'the profile yield must be checked before the memory scan');
});

test('recycling reuses the existing reopen path', () => {
  // `break` from the inner loop is exactly what the closed-window and preemption paths do:
  // the context closes and the outer loop reopens it. Introducing a second teardown would be
  // a second thing to get wrong, and this one is already exercised many times a day.
  const block = code.slice(code.indexOf('RECYCLING the browser'));
  assert.match(block.slice(0, 600), /\bbreak;/, 'must break, not exit or relaunch inline');
  assert.ok(!/process\.exit/.test(block.slice(0, 600)),
    'dying here would drop the session for no reason — the wedge watchdog is what exits');
});
