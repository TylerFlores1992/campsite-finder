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

test('the timings are bounded from both sides', async () => {
  // Long enough that a busy-but-healthy page answers; short enough that three of them is far
  // inside the 120s the cheapest existing arm needs.
  assert.ok(WEDGE_PROBE_TIMEOUT_MS >= 500 && WEDGE_PROBE_TIMEOUT_MS <= 5_000);
  assert.ok(WEDGE_PROBE_EVERY_MS >= 2_000 && WEDGE_PROBE_EVERY_MS <= 30_000);
  assert.ok(
    WEDGE_STRIKES * WEDGE_PROBE_EVERY_MS < 120_000,
    'this arm must act sooner than the ramp arm or it buys nothing',
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
