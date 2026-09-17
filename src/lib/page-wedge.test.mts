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
  // null in commitUsedMb renders as the second. The house rule, at the newest instrument.
  assert.match(eventLiteral, /memKnown/, 'the event must say whether the reading was known');
  assert.match(eventLiteral, /memWhy/, 'an unknown reading must carry its own reason');
  assert.match(eventLiteral, /mem\.known === true \? \(mem\.commitUsedMb/,
    'commitUsedMb must be gated on the reading being KNOWN, not merely present');
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
