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

/**
 * Read a numeric default out of a `process.env.X || N` fallback.
 *
 * IT MUST HANDLE `60_000`. The first version of this used a bare `(\d+)`, which stops at the
 * underscore — so `MEM_STALL_MS` read as **60** and `WATCHDOG_MS` as **10**. That did not
 * merely fail one test: it made the watchdog-cadence assertion PASS for the wrong reason,
 * since 10 is comfortably under a 15,000 ms ceiling. A guard that reads the wrong number is
 * a guard that will approve the wrong value later, silently. Same family as the ordering
 * assertion that matched the import line.
 */
function envDefault(name: string): number {
  const m = new RegExp(`${name} \\|\\| ([\\d_]+)`).exec(code);
  assert.ok(m, `no default found for ${name} — the constant may have been renamed`);
  return Number(m![1].replace(/_/g, ''));
}

test('the trigger is SIZE, not age', () => {
  // The family sits at 220-300 MB for hours and then ramps ~4,160 MB/min. An age bound
  // would have to be absurdly aggressive to land inside a ten-minute cliff, and would spend
  // a session for nothing across the ~95% of the day that is flat.
  assert.match(code, /const RC_MAX_FAMILY_MB = Number\(process\.env\.RC_KEEPWARM_MAX_MB \|\| 1500\)/);
  assert.match(code, /mb != null && mb > RC_MAX_FAMILY_MB/);
});

