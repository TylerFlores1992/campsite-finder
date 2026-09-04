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
  // MUST HANDLE `40 * 60_000` AS WELL AS `60_000`. The first version matched `[\d_]+`, which
  // stops at the space — so `RC_KEEPWARM_MAX_AGE_MS` read as **40** and the "is it at least 20
  // minutes?" assertion failed with `0.0006m`. That is the SECOND time in one session a
  // threshold guard has silently read the wrong number, after a bare `(\d+)` stopping at the
  // underscore in `60_000` — and this helper was written to stop exactly that. A guard that
  // misreads a value will approve a wrong one later without saying anything.
  const m = new RegExp(`${name} \\|\\| ([\\d_ *]+?)\\s*\\)`).exec(code);
  assert.ok(m, `no default found for ${name}`);
  const factors = m![1].split('*').map((x) => Number(x.trim().replace(/_/g, '')));
  assert.ok(factors.every(Number.isFinite), `could not parse the default for ${name}: ${m![1]}`);
  return factors.reduce((a, b) => a * b, 1);
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
  // BOUNDED AT THE NEXT SECTION, not by a character count. The window was a flat 600 chars
  // and broke the moment the heap diagnostics were added between the trip and its `break` —
  // a guard measuring by proximity rather than by structure, which fails on any edit that
  // makes the block longer and says nothing useful when it does.
  const start = code.indexOf('RECYCLING the browser');
  const end = code.indexOf('lastExpiryPoll >= EXPIRY_POLL_MS', start);
  assert.ok(start > -1 && end > start, 'could not locate the size-bound trip block');
  const block = code.slice(start, end);
  assert.match(block, /\bbreak;/, 'must break, not exit or relaunch inline');
  assert.ok(!/process\.exit/.test(block),
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
  const hung = envDefault('RC_KEEPWARM_HUNG_MS');
  assert.ok(stall < hung, 'the runaway arm must fire before the generic wedge arm');
  assert.ok(stall >= 30_000, 'not so short that an ordinary slow page load trips it');
  assert.match(code, /stalledMs > HUNG_MS/, 'the generic wedge watchdog must survive');
});

