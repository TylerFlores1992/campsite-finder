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
import { classifyProfile, parseSample, createSampler, SAMPLE_EVERY_MS } from '../scripts/auto-cart-bot/memory-sample.mjs';
import {
  readMemoryVerdict, MIN_COMPARABLE_PAIRS, LEAK_MB_PER_MIN, type MemorySampleRow,
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

test('a verdict is refused until enough pairs can actually be compared', () => {
  // Same discipline as MIN_RENEWAL_TESTS: rows fetched is not evidence gathered.
  const rows = Array.from({ length: 4 }, (_, i) => row({ taken_at: at(i) }));
  const v = readMemoryVerdict(rows);
  assert.equal(v.enough, false);
  assert.match(v.verdict, /NOT ENOUGH DATA/);
  assert.ok(v.comparablePairs < MIN_COMPARABLE_PAIRS);
});

test('a family that never appeared is reported as unobserved, not as clean', () => {
  // THE 2026-08-14 FAILURE, EXACTLY. Every process sampled was on the RC profile, no rec.gov
  // browser existed at any point, and the result was read as evidence about the leak. It could
  // not be. A family with no processes has been ruled out of nothing.
  const rows = Array.from({ length: 20 }, (_, i) => row({ taken_at: at(i) }));
  const v = readMemoryVerdict(rows);
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
  const v = readMemoryVerdict(rows);
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
  const v = readMemoryVerdict(rows);
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
  const v = readMemoryVerdict(rows);
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
  const v = readMemoryVerdict(rows);
  assert.equal(Math.round(v.worstGapMin), 47);
});
