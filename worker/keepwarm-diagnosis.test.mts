// Three instruments added 2026-08-17 (fourth pass), once the leak had a full history:
// twenty ramps in five days, every ~70 minutes, every one the `rc` family, ~2,400 MB/min.
//
// The containment landed first and WORKED on its very first ramp — 7 GB and 61% COMMIT
// instead of 27 GB and 99%, recycled within ~40 seconds. But the same reading settled the
// other half of the question in the unwelcome direction: **the ramp still happened on a
// browser launched without the throttling flags, so those were not the cause.** The stated
// reading rule was "no ramps at all means the flags were it; ramps that stop short mean the
// containment was", and it returned the second answer within the hour.
//
// So the leak is contained and not cured, and these three exist to close that gap:
//
//   1. A BREADCRUMB. Four wedges were recorded, each beginning at `renewing the session` and
//      ending twelve minutes later, and none said which of six awaits never returned.
//   2. HEAP FACTS over CDP, which split "JavaScript is retaining it" from "it is not the JS
//      heap at all" — the one fact that halves the candidate space.
//   3. AN AGE RECYCLE, which steps out of the renewal window rather than surviving it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const KEEPWARM = strip(readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8'));
const TOKEN = strip(readFileSync('scripts/auto-cart-bot/rc-token.mjs', 'utf8'));
const HEAP = strip(readFileSync('scripts/auto-cart-bot/rc-heap.mjs', 'utf8'));

function envDefault(code: string, name: string): number {
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

/* ── 1. THE BREADCRUMB ──────────────────────────────────────────────────────────────── */

test('marking a step does NOT reset the stall clock', () => {
  // THE WHOLE TRAP, and it would have been invisible. If `mark` touched `lastTick`, then
  // entering a step would postpone the watchdog that exists to catch a step never finishing
  // — so a loop wedged mid-renewal would look healthy for another twelve minutes and the
  // breadcrumb would have made the wedge detector WORSE while appearing to improve it.
  const markFn = /const mark = \([^)]*\) => \{([^}]*)\}/.exec(KEEPWARM);
  assert.ok(markFn, 'mark() must exist');
  assert.ok(!markFn![1].includes('lastTick'),
    'mark() must never touch lastTick — a step beginning is not the loop advancing');
  assert.match(KEEPWARM, /const tick = \(\) => \{ lastTick = Date\.now\(\); \};/,
    'tick() remains the only thing that advances the stall clock');
});

test('the wedge report names the step it was in', () => {
  const bail = KEEPWARM.slice(KEEPWARM.indexOf('const bail = ('));
  assert.match(bail.slice(0, 700), /Stalled in: \$\{step\}/,
    'the bail must print the breadcrumb — that is the entire point of collecting it');
  // Before the exit, or it is not printed at all.
  const stalledAt = bail.indexOf('Stalled in:');
  const exitAt = bail.indexOf('process.exit(1)');
  assert.ok(stalledAt > -1 && exitAt > stalledAt, 'the breadcrumb must be logged before exiting');
});

test('the renewal reports its own stages, and the caller passes a receiver', () => {
  // BOTH HALVES. `onStep` defaulting to a no-op means rc-token.mjs alone proves nothing —
  // this is the "fix present but inert" shape that has cost this repo three commits, most
  // recently the poller not passing `--claimed`.
  assert.match(TOKEN, /onStep = \(\) => \{\}/, 'renewSession must accept a step receiver');
  for (const stage of ['renew:read-token', 'renew:reload', 'renew:click-sign-in']) {
    assert.ok(TOKEN.includes(`onStep('${stage}')`), `renewSession must report ${stage}`);
  }
  assert.match(KEEPWARM, /onStep: mark,/,
    'the keep-warm must actually pass mark in, or the stages are reported to nobody');
});

test('every await in the resident loop is covered by a mark', () => {
  // A breadcrumb with holes points at the last step that DID mark, which is worse than no
  // breadcrumb: it names an innocent call with total confidence.
  const loop = KEEPWARM.slice(KEEPWARM.indexOf('async function warmResident()'));
  for (const step of [
    'auto-login', 'login rehearsal', 'reading the token', 'renewal',
    'memory scan', 'initial RC load', 'priming the token', 'idle',
  ]) {
    assert.ok(loop.includes(`mark('${step}')`), `no breadcrumb for: ${step}`);
  }
});

