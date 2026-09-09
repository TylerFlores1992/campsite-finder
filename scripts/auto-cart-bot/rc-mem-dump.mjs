/**
 * ASK CHROMIUM WHO OWNS THE 32 GB — a memory-infra dump, aggregated and never stored raw.
 *
 * ## What the walk left open
 *
 * On 2026-09-05 the committed-region walk named the CLASS of the leak from the outside: the
 * ramping renderer held **16,387 committed regions of ~2.0 MB, `commit/mapped`, 32,779 MB in
 * one bucket**, against a control renderer's 74 mapped regions and 84 MB. Pagefile-backed
 * shared-memory SECTIONS, charged and never written (`currentMB=0`), which is exactly why
 * private bytes, free RAM, the JS heap and the CDP sampling profiler were all structurally
 * blind to it — five instruments, one reason.
 *
 * What the walk cannot say is WHO ASKED FOR THEM. `VirtualQueryEx` reports a region's type and
 * size; it does not report the subsystem that created the section, and for a pagefile-backed
 * anonymous section there is no name to read. Three mechanisms have been guessed at on this
 * leak and each cost a session, so this module asks the only party that knows: Chromium.
 *
 * ## The instrument
 *
 * `Tracing.requestMemoryDump` at `detailed` level makes every Chromium process emit its own
 * allocator dumps — `malloc`, `v8`, `partition_alloc`, `discardable`, `gpu`, `skia`, `mojo`,
 * `shared_memory` — plus an OWNERSHIP GRAPH. `base::SharedMemoryTracker` emits one
 * `shared_memory/<guid>` dump per mapping, and whichever subsystem owns that mapping adds an
 * ownership edge to it. So the reading is:
 *
 *   • `shared_memory` ≈ 32 GB, ~16k dumps in the 2-4M bucket  -> the sections ARE base shared
 *     memory, and the OWNER column names the subsystem. That is the answer.
 *   • `shared_memory` small while the process holds 32 GB of mapped commit  -> they are NOT
 *     base shared memory, which eliminates discardable, mojo and the GPU transfer path in one
 *     reading and points outside Chromium's tracked allocators (a driver, ANGLE/D3D, a font
 *     cache). ALSO an answer, and a strong one.
 *
 * A negative is the point. It is why this is worth taking even on the reading where nothing
 * is attributed.
 *
 * ## Measured before it was written, and where that measurement does NOT reach
 *
 * Against a real Chromium in the dev container: the dump costs **~200 ms** end to end, and
 * thirty 1024x1024 WebGL texture uploads came back attributed to `gpu/transfer_memory` and
 * `gpu/transfer_buffer_memory` — i.e. the ownership edges resolve and name a real subsystem.
 * `scripts/auto-cart-bot/mem-dump-probe.mjs` is that check, kept so it can be re-run.
 *
 * **THAT VALIDATION IS LINUX AND THE BOX IS WINDOWS.** The native sampler was validated the
 * same way and its symbolization turned out to be absent on Windows — "validated somewhere
 * that is not where it runs" is a recorded cost here, twice. The dump machinery is the same
 * code on both, but WHETHER THE 2 MB SECTIONS GO THROUGH `base::SharedMemoryMapping` AT ALL IS
 * PRECISELY THE OPEN QUESTION, so do not read a small `shared_memory` total as the instrument
 * failing. It is the second branch above.
 *
 * ## Rules it obeys, each one paid for elsewhere in this repo
 *
 *  • **Nothing raw is retained.** The events are folded as they arrive and dropped. A renderer
 *    with 16k mappings emits 16k allocator dumps; buffering those to fold later is
 *    `response.body()` and the multi-GB heap snapshot in a third costume — the cure arriving
 *    as part of the disease, on a box already at 50 GB of commit.
 *  • **A missing size is `null`, never 0.** `discardable` was observed emitting a root dump
 *    with a guid and no size attribute at all. Zero would read as "that allocator holds
 *    nothing", which is a claim; "not reported" is the observation.
 *  • **Every failure names itself.** Tracing already started, a browser that will not answer,
 *    a dump that returns `success: false` — each returns a reason. An empty reading that reads
 *    as "no shared memory here" is the absent-reading-as-a-negative shape this file has paid
 *    for more than any other.
 *  • **Bounded, and it never delays anything.** The caller fires it from the watchdog timer,
 *    fire-and-forget; this module still bounds itself, because a browser in a ramp is by
 *    assumption one that may not answer.
 *  • **AN ABSENT PROCESS IS NOT A SMALL ONE.** The dump is COORDINATED by the browser process
 *    and each child contributes its own; a renderer that will not answer is simply missing
 *    from the result rather than reported as empty. That is the one way this instrument could
 *    manufacture a false elimination — a lead process with a small `shared_memory` total,
 *    read as "the sections are not base shared memory", when the ramping renderer never
 *    reported at all. Every process that DID answer is named with its pid in the rendering,
 *    and the readout says to check that pid against the region walk's target for the same
 *    event. Do not conclude anything from a dump the ramping renderer is not in.
 *  • **No per-region identifiers leave the box.** The `shared_memory/<guid>` names are hashes
 *    of mapping ids and there would be 16k of them; only counts, bytes and OWNER names are
 *    reported. Do not collect a field you would then have to filter.
 */

