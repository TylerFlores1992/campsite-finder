/**
 * THE CHROMIUM MEMORY SERIES — the parts that decide what gets believed.
 *
 * Migration 059 exists because attributing the leak has been attempted three times by hand and
 * failed three times, and the 2026-08-14 attempt failed in the most instructive way: it
 * returned a clean, confident, NEGATIVE growth rate having sampled zero processes of the family
 * that was never ruled out. `keepSessionsWarm` opens a rec.gov Chromium every thirty minutes
 * and closes it; a five-minute window has about one chance in ten of containing one.
 *
 * So the failure mode being guarded here is not "the arithmetic is wrong". It is "the readout
 * produces a number that reads as a measurement when the data could not support one" — the
 * same shape as `status = 'sent'` meaning only "Twilio returned 2xx", and as the family rollup
 * printing `rc 0 MB` over a profile holding 312 MB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyProfile, parseSample, createSampler, takeSample, SAMPLE_EVERY_MS,
} from '../scripts/auto-cart-bot/memory-sample.mjs';
import {
  readMemoryVerdict, MIN_COMPARABLE_PAIRS, LEAK_MB_PER_MIN, BIG_PROCESS_MB,
  type MemorySampleRow,
} from '../src/lib/chromium-memory';

const RC = String.raw`C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\.rc-bot-profile`;
const RECGOV = String.raw`C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\profiles\user_42`;

/** Build a row with sensible defaults, overriding only what the case is about. */
function row(over: Partial<MemorySampleRow> & { taken_at: string }): MemorySampleRow {
  return {
    source: 'bot',
    commit_used_mb: 9000, commit_limit_mb: 57700, ram_free_mb: 8000,
    rc_procs: 8, rc_mb: 300, recgov_procs: 0, recgov_mb: 0, other_procs: 0, other_mb: 0,
    max_pid: 100, max_mb: 100, max_family: 'rc',
    ...over,
  };
}

/** n samples two minutes apart, from a fixed start. */
const at = (i: number) => new Date(Date.UTC(2026, 7, 14, 12, 0, 0) + i * 2 * 60_000).toISOString();

/**
 * "Now" for a case that is NOT about the series having stopped — one minute after its last
 * sample, i.e. a series that is still running.
 *
 * PINNED RATHER THAN LEFT TO `Date.now()`. The fixtures carry fixed 2026-08-14 dates, so a
 * default of the real clock would make every one of these a series that stopped months ago,
 * and each test would then be asserting against a verdict with the trailing-gap sentence
 * stapled to it — passing today, for a reason that has nothing to do with what it checks, and
 * drifting as the wall clock moves. That is the `sync-claim` flake shape, bought cheaply.
 */
const justAfter = (rows: MemorySampleRow[]) =>
  Date.parse(rows[rows.length - 1]!.taken_at) + 60_000;

test('the family classifier puts the RC profile in rc, not rec.gov', () => {
  // ORDER IS THE BUG. `.rc-bot-profile` lives INSIDE the directory the rec.gov test matches,
  // so a classifier that checks `auto-cart-bot` first files every RC process under rec.gov —
  // which is exactly the misattribution made twice by hand.
  assert.equal(classifyProfile(RC), 'rc');
  assert.equal(classifyProfile(RECGOV), 'recgov');
  assert.equal(classifyProfile(String.raw`C:\Users\Tyler\AppData\Local\Google\Chrome\User Data`), 'other');
  assert.equal(classifyProfile(''), 'other');
});