/* ── 2. HEAP FACTS ──────────────────────────────────────────────────────────────────── */

test('the verdict names the category, not just the numbers', () => {
  // A row of counters at the bottom of a log is a row of counters. The question is JS-versus-
  // not, so the line must answer it — the same reason the renewal prints WHICH stage minted
  // the token rather than just "renewed".
  assert.match(HEAP, /JAVASCRIPT is retaining it/);
  assert.match(HEAP, /NOT the JS heap/);
  assert.match(HEAP, /const share = jsMb \/ processMb/,
    'the split is the ratio of JS heap to PROCESS size — neither number means much alone');
});

test('a CDP call that never answers is a reading, not a crash', () => {
  // The browser is by assumption in trouble, so "it would not answer" is the likeliest
  // outcome and is itself informative. Same rule as `unknown` never rounding to `signed-out`.
  assert.match(HEAP, /no answer in \$\{ms\}ms/);
  assert.match(HEAP, /heap facts unavailable/);
  assert.ok(!/throw /.test(HEAP.slice(HEAP.indexOf('export async function collectHeapFacts'))),
    'collectHeapFacts must never throw into a setInterval where nothing catches it');
});

test('the diagnostic can never delay the exit', () => {
  // The guard's job is to save the box. A diagnostic that can hold it up has inverted the
  // priority — which is precisely the mistake `rcFamilyMb` would have made in this same arm.
  const arm = KEEPWARM.slice(KEEPWARM.indexOf('stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB'));
  const block = arm.slice(0, 1800);
  assert.match(block, /collectHeapFacts\(ctx, residentPage\)\.catch/,
    'a failed collection must not prevent the bail');
  assert.match(block, /bail\(/, 'the bail must still run afterwards');
  const cdpTimeout = envDefault(HEAP, 'RC_HEAP_CDP_TIMEOUT_MS');
  const stall = envDefault(KEEPWARM, 'RC_KEEPWARM_MEM_STALL_MS');
  assert.ok(cdpTimeout * 4 < stall,
    `every CDP step is bounded at ${cdpTimeout}ms and there are a handful — must stay well `
    + `inside the ${stall}ms stall window`);
});

test('the runaway arm cannot fire twice', () => {
  // It is async now, and the timer fires every ten seconds — without a guard a slow heap read
  // would queue a second and a third bail behind the first, each releasing the profile lock.
  assert.match(KEEPWARM, /&& !bailing\)/);
  assert.match(KEEPWARM, /bailing = true;/);
});