/** The whole dump, start to finish. Generous: the interesting case is a struggling browser. */
export const MEM_DUMP_TIMEOUT_MS = Number(process.env.RC_MEM_DUMP_TIMEOUT_MS || 20_000);
/**
 * The bound on the CLEANUP `Tracing.end`, and it is not optional.
 *
 * Found by the guards: without it the `finally` awaits a browser that has already been
 * established as not answering, so `takeMemoryDump` never resolves — and the caller's
 * in-flight flag never clears, which would leave the instrument firing exactly once per
 * browser life and reporting nothing ever after. A hang inside the cleanup of a bounded
 * operation is a hang.
 */
export const MEM_DUMP_CLEANUP_MS = Number(process.env.RC_MEM_DUMP_CLEANUP_MS || 3_000);
/**
 * The two ways Chromium reports tracing left in a stuck state by a previous attempt. Both
 * were observed rather than guessed — see the recovery in `takeMemoryDump` for where each
 * came from. Exported so a test pins the wordings rather than a copy of them.
 */
export const TRACING_STUCK = /already been started|stopped before start/i;
/** Processes rendered. A browser has ~6-10; the cap is a bound, not a filter. */
export const MAX_PROCESSES = 10;
/** Owners rendered per process, biggest first. */
export const MAX_OWNERS = 8;
/** Roots rendered per process, biggest first. */
export const MAX_ROOTS = 10;
/**
 * Ownership edges retained for deferred resolution. An edge's source guid may belong to a
 * process whose dump arrives LATER — cross-process ownership is how a renderer's mapping comes
 * to be owned by a GPU-process dump — so resolution cannot happen as the events stream. The
 * cap stops a pathological dump from being the allocation it is measuring.
 */
export const MAX_EDGES = 200_000;

/**
 * THE SAME BUCKETS THE COMMITTED-REGION WALK USES, boundaries included, so the two readings
 * are directly comparable rather than nearly so. The walk's `2-4M` bucket held 16,387 regions;
 * if that bucket here holds ~16k `shared_memory` dumps, the two instruments are describing one
 * population and the owner column names it. Mirrored from ramp-scan.mjs's PowerShell, `-lt`
 * on the first two boundaries and `-le` after — that asymmetry is theirs and matching it is
 * the whole point.
 */
export function sizeBucket(bytes) {
  if (bytes < 65536) return 'lt64K';
  if (bytes < 1048576) return '64K-1M';
  if (bytes < 2097152) return '1-2M';
  if (bytes <= 4194304) return '2-4M';
  if (bytes <= 16777216) return '4-16M';
  if (bytes <= 268435456) return '16-256M';
  if (bytes <= 1073741824) return '256M-1G';
  return 'gt1G';
}

const hexBytes = (attr) => {
  const v = attr?.value;
  if (typeof v !== 'string' || !v) return null;
  const n = Number.parseInt(v, 16);
  return Number.isFinite(n) ? n : null;
};

/**
 * Collapse an allocator dump name to the subsystem worth naming.
 *
 * `discardable/segment_4` and `discardable/segment_5` are one answer, not two, and a renderer
 * in this state would otherwise produce thousands of one-row "owners" and bury the reading.
 * Two segments, with a trailing id stripped — `gpu/transfer_memory` survives whole, which is
 * the level of detail that actually distinguishes the candidates.
 */
export function ownerKey(name) {
  if (typeof name !== 'string' || !name) return '(unnamed)';
  const parts = name.split('/');
  const head = parts[0];
  if (parts.length < 2) return head;
  const second = parts[1].replace(/_(0x)?[0-9a-f]{6,}$/i, '').replace(/_\d+$/, '');
  return second ? `${head}/${second}` : head;
}

