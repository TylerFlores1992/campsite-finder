/**
 * A poller row is a (watch, campground) — the guard over the migration-070 collision.
 *
 * Since 070 `loadWatches` emits one row per (watch, campground) and every row of a park
 * watch carries the SAME `w.id`. Everything written before that keyed per-watch state on
 * the watch id alone, which was correct when a watch WAS a campground and silently became
 * a collision when it stopped being one. Two live watches on 2026-08-24 were affected.
 *
 * The cadence half is tested behaviourally in `poll-cadence.test.mts`. The result maps are
 * locals inside `runCycle`, and importing `poller.ts` STARTS the poller — so that half is
 * guarded structurally, with a floor so a guard that matched nothing cannot pass for one
 * that approved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { watchKey } from './watch-key';

const poller = readFileSync('worker/poller.ts', 'utf8');
/** Comments quote the BROKEN form to explain it; a guard that failed on its own
 *  explanation would be "fixed" by deleting the explanation. */
const code = poller.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const MAPS = ['rcResults', 'rcHeld', 'raResults', 'gtcResults', 'tnscResults'];

test('the two halves of the key cannot be confused for one another', () => {
  assert.equal(watchKey({ id: 'w1', campground_id: 'rc-583' }), 'w1|rc-583');
  // Different divisions of ONE watch are different rows. That is the whole point.
  assert.notEqual(
    watchKey({ id: 'w1', campground_id: 'rc-583' }),
    watchKey({ id: 'w1', campground_id: 'rc-582' }),
  );
  // ...and so are two watches on one campground, or the second watcher would ride the
  // first's cadence.
  assert.notEqual(
    watchKey({ id: 'w1', campground_id: 'rc-583' }),
    watchKey({ id: 'w2', campground_id: 'rc-583' }),
  );
  // A SEPARATOR THAT CANNOT APPEAR IN EITHER HALF. Watch ids are UUIDs and campground ids
  // are source-prefixed slugs, so `|` keeps this unambiguous where a bare concatenation
  // could be made to collide.
  assert.ok(watchKey({ id: 'a', campground_id: 'b' }).includes('|'));
});

test('no per-cycle result map is keyed on a bare watch id', () => {
  // THE REGRESSION THIS EXISTS FOR. `rcResults.set(w.id, …)` reads perfectly well and is
  // wrong for a park watch: the last division to finish overwrites the others, then every
  // row of that watch reads the survivor back and alerts about a site that belongs to a
  // different division.
  let checked = 0;
  for (const map of MAPS) {
    const uses = code.match(new RegExp(`${map}\\.(set|get)\\([^)]*`, 'g')) ?? [];
    assert.ok(uses.length > 0, `${map} is not used in poller.ts — this guard has rotted`);
    for (const use of uses) {
      checked++;
      assert.ok(!/\((w|watch)\.id\b/.test(use),
        `${map} is keyed on a bare watch id: ${use.slice(0, 70)}`);
      assert.match(use, /watchKey\(/, `${map} must be keyed with watchKey: ${use.slice(0, 70)}`);
    }
  }
  // A guard that inspected nothing is indistinguishable from one that approved. Ten call
  // sites existed when this was written.
  assert.ok(checked >= 10, `only ${checked} map accesses inspected — the anchors have rotted`);
});

test('the cadence tracker takes the campground too, so the type system carries the rule', () => {
  // `DueTracker.due` REQUIRES `campground_id`. That is what turned this from a silent
  // collision into a compile error at every call site the day the key changed — and it is
  // why the fix could not be half-applied.
  const cadence = readFileSync('worker/poll-cadence.ts', 'utf8');
  assert.match(cadence, /due<T extends \{[^}]*campground_id: string/);
  assert.match(cadence, /watchKey\(/, 'and it must actually use it, not merely accept it');
  assert.ok(!/this\.last\.(set|get)\(w\.id\b/.test(cadence),
    'the tracker is still stamping a bare watch id');
});
