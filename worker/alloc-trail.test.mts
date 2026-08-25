/**
 * THE ALLOCATION TRAIL'S DECISIONS.
 *
 * The trail exists because both existing ways of reading an allocation profile were measured
 * blind (see `rc-alloc-trail.mjs`). Its own correctness therefore has to be exercised rather
 * than reasoned about, and the decisions are pure so it can be done without a browser — the
 * same split as `claim.ts`, `session-coverage.mjs` and `renewal-schedule.mjs`.
 *
 * `read` is injected, so these drive the REAL `createAllocTrail` against a scripted profile
 * rather than a copy of its rules. A test that asserts against a copy asserts the copy — the
 * `rc-holds-readout` lesson.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSegments, rampOf, describeAllocTrail, createAllocTrail,
} from '../scripts/auto-cart-bot/rc-alloc-trail.mjs';

const MB = 1048576;
/** A sample as the trail stores them. `freeMb` FALLS as the machine loses memory. */
const S = (at: number, totalMb: number, freeMb: number, sites: Array<[string, number]> = []) => ({
  at,
  freeMb,
  profile: {
    totalBytes: totalMb * MB,
    sites: sites.map(([site, m]) => ({ site, bytes: m * MB })),
  },
});

test('a rising profile is one segment', () => {
  const segs = splitSegments([S(1, 10, 9000), S(2, 200, 8000), S(3, 900, 7000)]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 3);
});

test('a COLLAPSE is a renderer swap and starts a new segment', () => {
  // The shape measured on a real Chromium: an all-time profile fell 274 MB -> 1 MB across a
  // cross-site navigation. A swap resets to under half a percent of what it held.
  const segs = splitSegments([S(1, 100, 9000), S(2, 274, 8900), S(3, 1, 8800), S(4, 90, 8700)]);
  assert.equal(segs.length, 2, 'the collapse must split');
  assert.deepEqual(segs.map((s) => s.length), [2, 2]);
});

test('a FRACTIONAL decrease is noise and must NOT split', () => {
  // THE BUG THE PROBE FOUND, and it is the dangerous direction. `alloc-trail-probe.mjs`
  // recorded a real profile stepping 955.4 -> 955.2 MB between two reads — invisible in a
  // rounded log line, and under a strict `<` it cut a 1,271 MB ramp into 954 and 319 and
  // reported the larger half as the whole event. An instrument that halves the number it
  // exists to report is worse than none.
  const jitter = [
    { at: 1, freeMb: 9000, profile: { totalBytes: Math.round(955.4 * MB), sites: [] } },
    { at: 2, freeMb: 8000, profile: { totalBytes: Math.round(955.2 * MB), sites: [] } },
    { at: 3, freeMb: 7000, profile: { totalBytes: Math.round(1272 * MB), sites: [] } },
  ];
  const segs = splitSegments(jitter);
  assert.equal(segs.length, 1, 'a sub-megabyte wobble is not a renderer swap');
  assert.equal(rampOf(segs[0])!.growthBytes, Math.round(1272 * MB) - Math.round(955.4 * MB));
});

test('rampOf reports growth, the free-RAM delta and where the bytes went', () => {
  const r = rampOf([
    S(1000, 100, 9000, [['a', 60], ['b', 30]]),
    S(2000, 2100, 6500, [['a', 1800], ['b', 40]]),
  ])!;
  assert.equal(r.growthBytes, 2000 * MB);
  // NEGATIVE while the machine loses memory, matching what withNetworkTrace produces and what
  // reportNativeAlloc's gate tests for. A trip that FREED memory is not a ramp.
  assert.equal(r.ramDeltaMb, -2500);
  assert.equal(r.sites[0].site, 'a');
  assert.equal(r.sites[0].bytes, 1740 * MB, 'sites are DIFFED, not carried whole');
  assert.ok(!r.sites.some((s) => s.site === 'b' && s.bytes <= 0),
    'a site that did not grow must not appear as a negative row');
});

test('a single sample is not a ramp — there is nothing to be a change from', () => {
  assert.equal(rampOf([S(1, 900, 4000)]), null);
});

/** A trail wired to a scripted sequence of profile reads. */
function harness(reads: Array<{ totalMb: number; sites?: Array<[string, number]> } | null>) {
  let i = 0;
  const trail = createAllocTrail({
    read: async () => {
      const r = reads[Math.min(i++, reads.length - 1)];
      return r === null ? null : {
        totalBytes: r.totalMb * MB,
        sites: (r.sites ?? []).map(([site, m]) => ({ site, bytes: m * MB })),
        modules: null,
      };
    },
    windowMs: 20 * 60_000,
    sampleMs: 20_000,
    rampBytes: 400 * MB,
  });
  return { trail, taken: () => i };
}

