/**
 * Guards for the page-wedge arm — the cure for the 2 MiB shared-mapping leak.
 *
 * WHY THIS LIVES UNDER `src/` AND NOT `worker/`. `worker/**` is the FIRST entry in
 * `worker-deploy.yml`'s `paths:`, so a guard there restarts all three pollers to ship a test
 * for a file the worker does not import. Checked against that list rather than remembered —
 * this repo has recorded getting that claim wrong twice.
 *
 * THE BEHAVIOURAL HALF IS REAL AND THE STRUCTURAL HALF IS NOT DECORATION. `wedgeDecision` is
 * pure and can be driven directly; the wiring in `rc-keepwarm.mjs` cannot, because importing
 * that file STARTS the keep-warm loop. A perfect decision that nothing calls is the
 * fix-present-and-inert shape this repo has now paid for eight times, so the call site is
 * pinned structurally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  probeResidentPage, wedgeDecision,
  WEDGE_STRIKES, WEDGE_MAX_RECYCLES, WEDGE_PROBE_TIMEOUT_MS, WEDGE_PROBE_EVERY_MS,
} = await import('../../scripts/auto-cart-bot/page-wedge.mjs');

const wedgeSrc = readFileSync('scripts/auto-cart-bot/page-wedge.mjs', 'utf8');
const keepwarmSrc = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
/** Comments quote the very shapes these guards forbid, so they are stripped before matching. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const kw = code(keepwarmSrc);
const wedge = code(wedgeSrc);

// ── the probe ──────────────────────────────────────────────────────────────────────────────

test('the probe is BOUNDED — page.evaluate has no timeout of its own', async () => {
  // THE STRUCTURAL ASSERTION GOES FIRST, AND THE ORDER IS THE WHOLE LESSON. It was third, and
  // deleting the race SURVIVED this guard: an unbounded probe does not fail the behavioural
  // half, it HANGS, and node:test reports a hung suite as `# fail 0` with every test
  // `cancelled` — which reads as a pass to anything counting failures, including the mutation
  // harness that caught it. An assertion placed after a call that can hang is unreachable.
  assert.match(wedge, /Promise\.race\(/, 'the probe must race the evaluate against a timer');

  // A page that never answers. The call is itself raced, so a hang arrives as a failed
  // assertion rather than as silence — the same rule, applied to the test's own await.
  const t0 = Date.now();
  const reading = await Promise.race([
    probeResidentPage({ evaluate: () => new Promise(() => {}) }, 150),
    new Promise((r) => setTimeout(() => r('DID NOT RETURN'), 5_000)),
  ]);
  assert.equal(reading, 'wedged');
  assert.ok(Date.now() - t0 < 5_000, 'the probe did not return inside its budget');
});

test('a page that answers reads alive', async () => {
  assert.equal(await probeResidentPage({ evaluate: async () => 1 }, 500), 'alive');
});

test('a REJECTION is inconclusive, never wedged', async () => {
  // "Target closed" / "Execution context was destroyed" reject INSTANTLY, and they mean the
  // page is CHANGING, which is the healthy case. Counting them would rack up three strikes
  // during an ordinary reopen and recycle a page that was never wedged.
  const reading = await probeResidentPage({ evaluate: async () => { throw new Error('Target closed'); } }, 500);
  assert.equal(reading, 'inconclusive');
});

test('no page, or a closed page, is inconclusive — never an excuse to act', async () => {
  assert.equal(await probeResidentPage(null, 50), 'inconclusive');
  assert.equal(await probeResidentPage(undefined, 50), 'inconclusive');
  assert.equal(await probeResidentPage({ evaluate: async () => 1, isClosed: () => true }, 50), 'inconclusive');
});

// ── the decision ───────────────────────────────────────────────────────────────────────────

test('one miss is never enough, and STRIKES MUST BE CONSECUTIVE', async () => {
  let { strikes, act } = wedgeDecision({ reading: 'wedged', strikes: 0 });
  assert.equal(act, 'none');
  assert.equal(strikes, 1);
  // A single answer ends the episode. A GC pause, a heavy paint or a same-site tab loading
  // Okta on the shared main thread all produce one miss and then recover.
  ({ strikes, act } = wedgeDecision({ reading: 'alive', strikes }));
  assert.equal(strikes, 0, 'an alive reading must clear the strikes');
  assert.equal(act, 'none');
});

test('it acts only at the strike count, and the count is >= 2', async () => {
  assert.ok(WEDGE_STRIKES >= 2, 'one strike is a GC pause, not a wedge');
  let strikes = 0;
  let act = 'none';
  for (let i = 0; i < WEDGE_STRIKES; i++) {
    ({ strikes, act } = wedgeDecision({ reading: 'wedged', strikes }));
  }
  assert.equal(act, 'recycle', `it should act on strike ${WEDGE_STRIKES}`);
});

test('an inconclusive reading neither strikes nor clears', async () => {
  // Absence of evidence, in both directions. Rounding it either way is the mistake this
  // repo's whole history is made of.
  const r = wedgeDecision({ reading: 'inconclusive', strikes: 2 });
  assert.equal(r.strikes, 2, 'inconclusive must not add a strike');
  assert.equal(r.act, 'none');
});

test('the recycle budget ESCALATES rather than looping for ever', async () => {
  // Three fresh pages that all wedge is not a page fault, and a repeated cheap action is the
  // crash-loop shape supervise.ps1 stops loudly for.
  assert.ok(WEDGE_MAX_RECYCLES >= 1 && WEDGE_MAX_RECYCLES <= 5, 'budget out of sane bounds');
  const r = wedgeDecision({
    reading: 'wedged', strikes: WEDGE_STRIKES - 1, recycles: WEDGE_MAX_RECYCLES,
  });
  assert.equal(r.act, 'escalate', 'past the budget it must hand over to the bail');
  const under = wedgeDecision({
    reading: 'wedged', strikes: WEDGE_STRIKES - 1, recycles: WEDGE_MAX_RECYCLES - 1,
  });
  assert.equal(under.act, 'recycle', 'inside the budget it must still recycle');
});

/**
 * Read a `Number(process.env.NAME || <expr>)` default out of the keep-warm's source.
 *
 * `rc-keepwarm.mjs` STARTS THE KEEP-WARM ON IMPORT, so the one number this guard has to be
 * measured against cannot be imported — it has to be parsed. That parsing has been got wrong
 * twice in this repo and both times it read a threshold far smaller than the real one: a bare
 * `(\d+)` stops at the underscore in `60_000` (reporting 60) and again at the space in
 * `40 * 60_000` (reporting 40). Underscores are stripped and a product is multiplied out, and
 * an unparseable default THROWS rather than returning a number — a guard that silently reads
 * the wrong threshold approves the wrong value later.
 */