test('the JS classifier agrees with the PowerShell one in bot-commands.mjs', () => {
  // TWO IMPLEMENTATIONS OF ONE RULE IS TWO CHANCES TO FIX ONE AND FORGET THE OTHER, and the
  // forgotten copy is by definition the one running when it matters. The `memory` command
  // classifies in PowerShell for a human to read; the sampler classifies in JS for the series.
  // They must not be able to disagree about which family a path belongs to.
  const bot = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
  const line = bot.split('\n').find((l) => /fam = 'rc'/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(line, 'could not find the PowerShell family classifier');
  const rcFirst = line!.indexOf("fam = 'rc'");
  const recgovAt = line!.indexOf("fam = 'recgov'");
  assert.ok(rcFirst >= 0 && recgovAt > rcFirst,
    'PowerShell must also test the specific profile first');
  // And the two patterns it branches on are the two this module uses.
  assert.match(line!, /\\\\\.rc-bot-profile/, 'PowerShell branches on .rc-bot-profile');
  assert.match(line!, /auto-cart-bot/, 'and on auto-cart-bot for rec.gov');
});

test('parseSample totals per family and names the largest process', () => {
  const s = parseSample([
    'M|9000|57700|8000',
    `P|2976|44|${RC}`,
    `P|10820|114|"${RC}"`, // Chrome re-quotes the path for its children
    `P|4242|900|${RECGOV}`,
  ].join('\n'));

  assert.equal(s.commitUsedMb, 9000);
  assert.equal(s.commitLimitMb, 57700);
  // THE QUOTED CHILD MUST LAND IN THE SAME FAMILY as the unquoted parent. Left in, one
  // profile classifies and groups as two — the same quoting difference that hid the orphaned
  // Chrome children behind `[^"]*` and cost a night to the blank RC page.
  assert.equal(s.rcProcs, 2);
  assert.equal(s.rcMb, 158);
  assert.equal(s.recgovProcs, 1);
  assert.equal(s.recgovMb, 900);
  assert.equal(s.maxPid, 4242);
  assert.equal(s.maxFamily, 'recgov');
});

test('parseSample reports nulls, never zeros, when it did not find out', () => {
  // A PLAUSIBLE ZERO IS WORSE THAN A BLANK. `rc 0 MB` reads as "the RC profile is innocent";
  // that is what the broken rollup printed for weeks over a profile holding 312 MB. Zero
  // commit is a reading nobody could ever take.
  const s = parseSample('');
  assert.equal(s.commitUsedMb, null);
  assert.equal(s.commitLimitMb, null);
  assert.equal(s.maxPid, null);
  assert.equal(s.maxMb, null);
});

test('the sampler throttles, and a failure never escapes it', async () => {
  let now = 0;
  let taken = 0;
  const posted: unknown[] = [];
  const sample = createSampler({
    now: () => now,
    take: async () => { taken++; return parseSample(`M|1|2|3\nP|1|5|${RC}`); },
    post: async (s) => { posted.push(s); },
  });

  assert.equal(await sample(), true);
  now += SAMPLE_EVERY_MS - 1;
  assert.equal(await sample(), false, 'inside the interval it must not sample again');
  now += 2;
  assert.equal(await sample(), true);
  assert.equal(taken, 2);
  assert.equal(posted.length, 2);

  // A measurement must never break the thing it measures. This rides bot.mjs's 2s tick, which
  // is the loop that carts campsites.
  const boom = createSampler({
    now: () => 0,
    take: async () => { throw new Error('powershell is gone'); },
    post: async () => {},
  });
  assert.equal(await boom(), false, 'it must swallow the failure, not throw into the tick');
});

/**
 * THE FORCED SAMPLE, AND WHY EACH PROPERTY IS PINNED (2026-08-15).
 *
 * The interval cannot measure the rec.gov keepalive family: those browsers live a few
 * seconds, twice per thirty minutes, so 175 consecutive samples read `recgov 0` and that is
 * the EXPECTED reading rather than a lead. `keepSessionsWarm` therefore asks for a sample
 * while its own browser is open. Every assertion below is a way that fix could be present
 * and inert — the shape that has already cost this repo two commits (`6006428` changed only
 * the copy; the `--claimed` fix was never passed by its caller).
 */
test('the forced sample bypasses the throttle and carries its own source', async () => {
  let now = 0;
  const posted: Array<string | undefined> = [];
  const sample = createSampler({
    now: () => now,
    take: async () => parseSample(`M|1|2|3\nP|1|5|${RC}`),
    post: async (_s: unknown, source?: string) => { posted.push(source); },
  });

  assert.equal(await sample(), true, 'the first periodic sample');
  // Well inside SAMPLE_EVERY_MS: the periodic path must refuse, the forced path must not.
  now += 1000;
  assert.equal(await sample(), false, 'the interval still applies to periodic samples');
  assert.equal(await sample({ force: true, source: 'bot-keepalive' }), true,
    'a forced sample must ignore the interval, or it measures the family it exists for never');
  assert.deepEqual(posted, [undefined, 'bot-keepalive'],
    'the source must reach post(), or a forced reading is indistinguishable from the series');
});

test('a forced sample does NOT reset the interval clock', async () => {
  // If it did, a keepalive would silently push the periodic series out by two minutes twice
  // an hour — and the periodic sample landing just after a forced one is the ONLY way this
  // instrument ever pairs two readings of a keepalive browser, which happens exactly when
  // that browser failed to close. Resetting the clock would delete the runaway case.
  let now = 0;
  let taken = 0;
  const sample = createSampler({
    now: () => now,
    take: async () => { taken++; return parseSample(`M|1|2|3\nP|1|5|${RC}`); },
    post: async () => {},
  });
  assert.equal(await sample(), true);
  now += SAMPLE_EVERY_MS - 1;
  assert.equal(await sample({ force: true, source: 'bot-keepalive' }), true);
  now += 2; // now past the interval measured from the PERIODIC sample, not the forced one
  assert.equal(await sample(), true, 'the forced sample must not have moved the interval');
  assert.equal(taken, 3);
});

test('a forced sample that is lost to an in-flight read says so', async () => {
  // The interval can afford a skipped tick. A forced one is the only sighting of a
  // five-second browser, and a silent miss reads as "the family was not running" — the exact
  // ambiguity the C| line was added to remove one level down.
  const logs: string[] = [];
  // Held on an object, not in a `let`: control-flow analysis narrows a `let` initialised to
  // null and never sees the assignment made inside the promise executor, so calling it back
  // is a type error on a value that is provably set.
  const held: { release?: () => void } = {};
  const sample = createSampler({
    now: () => 0,
    log: (m: string) => logs.push(m),
    take: () => new Promise((res) => { held.release = () => res(parseSample(`M|1|2|3`)); }),
    post: async () => {},
  });
  const first = sample();                       // parks in flight
  const lost = await sample({ force: true, source: 'bot-keepalive' });
  assert.equal(lost, false);
  assert.ok(logs.some((l) => /keepalive not sampled/i.test(l)),
    'a lost forced sample must be audible');
  held.release?.();
  await first;
});

test('keepSessionsWarm actually takes the forced sample, INSIDE the browser block', () => {
  // The fix is worthless if it is not called, and worse than worthless if it is called after
  // the context closes: the scan runs in a separate PowerShell process, so an unawaited or
  // late sample measures a browser that no longer exists — precisely the thing it was added
  // to see.
  const bot = readFileSync('scripts/auto-cart-bot/bot.mjs', 'utf8');
  const call = /await\s+sampleMemory\(\{[^}]*force:\s*true[^}]*source:\s*'bot-keepalive'[^}]*\}\)/;
  assert.match(bot, call, 'bot.mjs must AWAIT a forced, sourced sample');

  // It must sit between opening the browser and returning from the callback.
  const block = bot.slice(bot.indexOf('const state = await withBrowser('));
  const end = block.indexOf('{ headless: false }');
  assert.ok(end > 0, 'could not find the keepalive withBrowser block');
  assert.match(block.slice(0, end), call,
    'the forced sample must be inside the keepalive withBrowser callback, while the browser is open');

  // And the source must survive the post() closure — bound as a constant 'bot', every forced
  // reading would land in the series it is meant to be told apart from.
  assert.match(bot, /post:\s*\(memory,\s*source\s*=\s*'bot'\)\s*=>\s*reportControl\(\{\s*memory,\s*source\s*\}\)/,
    "bot.mjs's post() must forward the source rather than hard-coding 'bot'");
});