/** Drive the fire-and-forget sampler and let its promise settle. */
async function tick(trail: any, at: number, freeMb: number) {
  trail.sample(at, freeMb);
  await new Promise((r) => setImmediate(r));
}

test('an OPEN segment is withheld on a tick and taken at teardown', async () => {
  const { trail } = harness([{ totalMb: 10 }, { totalMb: 900 }, { totalMb: 1800 }]);
  trail.register('renewal', {});
  await tick(trail, 0, 9000);
  await tick(trail, 20_000, 6000);
  await tick(trail, 40_000, 3000);

  assert.deepEqual(trail.takeRamps(), [],
    'a segment still being written to has no final peak — reporting it would store a partial '
    + 'reading as though it were the event');

  const finals = trail.takeRamps({ final: true });
  assert.equal(finals.length, 1, 'teardown must take the open segment');
  assert.equal(finals[0].name, 'renewal');
  assert.equal(finals[0].growthBytes, 1790 * MB);
  assert.equal(finals[0].ramDeltaMb, -6000);
});

test('an ENDED segment is taken on an ordinary tick — that is the trigger', async () => {
  // The renderer swap is what makes the peak final, and it is the moment the number would
  // otherwise be discarded by the navigation that caused it.
  const { trail } = harness([{ totalMb: 10 }, { totalMb: 1500 }, { totalMb: 5 }, { totalMb: 20 }]);
  trail.register('renewal', {});
  for (const [i, free] of [9000, 6000, 9000, 8900].entries()) await tick(trail, i * 20_000, free);

  const got = trail.takeRamps();
  assert.equal(got.length, 1, 'the swapped-away segment is final and must be reported');
  assert.equal(got[0].growthBytes, 1490 * MB);
});

test('a ramp is reported ONCE, however often the flush runs', async () => {
  const { trail } = harness([{ totalMb: 10 }, { totalMb: 1500 }, { totalMb: 5 }]);
  trail.register('renewal', {});
  for (const [i, free] of [9000, 6000, 9000].entries()) await tick(trail, i * 20_000, free);
  assert.equal(trail.takeRamps().length, 1);
  assert.equal(trail.takeRamps().length, 0, 'the flush runs every 10s; a ramp must not re-send');
  assert.equal(trail.takeRamps({ final: true }).length, 0, 'nor at teardown afterwards');
});

test('a ramp is not re-reported when the window prunes its first sample', async () => {
  // THE BUG A SELF-REVIEW CAUGHT. `reported` first keyed on the segment's START, and the
  // window prunes from the FRONT — so an aged-out first sample moves the start, changes the
  // key, and the same ramp is stored again. A duplicate reading is worse than a missing one
  // here: two rows for one event read as two events, and the whole investigation is a
  // question about how often these happen.
  //
  // THREE SAMPLES IN THE RAMP, DELIBERATELY. The first version of this test used two, so
  // pruning left a single sample, `rampOf` returned null, and the mutation SURVIVED — the
  // test proved the segment became unreportable rather than that the key was stable. It has
  // to still be a reportable ramp after the prune, or it is not testing the key at all.
  const { trail } = harness([
    { totalMb: 10 }, { totalMb: 800 }, { totalMb: 1500 }, { totalMb: 3 }, { totalMb: 10 },
  ]);
  trail.register('renewal', {});
  for (const [i, free] of [9000, 7000, 6000, 9000, 8990].entries()) await tick(trail, i * 20_000, free);
  assert.equal(trail.takeRamps().length, 1, 'reported once');

  // Age the buffer past the first sample, exactly as the 20-minute window does. What is left
  // of the ramp is 800 -> 1500 MB, still comfortably over the bar.
  const live = trail.buffers().get('renewal')!;
  const was = live.length;
  live.shift();
  assert.equal(live.length, was - 1, 'the prune must actually have happened');
  assert.ok(rampOf(splitSegments(live)[0])!.growthBytes > 400 * MB,
    'and what remains must still be a reportable ramp, or this tests nothing about the key');
  assert.deepEqual(trail.takeRamps({ final: true }), [],
    'the same ramp must not come back under a new key just because it got shorter');
});

test('an ordinary Okta trip is under the bar and is not stored', async () => {
  // Measured on the box 2026-08-25: two real renewals at 47 MB and 39 MB. Storing those would
  // bury the interesting rows exactly as the 16k log window already does.
  const { trail } = harness([{ totalMb: 5 }, { totalMb: 52 }]);
  trail.register('renewal', {});
  await tick(trail, 0, 9000);
  await tick(trail, 20_000, 8950);
  assert.deepEqual(trail.takeRamps({ final: true }), []);
});

