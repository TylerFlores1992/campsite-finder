/**
 * ASK CHROMIUM WHO OWNS THE 32 GB — guards for scripts/auto-cart-bot/rc-mem-dump.mjs.
 *
 * The committed-region walk named the CLASS of the leak (16,387 pagefile-backed sections of
 * ~2 MB) and cannot name what created them. The memory-infra dump asks Chromium. These guards
 * pin the four properties that decide whether its answer is worth anything:
 *
 *  1. **A missing size is `null`, never 0.** `discardable` really does emit a root dump with a
 *     guid and no size, and zero would read as "that allocator holds nothing" — a claim, where
 *     the observation is "not reported". Same rule as every absent reading in this repo.
 *  2. **The buckets are the WALK's buckets**, boundaries included. The whole point is that
 *     "16,387 regions in 2-4M" and "N shared_memory mappings in 2-4M" describe one population
 *     or visibly do not; nearly-the-same boundaries would make that comparison a guess.
 *  3. **Ownership resolves across processes.** A renderer's mapping is routinely owned by a
 *     dump in the GPU process, whose event arrives later — so resolution is deferred, and an
 *     unresolvable source is REPORTED as one rather than dropped.
 *  4. **A refusal names itself.** Tracing already started, a browser that will not answer, a
 *     `success: false` — each must be distinguishable from a dump that ran and found no shared
 *     memory, because those two readings point in opposite directions.
 *
 * And the wiring, which is the half that would otherwise be inert: the dump is fired from the
 * watchdog TIMER (a check in the loop body is structurally unreachable during a ramp — four
 * times in this file), from the same `memory` reading and the same comparison the ramp arm
 * uses, BEFORE the bail rather than inside it, fire-and-forget with an in-flight flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  foldDumpEvents, summariseMemDump, renderMemDump, takeMemoryDump, ownerKey, sizeBucket,
  MEM_DUMP_TIMEOUT_MS, MEM_DUMP_CLEANUP_MS,
} from '../scripts/auto-cart-bot/rc-mem-dump.mjs';
import { MAX_DETAIL_CHARS, BOT_EVENT_KINDS } from '../src/lib/bot-events';
import { rampDumpGrace, MEM_DUMP_GRACE_MS_DEFAULT } from '../scripts/auto-cart-bot/ramp-bail.mjs';

const KEEPWARM = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
const READOUT = readFileSync(new URL('../scripts/bot-events-readout.mts', import.meta.url), 'utf8');
/** Comments are stripped so a guard can never be satisfied by the prose that explains it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const KW = code(KEEPWARM);

const hex = (n: number) => ({ type: 'scalar', units: 'bytes', value: n.toString(16) });
const shm = (guid: string, bytes: number) => [`shared_memory/${guid}`, { guid, attrs: { size: hex(bytes) } }];

/** One process's dump event, in the exact shape Chromium emits. */
const dumpEvent = (pid: number, allocators: Record<string, unknown>, graph: unknown[] = []) => ({
  ph: 'v', pid, args: { dumps: { allocators, allocators_graph: graph } },
});

test('a root with no size reports null, never zero — the discardable case', () => {
  const f = foldDumpEvents([dumpEvent(1, {
    malloc: { guid: 'a', attrs: { size: hex(1048576 * 10) } },
    discardable: { guid: 'b' },
  })]);
  const roots = Object.fromEntries(f.processes[0].roots.map((r: any) => [r.name, r.bytes]));
  assert.equal(roots.malloc, 1048576 * 10);
  assert.equal(roots.discardable, null, 'a missing size attribute must not become 0');
  // AND A SIZE WE CANNOT PARSE IS THE SAME ANSWER. Found by mutation: every fixture here had
  // either a good hex value or no attrs at all, so the unparseable branch was unexercised and
  // returning 0 from it survived the whole suite. Zero would put a phantom allocator on the
  // readout at exactly the moment a malformed trace needs saying out loud.
  const bad = foldDumpEvents([dumpEvent(2, {
    malloc: { guid: 'a', attrs: { size: { type: 'scalar', units: 'bytes', value: 'not-hex' } } },
    v8: { guid: 'b', attrs: { size: { type: 'scalar', units: 'bytes', value: 12 } } },
  })]);
  assert.deepEqual(bad.processes[0].roots.map((r: any) => r.bytes), [null, null]);
  const s = summariseMemDump(f, 'ramp');
  assert.equal(s.lead!.roots.find((r: any) => r.name === 'discardable').mb, null);
});

test('roots are an ARRAY, biggest first — jsonb does not preserve object key order', () => {
  // Stored as an object, `detail` came back re-sorted by key LENGTH, so a rendered fixture
  // showed `malloc · discardable · shared_memory · partition_alloc` with the 32 GB allocator
  // printed third. An array survives the round trip; the order is the reading.
  const f = foldDumpEvents([dumpEvent(1, {
    malloc: { guid: 'a', attrs: { size: hex(120 * 1048576) } },
    shared_memory: { guid: 'b', attrs: { size: hex(32774 * 1048576) } },
    partition_alloc: { guid: 'c', attrs: { size: hex(60 * 1048576) } },
    discardable: { guid: 'd' },
  })]);
  const roots = summariseMemDump(f, 'ramp').lead!.roots;
  assert.ok(Array.isArray(roots), 'an object here loses its order in jsonb');
  assert.deepEqual(roots.map((r: any) => r.name), ['shared_memory', 'malloc', 'partition_alloc', 'discardable']);
});