test('the RAM floor leaves room for a renewal to finish, and still beats 90% COMMIT', () => {
  /**
   * BOTH BOUNDS ARE MEASURED, and the upper one is the reason this test was rewritten.
   *
   * At 4000 the arm was arithmetically certain to kill every Okta renewal — the navigation
   * always exceeds MEM_STALL_MS and always allocates several GB, so both conditions are met
   * by a renewal that is working perfectly. Five firings, five stalls in
   * `renew:click-sign-in`. On 2026-08-19 it killed the repair that would have restored a
   * session which had just stopped re-minting itself, and the session then sat dead.
   *
   * UPPER BOUND — a renewal must be able to complete. Worst observed peak is 5,688 MB
   * against a ~9,000 MB idle, so the trough is around 3,300 MB and the floor must sit below
   * it. `maybeAutoLogin` makes the same navigation at T−30 of a real release, so a floor
   * that kills a renewal can kill the login a campsite depends on.
   *
   * LOWER BOUND — free RAM maps to COMMIT on this box: 1,875 MB → 74%, 982 MB → 83%,
   * 520 MB → 89%. ~90% is where Windows stops scheduling tasks and ~99% is where Node
   * aborts, so the floor must stay well clear of those.
   *
   * The UNBOUNDED case that once justified a high floor is the 25 GB ORPHAN, and this arm
   * never fired on it — the loop kept ticking, so there was no stall. That is
   * `orphan-sweep.mjs`'s job and it does not depend on this number.
   */
  const floor = envDefault('RC_KEEPWARM_LOW_RAM_MB');
  assert.ok(floor >= 1500,
    `${floor} MB acts past ~85% COMMIT, close to where the box stops scheduling tasks`);
  assert.ok(floor <= 3000,
    `${floor} MB trips during a normal Okta renewal — the measured trough is ~3,300 MB, and ` +
    'a guard that kills the repair is worse than no guard');
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

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * RECYCLE AFTER AN OKTA ROUND TRIP (2026-08-18)
 *
 * A CONTROLLED COMPARISON, off one ten-minute window on the box. Three token-less renewals,
 * same code, same profile, same browser generation, differing only in whether RC's sign-in
 * control was found and clicked:
 *
 *     19:04:04  token-less -> `no-signin-control` (never clicked)  ->   200 MB
 *     19:10:43  token-less -> `authorize` OK (clicked)             -> 2,331 MB
 *     19:13:46  token-less -> `no-signin-control` (never clicked)  ->   237 MB
 *
 * The two that never navigated ran the identical clear, reload and prime and allocated
 * NOTHING. So the onset is the Okta navigation, not `renew:reload` where the RAM trail had
 * put it — the trail could only say where the stall was CAUGHT.
 *
 * AND IT CORRECTS THE ENTRY SHIPPED THE SAME MORNING. `planRenewal` stands down on a live
 * token because every ramp began in a near-expiry renewal AND because the token-less cell
 * "works and does not ramp". The first half stands; the second is false. The stand-down
 * halves the leak (two Okta trips per near-expiry renewal against one) and cannot cure it.
 *
 * These tests pin the recycle to the CLICK and to the loop position, because the two ways to
 * get this wrong both read as correct: keying off `stage` strings that must stay in step
 * across two files, and placing the check where a `continue` skips it.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

const TOKEN_SRC = readFileSync('scripts/auto-cart-bot/rc-token.mjs', 'utf8');
const tokenCode = TOKEN_SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('renewSession reports whether it actually navigated, and it is the click', () => {
  // The function that navigates is the function that knows. `stage` cannot answer this
  // without the caller knowing that `authorize` and `none` mean clicked while
  // `no-signin-control` does not — three strings to keep in step for one boolean.
  assert.match(tokenCode, /visitedOkta = clicked === true/,
    'visitedOkta must be set from the click itself');
  // ANCHORED ON THE FIELD, NOT ON THE WHOLE RETURN LITERAL. This used to pin the exact
  // property list in order, so adding `afterSource` beside it failed over behaviour that had
  // not changed at all — the same anchor-on-a-refactored-expression shape that has now broken
  // a guard in this repo seventeen times. What must be true is that the successful return
  // carries `visitedOkta`; which other fields travel with it is not this test's business.
  const ret = tokenCode.slice(tokenCode.indexOf('return { renewed, stage,'));
  assert.ok(ret.startsWith('return { renewed, stage,'), 'the successful return must exist');
  assert.match(ret.slice(0, 200), /\bvisitedOkta\b/, 'and must carry visitedOkta');
  assert.match(tokenCode, /skipped: 'no Okta session to renew against', visitedOkta: false/,
    'the early skip must carry visitedOkta too, or the caller reads undefined');
});

test('the RENEWAL does not recycle — the throwaway tab is its reclaim (inverted 2026-08-19)', () => {
  /**
   * THIS GUARD USED TO ASSERT THE OPPOSITE — `if (r?.visitedOkta) oktaTrip =` — and the
   * assertion it replaced WAS the design until the tab shipped: the renewal's Okta trip
   * allocated into the RESIDENT page's renderer, nothing was ever seen to give that memory
   * back in place, so the only reclaim was restarting the whole browser.
   *
   * The renewal now runs in a tab closed in a `finally`, and a renderer's memory dies with
   * its page — so the recycle on this path became a browser restart that frees already-freed
   * memory. Restarts are not free: one turned the rehearsal red on 08-18, and each churns the
   * profile lock. Reinstating the flag here would look like caution and buy nothing, which
   * is exactly the shape that passes review.
   *
   * `maybeAutoLogin` and the rehearsal still navigate the RESIDENT page; their setters are
   * pinned by the test below and must stay.
   */
  assert.ok(!/if \(r\?\.visitedOkta\) oktaTrip =/.test(code),
    'the renewal must NOT hand its Okta trip to the recycle — the tab close is the reclaim');
  assert.ok(!/oktaTrip = .*r\.stage === /.test(code),
    'nor read the stage back — the three-string coupling stays dead');
});

test('the renewal runs in a THROWAWAY TAB, closed whatever happens', () => {
  // The cure itself, pinned structurally because it is three properties an innocent-looking
  // refactor could undo one at a time:
  //  1. the trip runs on a page that is NOT the resident page,
  //  2. that page is closed in a `finally` — a thrown renewal, failed census or failed
  //     report must not leave the tab (and its gigabytes, on a bad trip) parked in the
  //     browser for the resident page's lifetime,
  //  3. a tab that cannot open is RECORDED, so `planRenewal`'s floor paces the retries —
  //     unrecorded, a sick browser would retry every tick, the 2026-08-08 request storm.
  assert.match(code, /const tab = await ctx\.newPage\(\)\.catch\(/,
    'the renewal must open its own page');
  assert.match(code, /withNetworkTrace\(tab, \(\) => renewSession\(tab, RC_HOME/,
    'and the trip must run on it — a `page` here is the resident renderer ballooning again');
  //
  // ANCHORED ON THE RENEWAL'S OWN TAB. This was a bare `indexOf('const tab = await
  // ctx.newPage()')` and broke the day `maybeAutoLogin` got a tab of its own — that one is
  // EARLIER in the file, so the search landed on it, `if (!tab)` found the auto-login's
  // stand-down instead of `recordRenewal`, and the guard reported a regression over
  // completely correct code. The same anchored-on-a-token-that-occurs-twice failure this
  // file already records twice. Search BACKWARDS from the renewal call, which is unique.
  const renewCallAt = code.indexOf('withNetworkTrace(tab, () => renewSession(tab');
  assert.ok(renewCallAt > -1, 'could not find the renewal call to anchor on');
  const tabAt = code.lastIndexOf('const tab = await ctx.newPage()', renewCallAt);
  assert.ok(tabAt > -1, 'the renewal must open its tab BEFORE the trip it wraps');
  const finallyAt = code.indexOf('} finally {', tabAt);
  assert.ok(finallyAt > tabAt, 'the tab block must carry a finally');
  // The bounded close (tab-close.mjs, 2026-09-04): sliced to the END of the finally block,
  // not a character window — the comment above the call grew and a window would have broken.
  const finallyEnd = code.indexOf('\n            }\n', finallyAt);
  assert.match(code.slice(finallyAt, finallyEnd > finallyAt ? finallyEnd : finallyAt + 900), /await closeTabBounded\(tab, \{ label: 'renewal'/,
    'and the finally must close the tab — through the bounded close, never a bare tab.close()');
  const noTab = code.slice(code.indexOf('if (!tab) {', tabAt));
  assert.match(noTab.slice(0, 200), /recordRenewal\(renewal, \{ token, now: Date\.now\(\), renewed: false \}\)/,
    'a tab that cannot open must still be recorded, or the schedule cannot pace the retry');
});

test('after a tab renewal the RESIDENT page is refreshed, or every report lies', () => {
  // The tab minted the token into the shared profile, but `checkAndReport` reads the
  // resident page, whose `window.__camphawkRcToken` is per-page and whose SPA is still
  // rendered signed-out. Without the reload, a successful renewal is followed by a report
  // announcing a dead session over a fresh hour of token — a repair that happened and
  // cannot be seen.
  const at = code.indexOf('if (r?.renewed) {', code.indexOf('const tab = await ctx.newPage()'));
  assert.ok(at > -1, 'the success branch must exist');
  const block = code.slice(at, at + 400);
  assert.match(block, /await page\.goto\(RC_HOME/, 'the resident page must be reloaded');
  assert.match(block, /await primeToken\(page/, 'and primed, so the very next report sees it');
});

test('the path that still navigates the RESIDENT page sets the flag', () => {
  /**
   * THIS GUARD USED TO COVER BOTH THE AUTO-LOGIN AND THE REHEARSAL, AND WAS INVERTED FOR THE
   * AUTO-LOGIN ON 2026-08-20 — deliberately, not relaxed.
   *
   * That assertion was right for as long as `maybeAutoLogin` navigated the resident page.
   * It now runs its Okta trip in a throwaway tab closed in a `finally`, exactly as the
   * renewal does, so the recycle there would restart the whole browser to free memory the
   * tab close already freed — at T−28 of a release, where a restart churns the profile lock
   * and a guard kill can hold it past 08:00. What drove it: on 2026-08-20 07:30 that login
   * cost 9,434 MB over twelve minutes on the resident page and the RAM guard killed it.
   *
   * THE REHEARSAL STILL NAVIGATES THE RESIDENT PAGE, so its setter stays and is pinned here.
   * Dropping it would leave a genuinely unreclaimed trip in the resident browser with nothing
   * to clean it up.
   *
   * The auto-login's tab, and every page-taking call bound to it, are owned by
   * worker/autologin-tab.test.mts. The one assertion kept here is that the flag does not come
   * back, because that is a change to THIS file's mechanism.
   */
  const at = code.indexOf('await maybeRehearse(ctx, page).catch(');
  assert.ok(at > -1, 'could not find the awaited rehearsal call');
  const block = code.slice(at, at + 400);
  assert.ok(block.includes("oktaTrip = 'the login rehearsal'"),
    'the rehearsal must set oktaTrip — it still navigates the resident page');
  assert.ok(block.indexOf("oktaTrip = 'the login rehearsal'") < block.indexOf('continue;'),
    'the flag must be set BEFORE the continue, or the recycle never happens');

  // And the auto-login must NOT bring it back. Bounded by the next call rather than a
  // character count: with comments stripped the rehearsal's own setter sits a few hundred
  // characters away, so a fixed window cannot tell the two arms apart.
  const loginAt = code.indexOf('await maybeAutoLogin(ctx, page).catch(');
  assert.ok(loginAt > -1 && loginAt < at, 'the auto-login call must be found, ahead of it');
  assert.ok(!/oktaTrip\s*=/.test(code.slice(loginAt, at)),
    'the auto-login runs in a tab now; reinstating the recycle here buys nothing and puts a ' +
    'browser restart back into the critical window while looking like caution');
});

test('the recycle is read at the top of the loop, where both continues reach it', () => {
  const loop = code.slice(code.indexOf('for (;;) {', code.indexOf('let oktaTrip')));
  const readAt = loop.indexOf('if (oktaTrip) {');
  const autoLoginAt = loop.indexOf('maybeAutoLogin(ctx, page)');
  // ANCHORED ON THE CALL, NOT ON `await`. This was `await renewSession(` and broke the moment
  // the renewal was wrapped in `withNetworkTrace(page, () => renewSession(…))` — over
  // completely unchanged behaviour, and by returning -1 rather than failing loudly, which
  // made `readAt < -1` false and read as a real regression. Match the callee itself.
  const renewAt = loop.indexOf('renewSession(');
  assert.ok(renewAt > -1, 'could not find the renewal call in the resident loop');
  assert.ok(readAt > -1, 'the recycle check must exist inside the resident loop');
  assert.ok(readAt < autoLoginAt && readAt < renewAt,
    'a check placed after the setters is skipped by every `continue` that sets one');
});

test('a cart still outranks the recycle, and the recycle outranks the memory scan', () => {
  const loop = code.slice(code.indexOf('for (;;) {', code.indexOf('let oktaTrip')));
  const yieldAt = loop.indexOf('profileRequested(PROFILE_DIR)');
  const readAt = loop.indexOf('if (oktaTrip) {');
  const memAt = loop.indexOf('lastMemCheck >= MEM_CHECK_MS');
  assert.ok(yieldAt < readAt,
    'the hold runner must be able to take the profile before we close the browser for tidiness');
  assert.ok(readAt < memAt,
    'recycling first saves a PowerShell spawn on a browser that is about to be replaced');
});

test('the recycle reuses the reopen path and is not gated on the cooldown', () => {
  const start = code.indexOf('if (oktaTrip) {');
  const end = code.indexOf('lastMemCheck >= MEM_CHECK_MS', start);
  assert.ok(start > -1 && end > start, 'could not locate the Okta recycle block');
  const block = code.slice(start, end);
  assert.match(block, /\bbreak;/, 'must break, so the existing outer loop reopens');
  assert.ok(!/process\.exit/.test(block),
    'exiting would hand the supervisor a restart and write an abnormal-exit marker');
  // It SETS the cooldown so the size arm does not immediately recycle a fresh browser, but
  // it must not READ it: we know two gigabytes were just allocated, and standing down would
  // leave them standing. Pacing comes from planRenewal's floor, gap and backoff.
  assert.match(block, /lastRecycleAt = Date\.now\(\)/, 'it must stamp the cooldown');
  assert.ok(!/lastRecycleAt < RECYCLE_COOLDOWN_MS/.test(block),
    'gating on the cooldown would skip a recycle after a real 2 GB allocation');
});
