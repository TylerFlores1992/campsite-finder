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
import { requestCountReason } from './bot-events';

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