/**
 * Fold dump events as they arrive.
 *
 * One `ph: 'v'` event per process carries that process's whole `allocators` map and its
 * `allocators_graph`. Everything is reduced to counters here and the event is dropped; the
 * only things held across events are the global guid->name map (needed because ownership
 * crosses processes) and the shared-memory edges awaiting resolution.
 */
export function newDumpAccumulator() {
  /** pid -> aggregate */
  const procs = new Map();
  /** global dump guid -> allocator name, across every process in this dump */
  const guidName = new Map();
  /** deferred: { pid, source, target } for edges whose target is a shared_memory dump */
  const shmEdges = [];
  /** pid -> main thread name, straight out of Chromium's own thread naming */
  const threads = new Map();
  let edgesCapped = false;
  let events = 0;

  const proc = (pid) => {
    let p = procs.get(pid);
    if (!p) {
      p = {
        pid,
        mainThread: null,
        roots: new Map(),      // name -> bytes | null
        shmCount: 0,
        shmBytes: 0,
        shmRootBytes: null,
        shmUnsized: 0,
        shmBuckets: new Map(), // bucket -> { n, bytes }
        shmGuidBytes: new Map(), // dump guid -> bytes, for edge resolution
        ownedGuids: new Set(),
        owners: new Map(),     // owner key -> { n, bytes }
        unowned: { n: 0, bytes: 0 },
        dumps: 0,
        events: 0,
      };
      procs.set(pid, p);
    }
    return p;
  };

  return {
    add(e) {
      if (!e || typeof e !== 'object') return;
      // Chromium's own thread naming. `CrRendererMain` / `CrBrowserMain` / `CrGpuMain` is a
      // literal we are relaying, not a type we are deriving — the pid is the join key with
      // ramp-scan's CHROME lines, which carry the real `type=`.
      if (e.ph === 'M' && e.name === 'thread_name' && typeof e.args?.name === 'string') {
        const n = e.args.name;
        if (/^Cr\w+Main$/.test(n) && !threads.has(e.pid)) threads.set(e.pid, n);
        return;
      }
      // PRESENT AND EMPTY IS NOT ABSENT, AND THE DIFFERENCE IS THE WHOLE RAMP READING.
      //
      // Measured (`dump-wedge-probe.mjs`): Chromium's memory-infra coordinator gives up on a
      // child that does not answer within ~15 s, returns `success: false`, and emits a process
      // dump for it carrying NO allocators. Keying off `allocators` dropped that process
      // entirely, so "the renderer was asked, Chromium timed it out, and it contributed
      // nothing" rendered identically to "the renderer never appeared" — and the second reads
      // as a coordination or timing fault worth chasing, which is what the 09-08 ramp dump was
      // read as. The process is created on the DUMP event now and `dumps=0` says the rest.
      const dumps = e.ph === 'v' ? e.args?.dumps : null;
      if (!dumps) return;
      events++;
      const p = proc(e.pid);
      p.events++;
      const alloc = dumps.allocators;
      if (!alloc) return;
      const graph = dumps.allocators_graph || [];
      for (const [name, dump] of Object.entries(alloc)) {
        p.dumps++;
        if (dump?.guid) guidName.set(dump.guid, name);
        const bytes = hexBytes(dump?.attrs?.size);
        if (!name.includes('/')) {
          // NULL, not 0 — see the header. `discardable` really does emit a root with no size.
          p.roots.set(name, bytes);
          if (name === 'shared_memory') p.shmRootBytes = bytes;
          continue;
        }
        if (!name.startsWith('shared_memory/')) continue;
        p.shmCount++;
        if (bytes === null) { p.shmUnsized++; continue; }
        p.shmBytes += bytes;
        const b = sizeBucket(bytes);
        const cur = p.shmBuckets.get(b) || { n: 0, bytes: 0 };
        cur.n++; cur.bytes += bytes;
        p.shmBuckets.set(b, cur);
        if (dump?.guid) p.shmGuidBytes.set(dump.guid, bytes);
      }
      for (const edge of graph) {
        if (!edge || edge.type !== 'ownership') continue;
        if (!p.shmGuidBytes.has(edge.target)) continue;
        p.ownedGuids.add(edge.target);
        if (shmEdges.length >= MAX_EDGES) { edgesCapped = true; continue; }
        shmEdges.push({ pid: e.pid, source: edge.source, target: edge.target });
      }
    },

    finish() {
      for (const { pid, source, target } of shmEdges) {
        const p = procs.get(pid);
        if (!p) continue;
        const bytes = p.shmGuidBytes.get(target) ?? 0;
        // An unresolved source is a real reading and is reported as one: the owner's dump
        // lives in another process and was not in this dump, which is itself informative.
        const key = guidName.has(source) ? ownerKey(guidName.get(source)) : '(owner in another process)';
        const cur = p.owners.get(key) || { n: 0, bytes: 0 };
        cur.n++; cur.bytes += bytes;
        p.owners.set(key, cur);
      }
      const out = [];
      for (const p of procs.values()) {
        for (const [guid, bytes] of p.shmGuidBytes) {
          if (p.ownedGuids.has(guid)) continue;
          p.unowned.n++; p.unowned.bytes += bytes;
        }
        out.push({
          pid: p.pid,
          mainThread: threads.get(p.pid) ?? null,
          dumps: p.dumps,
          roots: [...p.roots].map(([name, bytes]) => ({ name, bytes }))
            .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)),
          shmCount: p.shmCount,
          shmBytes: p.shmBytes,
          shmRootBytes: p.shmRootBytes,
          shmUnsized: p.shmUnsized,
          buckets: [...p.shmBuckets].map(([bucket, v]) => ({ bucket, ...v }))
            .sort((a, b) => b.bytes - a.bytes),
          owners: [...p.owners].map(([owner, v]) => ({ owner, ...v }))
            .sort((a, b) => b.bytes - a.bytes),
          unowned: { ...p.unowned },
        });
      }
      // Biggest shared_memory holder first: on a ramp that is the process the walk walked.
      out.sort((a, b) => b.shmBytes - a.shmBytes);
      return { processes: out, events, edgesCapped, edges: shmEdges.length };
    },
  };
}