test('Chromium\'s own shared_memory root is carried beside our sum, as a cross-check', () => {
  // The only check available on Windows, where the probe cannot run: the two describe one
  // population, so a gap is a fold that missed mappings rather than a browser holding less.
  const f = foldDumpEvents([dumpEvent(1, {
    shared_memory: { guid: 'r', attrs: { size: hex(100 * 1048576) } },
    'shared_memory/a': { guid: 's1', attrs: { size: hex(60 * 1048576) } },
    'shared_memory/b': { guid: 's2', attrs: { size: hex(40 * 1048576) } },
  })]);
  const lead = summariseMemDump(f, 'ramp').lead!;
  assert.equal(lead.shmMb, 100);
  assert.equal(lead.shmRootMb, 100);
  assert.match(READOUT, /Chromium's own shared_memory root reads/);
});

test('only top-level names are roots — sub-dumps would double count their parent', () => {
  const f = foldDumpEvents([dumpEvent(1, {
    malloc: { guid: 'a', attrs: { size: hex(100 * 1048576) } },
    'malloc/allocated_objects': { guid: 'b', attrs: { size: hex(100 * 1048576) } },
  })]);
  assert.deepEqual(f.processes[0].roots.map((r: any) => r.name), ['malloc']);
});

test('the size buckets are the region walk\'s buckets, boundaries included', () => {
  assert.equal(sizeBucket(65535), 'lt64K');
  assert.equal(sizeBucket(65536), '64K-1M');
  assert.equal(sizeBucket(1048575), '64K-1M');
  assert.equal(sizeBucket(1048576), '1-2M');
  assert.equal(sizeBucket(2097151), '1-2M');
  // The walk's own asymmetry: `-lt` on the first two boundaries and `-le` after. A 2 MB
  // section — the whole population under investigation — must land in 2-4M and not in 1-2M.
  assert.equal(sizeBucket(2097152), '2-4M');
  assert.equal(sizeBucket(4194304), '2-4M');
  assert.equal(sizeBucket(4194305), '4-16M');
  assert.equal(sizeBucket(1073741824), '256M-1G');
  assert.equal(sizeBucket(1073741825), 'gt1G');
});

test('a swarm of 2 MB mappings lands in one bucket, counted and totalled', () => {
  const allocators: Record<string, unknown> = { shared_memory: { guid: 'root', attrs: { size: hex(2097152 * 500) } } };
  for (let i = 0; i < 500; i++) { const [k, v] = shm(`g${i}`, 2097152); allocators[k as string] = v; }
  const f = foldDumpEvents([dumpEvent(7, allocators)]);
  const p = f.processes[0];
  assert.equal(p.shmCount, 500);
  assert.deepEqual(p.buckets.map((b: any) => [b.bucket, b.n]), [['2-4M', 500]]);
  assert.equal(p.shmBytes, 2097152 * 500);
});

test('ownership names the subsystem, and it resolves across processes', () => {
  // The renderer's mapping is owned by a dump that lives in the GPU process, whose event
  // arrives AFTER. Resolution is deferred for exactly this; resolving as we stream would
  // report the real answer as unattributed.
  const renderer = dumpEvent(11, Object.fromEntries([
    shm('aaa', 4 * 1048576),
    shm('bbb', 2 * 1048576),
  ]), [
    { type: 'ownership', source: 'gpu1', target: 'aaa' },
    { type: 'ownership', source: 'disc1', target: 'bbb' },
  ]);
  const gpu = dumpEvent(12, {
    'gpu/transfer_memory/0x7f00aa': { guid: 'gpu1', attrs: { size: hex(4 * 1048576) } },
    'discardable/segment_12': { guid: 'disc1', attrs: { size: hex(2 * 1048576) } },
  });
  const f = foldDumpEvents([renderer, gpu]);
  const p = f.processes.find((x: any) => x.pid === 11)!;
  assert.deepEqual(p.owners.map((o: any) => [o.owner, o.n]), [
    ['gpu/transfer_memory', 1],
    ['discardable/segment', 1],
  ]);
  assert.equal(p.unowned.n, 0);
});

test('an unresolvable owner is reported as one, never dropped', () => {
  const f = foldDumpEvents([dumpEvent(11, Object.fromEntries([shm('aaa', 8 * 1048576)]), [
    { type: 'ownership', source: 'never-seen', target: 'aaa' },
  ])]);
  const p = f.processes[0];
  assert.deepEqual(p.owners.map((o: any) => o.owner), ['(owner in another process)']);
  assert.equal(p.owners[0].bytes, 8 * 1048576);
  // It is owned — by somebody we could not name — so it must not ALSO be counted as unowned.
  assert.equal(p.unowned.n, 0);
});

test('a mapping with no ownership edge at all is its own line', () => {
  const f = foldDumpEvents([dumpEvent(11, Object.fromEntries([shm('aaa', 3 * 1048576)]))]);
  assert.deepEqual(f.processes[0].owners, []);
  assert.deepEqual(f.processes[0].unowned, { n: 1, bytes: 3 * 1048576 });
});

test('ownerKey collapses per-object ids and keeps the subsystem', () => {
  assert.equal(ownerKey('discardable/segment_4'), 'discardable/segment');
  assert.equal(ownerKey('gpu/transfer_memory'), 'gpu/transfer_memory');
  assert.equal(ownerKey('gpu/shared_images/0x7f0011aa22'), 'gpu/shared_images');
  assert.equal(ownerKey('malloc'), 'malloc');
  assert.equal(ownerKey(''), '(unnamed)');
});

test('the lead process is the biggest shared-memory holder, which is the one the walk walked', () => {
  const small = dumpEvent(1, Object.fromEntries([shm('a', 1048576)]));
  const big = dumpEvent(2, Object.fromEntries([shm('b', 900 * 1048576)]));
  const f = foldDumpEvents([small, big]);
  assert.equal(f.processes[0].pid, 2);
  assert.equal(summariseMemDump(f, 'ramp').lead!.pid, 2);
});

test('the main thread name is relayed from Chromium, not derived', () => {
  const f = foldDumpEvents([
    { ph: 'M', pid: 5, name: 'thread_name', args: { name: 'Compositor' } },
    { ph: 'M', pid: 5, name: 'thread_name', args: { name: 'CrRendererMain' } },
    dumpEvent(5, { malloc: { guid: 'a', attrs: { size: hex(1) } } }),
  ]);
  assert.equal(f.processes[0].mainThread, 'CrRendererMain');
});

test('the detail stays far under the cap even for a 16k-mapping renderer — over it is DROPPED, not truncated', () => {
  // cleanDetail returns NULL above MAX_DETAIL_CHARS, so an over-large summary does not lose
  // its tail, it loses the whole reading while looking like it was never taken. That is the
  // shape that made `notePlatform` invisible for weeks, one table over.
  const allocators: Record<string, unknown> = {};
  for (let i = 0; i < 16_387; i++) { const [k, v] = shm(`g${i}`, 2097152); allocators[k as string] = v; }
  const events = [dumpEvent(99, allocators)];
  for (let pid = 0; pid < 12; pid++) events.push(dumpEvent(pid, { malloc: { guid: `m${pid}`, attrs: { size: hex(1048576) } } }));
  const f = foldDumpEvents(events);
  const detail = JSON.stringify(summariseMemDump(f, 'ramp'));
  assert.ok(detail.length < MAX_DETAIL_CHARS / 4, `detail was ${detail.length} chars`);
  // And the rendering carries the per-process facts without one line per mapping.
  const text = renderMemDump(f);
  assert.ok(text.split('\n').length < 200, `text was ${text.split('\n').length} lines`);
  assert.match(text, /MDHIST pid=99 2-4M \d+MB count=16387/);
});

// ── takeMemoryDump: the CDP dance, and every way it can refuse ──────────────────────────────

const fakeCdp = (opts: { events?: unknown[]; refuse?: boolean; hangOn?: string } = {}) => {
  const listeners = new Map<string, Set<(a: unknown) => void>>();
  const calls: string[] = [];
  // A hang that can be let go of. Left genuinely unresolvable it survives the test and node's
  // runner cancels every test after it — which is how this stub cost twelve of them once.
  const hung: Array<() => void> = [];
  const api = {
    calls,
    listenerCount: () => (listeners.get('Tracing.dataCollected')?.size ?? 0),
    release() { for (const f of hung.splice(0)) f(); },
    on(ev: string, fn: (a: unknown) => void) { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(fn); },
    off(ev: string, fn: (a: unknown) => void) { listeners.get(ev)?.delete(fn); },
    once(ev: string, fn: (a: unknown) => void) { api.on(ev, fn); },
    emit(ev: string, a: unknown) { for (const fn of [...(listeners.get(ev) ?? [])]) fn(a); },
    async send(method: string, _p?: unknown) {
      calls.push(method);
      if (opts.hangOn === method) return await new Promise((resolve) => hung.push(() => resolve({})));
      if (method === 'Tracing.requestMemoryDump') {
        api.emit('Tracing.dataCollected', { value: opts.events ?? [] });
        return { dumpGuid: '0x1', success: opts.refuse ? false : true };
      }
      if (method === 'Tracing.end') { queueMicrotask(() => api.emit('Tracing.tracingComplete', {})); return {}; }
      return {};
    },
  };
  return api;
};

test('no session is a named refusal, not an empty reading', async () => {
  const r = await takeMemoryDump(null);
  assert.equal(r.ok, false);
  assert.match(r.why!, /no CDP session/);
});

test('a happy dump folds, ends tracing and removes its listener', async () => {
  const cdp = fakeCdp({ events: [dumpEvent(3, Object.fromEntries([shm('a', 2097152)]))] });
  const r = await takeMemoryDump(cdp as never);
  assert.equal(r.ok, true);
  assert.equal(r.folded!.processes[0].shmCount, 1);
  assert.deepEqual(cdp.calls, ['Tracing.start', 'Tracing.requestMemoryDump', 'Tracing.end']);
  // Leaving the listener attached would accumulate one per dump on a session shared with the
  // heap trail and the alloc trail for the life of the browser.
  assert.equal(cdp.listenerCount(), 0);
});

test('Chromium refusing the dump is reported as a refusal, not as "no shared memory"', async () => {
  const cdp = fakeCdp({ refuse: true });
  const r = await takeMemoryDump(cdp as never);
  assert.equal(r.ok, false);
  assert.match(r.why!, /refused/);
});

test('a throw from the browser is a reason, never an exception the timer must catch', async () => {
  const cdp = { on() {}, off() {}, once() {}, send: async () => { throw new Error('Target closed\nstack'); } };
  const r = await takeMemoryDump(cdp as never);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'Target closed');
});