test('the threshold sits well above normal and well below the cliff', () => {
  const limit = envDefault('RC_KEEPWARM_MAX_MB');
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

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE SIZE BOUND ABOVE COULD NEVER HAVE FIRED (found 2026-08-17, second pass)
 *
 * With the sampler finally recording, the leak has a full history for the first time: TWENTY
 * ramps in five days, every ~70 minutes, every one the `rc` family, every one a single
 * process, ~2,400 MB/min of REAL memory (free RAM 13,112 -> 881 MB across one of them).
 *
 * And they coincide with the keep-warm WEDGE — `renewing the session` at 15:42:58, `the loop
 * has not advanced in 13m` at 15:55:58 — whose four recorded restart times match four ramp
 * recoveries to within two minutes.
 *
 * WHICH MEANS THE RECYCLE SHIPPED THAT MORNING WAS INERT BY CONSTRUCTION. It is checked in
 * the resident loop's BODY; a wedge is that loop not advancing; so on every occasion it was
 * written for, control never reached it. Third instance of watchdog-wired-to-the-thing-it-
 * watches in this repo, after `expireStaleHolds` in the feed the dead runner polls and
 * `reclaimLapsedHolds` inside `withRC`.
 *
 * These tests pin the guard's LOCATION as much as its existence, because a guard in the
 * wrong place is precisely the defect and it reads as correct in review.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

test('the fast guard lives in the TIMER, not in the loop it is guarding', () => {
  // The whole finding. The wedge watchdog's own comment says why: the renew timer "is the
  // only code proven to still be executing, which makes it the only place a watchdog can
  // live." The size bound did not obey it; this one must.
  const timer = code.slice(code.indexOf('const renew = setInterval('));
  const end = timer.indexOf('}, WATCHDOG_MS);');
  assert.ok(end > -1, 'the watchdog interval must be driven by WATCHDOG_MS');
  const body = timer.slice(0, end);
  assert.match(body, /os\.freemem\(\)/, 'the RAM check must be inside the interval callback');
  assert.match(body, /stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB/,
    'and the decision itself, not merely the reading');
});

test('it needs BOTH a stall and low RAM', () => {
  // Low RAM alone is the owner using their own desktop PC, and killing the RC session over
  // that is the cry-wolf failure already fixed three times — most expensively at 07:33 on
  // 08-16, where the printed remedy would have destroyed the healthy session it complained
  // about. A stall alone is an unattended sign-in doing its job.
  assert.match(code, /stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB/);
  // EVERY place that reads the floor must carry the stall with it. Asserting only that the
  // conjunction appears somewhere would go green against a second, unguarded `if (freeMb <
  // LOW_RAM_MB)` added later — which is the one-armed version of this whole bug.
  //
  // Scoped to COMPARISONS. The failure message interpolates the floor to tell a human what
  // it was (`${LOW_RAM_MB} MB`), and a scan that flagged that would be "fixed" by deleting
  // the number from the message — making the guard less legible to defend a test. Same trap
  // as the chromium-attribution scan reading assignments only, because the comment beside it
  // quotes the broken pattern.
  const comparisons = code.split('\n').filter((l) => /[<>]=?\s*LOW_RAM_MB|LOW_RAM_MB\s*[<>]=?/.test(l));
  assert.ok(comparisons.length > 0, 'the floor must actually be compared against something');
  for (const line of comparisons) {
    assert.ok(line.includes('MEM_STALL_MS'),
      `free RAM is compared without a stall condition, so it can act alone: ${line.trim()}`);
  }
});

test('the RAM reading needs no child process', () => {
  // `rcFamilyMb()` spawns PowerShell, and spawning is exactly what fails at 99% COMMIT —
  // it is how supervise.ps1 could not start a shell on 08-12 and how the Scheduled Tasks
  // stopped on 08-17. An instrument that goes quiet as the emergency peaks reports the
  // emergency as calm, which is this repo's oldest failure shape.
  const timer = code.slice(code.indexOf('const renew = setInterval('));
  const body = timer.slice(0, timer.indexOf('}, WATCHDOG_MS);'));
  assert.ok(!/rcFamilyMb|takeSample/.test(body),
    'the fast arm must not spawn PowerShell — that is what fails first under load');
});

test('the tick is fast enough to bound a 2,400 MB/min ramp', () => {
  // The tick interval IS the overshoot. At the measured rate a two-minute timer — which is
  // what RENEW_MS was — lets the browser gain nearly 5 GB between looks.
  const ms = envDefault('RC_KEEPWARM_WATCHDOG_MS');
  assert.ok(ms > 0 && ms <= 15_000, `${ms}ms is too slow to bound the measured ramp`);
  // ...but the lock file must NOT get 12x more write traffic as a side effect.
  assert.match(code, /Date\.now\(\) - lastLockRenew >= RENEW_MS/,
    'the profile lock must keep its own slower cadence inside the faster timer');
});

test('the stall bar is shorter than the wedge bar, and both still exist', () => {
  // HUNG_MS has to tolerate a full unattended sign-in, so it cannot be tightened without
  // killing real logins — 12 minutes at 2,400 MB/min is 28 GB of runway. This arm can be
  // short precisely because it carries a second condition.
  const stall = envDefault('RC_KEEPWARM_MEM_STALL_MS');
  const hung = envDefault('RC_KEEPWARM_HUNG_MS') * 60_000;
  assert.ok(stall < hung, 'the runaway arm must fire before the generic wedge arm');
  assert.ok(stall >= 30_000, 'not so short that an ordinary slow page load trips it');
  assert.match(code, /stalledMs > HUNG_MS/, 'the generic wedge watchdog must survive');
});

test('the RAM floor is far below idle and far above zero', () => {
  // Measured idle on this box is ~13,000 MB free. The ramps passed 4,428 MB about three
  // minutes in, with COMMIT still near 67% — comfortably before the point where spawning a
  // process starts to fail, which is the only thing that must never happen again.
  const floor = envDefault('RC_KEEPWARM_LOW_RAM_MB');
  assert.ok(floor >= 2000, `${floor} MB fires so late the box may already be unable to spawn`);
  assert.ok(floor <= 8000, `${floor} MB is close enough to idle to fire on ordinary desktop use`);
});

test('the disproven throttling flags are gone and stay gone', () => {
  // They were added 2026-08-08 to catch "a timer inside RC's app". 2026-08-09 established
  // that timer fails and DELETES the tokens; 2026-08-15 established RC issues no refresh
  // token at all, so no timer of RC's could renew anything. What re-mints is a click we
  // drive ourselves, and `page.evaluate`/`page.goto` are devtools-driven and unthrottled.
  //
  // So they bought nothing and cost the brakes on an occluded tab running a permanently-401
  // SPA. Comment lines are stripped above, so the explanation quoting them cannot fail this.
  for (const flag of [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]) {
    assert.ok(!code.includes(flag), `${flag} must not come back without new evidence`);
  }
  assert.match(code, /'--hide-crash-restore-bubble'/,
    'the crash-restore bubble suppression is unrelated and must stay');
});