/** Fold a whole array at once. The trip streams instead; this is the same code, for tests. */
export function foldDumpEvents(events) {
  const acc = newDumpAccumulator();
  for (const e of events || []) acc.add(e);
  return acc.finish();
}

const mb = (bytes) => Math.round((bytes ?? 0) / 1048576);

/**
 * The small structured summary that rides in `detail`.
 *
 * DELIBERATELY SMALL. `cleanDetail` returns NULL above 8 KB — so an over-large detail is not
 * truncated, it is DROPPED, and the whole reading disappears while looking like it was never
 * taken. The per-process rendering goes in `text`, which is capped at 64 KB and truncates
 * visibly. Same split `ramp-scan` already uses.
 */
export function summariseMemDump(folded, phase) {
  const lead = folded?.processes?.[0] ?? null;
  const bucket = lead?.buckets?.[0] ?? null;
  const owner = lead?.owners?.[0] ?? null;
  return {
    phase,
    processes: folded?.processes?.length ?? 0,
    // The processes Chromium's coordinator TIMED OUT: heard from, contributed no allocator
    // dumps. On a ramp this is expected to be exactly the ramping renderer, and naming it is
    // what stops the readout reporting a valid dump as a coordination fault.
    emptyPids: (folded?.processes ?? []).filter((p) => p.dumps === 0).map((p) => p.pid),
    edgesCapped: folded?.edgesCapped === true,
    lead: lead && {
      pid: lead.pid,
      mainThread: lead.mainThread,
      shmMb: mb(lead.shmBytes),
      shmCount: lead.shmCount,
      // Chromium's OWN total for the `shared_memory` root, beside our sum over its children.
      // They describe the same population, so a disagreement is a fold that missed mappings —
      // a cross-check that costs one number and is the only one available on Windows, where
      // the probe cannot run.
      shmRootMb: lead.shmRootBytes === null ? null : mb(lead.shmRootBytes),
      topBucket: bucket ? { bucket: bucket.bucket, mb: mb(bucket.bytes), n: bucket.n } : null,
      topOwner: owner ? { owner: owner.owner, mb: mb(owner.bytes), n: owner.n } : null,
      unownedMb: mb(lead.unowned?.bytes),
      /**
       * AN ARRAY, NOT AN OBJECT, AND THAT IS NOT A STYLE CHOICE.
       *
       * `detail` is stored as `jsonb`, which does not preserve key order — it re-sorts by key
       * LENGTH and then bytewise. So a size-sorted object came back
       * `malloc · discardable · shared_memory · partition_alloc` and the readout printed the
       * biggest allocator third, where a reader takes the first as the largest. Caught by
       * rendering a fixture and reading it, which is the only way a formatting bug ever is.
       */
      roots: (lead.roots ?? []).slice(0, 6).map((r) => ({ name: r.name, mb: r.bytes === null ? null : mb(r.bytes) })),
    },
  };
}