test('a verdict is refused until enough pairs can actually be compared', () => {
  // Same discipline as MIN_RENEWAL_TESTS: rows fetched is not evidence gathered.
  const rows = Array.from({ length: 4 }, (_, i) => row({ taken_at: at(i) }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(v.enough, false);
  assert.match(v.verdict, /NOT ENOUGH DATA/);
  assert.ok(v.comparablePairs < MIN_COMPARABLE_PAIRS);
});

test('a family that never appeared is reported as unobserved, not as clean', () => {
  // THE 2026-08-14 FAILURE, EXACTLY. Every process sampled was on the RC profile, no rec.gov
  // browser existed at any point, and the result was read as evidence about the leak. It could
  // not be. A family with no processes has been ruled out of nothing.
  const rows = Array.from({ length: 20 }, (_, i) => row({ taken_at: at(i) }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.deepEqual(v.familiesSeen, ['rc']);
  assert.ok(!v.familiesSeen.includes('recgov'));
});

test('growth is only counted between two samples of the SAME process', () => {
  /**
   * THE TRAP THIS EXISTS FOR. rec.gov browsers open and close every thirty minutes, so a
   * family total going 0 MB -> 900 MB is usually a browser that did not exist in the first
   * sample, not a browser that grew. Subtracting those two is not a rate, it is a coincidence
   * with units on it — and it would report a leak on every single keepalive pass, for ever.
   */
  const rows = [
    row({ taken_at: at(0), max_pid: 111, max_mb: 40, max_family: 'recgov' }),
    // A DIFFERENT pid: a new browser, not growth. Must contribute no rate at all.
    row({ taken_at: at(1), max_pid: 222, max_mb: 4000, max_family: 'recgov' }),
  ];
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(v.comparablePairs, 0, 'two different processes are not a pair');
  assert.equal(v.worst, null, 'and must produce no growth finding');
});

test('a real climb on one pid is found, named, and called a leak', () => {
  // The 08-12 shape: ONE process, hundreds of MB per minute. The family is the answer the
  // whole exercise is for, so it must come back attributed.
  const rows = Array.from({ length: 12 }, (_, i) => row({
    taken_at: at(i),
    recgov_procs: 1,
    recgov_mb: 500 + i * 800,
    max_pid: 4242,
    max_mb: 500 + i * 800,
    max_family: 'recgov',
  }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(v.enough, true);
  assert.ok(v.worst, 'a climb this steep must be found');
  assert.equal(v.worst!.family, 'recgov');
  assert.equal(v.worst!.pid, 4242);
  assert.equal(Math.round(v.worst!.mbPerMin), 400);
  assert.ok(v.worst!.mbPerMin >= LEAK_MB_PER_MIN);
  assert.match(v.verdict, /LEAK OBSERVED/);
  assert.match(v.verdict, /recgov/, 'the verdict must name the family — that is the question');
});

test('a quiet window is never reported as "there is no leak"', () => {
  // It did not reproduce on 2026-08-14, and the standing instruction in the handover is that
  // "no leak observed" must not be read as "no leak". The readout is the thing most likely to
  // be quoted later, so it has to say so itself.
  const rows = Array.from({ length: 20 }, (_, i) => row({
    taken_at: at(i), max_pid: 100, max_mb: 300 - i, // flat-to-shrinking, like the real reading
  }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(v.enough, true);
  assert.match(v.verdict, /NO LEAK IN THIS WINDOW/);
  assert.match(v.verdict, /does NOT mean there is no leak/);
});

test('a hole in the series is measured, because that is where a crash looks like nothing', () => {
  // Taking a sample spawns PowerShell, and spawning is exactly what fails at 99% commit — the
  // supervise.ps1 failure IS this failure. So the samples nearest the crash are the ones most
  // likely to be missing, and the series ends rather than peaking.
  const rows = [
    row({ taken_at: at(0) }),
    row({ taken_at: new Date(Date.parse(at(0)) + 47 * 60_000).toISOString() }),
  ];
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(Math.round(v.worstGapMin), 47);
});

/**
 * ── THE GAP AT THE END ──────────────────────────────────────────────────────────────────────
 * `worstGapMin` measures the longest hole BETWEEN two samples, and for a while that was the
 * whole gap story. It missed the one shape this table was built to catch.
 *
 * Sampling spawns PowerShell, and spawning is exactly what fails at 99% commit — the
 * `supervise.ps1` failure IS this failure. So the box does not record a peak and then recover:
 * THE SERIES STOPS. And a series that stops has no internal gap at all, so a box that died
 * mid-ramp at 03:00 and a box sitting quietly idle produced the identical
 * `NO LEAK IN THIS WINDOW` — a failure and a success printing the same thing, in the very
 * instrument built to tell them apart.
 */
test('a series that STOPS is reported as stopped, not as a quiet window', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row({
    taken_at: at(i), max_pid: 100, max_mb: 300, commit_used_mb: 52000, // 90% of 57700
  }));
  // Three hours after the last sample: the box went silent and never came back.
  const v = readMemoryVerdict(rows, { now: Date.parse(at(19)) + 180 * 60_000 });

  assert.equal(v.seriesEnded, true);
  assert.equal(Math.round(v.lastSampleAgeMin!), 180);
  assert.equal(Math.round(v.lastCommitPct!), 90);
  // There is NO internal gap here — every sample is two minutes apart. That is the point: the
  // old worstGapMin could not see this at all.
  assert.equal(Math.round(v.worstGapMin), 2);
  assert.match(v.verdict, /THE SERIES HAS STOPPED/);
  assert.match(v.verdict, /what the crash looks like/);
});

test('a series that stops at NORMAL commit is not called a crash', () => {
  // DO NOT CRY WOLF. A box switched off, a bot stopped for an update and a crash all end the
  // series; only the commit figure tells them apart. Every alarm in this log that was not
  // carefully justified cried wolf, and the cost is that the next real one gets skimmed.
  const rows = Array.from({ length: 20 }, (_, i) => row({
    taken_at: at(i), commit_used_mb: 9000, // ~16%, the healthy 08-14 reading
  }));
  const v = readMemoryVerdict(rows, { now: Date.parse(at(19)) + 180 * 60_000 });

  assert.equal(v.seriesEnded, true);
  assert.match(v.verdict, /THE SERIES HAS STOPPED/);
  assert.match(v.verdict, /likelier cause is the bot being stopped/);
  assert.doesNotMatch(v.verdict, /what the crash looks like/,
    'a normal commit figure must not be dressed up as the crash');
});

test('the series stopping is ADDITIVE — it never overwrites the family it found', () => {
  // "It climbed AND THEN the series stopped" is the strongest reading this table can produce:
  // the ramp names the family and the silence is where it got to. A branch that replaced the
  // growth verdict with the silence would throw away the half that answers the question.
  const rows = Array.from({ length: 12 }, (_, i) => row({
    taken_at: at(i),
    recgov_procs: 1, recgov_mb: 500 + i * 800,
    max_pid: 4242, max_mb: 500 + i * 800, max_family: 'recgov',
    commit_used_mb: 40000 + i * 1000,
  }));
  const v = readMemoryVerdict(rows, { now: Date.parse(at(11)) + 60 * 60_000 });

  assert.match(v.verdict, /LEAK OBSERVED/, 'the growth verdict must survive');
  assert.match(v.verdict, /recgov/, 'and must still name the family');
  assert.match(v.verdict, /THE SERIES HAS STOPPED/, 'and the silence must be reported too');
});

test('a series still running is not reported as stopped', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row({ taken_at: at(i) }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.equal(v.seriesEnded, false);
  assert.doesNotMatch(v.verdict, /THE SERIES HAS STOPPED/);
});

/**
 * ── SIZE, NOT ONLY RATE ─────────────────────────────────────────────────────────────────────
 * The 08-12 process reached 7.9 GB in FORTY-SIX SECONDS — faster than this samples. Such a
 * climb is invisible to a two-minute cadence: it appears as a pid that did not exist last
 * time, already enormous, and the pairing rule correctly declines to call that a rate. So a
 * verdict keyed only on rate can print NO LEAK IN THIS WINDOW over a 7.9 GB browser sitting in
 * its own table.
 */
test('an enormous process is named even when nothing could be called a rate', () => {
  const rows = [
    row({ taken_at: at(0), max_pid: 100, max_mb: 90, max_family: 'rc' }),
    // A NEW pid, already huge: the 46-second ramp, entirely between two samples.
    row({ taken_at: at(1), max_pid: 4242, max_mb: 7900, max_family: 'recgov', recgov_procs: 1 }),
  ];
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });

  assert.equal(v.comparablePairs, 0, 'two different pids are correctly not a pair');
  assert.equal(v.worst, null, 'and so there is no rate to report');
  assert.ok(v.peak, 'but the largest process must still be found');
  assert.equal(v.peak!.family, 'recgov');
  assert.equal(v.peak!.pid, 4242);
  assert.equal(v.peak!.mb, 7900);
  assert.match(v.verdict, /OVERSIZED PROCESS/);
  assert.match(v.verdict, /recgov/, 'the verdict must name the family — that is the question');
  assert.doesNotMatch(v.verdict, /NO LEAK IN THIS WINDOW/);
  assert.doesNotMatch(v.verdict, /NOT ENOUGH DATA/,
    'a process this size is evidence with no pairing at all; the pair count gates a RATE');
});

test('an ordinary browser is never called oversized', () => {
  // The measured healthy shape: 40-114 MB per process on these profiles.
  const rows = Array.from({ length: 20 }, (_, i) => row({ taken_at: at(i), max_mb: 114 }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  assert.ok(v.peak!.mb < BIG_PROCESS_MB);
  assert.doesNotMatch(v.verdict, /OVERSIZED/);
  assert.match(v.verdict, /NO LEAK IN THIS WINDOW/);
});

test('when size AND rate agree, the verdict says both', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row({
    taken_at: at(i),
    recgov_procs: 1, recgov_mb: 2000 + i * 800,
    max_pid: 4242, max_mb: 2000 + i * 800, max_family: 'recgov',
  }));
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });
  // The RATE leads — it is two readings of one process, the stronger evidence — and the size
  // corroborates it rather than displacing it.
  assert.match(v.verdict, /LEAK OBSERVED/);
  assert.match(v.verdict, /400 MB\/min/);
  assert.match(v.verdict, /size and rate agree/);
});

test('the peak is the LARGEST process seen, not the most recent one', () => {
  // WRITTEN AFTER A MUTATION SURVIVED. Every earlier fixture happened to put its biggest
  // process in the last row, so "largest" and "last" were indistinguishable and a peak that
  // simply took the newest row passed the whole suite. The spike has to be in the MIDDLE, and
  // the box has to have recovered afterwards — which is exactly the shape a `kill-chrome` (or
  // the keepalive browser closing) leaves behind, so it is also the realistic case.
  const rows = [
    row({ taken_at: at(0), max_pid: 100, max_mb: 90, max_family: 'rc' }),
    row({ taken_at: at(1), max_pid: 4242, max_mb: 7900, max_family: 'recgov', recgov_procs: 1 }),
    row({ taken_at: at(2), max_pid: 100, max_mb: 95, max_family: 'rc' }),
  ];
  const v = readMemoryVerdict(rows, { now: justAfter(rows) });

  assert.equal(v.peak!.mb, 7900, 'the spike must survive the box recovering from it');
  assert.equal(v.peak!.pid, 4242);
  assert.equal(v.peak!.family, 'recgov');
  assert.match(v.verdict, /OVERSIZED PROCESS/,
    'a spike that has since been killed is still the attribution');
});

/**
 * ── THE SCAN THAT DID NOT REPORT ────────────────────────────────────────────────────────────
 * The sampler's first day in production, 2026-08-14: every row recorded `rc 0 procs, 0 MB`
 * while the `memory` command — interleaved with it, seconds apart, on the same box, through a
 * BYTE-IDENTICAL filter — reported NINE Chromium processes on `.rc-bot-profile`. The commit
 * figures in the same rows were correct, so PowerShell ran and only the process scan came back
 * empty.
 *
 * The zero is the bug, not the empty scan. This file's own header says an absent reading
 * returns nulls rather than zeros because a plausible zero is worse than a blank — and that
 * rule had been applied to the `M|` line and not to the scan. Exactly the half-application
 * that let the sibling `memory` rollup print `FAMILY rc 0 MB` over a profile holding 312 MB.
 */
test('a scan that never reports is null, not zero', () => {
  // Commit figures present, no C| and no P| — the shape observed in production.
  const s = parseSample('M|10277|59134|8629');
  assert.equal(s.commitUsedMb, 10277, 'the half that worked must still be recorded');
  assert.equal(s.scanned, false);
  assert.equal(s.rcProcs, null, 'NOT 0 — nothing was learned about the rc family');
  assert.equal(s.rcMb, null);
  assert.equal(s.recgovProcs, null);
  assert.equal(s.otherProcs, null);
});

test('a scan that reports zero IS zero — that is a real reading', () => {
  // 2026-08-14 genuinely had a window with none of our browsers running (CHROME 0 = OURS 0).
  // Collapsing that into "unknown" would be the opposite error and would erase real evidence.
  const s = parseSample('M|9000|57700|8000\nC|0');
  assert.equal(s.scanned, true);
  assert.equal(s.rcProcs, 0, 'the scan ran and found none: a measured zero');
  assert.equal(s.recgovProcs, 0);
  assert.equal(s.otherProcs, 0);
});

test('C| baselines every family, so an absent family reads as measured zero', () => {
  const s = parseSample([
    'M|9000|57700|8000',
    'C|1',
    String.raw`P|4242|900|C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\.rc-bot-profile`,
  ].join('\n'));
  assert.equal(s.rcProcs, 1);
  assert.equal(s.rcMb, 900);
  // The scan ran and found no rec.gov browser. That is evidence, and must not read as a gap.
  assert.equal(s.recgovProcs, 0);
  assert.equal(s.recgovMb, 0);
});

test('a P| without its C| still counts — losing a real process is the worse mistake', () => {
  const s = parseSample([
    'M|9000|57700|8000',
    String.raw`P|4242|7900|C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\profiles\user_42`,
  ].join('\n'));
  assert.equal(s.recgovProcs, 1);
  assert.equal(s.recgovMb, 7900);
  assert.equal(s.maxMb, 7900);
  // The families the scan said nothing about stay unknown rather than being invented as 0.
  assert.equal(s.rcProcs, null);
});

test('takeSample says out loud when the scan did not report', async () => {
  // THE REASON WAS BEING THROWN AWAY AT THE POINT IT WAS PRODUCED. stderr was discarded, so
  // when the scan came back empty on a box with nine of our browsers running, the one line
  // that could explain it was dropped and a `0` was stored instead.
  const said: string[] = [];
  const sample = await takeSample({
    platform: 'win32',
    log: (m: string) => said.push(m),
    exec: ((_f: unknown, _a: unknown, _o: unknown, cb: Function) =>
      cb(null, 'M|10277|59134|8629\n', 'Get-CimInstance : Access denied')) as never,
  });
  assert.equal(sample!.scanned, false);
  assert.equal(said.length, 1, 'it must report the failed scan exactly once');
  assert.match(said[0]!, /scan did not report/);
  assert.match(said[0]!, /Access denied/, "and must carry PowerShell's own words");
});

test('a healthy scan says nothing', async () => {
  const said: string[] = [];
  const sample = await takeSample({
    platform: 'win32',
    log: (m: string) => said.push(m),
    exec: ((_f: unknown, _a: unknown, _o: unknown, cb: Function) =>
      cb(null, 'M|9000|57700|8000\nC|0\n', '')) as never,
  });
  assert.equal(sample!.scanned, true);
  assert.deepEqual(said, [], 'a working instrument must not narrate');
});

test('the PowerShell emits the scan count, and BEFORE the per-process loop', () => {
  // WRITTEN AFTER A MUTATION SURVIVED. Deleting the `C|` line from the PowerShell broke
  // nothing in the suite, because every parse test feeds `parseSample` a hand-written string —
  // so the parser and the thing that produces its input could drift apart silently. There is
  // no PowerShell on the machine this repo is written from, which is exactly why the last
  // three PowerShell bugs here ran broken for weeks; the guard has to be mechanical.
  const src = readFileSync('scripts/auto-cart-bot/memory-sample.mjs', 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const count = code.indexOf("'C|{0}' -f $ours.Count");
  assert.ok(count > 0, 'the PowerShell must report how many processes the scan matched');

  // ORDER IS THE POINT. Emitted before the loop, a `C|9` with no `P|` lines localises the
  // failure to the loop; emitted after, a loop that throws takes the count down with it and
  // the reading is ambiguous again — which is the bug this line exists to end.
  const loop = code.indexOf('foreach ($o in $ours)');
  assert.ok(loop > 0, 'the per-process loop must still be there');
  assert.ok(count < loop, 'the count must be emitted BEFORE the loop that can fail');
});