function keepwarmEnvDefault(name: string): number {
  const m = kw.match(new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*([0-9_ *]+?)\\s*\\)`));
  assert.ok(m, `${name} default not found in rc-keepwarm.mjs — this guard is measuring nothing`);
  const value = m![1].replace(/_/g, '').split('*').reduce((a, part) => a * Number(part.trim()), 1);
  assert.ok(Number.isFinite(value) && value > 0, `${name} default did not parse: ${m![1]}`);
  return value;
}

test('the timings are bounded from both sides', async () => {
  // Long enough that a busy-but-healthy page answers; short enough that three of them is far
  // inside what the cheapest existing arm needs.
  assert.ok(WEDGE_PROBE_TIMEOUT_MS >= 500 && WEDGE_PROBE_TIMEOUT_MS <= 5_000);
  assert.ok(WEDGE_PROBE_EVERY_MS >= 2_000 && WEDGE_PROBE_EVERY_MS <= 30_000);

  // DERIVED FROM THE RAMP ARM'S OWN CONSTANT, never restated as a literal. Ordering is already
  // pinned above (`probeAt < rampAt`) — and ORDER IS NOT TIMING: both arms read the same
  // `stalledMs`, so whichever bar is crossed first is the one that acts, whatever the source
  // order. A literal here keeps passing if `RC_KEEPWARM_RAMP_STALL_MS` is ever lowered, and the
  // cure would then be beaten to every event by the arm that costs the whole browser while
  // nothing went red. That is the grace-versus-dump-timeout shape (a 15s hold against a 20s
  // budget: two constants with no stated relationship, ordered the wrong way round).
  const rampStallMs = keepwarmEnvDefault('RC_KEEPWARM_RAMP_STALL_MS');
  assert.ok(
    WEDGE_STRIKES * WEDGE_PROBE_EVERY_MS < rampStallMs,
    `this arm must act sooner than the ramp arm or it buys nothing: `
      + `${WEDGE_STRIKES} strikes x ${WEDGE_PROBE_EVERY_MS}ms vs a ${rampStallMs}ms stall bar`,
  );
});

// ── the wiring: a perfect decision that nothing calls is worth nothing ─────────────────────

test('the keep-warm actually calls the module — it does not keep its own copy', async () => {
  assert.match(kw, /from '\.\/page-wedge\.mjs'/, 'the keep-warm must import the module');
  assert.match(kw, /probeResidentPage\(residentPage\)/, 'it must probe the RESIDENT page');
  assert.match(kw, /wedgeDecision\(\{/, 'it must use the shared decision');
  assert.match(kw, /recycleWedgedPage\(/, 'the recycle action must be reachable');
});

test('the arm runs BEFORE the two expensive arms', async () => {
  // Order is the whole design: a page close costs one RC page load, a bail costs the RC
  // session. Giving the expensive arms first refusal spends a session on something a close
  // fixes.
  const probeAt = kw.indexOf('probeResidentPage(residentPage)');
  const hungAt = kw.indexOf('stalledMs > HUNG_MS');
  const rampAt = kw.indexOf('rampBailDecision({');
  assert.ok(probeAt > -1 && hungAt > -1 && rampAt > -1, 'anchors moved — this guard is measuring nothing');
  assert.ok(probeAt < hungAt, 'the page-wedge arm must precede the HUNG_MS arm');
  assert.ok(probeAt < rampAt, 'the page-wedge arm must precede the ramp arm');
});

test('the token is written down BEFORE the page is closed', async () => {
  // Same rule and the same call as reportAndBail and the runner's preemption path: the live
  // token lives in PAGE MEMORY and dies with the page.
  const body = kw.slice(kw.indexOf('const recycleWedgedPage'), kw.indexOf('const recycleWedgedPage') + 1600);
  const persistAt = body.indexOf('persistLiveToken');
  const closeAt = body.indexOf('.close({');
  assert.ok(persistAt > -1, 'the recycle must persist the live token');
  assert.ok(closeAt > -1, 'the recycle must close the page');
  assert.ok(persistAt < closeAt, 'the token must be persisted before the close destroys it');
});

test('the close does NOT wait for beforeunload', async () => {
  // A wedged renderer cannot run an unload handler, so asking it to is how the close inherits
  // the hang it exists to end. `page.reload()` on the same page hung past its own timeout.
  const body = kw.slice(kw.indexOf('const recycleWedgedPage'), kw.indexOf('const recycleWedgedPage') + 1600);
  assert.match(body, /close\(\{\s*runBeforeUnload:\s*false\s*\}\)/,
    'the wedged-page close must pass runBeforeUnload: false');
});

test('the probe is fire-and-forget behind an in-flight flag', async () => {
  // The timer must never await; and once the page goes quiet EVERY probe costs its full
  // timeout, so without the flag they pile up one per tick.
  assert.match(kw, /!wedge\.inFlight/, 'the probe must be guarded by an in-flight flag');
  assert.match(kw, /wedge\.inFlight = false/, 'the flag must be cleared');
  assert.doesNotMatch(kw, /await probeResidentPage\(/, 'the timer must not await the probe');
});

test('the strike and recycle state resets per browser life', async () => {
  // A reopen is a new page and a new renderer, so last life's strikes describe a page that no
  // longer exists — and a budget that never resets retires the arm after one long night.
  assert.match(kw, /wedge = \{ strikes: 0, recycles: 0, inFlight: false, lastProbe: 0 \}/);
  const resets = kw.match(/wedge = \{ strikes: 0, recycles: 0/g) ?? [];
  assert.ok(resets.length >= 2, 'it must be reset on reopen, not only declared once');
});

/**
 * THE FIRING IS THE WHOLE PROOF, SO IT HAS TO RECORD ITSELF.
 *
 * `tail-log` returns the last 16,000 characters, which is exactly how the 2026-08-23 ramp
 * attributions were lost. The three facts that say what a firing DID — how long the close
 * took, whether the token survived, and what the box was holding — must reach Postgres, not
 * only the log. Same move as migration 066 for the alloc readings.
 */
const recycleBody = (() => {
  const from = kw.indexOf('const recycleWedgedPage = async');
  assert.ok(from > -1, 'recycleWedgedPage moved — these guards are measuring nothing');
  const to = kw.indexOf('\n      };', from);
  assert.ok(to > from, 'could not bound recycleWedgedPage — these guards are measuring nothing');
  return kw.slice(from, to);
})();

/**
 * THE EVENT'S OWN OBJECT LITERAL, not the whole function.
 *
 * The first version of the guard below matched `\bcloseMs\b` anywhere in the body — which
 * the `const closeMs = ...` declaration and the log line satisfy on their own, so deleting
 * the field from the EVENT left the suite green. Caught by mutation; ~30th time a guard here
 * has anchored on the wrong thing.
 */
const eventLiteral = (() => {
  const from = recycleBody.indexOf("reportBotEvent('request-counts', {");
  assert.ok(from > -1, 'the event literal moved — this guard is measuring nothing');
  const to = recycleBody.indexOf('});', from);
  assert.ok(to > from, 'could not bound the event literal — this guard is measuring nothing');
  return recycleBody.slice(from, to);
})();

test('the firing carries the three facts that say what it DID', async () => {
  for (const field of ['closeMs', 'tokenKept', 'commitUsedMb']) {
    assert.match(eventLiteral, new RegExp(`(^|[{,\\s])${field}\\b`),
      `the wedge-recycle EVENT must carry ${field} — without it the log is the only record`);
  }
  assert.match(eventLiteral, /reason: 'wedge-recycle'/,
    'the durable marker must keep its exact literal — the readout matches on it');
});

test('the memory is read BEFORE the close, because after it there is nothing to read', async () => {
  const read = recycleBody.indexOf('readLatestMemory(');
  const close = recycleBody.indexOf('.close({ runBeforeUnload: false })');
  assert.ok(read > -1 && close > -1, 'anchors moved — this guard is measuring nothing');
  assert.ok(read < close,
    'the commit reading must be taken while the page still holds it; after the close it is gone');
});

test('an UNKNOWN memory reading reports itself, never a zero', async () => {
  // "we could not tell" and "the box was holding nothing" are opposite readings, and a bare
  // null renders as the second. The house rule, at the newest instrument.
  assert.match(eventLiteral, /memKnown/, 'the event must say whether the reading was known');
  assert.match(eventLiteral, /memWhy/, 'an unknown reading must carry its own reason');
  assert.match(eventLiteral, /rcMb: mem\.known === true \? \(mem\.rcMb/,
    'rcMb must be gated on the reading being KNOWN — an unattributed scan has no rc figure');
});

// ── INVERTED 2026-09-17, NOT RELAXED ─────────────────────────────────────────────────────
// This required `commitUsedMb` to be gated on `mem.known` too, and that rule is right in
// general and wrong for this one field. The two figures fail SEPARATELY: `rcMb` is the
// per-process scan, which reports UNKNOWN whenever a Chromium's command line is unreadable
// ("8 Chromium had an unreadable command line — this process may not be elevated", continuous
// on the box from 2026-09-17 04:15:30), while `commitUsedMb` is `Win32_OperatingSystem` and
// kept answering across all 17 blind samples. `readLatestMemory` refuses the WHOLE reading on
// a missing rc figure — so the old gate nulled the one number this read exists for at exactly
// the moment the other half could not supply its own. The ~32 GiB mapping is charged to
// COMMIT; without it the event cannot tell the leak from the ~7 GB baseline, which is the
// question it was added to answer.
test('commit is reported even when the rc scan is BLIND, because they fail separately', async () => {
  assert.match(eventLiteral, /commitUsedMb: Number\.isFinite/,
    'commit must be reported whenever it is a number — gating it on `known` nulls it exactly when the scan goes blind');
  assert.doesNotMatch(eventLiteral, /commitUsedMb: mem\.known/,
    'the old gate is the regression: a blind scan is unattributed memory, not an unknown box');
  // AND THE SAFETY IS IN THE READ, NOT HERE. Only the rc-blind branch carries commit at all —
  // the stale and previous-browser branches return none — so a number reported here is fresh
  // and describes this browser's lifetime. That is what makes ungating it honest rather than
  // a confident wrong figure, and it is asserted where it lives.
  const rb = readFileSync('scripts/auto-cart-bot/ramp-bail.mjs', 'utf8');
  const noRc = rb.indexOf("why: 'memory reading has no rc figure'");
  assert.ok(noRc > -1, 'the rc-blind branch moved — this guard is measuring nothing');
  assert.match(rb.slice(noRc, noRc + 220), /commitUsedMb: num\(/,
    'the rc-blind branch must carry commit, or the cure has nothing to report');
  for (const why of ['no memory reading on disk', 'memory reading unparseable', 'memory reading carries no time']) {
    const at = rb.indexOf(`why: '${why}'`);
    assert.ok(at > -1, `the ${why} branch moved — this guard is measuring nothing`);
    assert.doesNotMatch(rb.slice(at, at + 220), /commitUsedMb/,
      `${why} has no file to read a commit figure out of`);
  }
  for (const marker of ['old (max', 'predates this browser']) {
    const at = rb.indexOf(marker);
    assert.ok(at > -1, `the "${marker}" branch moved — this guard is measuring nothing`);
    assert.doesNotMatch(rb.slice(at, at + 220), /commitUsedMb/,
      `a ${marker.includes('old') ? 'stale' : 'previous-browser'} commit figure is confidently wrong, not merely unattributed`);
  }
});

test('it uses the ramp arm’s own reading, with the same notBefore', async () => {
  // A sample taken before this browser existed cannot be about this page — the 2026-09-07
  // defect, where a `ramp` dump measured the browser that REPLACED the one that ramped.
  assert.match(recycleBody, /notBefore: browserLifeSince/,
    'without notBefore this can confidently report the previous browser’s memory');
});

test('the report cannot delay the cure, and the token still goes first', async () => {
  assert.match(recycleBody, /void reportBotEvent\('request-counts'/,
    'the report must stay fire-and-forget — an awaited diagnostic delays the page close');
  const token = recycleBody.indexOf('persistLiveToken(');
  const close = recycleBody.indexOf('.close({ runBeforeUnload: false })');
  assert.ok(token > -1 && token < close,
    'the live token dies with the page, so it must be persisted before the close');
});

test('the recycle count is PASSED IN, not read after an await', async () => {
  // `wedge` is REASSIGNED on every reopen, and this function reads its arguments after two
  // awaits — so reading `wedge.recycles` there races the reopen this very close triggers.
  assert.match(kw, /recycleWedgedPage\(d\.why, d\.strikes, wedge\.recycles\)/,
    'the call site must capture strikes and recycles before any await');
  assert.doesNotMatch(recycleBody, /wedge\.recycles/,
    'reading wedge.recycles inside the async body races the reopen that the close causes');
});

// ── THE REOPEN: WHAT ACTUALLY BRINGS THE PAGE BACK ─────────────────────────────────────────
// `recycleWedgedPage`'s own header says it closes the page "precisely so that whatever the loop
// awaits rejects with 'Target closed' and the existing reopen path runs". READ AGAINST THE
// LOOP, THAT MECHANISM DOES NOT EXIST: every page-touching await in the resident loop is
// individually `.catch()`ed — `readLiveToken`, `maybeAutoLogin`, `maybeWarmupLogin`,
// `maybeRehearse`, `oktaSessionAlive` and `checkAndReport` all swallow and continue — and the
// CONTEXT is untouched by a page close, so nothing propagates out.
//
// WHAT REOPENS IS AN EXPLICIT `page.isClosed()` CHECK AT THE TOP OF THE 1-SECOND LOOP, written
// months earlier for "somebody tidying up closed the visible window". Without it the cure would
// close the page and the loop would spin for ever against a dead one: `probeResidentPage`
// returns `inconclusive` on a closed page, so NO strike accrues and the cure cannot re-fire,
// while the loop keeps advancing, so `HUNG_MS` cannot fire either. A permanent zombie, and
// strictly worse than the wedge it replaced.
//
// SO THAT CHECK IS LOAD-BEARING FOR A FEATURE IT WAS NOT WRITTEN FOR, which is the shape this
// repo records more than any other. Pinned here rather than left to be re-derived.
test('the reopen rests on an explicit isClosed() break, not on a rejection propagating', () => {
  const loop = (() => {
    const anchor = kw.indexOf('residentPage = page;');
    assert.ok(anchor > -1, 'the resident page assignment moved — this guard is measuring nothing');
    const from = kw.indexOf('for (;;) {', anchor);
    assert.ok(from > -1, 'the resident poll loop moved — this guard is measuring nothing');
    const to = kw.indexOf('\n    } catch (err) {', from);
    assert.ok(to > from, 'could not bound the resident loop — this guard is measuring nothing');
    return kw.slice(from, to);
  })();
  const closed = loop.indexOf('page.isClosed()');
  assert.ok(closed > -1,
    'the resident loop must test page.isClosed() — without it a closed page is a permanent zombie: no strike accrues and the loop keeps advancing, so neither the cure nor HUNG_MS can fire');
  // It must BREAK to the reopen. A `continue` leaves the loop spinning on the dead page, which
  // is the zombie with an extra keyword.
  assert.match(loop.slice(closed, closed + 200), /\bbreak;/,
    'the closed-page check must break out to the reopen, never continue');
  // NEAR THE TOP, AHEAD OF THE CAUGHT AWAITS. Below them it still works, but every one of them
  // would run a full iteration against a dead page first — and `readLiveToken` failing is what
  // `checkAndReport` reports as a dead SESSION.
  const firstCaught = loop.search(/\.catch\(/);
  assert.ok(firstCaught > -1, 'the caught awaits moved — this guard is measuring nothing');
  assert.ok(closed < firstCaught,
    'the closed-page check must precede the caught awaits, or a dead page is reported as a dead session first');
});

test('every page-touching await in the resident loop is caught, which is WHY the check is needed', () => {
  // This is not a style rule — it is the premise of the guard above, asserted so that the two
  // cannot drift apart. If these ever stop being caught, a rejection WOULD propagate and the
  // reopen would have a second path; the reasoning above would then need revisiting rather
  // than silently becoming wrong.
  const loop = kw.slice(kw.indexOf('for (;;) {', kw.indexOf('residentPage = page;')));
  for (const call of ['readLiveToken(page)', 'maybeAutoLogin(ctx, page)', 'checkAndReport(ctx, page)']) {
    const at = loop.indexOf(call);
    assert.ok(at > -1, `${call} moved — this guard is measuring nothing`);
    assert.match(loop.slice(at, at + 160), /\.catch\(/,
      `${call} is expected to swallow — if it no longer does, re-read the reopen guard's reasoning`);
  }
});