test('the full snapshot is opt-in and taken EARLY, never at the peak', () => {
  // A snapshot of a 25 GB heap is itself many GB, written to disk at the moment the box cannot
  // spawn a process — the cure arriving as part of the disease. The size bound trips at
  // ~1,500 MB where the file is ordinary and the growing objects are already present.
  assert.match(HEAP, /process\.env\.RC_HEAP_SNAPSHOT !== '1'/, 'off unless explicitly enabled');
  assert.match(HEAP, /snapshot exceeded/, 'and hard-capped, so it cannot fill the disk');
  const ramArm = KEEPWARM.slice(KEEPWARM.indexOf('stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB'));
  assert.ok(!ramArm.slice(0, 1800).includes('writeHeapSnapshot'),
    'the RAM-pressure arm must NEVER write a snapshot — that is the peak, not the start');
  const sizeArm = KEEPWARM.slice(KEEPWARM.indexOf('RECYCLING the browser'));
  assert.match(sizeArm.slice(0, 1500), /writeHeapSnapshot\(/,
    'the early size-bound trip is where a snapshot is affordable');
});

test('no remote debugging port is opened', () => {
  // CDP goes through Playwright's existing channel. `--remote-debugging-port` would open a
  // socket with full control of a browser holding a live ReserveCalifornia session, on a
  // machine that is routinely screen-shared, to buy a diagnostic. If Playwright's own channel
  // turns out to be jammed when we need it, that shows up as `no answer` and the port becomes
  // a decision made on evidence.
  assert.ok(!/remote-debugging-port/.test(KEEPWARM + HEAP));
  assert.match(HEAP, /ctx\.newCDPSession\(page\)/);
});

/* ── 3. THE AGE RECYCLE ─────────────────────────────────────────────────────────────── */

test('the age bound sits before the ramp window, not inside it', () => {
  // The ramps arrive ~60 min into a browser's life. Recycling at 40 steps out of the window
  // rather than surviving it — and lands every renewal in the token-less cell that is proven
  // to work, instead of the near-expiry cell where every observed wedge began.
  const age = envDefault(KEEPWARM, 'RC_KEEPWARM_MAX_AGE_MS');
  assert.ok(age <= 50 * 60_000, `${age / 60_000}m is inside the window the ramps start in`);
  assert.ok(age >= 20 * 60_000, `${age / 60_000}m churns the session for no reason`);
});

test('an unreachable feed DEFERS the recycle rather than permitting it', () => {
  // `nextRelease` is null both when there is no hold and when the server could not be asked.
  // Reading the second as the first is how an elective restart lands at 07:59. Unknown is not
  // permission — the same rule the update guard follows when it cannot reach the feed.
  assert.match(KEEPWARM, /const near = !reachable \|\|/,
    'unreachable must count as "a hold may be near"');
});

test('the elective recycle stands down near a release, and the emergency ones do not', () => {
  // This is the distinction that makes a blackout safe. The size bound and the RAM arm fire
  // only when something is already wrong, and a browser eating the box is worse for the cart
  // than a five-second reopen. The age recycle is elective, and elective work does not happen
  // at 07:59.
  assert.match(KEEPWARM, /RECYCLE_BLACKOUT_MIN/);
  const ramArm = KEEPWARM.slice(KEEPWARM.indexOf('stalledMs > MEM_STALL_MS'));
  assert.ok(!ramArm.slice(0, 1800).includes('RECYCLE_BLACKOUT_MIN'),
    'the RAM arm must not honour the blackout — a dying box outranks a pending cart');
  const sizeArm = KEEPWARM.slice(KEEPWARM.indexOf('RECYCLING the browser'), KEEPWARM.indexOf('RECYCLING the browser') + 1500);
  assert.ok(!sizeArm.includes('RECYCLE_BLACKOUT_MIN'),
    'nor the size bound');
});

test('the age check does not poll the feed once a second', () => {
  // The loop iterates every ~1s and the branch makes an HTTP call, so once the browser is past
  // its age an unrated check would be a request per second to camphawk.app for the whole
  // blackout — an hour of it.
  assert.match(KEEPWARM, /ageMs >= MAX_BROWSER_AGE_MS && Date\.now\(\) - lastAgeCheck >= AGE_CHECK_MS/);
  const gap = envDefault(KEEPWARM, 'RC_KEEPWARM_AGE_CHECK_MS');
  assert.ok(gap >= 30_000, `${gap}ms is too eager for a check that calls the server`);
});

test('the stand-down dedupes on a STATE, not on the sentence', () => {
  // The sentence carries a minute count that changes on every ask, so keying on it would
  // dedupe nothing and print a line a minute for the whole blackout. `autoLoginSkip` had
  // exactly this bug and it had to move into a tested module to be fixed.
  assert.match(KEEPWARM, /recycleSkip\(\s*\n?\s*reachable \? 'blackout' : 'feed-unreachable',/);
});

test('recycling on age reuses the existing reopen path', () => {
  // Same `break` as the closed-window and preemption paths, which run several times an hour.
  // A second teardown would be a second thing to get wrong.
  const block = KEEPWARM.slice(KEEPWARM.indexOf('recycling the browser at'));
  assert.match(block.slice(0, 500), /\bbreak;/);
  assert.ok(!/process\.exit/.test(block.slice(0, 500)));
});

test('the browser age is stamped at launch, not at process start', () => {
  // The loop reopens the context many times a day for the runner's preemption and for a closed
  // window. If the clock ran from process start, every reopen after the first forty minutes
  // would be instantly "too old" and recycle immediately — a busy loop wearing a fix's clothes.
  assert.match(KEEPWARM, /browserOpenedAt = Date\.now\(\);\n\s*ctx = await chromium\.launchPersistentContext/);
});