test('a read we could not take is NOT stored as zero', async () => {
  // A null reading pushed as 0 would look like a renderer swap and cut the segment in half,
  // reporting half the growth of a real ramp. Worse than a gap, because it is plausible.
  const { trail } = harness([{ totalMb: 10 }, null, { totalMb: 1800 }]);
  trail.register('renewal', {});
  for (const [i, free] of [9000, 7000, 4000].entries()) await tick(trail, i * 20_000, free);
  assert.equal(trail.samplesOf('renewal').length, 2, 'the null must not become a sample');
  const got = trail.takeRamps({ final: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].growthBytes, 1790 * MB, 'and the segment must not have been split by it');
});

test('unregistering keeps the buffer, which is what makes the tab peak reportable', async () => {
  const { trail } = harness([{ totalMb: 10 }, { totalMb: 1500 }]);
  trail.register('renewal', {});
  await tick(trail, 0, 9000);
  await tick(trail, 20_000, 6000);
  assert.deepEqual(trail.takeRamps(), [], 'still open while registered');
  trail.unregister('renewal');
  const got = trail.takeRamps();
  assert.equal(got.length, 1, 'a closed tab has no more to say, so its segment is final');
  assert.equal(got[0].growthBytes, 1490 * MB);
});

test('the window is bounded by TIME, not by a sample count', async () => {
  // TRAIL_KEEP is 12, which at a 10s tick is two minutes against a ten-minute ramp. That is
  // how the heap trail came to print twelve byte-identical samples already 123s stale.
  const { trail } = harness(Array.from({ length: 200 }, (_, n) => ({ totalMb: n })));
  trail.register('resident', {});
  for (let i = 0; i < 100; i++) await tick(trail, i * 20_000, 9000);
  const kept = trail.samplesOf('resident');
  assert.ok(kept.length > 12, `a count-bounded trail would keep 12; this kept ${kept.length}`);
  const span = kept[kept.length - 1].at - kept[0].at;
  assert.ok(span >= 15 * 60_000, `the window must reach back past a ten-minute ramp, got ${span}ms`);
});

test('a target that is still answering is not asked twice at once', async () => {
  let resolve: (v: unknown) => void = () => {};
  let calls = 0;
  const trail = createAllocTrail({
    read: (): any => { calls += 1; return new Promise((r) => { resolve = r; }); },
    sampleMs: 0,
  });
  trail.register('resident', {});
  trail.sample(0, 9000);
  trail.sample(1000, 9000);
  trail.sample(2000, 9000);
  assert.equal(calls, 1,
    'once the browser goes quiet every attempt costs its full CDP timeout, so without the '
    + 'in-flight flag they pile up one per tick');
  resolve({ totalBytes: 1, sites: [] });
});

test('one slow renderer does not starve the other of readings', async () => {
  // Per-target and not one global flag: the resident page and the trip tab are sampled
  // together, and a stuck read on either must not blind us to the one that is ramping.
  let calls: Record<string, number> = { a: 0, b: 0 };
  const trail = createAllocTrail({
    read: (cdp: any): any => {
      calls[cdp.id] += 1;
      return cdp.id === 'a' ? new Promise(() => {}) : Promise.resolve({ totalBytes: 1, sites: [] });
    },
    sampleMs: 0,
  });
  trail.register('resident', { id: 'a' });
  trail.register('renewal', { id: 'b' });
  trail.sample(0, 9000);
  await new Promise((r) => setImmediate(r));
  trail.sample(1000, 9000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.a, 1, 'the stuck one is asked once and then skipped');
  assert.ok(calls.b >= 2, `the healthy one keeps being read, got ${calls.b}`);
});

test('the rendered trail states its coverage and distinguishes empty from flat', () => {
  const empty = describeAllocTrail(new Map([['resident', []]]), 1000);
  assert.match(empty, /EMPTY/);
  assert.match(empty, /answered no CDP call/,
    '"the browser would not answer" and "the renderer allocated nothing" are different facts');

  const line = describeAllocTrail(
    new Map([['renewal', [S(0, 10, 9000), S(60_000, 2000, 6500)]]]), 120_000);
  assert.match(line, /1990 MB over 60s/);
  assert.match(line, /RAM -2500 MB/);
  assert.match(line, /renderers only/,
    'the browser process is NOT sampled and every line must say so — a figure that silently '
    + 'describes two thirds of a ramp is how "the biggest process" became a whole explanation');
});

test('a target with no trail at all says so rather than rendering blank', () => {
  assert.match(describeAllocTrail(new Map(), 0), /EMPTY/);
});