// THE ARM WAS SILENT ON EVERY OUTCOME BUT THE RECYCLE, WHICH MADE ITS `wedged` BRANCH
// UNFALSIFIABLE IN PRODUCTION. ~2,400 healthy probes evidenced the `alive` branch alone; a page
// that failed to answer twice and recovered wrote exactly what a page that never failed wrote.
// That is the merged-states shape, on the one branch the whole cure turns on and the one branch
// measured only in a container, on a different Chromium and a different OS.
test('a near miss and its recovery are BOTH reported, and the flag is read before it is overwritten', () => {
  const arm = (() => {
    const from = kw.indexOf('const d = wedgeDecision({');
    assert.ok(from > -1, 'the wedge arm moved — this guard is measuring nothing');
    const to = kw.indexOf('.finally(() => { wedge.inFlight = false; });', from);
    assert.ok(to > from, 'could not bound the wedge arm — this guard is measuring nothing');
    return kw.slice(from, to);
  })();

  const flag = arm.indexOf('const wasStriking = wedge.strikes > 0;');
  assert.ok(flag > -1, 'the arm must capture whether it was already striking, or a near miss cannot be told from a steady state');
  const overwrite = arm.indexOf('wedge.strikes = d.strikes;');
  assert.ok(overwrite > -1, 'the strike assignment moved — this guard is measuring nothing');
  // THE ORDERING IS THE WHOLE GUARD. Read after the assignment, `wasStriking` reflects the NEW
  // count, both gates below become vacuous, and the arm goes quiet again while looking correct.
  assert.ok(flag < overwrite,
    'wasStriking must be captured BEFORE wedge.strikes is overwritten, or both gates read the new value and report nothing');

  // ONCE PER EPISODE, NOT ONCE PER PROBE. This log rolls in ~20 minutes on two stand-down lines
  // a minute, so an arm that spoke every 10s would push the evidence out of the window it exists
  // to land in.
  assert.match(arm, /if \(d\.strikes > 0 && !wasStriking\) log\(/,
    'the entry line must be gated on NOT already striking, or it repeats every probe and buries the log');
  assert.match(arm, /wasStriking && d\.strikes === 0/,
    'the recovery line must be gated on having been striking — it is the near miss, and the only evidence of the `wedged` branch that does not need a full ramp');
});