/** The full per-process rendering, one fact per line, in the shape the walk's text uses. */
export function renderMemDump(folded) {
  const lines = [];
  const procs = folded?.processes ?? [];
  lines.push(`MDDUMP processes=${procs.length} events=${folded?.events ?? 0} edges=${folded?.edges ?? 0}${folded?.edgesCapped ? ' EDGES-CAPPED' : ''}`);
  for (const p of procs.slice(0, MAX_PROCESSES)) {
    // `empty=yes` is the coordinator having timed this process out — see the accumulator.
    // Spelled rather than left to `dumps=0`, because a reader scanning for the ramping
    // renderer needs the fact to be a word, not an inference from a zero.
    lines.push(`MDPROC pid=${p.pid} thread=${p.mainThread ?? 'unknown'} dumps=${p.dumps}${p.dumps === 0 ? ' empty=yes' : ''} shmMB=${mb(p.shmBytes)} shmCount=${p.shmCount} shmRootMB=${p.shmRootBytes === null ? 'notReported' : mb(p.shmRootBytes)}${p.shmUnsized ? ` unsized=${p.shmUnsized}` : ''}`);
    for (const r of p.roots.slice(0, MAX_ROOTS)) {
      lines.push(`MDROOT pid=${p.pid} ${r.name} ${r.bytes === null ? 'notReported' : `${mb(r.bytes)}MB`}`);
    }
    for (const b of p.buckets) lines.push(`MDHIST pid=${p.pid} ${b.bucket} ${mb(b.bytes)}MB count=${b.n}`);
    for (const o of p.owners.slice(0, MAX_OWNERS)) {
      lines.push(`MDOWNER pid=${p.pid} ${o.owner} ${mb(o.bytes)}MB count=${o.n}`);
    }
    if (p.unowned.n) lines.push(`MDOWNER pid=${p.pid} (no ownership edge) ${mb(p.unowned.bytes)}MB count=${p.unowned.n}`);
  }
  if (procs.length > MAX_PROCESSES) lines.push(`MDNOTE ${procs.length - MAX_PROCESSES} further process(es) not rendered`);
  return lines.join('\n');
}

/**
 * STOP TRACING PROPERLY — `Tracing.end` alone does not.
 *
 * The command RETURNS before tracing has actually stopped; the browser is only done once it
 * emits `Tracing.tracingComplete`. Both this module's `finally` and the first version of its
 * stuck-state recovery sent `end` and moved on, so the NEXT `Tracing.start` was refused with
 * `Tracing has already been started` — and the recovery, which sent another bare `end`, was
 * refused for exactly the same reason and looked like a browser that could not be recovered
 * at all. Found by `dump-wedge-probe.mjs` on a HEALTHY browser, which is the only place the
 * difference is visible: against a wedged one nothing completes either way.
 *
 * Bounded, and a failed `end` (tracing was not started) returns at once rather than waiting
 * out the budget for a completion that can never come.
 */
export async function stopTracing(cdp, ms) {
  let settle = null;
  const done = new Promise((resolve) => { settle = resolve; cdp.once('Tracing.tracingComplete', resolve); });
  // ONE deadline for the whole operation, and the SEND is inside it. Awaiting the send bare
  // pins the caller against a browser that never answers it — caught by this module's own
  // "a hung teardown cannot pin the caller" guard the moment the bare await was introduced.
  let timer = null;
  const deadline = new Promise((r) => { timer = setTimeout(r, ms); });
  let ended = false;
  await Promise.race([cdp.send('Tracing.end').then(() => { ended = true; }, () => {}), deadline]);
  // Nothing to wait for if the end never took: waiting would spend the rest of the budget on
  // a completion event that cannot arrive.
  if (ended) await Promise.race([done, deadline]);
  try { cdp.off('Tracing.tracingComplete', settle); } catch { /* ignore */ }
  if (timer) clearTimeout(timer);
}

/**
 * Take one dump over an existing CDP session.
 *
 * THE SESSION IS BORROWED, NEVER DETACHED. It is `heapProbe`'s, attached at launch while the
 * browser was healthy, precisely because negotiating a new session at trip time is what
 * produced `newCDPSession: no answer in 3000ms` on the first real firing of the heap facts.
 * The listener is removed in the `finally`; detaching the session would silently break the
 * heap trail and the alloc trail, which is the mistake the borrowers of this session are
 * already warned about.
 */