test('a timeout WITH data is still a reading — the dump arrives before tracingComplete', async () => {
  // The events land on `Tracing.requestMemoryDump`; only the teardown hangs. Reporting nothing
  // here would throw away the one reading the module exists to take, on precisely the browser
  // it was built for — one that is struggling.
  const cdp = fakeCdp({ events: [dumpEvent(4, Object.fromEntries([shm('a', 2097152)]))], hangOn: 'Tracing.end' });
  const p = takeMemoryDump(cdp as never, { timeoutMs: 40 });
  // Let the hung teardown go before the cleanup bound expires, so this test measures the
  // reading rather than MEM_DUMP_CLEANUP_MS.
  setTimeout(() => cdp.release(), 60);
  const r = await p;
  assert.equal(r.ok, true);
  assert.match(r.partial!, /no answer in 40ms/);
  assert.equal(r.folded!.processes[0].shmCount, 1);
});

test('a hung teardown cannot pin the caller — the cleanup is bounded too', { timeout: 15_000 }, async () => {
  // Without the bound the `finally` awaits a browser already established as not answering, so
  // this promise never settles and the caller's in-flight flag never clears: the instrument
  // would fire once per browser life and report nothing ever again. Found by these guards.
  assert.ok(MEM_DUMP_CLEANUP_MS >= 1_000 && MEM_DUMP_CLEANUP_MS <= 10_000);
  const cdp = fakeCdp({ events: [dumpEvent(4, Object.fromEntries([shm('a', 2097152)]))], hangOn: 'Tracing.end' });
  const started = Date.now();
  const r = await takeMemoryDump(cdp as never, { timeoutMs: 40 });
  assert.equal(r.ok, true, 'it must still resolve, with the data it did get');
  assert.ok(Date.now() - started < MEM_DUMP_CLEANUP_MS + 2_000, 'the cleanup ran to its bound and stopped');
  cdp.release();
});

