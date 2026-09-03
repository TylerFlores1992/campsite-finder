// Three instruments added 2026-08-17 (fourth pass), once the leak had a full history:
// twenty ramps in five days, every ~70 minutes, every one the `rc` family, ~2,400 MB/min.
//
// A ramp at 16:45 was written up as the containment firing and working — 7 GB instead of 27,
// and therefore as proof the throttling flags were not the cause. BOTH WERE WRONG. `stop-all`
// from an `update.bat` killed that browser at 16:47:31, two minutes into the ramp; the
// keep-warm had been launched at 15:58 on a commit that predates the containment, and there is
// no `RUNAWAY` line in the log because the guard was not running. The memory series cannot
// tell a guard firing from a stop-all, and `restarts.log` is what settles it.
//
// So NONE of this is production-tested yet, the flags remain an open candidate, and the
// reading rule is unchanged: no ramps at all means the flags were it; ramps that appear and
// stop around 8-10 GB mean the containment is what worked.
//
// What the same log DID establish is the finding that matters most here: the ramp begins at
// `renewing the session — the token has 9m left (src=live)`, the near-expiry cell, which is
// the half of the 2x2 that has never been observed to succeed. The age recycle exists to
// reach every renewal from the token-less cell instead.
//
// These three exist to close the gap between contained and cured:
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
const REHEARSAL = strip(readFileSync('scripts/auto-cart-bot/rehearsal.mjs', 'utf8'));
const AUTOLOGIN = strip(readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8'));
const SAMPLE = strip(readFileSync('scripts/auto-cart-bot/memory-sample.mjs', 'utf8'));
const MEMORY = strip(readFileSync('src/lib/chromium-memory.ts', 'utf8'));
const CLIENT = strip(readFileSync('src/lib/db/client.ts', 'utf8'));

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

/**
 * THE SHARED REPORT BLOCK, SLICED BY ITS OWN BRACES rather than by a character count.
 *
 * These three guards used to slice from `stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB` and
 * keep 1800/2200/2600 characters. That anchored them to the RUNAWAY arm and to the layout
 * inside it — so when 2026-09-03 extracted the block into `reportAndBail` so the WEDGE arm
 * could report too, all three went red over behaviour that had not merely survived but
 * widened. A window measured in characters is a guess about layout; this is not.
 *
 * Anchoring here also makes them STRONGER: the block they assert about is now the one BOTH
 * arms run, so a diagnostic dropped from either is a diagnostic dropped from both.
 */
function reportBlock(): string {
  const at = KEEPWARM.indexOf('const reportAndBail = (why, tail) =>');
  assert.ok(at > -1, 'the shared report block must exist — both bail arms run it');
  const end = KEEPWARM.indexOf('\n      };', at);
  assert.ok(end > at, 'could not find the end of reportAndBail');
  return KEEPWARM.slice(at, end);
}

/**
 * The two arms, sliced from their own conditions to their OWN closing brace.
 *
 * NOT to the next `return;` — that was the first version, and a mutation restoring the old
 * synchronous wedge arm (which has no `return`) made the slice run on into the runaway arm
 * below, whose `!bailing` then satisfied an assertion about the wedge. A guard that slices
 * between two anchors is broken by anything between them, silently and in the passing
 * direction; this repo has paid for that shape more than once.
 */
function arm(cond: string): string {
  const at = KEEPWARM.indexOf(cond);
  assert.ok(at > -1, `no arm matching: ${cond}`);
  const end = KEEPWARM.indexOf('\n      }', at);
  assert.ok(end > at, `arm did not close: ${cond}`);
  const body = KEEPWARM.slice(at, end);
  // An arm is a handful of lines. A slice that has run past its own block is not an arm, and
  // saying so here beats an assertion quietly passing on a neighbour's code.
  assert.ok(body.split('\n').length < 15, `arm slice ran on (${body.split('\n').length} lines): ${cond}`);
  return body;
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
  const block = reportBlock();
  assert.match(block, /collectHeapFacts\(ctx, residentPage, heapProbe\)\.catch/,
    'a failed collection must not prevent the bail');
  assert.match(block, /bail\(tail\)/, 'the bail must still run afterwards');
  assert.match(block, /setTimeout\(r, 4000\)/,
    'the flush is raced against a bound — it must not be able to hold the profile lock open');
  const cdpTimeout = envDefault(HEAP, 'RC_HEAP_CDP_TIMEOUT_MS');
  const stall = envDefault(KEEPWARM, 'RC_KEEPWARM_MEM_STALL_MS');
  assert.ok(cdpTimeout * 4 < stall,
    `every CDP step is bounded at ${cdpTimeout}ms and there are a handful — must stay well `
    + `inside the ${stall}ms stall window`);
});

