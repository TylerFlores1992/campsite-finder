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
import {
  foldDumpEvents, summariseMemDump, renderMemDump, takeMemoryDump, ownerKey, sizeBucket,
  MEM_DUMP_TIMEOUT_MS, MEM_DUMP_CLEANUP_MS,
} from '../scripts/auto-cart-bot/rc-mem-dump.mjs';
import { MAX_DETAIL_CHARS, BOT_EVENT_KINDS } from '../src/lib/bot-events';

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

test('it uses the SAME reading and the SAME comparison as the ramp arm', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /memory\.rcMb > RAMP_MB/, 'two comparisons one megabyte apart put the dump and the bail on different sides of one event');
  assert.ok(!/readLatestMemory/.test(fn), 'it must be handed the arm\'s reading, not take a second one');
});

test('it fires BEFORE the bail, not inside it — the bail\'s budget is what loses a cart', () => {
  const call = KW.indexOf('maybeMemoryDump(memory);');
  const bailArm = KW.indexOf("reportAndBail(rampBailLine(ramp)");
  assert.ok(bailArm > -1 && call > bailArm, 'expected the dump after the ramp arm returns');
  // BOUNDED ON CODE, NOT ON A COMMENT. The first version of this line ended the slice at the
  // string 'THE WEDGE ARM' — which `code()` has already stripped, so indexOf returned -1, the
  // slice ran to the end of the file and swallowed the call site it was checking was absent.
  // The recorded shape, caught on the first run.
  const bodyStart = KW.indexOf('const reportAndBail = (');
  const bodyEnd = KW.indexOf('if (stalledMs > HUNG_MS && !bailing) {');
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
  const reset = KW.indexOf('memDump = { baseline: false, ramp: false, inFlight: false };', open);
  assert.ok(reset > open && reset - open < 600, 'the reset must sit with the browser-life marker, or last life\'s baseline describes nothing');
  assert.match(KW.slice(open, reset + 200), /memDumpBrowserSince = Date\.now\(\)/);
});

test('a refusal does not spend the phase — it is not a reading', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  const bad = fn.indexOf('if (!r.ok)');
  assert.ok(bad > -1);
  assert.match(fn.slice(bad, bad + 400), /memDump\[phase\] = false;/);
});

test('the baseline waits for a browser that has loaded RC; the ramp reading never waits', () => {
  const fn = KW.slice(KW.indexOf('const maybeMemoryDump ='), KW.indexOf('const renew = setInterval(() => {\n      const stalledMs'));
  assert.match(fn, /if \(!over && Date\.now\(\) - memDumpBrowserSince < MEM_DUMP_BASELINE_AFTER_MS\) return;/);
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
  assert.match(READOUT, /Join on the pid/);
  // And an empty table must say what absence means rather than reading as "no leak".
  assert.match(READOUT, /Ordinary until the box runs rc-mem-dump\.mjs/);
});