test('a timeout with NO data refuses rather than reporting an empty browser', async () => {
  const cdp = fakeCdp({ hangOn: 'Tracing.start' });
  const r = await takeMemoryDump(cdp as never, { timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.match(r.why!, /no answer in 40ms/);
  cdp.release();
});

test('the default timeout is bounded on both sides', () => {
  assert.ok(MEM_DUMP_TIMEOUT_MS >= 5_000, 'too short to survive a struggling browser');
  assert.ok(MEM_DUMP_TIMEOUT_MS <= 60_000, 'long enough to be a hang rather than a bound');
});

// ── The wiring, which is the half that is otherwise inert ────────────────────────────────────

test('the kind is allow-listed, or the row stores with kind NULL and never reaches the readout', () => {
  assert.ok((BOT_EVENT_KINDS as readonly string[]).includes('mem-dump'));
});

test('the dump is fired from the watchdog TIMER, not the loop body', () => {
  const timer = KW.indexOf('const renew = setInterval(() => {\n      const stalledMs');
  assert.ok(timer > -1, 'the watchdog timer moved — re-anchor this guard');
  const call = KW.indexOf('maybeMemoryDump(memory);');
  assert.ok(call > timer, 'a check in the loop body cannot run while the loop is stalled, which is every ramp');
});

test('it uses the SAME reading as the ramp arm, at its own threshold', () => {
  // INVERTED 2026-09-07, NOT RELAXED — this guard REQUIRED the bug. It asserted
  // `memory.rcMb > RAMP_MB`, i.e. that the dump share the arm's threshold, on the reasoning
  // that "two comparisons one megabyte apart put the dump and the bail on different sides of
  // one event". The premise is right and the conclusion was wrong: sharing the threshold does
  // not put them on one side of the event, it puts them on the SAME TICK — and the arm
  // `return`s before the dump is called, so the dump never ran on the first ramp anybody
  // ordered. Same shape as held-offer-scope, where a test required the storm.
  //
  // What still matters is the READING: one `memory` object, so the two arms cannot disagree
  // about which event they are looking at. That half is kept verbatim.
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /memory\.rcMb > MEM_DUMP_RAMP_MB/, 'the dump must compare against its own, lower threshold');
  assert.doesNotMatch(fn, /memory\.rcMb > RAMP_MB/, 'sharing the arm\'s threshold is the 2026-09-07 race');
  assert.ok(!/readLatestMemory/.test(fn), 'it must be handed the arm\'s reading, not take a second one');
});

test('it is never inside reportAndBail — the bail\'s budget is what loses a cart', () => {
  // THE FIRST HALF OF THIS GUARD WAS DROPPED 2026-09-08, AND IT IS THE SECOND HALF THAT WAS
  // ever load-bearing. It asserted the dump call sits AFTER `reportAndBail(rampBailLine(ramp)`
  // in source order, which was a restatement of "only the threshold creates the gap" — the
  // premise falsified twice below. The grace deliberately starts the dump before that call on
  // the firing tick, so the old assertion would now require the regression.
  //
  // What still matters, and is not negotiable: the dump must not sit INSIDE `reportAndBail`.
  // That path releases the profile lock, and the lock held past 08:00 is what loses a cart.
  // The grace holds the whole bail for a bounded tick instead, which is a different thing:
  // the exit is delayed, never lengthened.
  // BOUNDED ON CODE, NOT ON A COMMENT. The first version of this line ended the slice at the
  // string 'THE WEDGE ARM' — which `code()` has already stripped, so indexOf returned -1, the
  // slice ran to the end of the file and swallowed the call site it was checking was absent.
  // The recorded shape, caught on the first run.
  //
  // AND IT IS BOUNDED ON THE FUNCTION'S OWN CLOSER, NOT ON THE NEXT ARM. It ended at the wedge
  // arm until 2026-09-08, which made the slice cover everything between the definition and
  // that arm — so the stall trigger, added in the gap and correctly OUTSIDE `reportAndBail`,
  // failed a guard whose rule it does not break. A slice between two anchors is broken by
  // anything inserted between them, silently and in whichever direction; the same shape
  // already cost `concurrent-mint.test.mts` a vacuous pass. The rule is unchanged and is not
  // weakened: the dump must not sit inside this function.
  const bodyStart = KW.indexOf('const reportAndBail = (');
  const bodyEnd = KW.indexOf('\n      };', bodyStart);
  assert.ok(bodyStart > -1 && bodyEnd > bodyStart, 'reportAndBail moved — re-anchor this guard');
  const reportBody = KW.slice(bodyStart, bodyEnd);
  assert.ok(!/maybeMemoryDump|takeMemoryDump/.test(reportBody), 'a multi-second dump must not sit on the path that releases the profile lock');
});

test('fire-and-forget with an in-flight flag — the timer must never await', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /void takeMemoryDump\(/, 'awaiting it would stall the one thing still executing during a ramp');
  assert.match(fn, /if \(memDump\.inFlight[^)]*\) return;/, 'without the flag a slow dump queues one per tick');
  assert.match(fn, /finally\(\(\) => \{ memDump\.inFlight = false; \}\)/);
});

test('each phase fires at most once per BROWSER life, and the flags reset with the browser', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /if \(memDump\[phase\]\) return;/);
  const open = KW.indexOf('residentPage = page;');
  // ANCHORED ON THE PREFIX, not the whole literal: adding a field to it (`graceUntil`,
  // 2026-09-08) invalidated the exact-match version over unchanged behaviour, which is the
  // re-anchoring tax this repo has paid twenty-odd times. What matters is that the three
  // phase flags are reset with the browser, not the literal's punctuation.
  const reset = KW.indexOf('memDump = { baseline: false, ramp: false, inFlight: false', open);
  assert.ok(reset > open && reset - open < 600, 'the reset must sit with the browser-life marker, or last life\'s baseline describes nothing');
  // Unconditional, on its own line: a bare match also accepts `if (!browserLifeSince) ...`,
  // which latches on the first browser and never resets. Verified by mutation 2026-09-07.
  assert.match(KW.slice(open, reset + 200), /\n\s*browserLifeSince = Date\.now\(\);/);
});

