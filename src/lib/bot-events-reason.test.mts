/**
 * `0 at a bail` OVER TWO REAL BAILS.
 *
 * #280 made each watchdog arm name itself in the `request-counts` reason (`bail:ramp`), so
 * that which arm fired could be read rather than inferred from the clock. The readout's
 * classifier still tested `reason === 'bail'`, so from that commit until 2026-09-06 no bail
 * was ever counted as one: the summary printed `0 at a bail`, and the bail rows — the only
 * readings taken DURING a ramp — printed LAST, below the teardowns the header calls the
 * baseline. Read against `docs/NEXT-SESSION.md`'s own instruction ("read the `bail` rows
 * first"), that reads as the arm never having fired.
 *
 * Both halves are guarded, because the ordering is the more valuable one and it is invisible
 * in the count: a classifier that were fixed only for the summary would still print the ramp
 * reading last.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestCountReason, loopAnswerReading } from './bot-events';

function code(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

test('the reason the box actually writes counts as a bail', () => {
  // THE PRODUCTION VALUE. `rc-keepwarm.mjs` posts `bail:${arm}`; there is no code path left
  // that writes a bare 'bail'. If this is the only assertion that fails, the classifier has
  // been reverted to an equality test.
  for (const arm of ['ramp', 'wedge', 'runaway', 'unknown']) {
    assert.equal(requestCountReason(`bail:${arm}`), 'bail', `bail:${arm}`);
  }
});

test('rows written before the arms named themselves are still bails', () => {
  // Pre-#280 rows carry the bare word and are real bails. A prefix-only test would drop them.
  assert.equal(requestCountReason('bail'), 'bail');
});

test('a prefix is not a substring — `bail` must not sweep in a neighbour', () => {
  // The reason it is `bail:` and not `bail`. A future reason that merely starts with those
  // four letters is not a bail, and miscounting one as a bail is the same class of error in
  // the opposite direction.
  for (const r of ['bailout', 'bail-later', 'bailed']) {
    assert.equal(requestCountReason(r), 'other', r);
  }
});

test('the other two reasons are unchanged, and anything unknown is `other`', () => {
  assert.equal(requestCountReason('hung-close'), 'hung-close');
  assert.equal(requestCountReason('teardown'), 'teardown');
  // An absent or non-string reason must land somewhere printable rather than throwing — an
  // older box that posts no reason at all is still a reading.
  for (const r of [null, undefined, 42, {}, '', 'something-new']) {
    assert.equal(requestCountReason(r), 'other', JSON.stringify(r) ?? 'undefined');
  }
});

test('the readout classifies through the shared function and keeps no equality list', () => {
  // THE FIX-PRESENT-AND-INERT SHAPE. `requestCountReason` can be perfect while the readout
  // goes on filtering on its own `=== 'bail'`, which is precisely the state this guard was
  // written in.
  const src = code('../../scripts/bot-events-readout.mts');
  assert.match(src, /requestCountReason\(d\(c\)\.reason\)/,
    'the readout must classify request-counts through requestCountReason');
  assert.doesNotMatch(src, /d\(c\)\.reason === /,
    'the readout must not keep its own equality classifier beside the shared one');
  assert.doesNotMatch(src, /\['bail', 'hung-close', 'teardown'\]/,
    'the `other` bucket must be derived from the same classifier, not a second hand-written list');
});

test('bails are printed BEFORE the teardown baseline', () => {
  // THE HALF THE COUNT CANNOT SHOW. The section header promises "Bails first — they are the
  // reading taken during a ramp"; with bails falling into `other` they printed last. Ordering
  // is what a reader acts on, so it is asserted rather than left to the classifier.
  const src = code('../../scripts/bot-events-readout.mts');
  const showBails = src.indexOf('for (const c of bails) show(');
  const showTears = src.indexOf('for (const c of baseline) show(');
  const showOther = src.indexOf('for (const c of other) show(');
  assert.ok(showBails > -1 && showTears > -1 && showOther > -1, 'all three render loops present');
  assert.ok(showBails < showTears, 'bails must render before the teardown baseline');
  assert.ok(showTears < showOther, 'the unrecognised bucket stays last');
});

/**
 * WHICH KIND OF LOOP. `page.on('request')` never sees the answer, so until the status was
 * counted "a retry loop against a rejection" and "the SPA asking on purpose" were the same
 * reading — and they need opposite fixes.
 */
test('an absent statuses field is NOT an empty one — the older-box case must not read as a finding', () => {
  // The house shape: an absent reading standing in for a negative. A row from a bundle older
  // than this change carries no `statuses` key; reporting that as "nothing came back" would
  // make every historical burst look like Chromium being ignored.
  assert.equal(loopAnswerReading({ lifetime: 19008 }).kind, 'not-reported');
  assert.equal(loopAnswerReading({ lifetime: 19008, statuses: null }).kind, 'not-reported');
  assert.match(loopAnswerReading({ lifetime: 19008 }).text, /older box/);
  // And the genuinely-empty case is its own kind, with the ask count in it.
  const none = loopAnswerReading({ lifetime: 19008, statuses: {} });
  assert.equal(none.kind, 'unanswered');
  assert.match(none.text, /19008 ask/);
});

test('a rejection loop and a served loop are told apart, and the rejection names the wrong fix', () => {
  const rejected = loopAnswerReading({ lifetime: 49237, statuses: { 401: 49230, failed: 7 } });
  assert.equal(rejected.kind, 'rejected');
  assert.match(rejected.text, /RETRY LOOP AGAINST A REJECTION/);
  // The standing instruction is "do not reach for blocking the requests first".
  assert.match(rejected.text, /NOT blocking the requests/);
  const ok = loopAnswerReading({ lifetime: 49237, statuses: { 200: 49237 } });
  assert.equal(ok.kind, 'ok');
  assert.match(ok.text, /asking on purpose/);
  assert.notEqual(rejected.text, ok.text, 'the two candidates must not render the same sentence');
});

test('Chromium refusing is a third answer, and a spread names no cause at all', () => {
  assert.equal(loopAnswerReading({ lifetime: 900, statuses: { failed: 890, 200: 10 } }).kind, 'failed');
  // No dominant code is not a story. Naming the largest slice of a spread is how a tidy
  // explanation gets recorded as a finding.
  const mixed = loopAnswerReading({ lifetime: 100, statuses: { 200: 50, 401: 30, 500: 20 } });
  assert.equal(mixed.kind, 'mixed');
  assert.match(mixed.text, /no single answer dominates/);
});

test('asks with no answer are counted beside the answers, never folded into them', () => {
  // 49,000 asks answered 200 twelve times is a different finding from a 200 loop.
  const r = loopAnswerReading({ lifetime: 49237, statuses: { 200: 12 } });
  assert.match(r.text, /49225 of 49237 ask\(s\) got no answer/);
});

test('the readout calls it — a verdict nothing renders is a verdict nobody reads', () => {
  // The fix-present-and-inert shape: the function can be perfect and the readout still print
  // only "a REQUEST LOOP", which is the sentence that could not tell the two candidates apart.
  const readout = code('../../scripts/bot-events-readout.mts');
  assert.match(readout, /loopAnswerReading\(lead\)/, 'the loop branch must render the answer reading');
  const loop = readout.indexOf('is a REQUEST LOOP');
  const answers = readout.indexOf('loopAnswerReading(lead)');
  assert.ok(loop > -1 && answers > loop, 'it belongs with the loop verdict it qualifies');
});