test('NEITHER bail arm can fire twice', () => {
  // Both are async now, and the timer fires every ten seconds — without a guard a slow heap
  // read would queue a second and a third bail behind the first, each releasing the profile
  // lock. The WEDGE arm needed this only from 2026-09-03: until then it called `bail`
  // synchronously, so a second tick could never reach it, and making it report first is
  // exactly what opened that window.
  assert.match(arm('stalledMs > HUNG_MS'), /&& !bailing\)/, 'the wedge arm');
  assert.match(arm('stalledMs > MEM_STALL_MS'), /&& !bailing\)/, 'the runaway arm');
  assert.match(reportBlock(), /bailing = true;/,
    'and the flag is set by the shared block, so neither arm can forget it');
});

test('BOTH bail arms report — the wedge one was missing until 2026-09-03', () => {
  /**
   * THE FIFTH MISSED RAMP, AND THE INSTRUMENT WAS BOLTED TO TWO OF THREE DOORS.
   *
   * On 2026-09-03 pid 6572 went 115 MB -> 8,743 MB and took COMMIT to 99%. It ended through
   * the WEDGE arm (`Stalled in: reporting session health`, 631s) — which called `bail`
   * directly, so `process.exit` discarded the OPEN segment that only
   * `flushAllocRamps({ final: true })` takes, and `native_alloc_readings` gained no
   * `trail-*` row. The trail was correct throughout; nothing ran it on that path.
   *
   * Same shape as `expireStaleHolds` living in a feed only a live runner polls, and as the
   * size guard checked in the body of the loop it guards against.
   */
  assert.match(arm('stalledMs > HUNG_MS'), /reportAndBail\(/,
    'a wedge must report before it exits — this is the arm a stalled loop actually reaches');
  assert.match(arm('stalledMs > MEM_STALL_MS'), /reportAndBail\(/, 'and so must a runaway');
  // The direct call is the regression, and it is what a tidy-up would reinstate.
  for (const [name, cond] of [['wedge', 'stalledMs > HUNG_MS'], ['runaway', 'stalledMs > MEM_STALL_MS']]) {
    assert.ok(!/(?<!report)[Bb]ail\(`|(?<!report)bail\('/.test(arm(cond)),
      `the ${name} arm must go through reportAndBail, never call bail directly`);
  }
});

test('the OPEN segment is taken on the way out, or a 9 GB ramp reports nothing', () => {
  // `final: true` is the entire difference between the ordinary tick (ENDED segments only,
  // because a renderer swap has happened and the peak is known) and an exit. A process that
  // exits is one of the two ways a ramp ends without our ever seeing the swap.
  assert.match(reportBlock(), /flushAllocRamps\(\{ final: true \}\)/,
    'the shared block must flush the open segment');
  assert.match(reportBlock(), /await Promise\.race\(\[/,
    'and AWAIT it — process.exit kills a fire-and-forget POST, losing the reading');
});

test('the profile lock is released AFTER the report, not before it', () => {
  /**
   * DELIBERATE, AND THE OPPOSITE LOOKS LIKE CAUTION. Releasing early would get the hold
   * runner onto the profile sooner — and our browser stays open until `process.exit`, so the
   * runner would launch a SECOND Chromium on one `user-data-dir`. That is the corruption case
   * the lock exists to prevent, and it would be bought for a few seconds of a stall already
   * twelve minutes old.
   */
  const block = reportBlock();
  assert.ok(!block.includes('releaseProfileLockIfMine'),
    'the report must not release the lock — `bail` does that, last');
  const bail = KEEPWARM.slice(KEEPWARM.indexOf('const bail = (why) =>'));
  const release = bail.indexOf('releaseProfileLockIfMine');
  const exit = bail.indexOf('process.exit(1)');
  assert.ok(release > -1 && exit > release, 'bail releases the lock immediately before exiting');
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

/* ── 3. THE AGE RECYCLE — BUILT, MEASURED, AND REMOVED ─────────────────────────────── */

/**
 * IT FIRED CORRECTLY AND IT DID NOTHING, and the rationale behind it was false.
 *
 * The argument was: recycling at 40 minutes lands every renewal in the token-less cell, which
 * is the half of the 2x2 that works. The first firing showed the premise is wrong —
 * localStorage survives a browser restart, so the recycled browser came straight back holding
 * a live token:
 *
 *     02:36:27 recycling the browser at 40m old ...
 *     02:36:32 RC loaded and STAYING OPEN - token source: live
 *     02:36:34 RC session kept warm - token exp in 32m; src=live
 *     02:58:44 renewing the session - the token has 10m left (src=live)   <- same cell as ever
 *     03:00:24 RUNAWAY ... Stalled in: renew:click-sign-in
 *
 * So it changed neither the cell nor the timing, and cost a browser restart every forty
 * minutes. That is not free: restarts have side effects, and one of them turned the login
 * rehearsal red the same night.
 *
 * The related question is settled by the same data. The resident tab was suspected of being
 * the problem and it is not: the browser sits flat at 200-330 MB for the best part of an hour
 * and only ramps DURING the renewal. Parking it on about:blank would target the measured-
 * innocent part and add a page load per poll from an IP that has eaten a 12-hour block.
 * Leave it alone.
 */
test('the age recycle is gone, and does not come back without new evidence', () => {
  for (const token of ['MAX_BROWSER_AGE_MS', 'browserOpenedAt', 'RECYCLE_BLACKOUT_MIN']) {
    assert.ok(!KEEPWARM.includes(token),
      `${token} is back — the measured result was that it changes neither the renewal cell `
      + 'nor the timing, because localStorage survives a browser restart');
  }
});

test('the guards that DO work are still there', () => {
  // Removing the elective recycle must not take the two proven arms with it. The RAM arm is
  // the one with a log line behind it; the size bound is the early, cheap one.
  assert.match(KEEPWARM, /stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB/);
  assert.match(KEEPWARM, /mb != null && mb > RC_MAX_FAMILY_MB/);
});

/* ── 4. AFTERMATH OF THE FIRST REAL FIRING ─────────────────────────────────────────── */

test('the CDP probe is attached at LAUNCH, not negotiated at the trip', () => {
  // The first real firing produced `heap facts unavailable (newCDPSession: no answer in
  // 3000ms)`. Creating a session needs the browser to negotiate a target attachment, and a
  // browser eating the machine will not. Sending one command down an existing socket is a far
  // smaller ask.
  assert.match(HEAP, /export async function attachHeapProbe/);
  const open = KEEPWARM.indexOf('attachHeapProbe(ctx, page)');
  const prime = KEEPWARM.indexOf("mark('priming the token')");
  assert.ok(open > -1 && prime > open, 'the probe must be attached during the healthy open');
  assert.match(KEEPWARM, /collectHeapFacts\(ctx, residentPage, heapProbe\)/,
    'and actually passed at the trip, or attaching it early changes nothing');
});

test('the long-lived probe is never detached by a caller that borrowed it', () => {
  // Detaching the shared session after one trip would silently restore the bug: the second
  // firing would find nothing and be back to negotiating against an unresponsive browser.
  assert.match(HEAP, /if \(borrowed\) await within\(cdp\.detach\(\)/);
});

test('a rehearsal does not run straight after a runaway kill', () => {
  // Ours killed a browser at 03:00:24; the rehearsal fired 24 seconds later against a box
  // still recovering, got "We're having trouble loading the application", and reported THE
  // UNATTENDED LOGIN IS BROKEN with a real hold twelve hours out. It spends the once-per-20h
  // budget and points a human at the box over a system that is working.
  assert.match(REHEARSAL, /minutesSinceAbnormalExit != null && minutesSinceAbnormalExit < REHEARSAL_QUIET_AFTER_RESTART_MIN/);
  // NULL MUST NOT GATE. No marker is the ordinary case on a box that has never had a runaway,
  // and treating it as "recently killed" would switch the rehearsal off for ever.
  assert.match(REHEARSAL, /minutesSinceAbnormalExit != null &&/);
  // BOTH HALVES: the bail must write the marker and the caller must read it in.
  assert.match(KEEPWARM, /fs\.writeFileSync\(ABNORMAL_EXIT_MARKER/);
  assert.match(KEEPWARM, /minutesSinceAbnormalExit: minutesSinceAbnormalExit\(\)/);
});

test("RC's app failing to load is INCONCLUSIVE, not a broken login", () => {
  // No sign-in link on a page that never rendered means "we could not ask", not "the answer is
  // no" — the same rule as the 2026-08-09 banner trap and the rehearsal's provedNothing.
  // It stays loud in the log (it is also the 08-14 blank-page signature); only the severity
  // changes.
  assert.match(AUTOLOGIN, /trouble loading the application\|check your connection/);
  const branch = AUTOLOGIN.slice(AUTOLOGIN.indexOf('trouble loading the application'));
  assert.match(branch.slice(0, 400), /provedNothing: true/);
  // ONE reading of the page for both the decision and the message — withBanner re-queries the
  // DOM on every call, so asking twice could classify on one answer and report another.
  assert.match(AUTOLOGIN, /const said = await withBanner\(link/);
});

/* ── 5. THE HEAP TRAIL: ASK WHILE IT CAN STILL ANSWER ──────────────────────────────── */

/**
 * Two firings, two different CDP failures, and together they close off asking at the trip:
 *
 *     03:00:24  heap facts unavailable (newCDPSession: no answer in 3000ms)
 *     04:05:54  heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
 *
 * Attaching at launch fixed the first. The second proves the browser will not answer a command
 * down an EXISTING socket either, so no timeout worth spending changes the outcome. The
 * reading has to be taken BEFORE the browser goes quiet, which means a series rather than an
 * observation — the same lesson as the memory sampler that produced this whole investigation.
 */

test('the trail is sampled from the TIMER, not the loop', () => {
  // Same argument as the guard itself: the loop is stalled during exactly the window whose
  // readings are worth having, so a sampler living there would capture nothing.
  const timer = KEEPWARM.slice(KEEPWARM.indexOf('const renew = setInterval('));
  const body = timer.slice(0, timer.indexOf('}, WATCHDOG_MS);'));
  assert.match(body, /sampleHeap\(heapProbe\)/, 'the trail must be sampled inside the watchdog tick');
});

test('sampling never blocks the watchdog, and never piles up', () => {
  // The timer must not await: the guard's whole value is that it keeps running. And once the
  // browser stops answering, every attempt costs its full timeout — without an in-flight flag
  // those would accumulate one per tick, against a browser already in trouble.
  const timer = KEEPWARM.slice(KEEPWARM.indexOf('const renew = setInterval('));
  const body = timer.slice(0, timer.indexOf('}, WATCHDOG_MS);'));
  assert.match(body, /void sampleHeap\(/, 'must be fire-and-forget');
  assert.ok(!/await sampleHeap/.test(body), 'awaiting it would stall the watchdog itself');
  assert.match(body, /!heapInFlight && heapProbe/, 'overlapping samples must be prevented');
  assert.match(body, /finally\(\(\) => \{ heapInFlight = false; \}\)/,
    'and the flag must clear on failure too, or one timeout ends sampling for ever');
});

test('the trail is bounded and printed at the trip', () => {
  assert.match(KEEPWARM, /\.slice\(-TRAIL_KEEP\)/, 'the buffer must be bounded');
  assert.match(reportBlock(), /describeTrail\(heapTrail, Date\.now\(\)\)/,
    'the trip must print the trail — it is the reading that actually arrives');
});

test('an empty trail says so rather than printing nothing', () => {
  // "The browser answered no CDP call at all" and "the JS heap was flat" are different facts,
  // and a blank line would merge them. Same rule as `unknown` never rounding to a verdict.
  assert.match(HEAP, /heap trail: EMPTY/);
  assert.match(HEAP, /if \(!samples \|\| !samples\.length\)/);
});

test('a trail sample is cheaper than a trip-time reading', () => {
  // It runs on a ten-second timer, so a slow answer is not worth waiting for — there will be
  // another along shortly, and an attempt outliving its own tick would overlap the next.
  const trail = Number(/RC_HEAP_TRAIL_TIMEOUT_MS \|\| ([\d_]+)/.exec(HEAP)?.[1]?.replace(/_/g, ''));
  const trip = envDefault(HEAP, 'RC_HEAP_CDP_TIMEOUT_MS');
  assert.ok(trail > 0 && trail < trip, `trail ${trail}ms must be tighter than the trip's ${trip}ms`);
  const tick = envDefault(KEEPWARM, 'RC_KEEPWARM_WATCHDOG_MS');
  assert.ok(trail < tick, 'a sample must not outlive the tick that started it');
});

/* ── 6. TIMING THE ONSET, AND NAMING THE PROCESS ───────────────────────────────────── */

/**
 * The heap trail answered "is it the JS heap?" — 16 MB, flat, twelve identical samples, while
 * the process reached 4,903 MB. It cannot answer the two questions that follow, for one shared
 * reason: it stops the instant the ramp begins, because CDP goes unanswerable.
 *
 *   WHEN does the ramp start?  -> `os.freemem()` is a syscall and never stops answering.
 *   WHICH process is growing?  -> the periodic PowerShell scan already reads the command line.
 */

test('the RAM trail records the STEP, not just the number', () => {
  // The step is the entire point. Three firings stalled in renew:click-sign-in, but memory rose
  // across the reload, the prime AND the click — so the click is where it was caught, not where
  // it is proven to allocate, and those have different fixes.
  assert.match(KEEPWARM, /ramTrail = \[\.\.\.ramTrail, \{ at: Date\.now\(\), freeMb: Math\.round\(freeMb\), step \}\]/);
  assert.match(KEEPWARM, /\.slice\(-TRAIL_KEEP\)/, 'and stays bounded');
});

test('the RAM trail is recorded on every tick, healthy ones included', () => {
  // The sample before the ramp is what gives the one during it a baseline to be a change from.
  // Recording only under pressure would produce a series with no "before".
  const timer = KEEPWARM.slice(KEEPWARM.indexOf('const renew = setInterval('));
  const body = timer.slice(0, timer.indexOf('}, WATCHDOG_MS);'));
  const at = body.indexOf('ramTrail = [...ramTrail');
  const guard = body.indexOf('stalledMs > MEM_STALL_MS');
  assert.ok(at > -1 && guard > at, 'the trail must be appended before the guard can exit');
});

test('a collapsed RAM group shows its change, oldest to newest', () => {
  // The first version overwrote the value as it walked, so a group printed the OLDEST reading
  // against the NEWEST timestamp - reversing the direction of travel on the one line whose job
  // is showing memory fall. Caught by rendering a fixture and reading it.
  assert.match(HEAP, /last\.oldestMb = s\.freeMb/);
  assert.match(HEAP, /\$\{p\.oldestMb\}→\$\{p\.newestMb\}/);
});

test('both trails are printed at the trip', () => {
  const block = reportBlock();
  assert.match(block, /describeTrail\(heapTrail/, 'the heap trail');
  assert.match(block, /describeRamTrail\(ramTrail/, 'and the one that spans the event');
});

test('the scan reads the process type, and the browser is not "unknown"', () => {
  // browser | renderer | gpu-process | utility are four different investigations. The PARENT
  // carries no --type at all, so an absent flag identifies it rather than defeating the check.
  assert.match(SAMPLE, /--type=\(\[a-zA-Z-\]\+\)/);
  assert.match(SAMPLE, /\$ty = 'browser'/, "no --type means the parent, never null");
});

test('the type is emitted BEFORE the directory', () => {
  // The directory is a path that may contain `|` and is therefore joined from the remainder by
  // the parser. A field appended after it would be swallowed by that join.
  assert.match(SAMPLE, /'P\|\{0\}\|\{1\}\|\{2\}\|\{3\}' -f \$o\.ProcessId, \$mb, \$ty, \$dir/);
});

test('a box on the OLD build still parses correctly', () => {
  // The update takes as long as it takes, and during it this parser sees four-field lines. Read
  // as the new shape they would put the directory in the type slot and classify every process
  // as `other`, silently emptying the family under investigation.
  assert.match(SAMPLE, /const hasType = parts\.length >= 5/);
  assert.match(SAMPLE, /parts\.slice\(hasType \? 4 : 3\)/);
});

test('per-type totals are kept, not just the biggest process', () => {
  // The last three ramps put only 3,052 MB of 4,903 in the biggest process, so naming only that
  // describes under two thirds of the growth.
  assert.match(SAMPLE, /out\.rcByType\[type\] = \(out\.rcByType\[type\] \?\? 0\) \+ mb/);
  assert.match(MEMORY, /rc_by_type/);
});

test('the type crosses the network through an allow-list', () => {
  // It arrives from the box and is rendered on the admin page, so it is not stored verbatim.
  // An unrecognised value stores null - "not reported" - which the readout prints as a gap.
  assert.match(MEMORY, /const PROCESS_TYPES = new Set\(\[/);
  assert.match(MEMORY, /PROCESS_TYPES\.has\(sample\.maxType\) \? sample\.maxType : null/);
  // An empty map must store null rather than {} - "we looked and every type was zero" is a
  // measurement nobody took. Same rule the family counts had to be taught.
  assert.match(MEMORY, /return Object\.keys\(out\)\.length \? JSON\.stringify\(out\) : null;/);
});

/* ── 7. THE JSONB THAT KILLED THE SERIES (2026-08-18) ──────────────────────────────── */

/**
 * `rc_by_type` shipped as a jsonb column with a plain JS object handed to `mutate`. `sqlit`
 * INTERPOLATES rather than binds, and its fallback is `String(val)` — so the object became the
 * literal `'[object Object]'`, Postgres rejected it, the whole INSERT threw, and
 * `recordMemorySample`'s catch turned that into silence.
 *
 * The cost was not the missing column. **No sample was stored at all** for ten minutes — the
 * instrument this entire leak investigation runs on, switched off by one unstringified
 * argument, with nothing anywhere reporting it. It was found only because a reading that should
 * have arrived did not.
 *
 * Two guards, because the call site and the class of bug are different problems.
 */

test('the per-type map is stringified and cast, never passed as an object', () => {
  assert.match(MEMORY, /JSON\.stringify\(out\) : null/,
    'rcByType must hand mutate a string');
  assert.match(MEMORY, /\$15::jsonb/,
    'and the SQL must cast it, so the column type is never inferred from a bare literal');
});

test('sqlit REFUSES a plain object rather than stringifying it', () => {
  // The systemic half. `[object Object]` is either a rejected statement or corrupt data written
  // without complaint, and neither is ever what a caller wanted. Throwing surfaces an existing
  // bug rather than creating one — nobody can have been relying on that literal.
  assert.match(CLIENT, /sqlit: refusing to interpolate a plain object/);
  // THE CONDITION, NOT JUST THE MESSAGE. The first version asserted only that the string was
  // present and correctly positioned — so replacing the test with `if (false)` left both true
  // and the mutation passed against a sqlit that stringified objects exactly as before. Same
  // trap as the power-cycle guard that pinned the hold query but not the comparison deciding
  // on it. Twelfth time a guard here has anchored on the wrong thing.
  assert.match(CLIENT, /if \(typeof val === 'object'\) \{/,
    'the type test itself must be live, not merely the message it would print');
  const fn = CLIENT.slice(CLIENT.indexOf('export function sqlit'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const throwAt = body.indexOf('refusing to interpolate');
  const fallbackAt = body.indexOf('String(val).replace');
  assert.ok(throwAt > -1 && fallbackAt > throwAt,
    'the refusal must come BEFORE the String() fallback, or it can never run');
  // Arrays and Dates have real encodings and must still work.
  assert.ok(body.indexOf('Array.isArray(val)') < throwAt, 'arrays keep their ARRAY[...] form');
  assert.ok(body.indexOf('val instanceof Date') < throwAt, 'dates keep their ISO form');
});