test('a refusal does not spend the phase — it is not a reading', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  const bad = fn.indexOf('if (!r.ok)');
  assert.ok(bad > -1);
  assert.match(fn.slice(bad, bad + 400), /memDump\[phase\] = false;/);
});

test('the baseline waits for a browser that has loaded RC; the ramp reading never waits', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /if \(!over && Date\.now\(\) - browserLifeSince < MEM_DUMP_BASELINE_AFTER_MS\) return;/);
});

test('the readout renders it, and BOTH verdict branches are there', () => {
  assert.match(READOUT, /recentBotEvents\('mem-dump'/);
  assert.match(READOUT, /MEMORY DUMPS:/);
  // The small reading is an ANSWER — it retires discardable, mojo and the GPU transfer path
  // together — so a readout that only knows how to celebrate a big one is half an instrument.
  assert.match(READOUT, /the sections ARE base shared memory/);
  // ANCHORED ON THE LINE THAT CARRIES THE NUMBER, not on the paragraph below it. The first
  // version matched `NOT base shared memory` — a later line the mutation did not touch — so
  // deleting the small-reading verdict left the guard green. A guard that matches a
  // neighbouring sentence is measuring the neighbour.
  assert.match(READOUT, /only \$\{lead\.shmMb\} MB of tracked shared memory/);
  assert.match(READOUT, /NOT base shared memory/);
  // The one false elimination this instrument can manufacture: the dump is coordinated by the
  // browser process, so a renderer that will not answer is MISSING from it rather than empty —
  // and a missing contribution read as a small one retires three candidates on nothing.
  assert.match(READOUT, /MISSING/);
  /**
   * THE JOIN IS DONE, NOT ASKED FOR (2026-09-08). This asserted the instruction
   * `Join on the pid in the ramp-scan's region walk` — and the first time it mattered nobody
   * did: the 09-07 dump measured a browser five seconds old and its `shared_memory 2 MB` was
   * one sentence from being written up as an elimination. The readout now joins the walk's
   * target pid against the dump's own process list and SUPPRESSES the verdict when they
   * disagree, so the assertion moves to the mechanism rather than to the request.
   *
   * UPDATED, NOT RELAXED: the void branch is pinned here and again in
   * src/lib/leak-capture.test.mts, which drives the decision directly.
   */
  assert.match(READOUT, /dumpJoinReading\(/);
  assert.match(READOUT, /join\.kind === 'void'/);
  // And an empty table must say what absence means rather than reading as "no leak".
  assert.match(READOUT, /Ordinary until the box runs rc-mem-dump\.mjs/);
});

// ── The dump's head start is a THRESHOLD, not the bail's extra stall condition ─────────────
//
// It shared RAMP_MB until 2026-09-07 and argued that the ramp arm's additional 120s-stall
// condition put the dump ~2 minutes ahead of the exit. THAT WAS FALSE, and it cost the first
// forced ramp its owner column: the loop stalls the instant the Okta trip begins, so by the
// time the family crosses the bar the stall is already minutes old, both arms go true on one
// tick, and `maybeMemoryDump` sits AFTER the arm's `return` and is never called.
//
//     20:42:23  ramp-scan       rc 4805 MB, walk complete
//     20:42:24  request-counts  reason=bail:ramp
//               (no mem-dump, on the one ramp anybody had ordered)

function envDefault(code: string, name: string): number {
  // See keepwarm-diagnosis.test.mts: a bare (\d+) stops at the underscore in 60_000 and a
  // [\d_]+ stops at the space in `40 * 60_000`. Both have silently read the wrong number here.
  const m = new RegExp(`${name} \\|\\| ([\\d_ *]+?)\\s*\\)`).exec(code);
  assert.ok(m, `no default found for ${name}`);
  const factors = m![1].split('*').map((x) => Number(x.trim().replace(/_/g, '')));
  assert.ok(factors.every(Number.isFinite), `could not parse the default for ${name}: ${m![1]}`);
  return factors.reduce((a, b) => a * b, 1);
}

test('the dump fires below the bail, or the arm races it away', () => {
  const dump = envDefault(KEEPWARM, 'RC_MEM_DUMP_RAMP_MB');
  const bail = envDefault(KEEPWARM, 'RC_KEEPWARM_RAMP_MB');
  assert.ok(dump < bail,
    `the dump threshold (${dump}) must be STRICTLY below the bail's (${bail}) — equal is the `
    + '2026-09-07 race, where the dump was never called at all');
  // Bounded from below too: the family idles at 200-330 MB, so a threshold near that fires on
  // every ordinary tick and buries the reading it exists to take.
  assert.ok(dump > 800, `${dump} is close enough to the idle baseline to fire on nothing`);
  // And it must still be a RAMP. The onset takes the family past 2,800 MB inside one two-
  // minute sampler tick, so anything at or above that has no head start left to give.
  assert.ok(dump <= 2500, `${dump} is too close to the onset's own climb to buy a tick`);
});

test('the dump reads its OWN threshold, not the bail\'s', () => {
  const from = KW.indexOf('const maybeMemoryDump');
  assert.ok(from > -1, 'maybeMemoryDump must exist — anchor not found');
  const to = KW.indexOf('const renew = setInterval', from);
  assert.ok(to > from, 'the end anchor must be found AFTER the start');
  const body = KW.slice(from, to);
  assert.match(body, /memory\.rcMb > MEM_DUMP_RAMP_MB/,
    'the phase must be decided by the dump\'s own threshold');
  assert.doesNotMatch(body, /memory\.rcMb > RAMP_MB/,
    'sharing RAMP_MB is the regression — the arm returns before this is reached');
});

// ── AND THE THRESHOLD ALONE CANNOT BUY THE GAP EITHER — the grace is what does ─────────────
//
// INVERTED 2026-09-08, NOT RELAXED. The guard here asserted "the bail still returns before the
// dump, so ONLY the threshold creates the gap", which is the premise the third consecutive
// missed ramp falsified. `MEM_DUMP_RAMP_MB` (1500) is a gap measured in MEGABYTES and PAID IN
// SAMPLER TICKS: both arms read one file that `bot.mjs` writes every two minutes, so a lower
// threshold only helps when a SAMPLE lands between the two numbers. On 2026-09-08 none did:
//
//     09:01:10  rc =   238 MB   commit  7,273 / 17,150
//     09:03:11  rc = 3,423 MB   commit 43,760 / 44,960   <- the only sample of the whole ramp
//     09:05:11  rc =   205 MB   commit  7,000 / 17,150
//
// Onset, peak and bail inside ONE interval — ≥1,580 MB/min against the ~850 the gap was sized
// for. The single reading above 1500 was also above 3000, both arms went true on that tick,
// and `maybeMemoryDump` sat after the arm's `return` exactly as it did on 09-07. Moving the
// number left the mechanism, which is the shape #296 was itself written to end.
//
// The threshold is KEPT — it still wins the ~half of ramps where a sample does land in the gap,
// and it takes the dump while the browser is healthier. It is simply not sufficient.

test('the bail grants the dump a bounded grace, because the threshold cannot guarantee a tick', () => {
  const arm = KW.indexOf('if (ramp.fire)');
  assert.ok(arm > -1, 'the ramp arm moved — re-anchor this guard');
  const armEnd = KW.indexOf("reportAndBail(rampBailLine(ramp)", arm);
  assert.ok(armEnd > arm, 'the ramp arm no longer bails — re-anchor this guard');
  const block = KW.slice(arm, armEnd);
  assert.match(block, /rampDumpGrace\(\{/, 'the firing tick must consult the grace before it bails');
  assert.match(block, /if \(grace\.hold\) \{/, 'a granted grace must actually hold the bail');
  // BOTH FACTS, OR THE PURE FUNCTION IS PERFECT AND UNREACHABLE. `rampDumpGrace` cannot see an
  // in-flight dump the caller does not tell it about, and every behavioural guard above calls
  // it directly — so a call site that drops `dumpInFlight` restores the 2026-09-08 bug with the
  // whole suite green. Fix-present-and-inert, pinned structurally.
  assert.match(block, /dumpStarted: memDump\.ramp,/, 'the grace must be told the ramp dump has started');
  assert.match(block, /dumpInFlight: memDump\.inFlight,/,
    'the grace must be told the dump is still running, or it bails the tick after it starts');
  assert.match(block, /\n\s*maybeMemoryDump\(memory\);/,
    'the held tick must START the dump, or the grace buys a delay and no reading');
  assert.match(block, /return;/, 'a held tick must not fall through into the bail on the same tick');
});

test('the grace is stored and reset with the browser life, so it cannot be granted twice', () => {
  assert.match(KW, /memDump\.graceUntil = grace\.until;/, 'the deadline must be stored, or every tick re-grants it');
  // Reset WITH the browser, like the two phase flags: a deadline carried across a reopen would
  // deny the next browser its grace on the strength of the last one's.
  const open = KW.indexOf('residentPage = page;');
  const reset = KW.indexOf('graceUntil: null', open);
  assert.ok(reset > open && reset - open < 600, 'the grace deadline must reset with the browser life');
});

test('the dump call after the arm survives, and it is REACHABLE', () => {
  // Every guard here anchors with indexOf, which matches just as happily inside
  // `if (false) maybeMemoryDump(memory);` — verified: that mutation passed all 33 tests. So the
  // statement is pinned as a BARE statement on its own line. Fix-present-and-inert, caught in
  // the guard written to stop the previous instance of it.
  assert.match(KW, /\n\s*maybeMemoryDump\(memory\);/,
    'the dump must be called unconditionally, not from behind a condition');
  // The non-firing tick still takes it: the grace covers the tick where the arm fires, and the
  // ordinary case — a sample that DOES land in the gap — is still this call.
  const armEnd = KW.indexOf("reportAndBail(rampBailLine(ramp)");
  assert.ok(KW.indexOf('maybeMemoryDump(memory);', armEnd) > armEnd,
    'the call below the arm is what fires when a sample lands in the threshold gap');
});

// ── THE PROBES — nothing runs them, so nothing notices when they rot ───────────────────────
//
// `ramp-arm-probe.mjs` reproduces the 09-08 07:47 miss in a container in seconds; the whole
// point is that the trigger path stops needing a ramp to test. But no CI job runs it (it needs
// a Chromium and a sandbox), so it can break silently and be discovered the next time somebody
// reaches for it — which is exactly when they cannot afford to debug it.
//
// This does not run the probes. It checks the two ways they go quietly dead: a syntax error,
// and the import somebody "fixes" to match the neighbours.

test('the leak probes parse and keep their deliberate playwright-core import', () => {
  const probes = ['ramp-arm-probe.mjs', 'mapped-memory-repro.mjs', 'mem-dump-probe.mjs', 'alloc-trail-probe.mjs'];
  let checked = 0;
  for (const name of probes) {
    const url = new URL(`../scripts/auto-cart-bot/${name}`, import.meta.url);
    const src = readFileSync(url, 'utf8');
    // `playwright-core` is the repo's devDependency; the box has the full package. A probe
    // switched to bare `playwright` stops running in the one place it is useful, and the
    // headers of all four say so. Asserted rather than trusted to a comment.
    assert.match(src, /from 'playwright-core'/,
      `${name} must import playwright-core — bare 'playwright' is not installed in the sandbox`);
    assert.doesNotMatch(src, /from 'playwright'/, `${name} imports bare playwright`);
    // A syntax error makes it useless and nothing else would notice.
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name} does not parse: ${r.stderr}`);
    checked++;
  }
  // PER FILE, so a probe deleted or renamed fails here rather than shrinking the loop to zero
  // and passing — the vacuous-guard shape this file has recorded more than once.
  assert.equal(checked, probes.length, 'a probe went missing — this guard must not silently shrink');
});

// ── THE STALL TRIGGER — the reading taken before the worst moment, not at it ────────────────
//
// Four ramps were lost to a trigger gated on `.memory-latest.json`, which another process
// writes every two minutes: the reading was about the dead browser (09-07 02:03), the bail
// raced it (09-07 20:42), no sample landed in the threshold gap (09-08 02:03), the grace held
// one tick of a twenty-second budget (09-08 07:47). Each fix was right and each cost 5-28
// hours, because the trigger can only be exercised by a ramp.
//
// The stall is a local number this timer sets. It is never UNKNOWN, never stale, never about
// another browser, and cannot be crossed between two samples — so none of the four can reach
// it. Same rule the memory sampler, the heap trail and the RAM trail were all built on and
// which was never applied to the dump: a SERIES beats an observation taken at the worst moment.

test('the stall trigger fires the ramp dump and reads NO memory figure', () => {
  assert.match(KW, /if \(stalledMs > MEM_DUMP_STALL_MS\) \{\s*\n\s*maybeMemoryDump\(null, 'ramp'\);/,
    'the stall trigger must force the ramp phase with no memory reading — a trigger that '
    + 'consults the sampler file inherits all four failure modes it exists to escape');
});

test('it runs BEFORE the wedge arm, or a return can race it exactly as 09-07 did', () => {
  const trigger = KW.indexOf('if (stalledMs > MEM_DUMP_STALL_MS)');
  const wedge = KW.indexOf('if (stalledMs > HUNG_MS && !bailing) {');
  const rampArm = KW.indexOf('const ramp = rampBailDecision({');
  assert.ok(trigger > -1, 'the stall trigger is gone');
  assert.ok(wedge > trigger, 'the stall trigger must precede the wedge arm');
  assert.ok(rampArm > trigger, 'the stall trigger must precede the ramp arm');
});

test('the stall threshold is above the longest healthy trip and below the bail', () => {
  const stall = envDefault(KEEPWARM, 'RC_MEM_DUMP_STALL_MS');
  const bail = envDefault(KEEPWARM, 'RC_KEEPWARM_RAMP_STALL_MS');
  // ABOVE 75s: the longest renewal in forty recorded tab-closes is 71.5s, so an ordinary trip
  // must not reach this and spend a reading on a healthy browser.
  assert.ok(stall >= 75_000, `${stall}ms fires on ordinary renewals, which run to 71.5s`);
  // BELOW the bail's stall, or there is no head start at all and this is the 09-07 race again.
  assert.ok(stall < bail, `${stall}ms must precede the bail arm's ${bail}ms or the dump is raced away`);
});

test('the ramp budget resets per STALL EPISODE, so a slow healthy trip cannot spend it', () => {
  // A once-per-browser-life budget would let one unusually slow trip take the slot and leave
  // the real ramp with nothing — the fix creating the failure it was built to remove.
  const block = KW.slice(KW.indexOf('if (stalledMs > MEM_DUMP_STALL_MS)'), KW.indexOf('if (stalledMs > HUNG_MS && !bailing) {'));
  assert.match(block, /else if \(!memDump\.inFlight && memDump\.ramp\) \{/,
    'the reset must be guarded on inFlight — re-arming a dump underneath itself is not a reset');
  assert.match(block, /memDump\.ramp = false;/, 'the ramp flag must reset when the loop advances');
  assert.match(block, /memDump\.landed = false;/, 'landed must reset with it or the expiry line goes quiet for ever');
  assert.match(block, /memDump\.graceUntil = null;/, 'a deadline carried into the next episode denies it its grace');
  // THE BASELINE IS A CONTROL AND IS ONCE PER BROWSER. Resetting it here would take one every
  // long trip, which is noise in the table the ramp row is read against.
  assert.doesNotMatch(block, /memDump\.baseline = false;/,
    'the baseline is once per browser life — resetting it per stall makes the control noise');
});

test('a forced phase bypasses the memory reading, and an unforced call still needs one', () => {
  const body = KW.slice(KW.indexOf('const maybeMemoryDump = ('), KW.indexOf('const renew = setInterval(() => {'));
  assert.match(body, /maybeMemoryDump = \(memory, forcedPhase = null\)/, 'the forced phase parameter is gone');
  assert.match(body, /if \(!forcedPhase && !memory\?\.known\) return;/,
    'a forced phase must not require a memory reading — that requirement IS the four misses');
  assert.match(body, /const phase = forcedPhase \?\? /,
    'the forced phase must decide the phase, or the stall trigger silently files a ramp as a baseline');
});

// ── The grace itself ───────────────────────────────────────────────────────────────────────

test('a firing tick with no dump yet HOLDS, and names the deadline it just set', () => {
  const g = rampDumpGrace({ now: 1_000, dumpStarted: false, dumpInFlight: false, graceUntil: null, canDump: true, graceMs: 15_000 });
  assert.equal(g.hold, true);
  assert.equal(g.started, true, 'the first hold must report that it started the grace');
  assert.equal(g.until, 16_000);
});

// INVERTED 2026-09-08, NOT RELAXED — this guard REQUIRED the bug, which is the
// `held-offer-scope` shape. It asserted that a dump which had STARTED stopped the hold, on the
// premise that a dump costs ~200ms (the healthy-path baseline). During a ramp the browser
// answers no CDP call in 3000ms, so the very next tick bailed and `process.exit` threw the
// accumulator away — ten seconds into a twenty-second budget, with no line either way. A dump
// is TAKEN when it has started and finished, and the hold is what waits for that.
test('a dump IN FLIGHT holds the bail — the grace is a wait, not a permission slip', () => {
  const g = rampDumpGrace({ now: 11_000, dumpStarted: true, dumpInFlight: true, graceUntil: 16_000, canDump: true });
  assert.equal(g.hold, true, 'bailing while the dump is still running is what lost four ramps');
  assert.equal(g.started, false, 'a continued hold must not look like a fresh grant');
  assert.equal(g.until, 16_000, 'the deadline must not be pushed out — that is an unbounded hold');
  assert.match(g.why, /waiting for the ramp dump/);
});

test('a dump that started AND finished stops the hold — that is the ordinary path', () => {
  const g = rampDumpGrace({ now: 11_000, dumpStarted: true, dumpInFlight: false, graceUntil: 16_000, canDump: true });
  assert.equal(g.hold, false);
  assert.match(g.why, /has been taken/);
});

test('a refusal is retried inside the deadline — that is why it is not one tick', () => {
  // `maybeMemoryDump` puts the phase back on a refusal, and a BASELINE dump can be in flight
  // when the arm fires: the baseline is due three minutes into a browser life and every
  // burst-carrying ramp so far has landed in a browser 2-3 minutes old.
  const g = rampDumpGrace({ now: 11_000, dumpStarted: false, dumpInFlight: false, graceUntil: 16_000, canDump: true });
  assert.equal(g.hold, true);
  assert.equal(g.started, false, 'a continued hold must not look like a fresh grant');
  assert.equal(g.until, 16_000, 'the deadline must not be pushed out — that is an unbounded hold');
});

test('the deadline BINDS — an expired grace bails and says the reading was lost', () => {
  const g = rampDumpGrace({ now: 99_000, dumpStarted: false, dumpInFlight: false, graceUntil: 16_000, canDump: true });
  assert.equal(g.hold, false);
  assert.match(g.why, /expired/, 'a grace that ran and bought nothing must be distinguishable from one never granted');
});

test('the deadline binds a dump still in flight too, and says which expiry it was', () => {
  // It CAN delay the bail and must never prevent it: a browser that will not answer inside its
  // own timeout does not get to hold the profile lock indefinitely.
  const g = rampDumpGrace({ now: 99_000, dumpStarted: true, dumpInFlight: true, graceUntil: 16_000, canDump: true });
  assert.equal(g.hold, false, 'an in-flight dump must not outlast the deadline');
  assert.match(g.why, /still in flight/,
    'a browser too slow to answer and a dump that never started are different findings');
});

test('no CDP probe means no hold — there is nothing to wait for', () => {
  const g = rampDumpGrace({ now: 1_000, dumpStarted: false, dumpInFlight: false, graceUntil: null, canDump: false });
  assert.equal(g.hold, false);
  assert.equal(g.until, null);
});

test('the grace cannot outlast the wedge it exists to pre-empt', () => {
  // ONE DEFINITION: the keep-warm must fall back to the module's default rather than carry a
  // number of its own. Two copies of a bound is how `nextHoldRelease` came to disagree with
  // `dueHolds`, and `envDefault` cannot read a symbol, so this is asserted rather than parsed.
  assert.match(KW, /RC_MEM_DUMP_GRACE_MS \|\| MEM_DUMP_GRACE_MS_DEFAULT/,
    'the grace default must come from ramp-bail.mjs, not from a second literal here');
  const grace = MEM_DUMP_GRACE_MS_DEFAULT;
  const tick = envDefault(KEEPWARM, 'RC_KEEPWARM_WATCHDOG_MS');
  // Longer than one tick, or the retry arm above can never run and a baseline in flight eats
  // the whole grace.
  assert.ok(grace > tick, `${grace}ms must exceed one ${tick}ms tick or the refusal can never be retried`);
  // And short enough that the profile lock is not meaningfully later. The bail's own
  // diagnostics already cost 2-8s against a stall that is 120s old by definition; three ticks
  // is the ceiling at which this stops being a rounding error on that.
  assert.ok(grace <= 3 * tick, `${grace}ms holds the profile lock too long — the lock past 08:00 is what loses a cart`);
});

// THE PAIRING NOTHING CHECKED, AND IT IS THE ONE THAT DECIDES WHETHER A READING IS POSSIBLE.
// The guard above bounds the grace against the TICK. The grace shipped at 15_000 against a
// `MEM_DUMP_TIMEOUT_MS` of 20_000 — two constants with no stated relationship, ordered the
// wrong way round — so the bail was always going to kill a dump that was still inside its own
// budget, and on 2026-09-08 it did. A guard on the wrong pairing is how that goes unnoticed.
test('the grace covers the dump\'s OWN timeout, or the bail kills a dump that would have answered', () => {
  assert.ok(
    MEM_DUMP_GRACE_MS_DEFAULT >= MEM_DUMP_TIMEOUT_MS,
    `a ${MEM_DUMP_GRACE_MS_DEFAULT}ms grace cannot wait out a ${MEM_DUMP_TIMEOUT_MS}ms dump — `
    + 'the exit would discard an accumulator that was still filling',
  );
  // DERIVED, not a second literal that happens to be big enough today. Raising the dump's
  // timeout must raise the wait with it; two numbers kept in step by hand is the failure above.
  const src = readFileSync(new URL('../scripts/auto-cart-bot/ramp-bail.mjs', import.meta.url), 'utf8');
  assert.match(src, /MEM_DUMP_GRACE_MS_DEFAULT = MEM_DUMP_TIMEOUT_MS/,
    'the grace default must be derived from the dump timeout, not written beside it');
});

test('the bail names a grace that bought nothing, and knows a landed reading from a started one', () => {
  // `!memDump.ramp` is "no dump was STARTED". The 2026-09-08 case — started, then killed in
  // flight — is exactly the one it cannot see, so the bail printed no line at all about a
  // grace it had just spent. `landed` is set on a dump that produced a reading.
  assert.match(KW, /if \(grace\.until != null && !memDump\.landed\) log\(/,
    'the expiry line must gate on a LANDED reading, not on a dump having been started');
  assert.match(KW, /if \(phase === 'ramp'\) memDump\.landed = true;/,
    'nothing sets `landed`, so the expiry line would fire on every successful ramp dump');
  // Reset with the browser life, like the two phase flags and the deadline beside them.
  const open = KW.indexOf('residentPage = page;');
  const reset = KW.indexOf('landed: false', open);
  assert.ok(reset > open && reset - open < 600, '`landed` must reset with the browser life');
});