export async function takeMemoryDump(cdp, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? MEM_DUMP_TIMEOUT_MS;
  if (!cdp) return { ok: false, why: 'no CDP session', ms: 0 };
  const started = Date.now();
  const acc = newDumpAccumulator();
  const onData = ({ value }) => { for (const e of value || []) acc.add(e); };
  let started_tracing = false;
  let recovered = false;
  try {
    const work = (async () => {
      const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      cdp.on('Tracing.dataCollected', onData);
      const cfg = {
        traceConfig: {
          includedCategories: ['disabled-by-default-memory-infra'],
          excludedCategories: ['*'],
        },
        transferMode: 'ReportEvents',
      };
      // A DUMP THAT TIMED OUT LEAVES TRACING STUCK, AND THE NEXT ONE INHERITS IT.
      //
      // Measured twice, on two boxes and in two wordings. On the mini-PC, 2026-09-09
      // 11:29:54: `memory dump (ramp) did not run: Tracing.start: Tracing was stopped before
      // start has been completed` — the ramp dump for that ramp, lost outright. In the dev
      // container the sibling wording appears the moment two dumps are attempted back to
      // back against a wedged renderer: `Tracing has already been started`.
      //
      // Both are the same thing: the previous attempt's bounded `Tracing.end` in the finally
      // raced the browser and left tracing neither started nor stopped. The ramp dump is by
      // construction the SECOND dump of a browser life (a baseline preceded it) and by
      // construction follows a browser that is not answering, so this is not an edge case —
      // it is the case. Recover once and retry rather than spending the whole ramp on it.
      //
      // NARROW ON PURPOSE. Only the two stuck-state wordings are recovered; any other
      // `Tracing.start` failure is a different fault and is thrown, because a blanket retry
      // would turn "this browser cannot trace at all" into two timeouts instead of one.
      //
      // THE FLAG GOES UP BEFORE THE SEND, NOT AFTER IT. `Tracing.start` can take effect and
      // then have its reply lost to the caller's own timeout — the outer race can fire while
      // this await is still pending — and a flag set afterwards would leave the `finally`
      // believing there was nothing to stop. That is not hypothetical: it leaves tracing
      // started with nobody to stop it, which is precisely the state the NEXT dump reports as
      // `Tracing was stopped before start has been completed`. `stopTracing` already handles
      // being called when tracing was never started, so the pessimistic flag costs nothing.
      started_tracing = true;
      try {
        await cdp.send('Tracing.start', cfg);
      } catch (e) {
        if (!TRACING_STUCK.test(`${e?.message ?? e}`)) throw e;
        recovered = true;
        await stopTracing(cdp, MEM_DUMP_CLEANUP_MS);
        await cdp.send('Tracing.start', cfg);
      }
      const res = await cdp.send('Tracing.requestMemoryDump', {
        deterministic: false,
        levelOfDetail: 'detailed',
      });
      // RC's own word for it. `success: false` means Chromium refused the dump — a different
      // fact from a dump that ran and found nothing, and the two must not print the same.
      const refused = res && res.success === false;
      await cdp.send('Tracing.end');
      started_tracing = false;
      await complete;
      return refused ? { ok: false, why: 'Chromium refused the dump (success: false)' } : { ok: true };
    })();
    const raced = await Promise.race([
      work,
      new Promise((r) => setTimeout(() => r({ ok: false, why: `no answer in ${timeoutMs}ms` }), timeoutMs)),
    ]);
    const folded = acc.finish();
    // A TIMEOUT WITH DATA IS STILL A READING. The dump events arrive before
    // `Tracing.tracingComplete`, so a browser too slow to finish tearing tracing down can
    // still have told us everything we asked for. Reporting nothing there would throw away
    // the one reading the whole module exists to take.
    if (!raced.ok && folded.processes.length === 0) {
      return { ok: false, why: raced.why, ms: Date.now() - started, recovered };
    }
    return {
      ok: true,
      partial: !raced.ok ? raced.why : null,
      ms: Date.now() - started,
      recovered,
      folded,
    };
  } catch (e) {
    return { ok: false, why: `${e?.message ?? e}`.split('\n')[0], ms: Date.now() - started, recovered };
  } finally {
    try { cdp.off('Tracing.dataCollected', onData); } catch { /* ignore */ }
    // Leaving tracing running would make every LATER dump fail with "already started", so the
    // instrument would work exactly once per browser life and report a refusal after that.
    if (started_tracing) {
      await stopTracing(cdp, MEM_DUMP_CLEANUP_MS);
    }
  }
}
