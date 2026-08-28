/**
 * A FINAL FLUSH THAT REPORTS NOTHING MUST SAY WHY.
 *
 * The Track A trail has been armed since 2026-08-25 and has stored **zero** `trail-*`
 * readings across three real ramps:
 *
 *   08-25 20:22 (~3.6 GB) · 08-26 21:24 (9,112 MB, 100% COMMIT) · 08-28 02:01 (8,981 MB)
 *
 * THE OBVIOUS EXPLANATION IS RULED OUT, and that is what makes this worth building. The
 * theory was that the segment never ENDS — `takeRamps` only takes ended segments on an
 * ordinary tick — so a ramp on the long-lived resident renderer would never be taken. For
 * the 08-28 event that is false: `chromium_memory_samples.max_pid` went 14596 -> 7812 at
 * 02:15, two minutes after the 8,981 MB peak. The browser really was replaced, so
 * `warmResident`'s `finally` really did run, and `final: true` really does include the open
 * segment. The trigger fired and stored nothing anyway.
 *
 * TWO POSSIBILITIES REMAIN, THEY LOOK IDENTICAL FROM OUTSIDE, AND THEY NEED OPPOSITE FIXES:
 *
 *   * `EMPTY — that renderer answered no CDP call at all`. The browser stopped answering as
 *     it grew, which has happened twice before on two different CDP calls
 *     (`newCDPSession`, then `Performance.getMetrics`). The trail then needs a different
 *     TRANSPORT, and no amount of trigger work helps.
 *   * SEGMENTS PRESENT with growth under the 400 MB bar. Every reading ever taken points
 *     here — 13-109 MB attributed against events of 5-9 GB — and it would mean the sampling
 *     profiler cannot see these bytes at all, so Track A is measuring a quantity that
 *     structurally excludes the leak and no threshold tuning can rescue it.
 *
 * Distinguishing them is one log line reusing `describeAllocTrail`, which already exists and
 * is already printed on the runaway bail. It was simply never printed at the TEARDOWN — and
 * the teardown is the arm a real ramp lands in, because the bail needs a stall AND free RAM
 * under 2,000 MB, and the 08-28 ramp bottomed at 4,191 MB.
 *
 * WHY GUARD IT. This is the fifth instance in this repo of a diagnostic that cannot reach
 * what it measures, and the failure mode is silence — which is indistinguishable from a
 * quiet night. Dropping `describeIfEmpty` from the teardown call, or making the condition
 * unreachable, restores that silence with nothing to notice. Same reasoning as
 * `egress-watchdog.test.mts`: the pure function is fine, the WIRING is what rots.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const keepwarm = readFileSync(
  new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
const trail = readFileSync(
  new URL('../scripts/auto-cart-bot/rc-alloc-trail.mjs', import.meta.url), 'utf8');

/** Comments stripped — this file's subject quotes the shapes it is about. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

const kw = code(keepwarm);

test('THE TEARDOWN ASKS FOR THE DESCRIPTION — it is the arm a real ramp lands in', () => {
  // Scoped to the `finally` that flushes, not to the file: the bail also calls
  // `flushAllocRamps({ final: true })` and deliberately does NOT pass this, because it logs
  // `describeAllocTrail` unconditionally a few lines earlier. Asserting on the file as a
  // whole would pass if only the bail had it, which is the arm that already worked.
  const at = kw.indexOf('describeIfEmpty: true');
  assert.ok(at > -1,
    'no caller asks a final flush to describe an empty trail, so a 9 GB ramp still leaves '
    + 'nothing but silence at the teardown — which is what three ramps already did');
  const near = kw.slice(Math.max(0, at - 600), at + 200);
  assert.match(near, /flushAllocRamps\(\{\s*final:\s*true,\s*describeIfEmpty:\s*true\s*\}\)/,
    'describeIfEmpty must be passed to a FINAL flush — on an ordinary tick the open segment '
    + 'is not taken, so an empty result there is the normal state and not a finding');
  assert.match(near, /ctx\?\.close\(\)|releaseProfileLockIfMine|finally/,
    "it belongs in warmResident's teardown, where every `break` that replaces the browser "
    + 'lands — that is the moment the trail dies and an untaken reading is lost');
});

test('THE BAIL DOES NOT ALSO PASS IT — the same text twice reads as a bug', () => {
  // The bail already logs describeAllocTrail unconditionally. Two identical adjacent lines
  // would look like a defect and invite somebody to "fix" it by deleting one — and the one
  // deleted would be whichever is easier to reach, not whichever matters.
  const calls = [...kw.matchAll(/flushAllocRamps\(\{[^}]*\}\)/g)].map((m) => m[0]);
  const withFlag = calls.filter((c) => c.includes('describeIfEmpty'));
  assert.equal(withFlag.length, 1,
    `expected exactly one caller to pass describeIfEmpty, found ${withFlag.length}: `
    + `${calls.join(' | ')}. The bail describes the trail on its own; a second copy there `
    + 'prints the same text twice.');
});

test('THE DESCRIPTION IS REACHED ONLY WHEN NOTHING WAS REPORTED', () => {
  const start = kw.indexOf('function flushAllocRamps');
  assert.ok(start > -1, 'flushAllocRamps must exist');
  const body = kw.slice(start, kw.indexOf('\n}', start));
  assert.match(body, /if\s*\(final\s*&&\s*describeIfEmpty\s*&&\s*sent\.length\s*===\s*0\)/,
    'all three conditions are load-bearing: `final` because an ordinary tick legitimately '
    + 'takes nothing, `describeIfEmpty` because the bail describes separately, and '
    + '`sent.length === 0` because this fires on every reopen and tail-log returns only the '
    + 'last 16,000 characters — noise here destroys the record it exists to preserve');
  assert.match(body, /describeAllocTrail\(allocTrail\.buffers\(\)/,
    'it must describe the REAL buffers, not a summary computed here — a second rendering of '
    + 'the same state is a second thing to keep in step');
});

test('THE DESCRIPTION CAN ACTUALLY DISCRIMINATE — it reports growth under the bar', () => {
  // The whole value is telling "no samples" from "samples too small". If describeAllocTrail
  // applied the 400 MB bar the way takeRamps does, both would print nothing and the line
  // would be worthless — which is the shape of every instrument this project has had to
  // rebuild.
  const t = code(trail);
  const start = t.indexOf('export function rampOf');
  assert.ok(start > -1, 'rampOf must exist');
  const body = t.slice(start, t.indexOf('\n}', start));
  assert.doesNotMatch(body, /rampBytes|ALLOC_RAMP_BYTES/,
    'rampOf must NOT apply the ramp bar — describeAllocTrail is built on it, and a filtered '
    + 'rampOf would make a sub-400 MB segment print as nothing, which is the exact case this '
    + 'diagnostic exists to reveal');

  const desc = t.indexOf('export function describeAllocTrail');
  assert.ok(desc > -1, 'describeAllocTrail must exist');
  const dbody = t.slice(desc, t.indexOf('\n}', desc));
  assert.doesNotMatch(dbody, /growthBytes\s*[<>]/,
    'describeAllocTrail must not filter segments by size either');
  assert.match(dbody, /EMPTY/,
    'it must distinguish an empty trail in words — "that renderer answered no CDP call at '
    + 'all" and "a segment too small to report" are the two answers, and they need opposite '
    + 'fixes');
});
