/**
 * BOT EVENTS — rare, structured observations from the mini-PC (migration 075).
 *
 * Four kinds today, and the reason for each is in the migration's header:
 *
 *   `ramp-scan`   bot.mjs took the full `memory` scan by itself, the first time the periodic
 *                 sample saw the rc Chromium family past RAMP_SCAN_MB. `detail` carries the
 *                 trigger values; `text` carries the scan. It answers the one question the
 *                 memory series cannot: where the ~35 GB of commit that appears at every ramp
 *                 onset — and that chrome.exe private bytes do not account for — actually is.
 *
 *   `tab-close`   rc-keepwarm closed a throwaway tab (renewal / auto-login / warmup) and is
 *                 reporting how long the trip took and how long the close took, and whether
 *                 the close had to be given up on. A renewal body that takes ten minutes and a
 *                 `tab.close()` that hangs for ten minutes look identical in the memory
 *                 series; this is the number that separates them.
 *
 *   `request-counts`  rc-keepwarm's count of the RESIDENT page's requests — `origin +
 *                 pathname` keys, lifetime and rolling two-minute counts, top ten — taken at a
 *                 bail, at the teardown and on a hung close. The 09-04 ramp scan put ~35 GB of
 *                 untouched shared-section commit on a renderer holding 18,705 handles; if
 *                 that is a request loop, the top path here names the endpoint. `reason`
 *                 says which of the three took it. Never a query, never a body.
 *
 *   `mem-dump`    rc-keepwarm asked Chromium's own memory-infra tracer who owns the shared
 *                 memory in each of its processes — once as a baseline and once when the rc
 *                 family crosses the ramp threshold. The committed-region walk named the CLASS
 *                 of the 32 GB (16,387 pagefile-backed sections of ~2 MB) and cannot name what
 *                 created them, because Windows records no owner for an anonymous section.
 *                 `detail` carries the lead process's totals; `text` carries the per-process
 *                 roots, size histogram and OWNER attribution. A small `shared_memory` total
 *                 beside a 32 GB mapped process is a reading too — see rc-mem-dump.mjs.
 *
 * THE RULES ARE THE SAME AS `native-alloc.ts`, ONE TABLE OVER: the kind is allow-listed so a
 * caller with the token cannot put arbitrary text on an admin readout; the detail is capped;
 * the text is capped and stripped of control characters, because Postgres text cannot hold a
 * NUL and an unstorable answer is how `tail-log` went silent on 2026-08-11; and the JSON is
 * stringified HERE, because `sqlit` interpolates rather than binds and hands a plain object to
 * `String()` — the `[object Object]` that switched the memory series off for ten minutes.
 */
import { mutate, query } from '@/lib/db/client';

export const BOT_EVENT_KINDS = ['ramp-scan', 'tab-close', 'request-counts', 'mem-dump'] as const;
export type BotEventKind = (typeof BOT_EVENT_KINDS)[number];
const KINDS = new Set<string>(BOT_EVENT_KINDS);

/** Detail is small structured facts, never a dump — 8 KB is many times what either kind needs. */
export const MAX_DETAIL_CHARS = 8_000;
/** A full `memory` scan is ~3-6 KB; 64 KB leaves room for a box with many processes. */
export const MAX_TEXT_CHARS = 64_000;

export interface BotEventInput {
  kind?: unknown;
  detail?: unknown;
  text?: unknown;
}

export interface BotEventRow {
  id: number;
  at: string;
  source: string | null;
  kind: string | null;
  detail: Record<string, unknown> | null;
  text: string | null;
}

/**
 * Strip what Postgres text cannot hold and what a readout should never print: every control
 * character except newline and tab. A NUL is the one that throws; the rest are the ones a
 * PowerShell console encoding can leave behind.
 */
export function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  if (!t) return null;
  return t.length > MAX_TEXT_CHARS
    ? `${t.slice(0, MAX_TEXT_CHARS)}\n(truncated at ${MAX_TEXT_CHARS} chars)`
    : t;
}

/** A plain object, JSON-serialisable, under the cap — or null. Never a string, never an array. */
export function cleanDetail(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let s: string;
  try { s = JSON.stringify(raw); } catch { return null; }
  if (!s || s === '{}' || s.length > MAX_DETAIL_CHARS) return null;
  return s;
}

export function eventKind(raw: unknown): BotEventKind | null {
  return typeof raw === 'string' && KINDS.has(raw) ? (raw as BotEventKind) : null;
}

export async function recordBotEvent(input: BotEventInput, source: string | null): Promise<void> {
  await mutate(
    `INSERT INTO bot_events (source, kind, detail, text) VALUES ($1, $2, $3::jsonb, $4)`,
    [
      source ? source.slice(0, 40) : null,
      eventKind(input.kind),
      cleanDetail(input.detail),
      cleanText(input.text),
    ],
  ).catch((e) => console.error('[bot-events] recordBotEvent failed:', (e as Error).message));
}

export async function recentBotEvents(
  kind: BotEventKind, hours: number, limit = 50,
): Promise<BotEventRow[]> {
  return await query<BotEventRow>(
    `SELECT id, at::text, source, kind, detail, text
       FROM bot_events
      WHERE kind = $1 AND at > NOW() - ($2 || ' hours')::interval
      ORDER BY at DESC
      LIMIT $3`,
    [kind, String(Math.max(1, Math.floor(hours))), limit],
  );
}

/**
 * WHICH OF THE THREE TOOK A `request-counts` READING — a PREFIX test, never an equality one.
 *
 * Every arm reported the bare `'bail'` until 2026-09-05, when #280 made each one name itself
 * (`bail:ramp`, `bail:wedge`, …) so that which arm fired could be READ rather than inferred
 * from the clock — twelve minutes being `HUNG_MS` to the minute — after the log window that
 * would have settled it had already rolled. The readout's classifier was not moved with it.
 *
 * So from that commit until 2026-09-06 EVERY bail fell through to `other`, with two live
 * consequences on the one instrument the leak investigation now depends on:
 *
 *   - the summary printed `0 at a bail` over two real bails, and
 *   - the bail rows — the ONLY readings taken DURING a ramp — printed LAST, below the
 *     teardowns the section header calls the baseline.
 *
 * That is this file's most-repeated shape: an absent reading standing in for a negative. A
 * reader following `docs/NEXT-SESSION.md`'s own instruction ("read the `bail` rows first,
 * teardowns are the baseline") would have concluded the arm never fired.
 *
 * `bail:` and not `bail`, so a future `bailout` cannot be swept in; the bare `'bail'` stays
 * matched because rows written before #280 carry it and are still real bails. The full reason
 * is what gets PRINTED either way, so the arm name is never lost.
 */
export type RequestCountReason = 'bail' | 'hung-close' | 'teardown' | 'other';

export function requestCountReason(raw: unknown): RequestCountReason {
  const r = typeof raw === 'string' ? raw : '';
  if (r === 'bail' || r.startsWith('bail:')) return 'bail';
  if (r === 'hung-close' || r === 'teardown') return r;
  return 'other';
}

/**
 * WHAT KIND OF LOOP — the reading `page.on('request')` alone could never take.
 *
 * The RDR burst has been observed at 19,008 / 18,392 / ≥49,237 hits on one path inside two
 * minutes, from the residential IP that has eaten a 12-hour block once. Until the status was
 * counted, "RC's SPA retrying against a rejection" and "RC's SPA asking on purpose" were the
 * SAME reading — and they need opposite fixes: the first is an auth state to repair, the
 * second is a request pattern to stop making.
 *
 * ABSENT IS NOT EMPTY, and that distinction is the whole reason this is a function rather
 * than a ternary at the call site. A row written by a bundle older than this change carries
 * NO `statuses` key at all; a row that carries `{}` is a page whose asks were never answered.
 * Rounding the first to the second would report every historical burst as "nothing came back",
 * which is a finding, and a false one.
 */
export type LoopAnswerKind = 'not-reported' | 'unanswered' | 'rejected' | 'ok' | 'failed' | 'mixed';

export function loopAnswerReading(
  row: { lifetime?: unknown; statuses?: Record<string, number> | null | undefined } | null | undefined,
): { kind: LoopAnswerKind; text: string } {
  const statuses = row?.statuses;
  if (statuses == null) {
    return {
      kind: 'not-reported',
      text: 'this bundle does not report statuses — an older box. Until it updates, a retry loop '
        + 'and an SPA asking on purpose are the same reading.',
    };
  }
  const entries = Object.entries(statuses).filter(([, v]) => Number(v) > 0);
  const answered = entries.reduce((n, [, v]) => n + Number(v), 0);
  const asked = Number(row?.lifetime) || 0;
  const missing = Math.max(0, asked - answered);
  if (answered === 0) {
    return {
      kind: 'unanswered',
      text: `nothing came back for any of the ${asked} ask(s) — Chromium is not being answered at all, `
        + 'which is neither of the two candidates and is its own finding.',
    };
  }
  const [topStatus, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
  const share = topCount / answered;
  const tail = missing > 0 ? ` (${missing} of ${asked} ask(s) got no answer at all)` : '';
  // A dominant code is a story; a spread is not, and saying so beats naming the largest slice.
  if (share < 0.8) {
    return { kind: 'mixed', text: `no single answer dominates (top ${topStatus} at ${Math.round(share * 100)}%)${tail}.` };
  }
  if (topStatus === 'failed') {
    return {
      kind: 'failed',
      text: `${Math.round(share * 100)}% of the answers are Chromium REFUSING the request${tail} — `
        + 'look at what is aborting them before looking at RC.',
    };
  }
  const code = Number(topStatus);
  if (code === 401 || code === 403) {
    return {
      kind: 'rejected',
      text: `${Math.round(share * 100)}% answered ${code}${tail} — this is a RETRY LOOP AGAINST A REJECTION. `
        + 'The fix is the auth state it is retrying with, NOT blocking the requests.',
    };
  }
  if (code >= 200 && code < 400) {
    return {
      kind: 'ok',
      text: `${Math.round(share * 100)}% answered ${code}${tail} — RC's SPA is asking on purpose and being served. `
        + 'Nothing is failing, so the fix is the request pattern, not the auth state.',
    };
  }
  return { kind: 'mixed', text: `${Math.round(share * 100)}% answered ${code}${tail}.` };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * READING THE ONE-SHOT LEAK CAPTURE
 *
 * The region walk and the memory dump ride the same 3 GB trigger and answer opposite halves
 * of one question, and until 2026-09-08 a human had to join them by eye and reach the verdict
 * themselves. The first time that was needed nobody did: the 09-07 dump measured a browser
 * five seconds old, its `shared_memory 2 MB` read as an elimination, and the reading was void.
 *
 * These are pure so the branch that says `VOID` is reachable from a test — inline in the
 * readout, it could only ever run against a real ramp, which is what let `closeOnToken` ship
 * wrong for six days. Same reason `closeReasonReading` and `loopAnswerReading` are functions.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

export type DumpJoinKind = 'no-walk' | 'void' | 'joined';

/**
 * Why a join is void. Both suppress the verdict; they need OPPOSITE fixes.
 *
 * `generation` — the dump described a DIFFERENT browser. 2026-09-07: a `bail:ramp` killed the
 * ramping generation, the supervisor restarted within seconds, and the dump measured the
 * replacement. The fault is the dump's TIMING.
 *
 * `target-silent` — the dump described THIS browser and the ramping renderer alone is missing
 * from it. 2026-09-08 21:43: the dump answered for seven pids, every one of them in the ramp
 * scan's own process list, and spent its full 20,000 ms waiting for the eighth. The timing is
 * RIGHT and the subject has stopped answering CDP — the third instrument to hit that wall,
 * after `newCDPSession` and `Performance.getMetrics`.
 *
 * `unknown` — no generation list to compare against, so it names both and asserts neither.
 *
 * NAMING THE WRONG ONE IS THE EXPENSIVE ERROR, WHICH IS WHY THIS EXISTS. Until 2026-09-08 the
 * void text asserted the `generation` mechanism unconditionally — so on the first ramp the
 * stall trigger ever caught, the readout told the reader to go and fix the half that had just
 * started working.
 */
export type DumpJoinVoidCause = 'generation' | 'target-silent' | 'target-empty' | 'unknown';

/**
 * Did the memory dump measure the process the region walk walked?
 *
 * A COORDINATED DUMP OMITS A PROCESS THAT WILL NOT ANSWER — it does not report it as empty —
 * so a missing renderer read as a small `shared_memory` total is the one false elimination
 * this instrument can manufacture. `void` therefore suppresses the verdict entirely rather
 * than qualifying it.
 *
 * `no-walk` is NOT `void`. No walk to join against is an absence, and an absence must not be
 * dressed as a failed join — the reader still has the manual check available and should be
 * told so, which is a different sentence.
 *
 * THE KIND STAYS `void` FOR EVERY CAUSE, DELIBERATELY. The caller suppresses on
 * `kind === 'void'`, so a cause it has never heard of must still suppress — a new variant
 * must not be able to un-suppress the one sentence a reader quotes. The cause rides beside
 * the kind rather than replacing it.
 */
export function dumpJoinReading(
  args: {
    walkTargetPid?: string | null;
    dumpPids?: readonly string[] | null;
    walkNearby?: boolean;
    /** Every chrome.exe the region walk saw in the SAME event — the browser generation. */
    walkGenerationPids?: readonly string[] | null;
    /**
     * Processes Chromium's coordinator TIMED OUT: present in the dump, contributing no
     * allocator dumps at all. Measured in `dump-wedge-probe.mjs` — a child that does not
     * answer within ~15 s is not dropped, it is emitted EMPTY.
     */
    dumpEmptyPids?: readonly string[] | null;
  },
): { kind: DumpJoinKind; cause?: DumpJoinVoidCause; text: string } {
  const target = args.walkTargetPid ?? null;
  const pids = args.dumpPids ?? [];
  if (!target) {
    return {
      kind: 'no-walk',
      text: args.walkNearby
        ? 'a region walk is near this dump but did not complete, so nothing confirms which browser was '
          + 'measured. Check the pid by hand before reading the verdict.'
        : 'no region walk near this dump, so nothing confirms which browser was measured. Check the pid '
          + 'by hand before reading the verdict.',
    };
  }
  if (!pids.includes(target)) {
    const generation = args.walkGenerationPids ?? null;
    const overlap = generation ? pids.filter((p) => generation.includes(p)).length : 0;
    const head = `VOID: the walk's target is pid ${target} and the dump answered for `
      + `${pids.length ? pids.join(', ') : 'no process at all'}. A renderer missing from a coordinated dump `
      + 'is MISSING, not empty, so its shared_memory figure eliminates NOTHING';
    if (!generation || generation.length === 0) {
      return {
        kind: 'void',
        cause: 'unknown',
        text: `${head} — and with no process list from the walk, a dump of a DIFFERENT browser and a dump `
          + 'this browser gave minus the ramping renderer are indistinguishable here. Compare the pids by hand.',
      };
    }
    if (overlap === 0) {
      return {
        kind: 'void',
        cause: 'generation',
        text: `${head} — and NONE of those ${pids.length} pid(s) is in the walk's own process list, so this is `
          + 'a DIFFERENT browser: the 2026-09-07 shape, where a bail killed the generation and the dump '
          + 'measured its replacement. The fault is the timing.',
      };
    }
    return {
      kind: 'void',
      cause: 'target-silent',
      text: `${head} — but ${overlap} of those ${pids.length} pid(s) ARE in the walk's own process list, so the `
        + 'dump reached the RIGHT browser and the ramping renderer alone did not answer it. The timing is '
        + 'right; the subject has gone quiet, as it did for newCDPSession and Performance.getMetrics before '
        + 'it. Do NOT go looking at the trigger.',
    };
  }
  // PRESENT AND EMPTY IS NOT PRESENT. The fold used to drop a process that contributed no
  // allocator dumps, so the ramping renderer read as MISSING; it is recorded now, and without
  // this branch that change alone would have flipped every future ramp dump from VOID to
  // `joined` — i.e. turned a reading that eliminates nothing into one that reads as success.
  // It stays `void` so callers that suppress the shared-memory verdict keep suppressing it.
  if ((args.dumpEmptyPids ?? []).includes(target)) {
    return {
      kind: 'void',
      cause: 'target-empty',
      text: `VOID: the ramping renderer (pid ${target}) IS in this dump and contributed ZERO allocator `
        + "dumps — Chromium's coordinator gave up on it (~15s) and emitted an empty process dump. So its "
        + 'shared_memory figure is not small, it is ABSENT, and it eliminates nothing. Measured in '
        + 'dump-wedge-probe.mjs: no level and no timeout changes this, because there is no allocator data '
        + 'to be had from a renderer that never emitted any. Do NOT go looking at the trigger or the '
        + 'budget — the reading has to come from outside the process (VMTHREAD/VMSPAN in the region walk).',
    };
  }
  return { kind: 'joined', text: `the ramping renderer (pid ${target}, from the region walk) IS in this dump.` };
}

export type MappedSwarmKind = 'absent' | 'none' | 'per-region' | 'carved' | 'mixed';

/**
 * Are the 2 MB mapped regions N separate sections, or a few big mappings carved into views?
 *
 * `AllocationBase` is already in the MEMORY_BASIC_INFORMATION the walk reads, so this costs
 * nothing and settles a question the histogram cannot: 16k regions sharing four bases is one
 * bug and 16k regions with 16k bases is another, and they have different fixes.
 */
export function mappedSwarmReading(
  args: { regions?: unknown; allocBases?: unknown; present?: boolean },
): { kind: MappedSwarmKind; text: string } {
  if (args.present === false) {
    return { kind: 'absent', text: '2-4M census: absent — this scan predates it (box on an older ramp-scan.mjs).' };
  }
  const regions = Number(args.regions) || 0;
  const bases = Number(args.allocBases) || 0;
  if (regions === 0) {
    return { kind: 'none', text: '2-4M mapped: no committed MEM_MAPPED region in that band — the swarm is not here.' };
  }
  const head = `2-4M mapped: ${regions} region(s) across ${bases} allocation base(s) — `;
  if (bases >= regions * 0.9) {
    return { kind: 'per-region', text: `${head}each is its OWN mapping, so this is N separate sections, not one carved up.` };
  }
  if (bases <= 4) {
    return { kind: 'carved', text: `${head}a HANDFUL of large mappings carved into 2 MB views — a different bug from N sections.` };
  }
  return { kind: 'mixed', text: `${head}neither one mapping nor one-per-region; read the base count before assuming either.` };
}

/** GetMappedFileName needs PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. */
export const NAME_CENSUS_ACCESS = 1040;

export type MappedNameKind = 'no-access' | 'unsampled' | 'anonymous' | 'file-backed';

/**
 * A thread that holds most of a sampling window is SPINNING; a process with none is BLOCKED.
 * Below this share of the window the top thread is not doing the work and saying so would be
 * a story. One core for the whole window is 1.0; a quarter of it is still a busy thread.
 */
export const BUSY_THREAD_SHARE = 0.25;

export type BusyThreadKind = 'unavailable' | 'spinning-main' | 'spinning-worker' | 'blocked';

/**
 * WHICH THREAD IS BUSY IN A RENDERER THAT WILL NOT TALK — and whether any is.
 *
 * Every CDP instrument is structurally unable to answer this: a wedged renderer contributes
 * ZERO allocator dumps at every dump level (measured, `dump-wedge-probe.mjs`), and the alloc
 * trail reported `[resident]: EMPTY — that renderer answered no CDP call at all` for a whole
 * browser life. The region walk asks Windows instead and needs nothing from the process.
 *
 * The two branches need OPPOSITE fixes and nothing has ever distinguished them:
 *
 *   • SPINNING — one thread holds the window. `main=True` says the spin is on the renderer's
 *     main thread (Blink, JS, the command-buffer client, the allocator), which is also why it
 *     cannot answer a dump: it never returns to its message loop.
 *   • BLOCKED — nobody is burning CPU. The 32 GB was mapped and then something stopped, and
 *     `wait=` names what on. That would put the cause in an IPC peer rather than in a loop.
 */
export function busyThreadReading(
  args: {
    threads?: unknown;
    windowMs?: unknown;
    busyMs?: unknown;
    /** The top thread by CPU delta: its delta, and whether it is the process's main thread. */
    topDeltaMs?: unknown;
    topIsMain?: unknown;
    topWait?: unknown;
  },
): { kind: BusyThreadKind; text: string } {
  const windowMs = Number(args.windowMs) || 0;
  const threads = Number(args.threads) || 0;
  const top = Number(args.topDeltaMs);
  if (!windowMs || !threads || !Number.isFinite(top)) {
    return {
      kind: 'unavailable',
      text: 'no thread census in this scan — the box predates VMTHREAD, or the census refused. That is an '
        + 'absence, not a reading: it says nothing about whether the renderer was spinning.',
    };
  }
  const share = top / windowMs;
  if (share < BUSY_THREAD_SHARE) {
    return {
      kind: 'blocked',
      text: `BLOCKED, not spinning: across ${threads} thread(s) the busiest burned ${Math.round(top)} ms of a `
        + `${windowMs} ms window (${(share * 100).toFixed(0)}%). Nothing is looping, so the 32 GB was mapped `
        + `and then the process stopped${args.topWait && args.topWait !== '-' ? `, waiting on ${String(args.topWait)}` : ''}. `
        + 'That points at an IPC peer or a lock rather than at an allocation loop.',
    };
  }
  const main = args.topIsMain === true || String(args.topIsMain).toLowerCase() === 'true';
  return {
    kind: main ? 'spinning-main' : 'spinning-worker',
    text: `SPINNING on ${main ? 'the MAIN thread' : 'a WORKER thread'}: the busiest of ${threads} thread(s) `
      + `burned ${Math.round(top)} ms of a ${windowMs} ms window (${(share * 100).toFixed(0)}% of a core). `
      + (main
        ? 'The renderer main thread is in a loop that never returns to its message loop, which is also why it '
          + 'answers no CDP call. Blink, JS, the command-buffer client and the allocator all live there.'
        : 'The main thread is NOT the busy one, so the loop is on a worker (raster, compositor, a pool thread) '
          + 'and the main thread is blocked behind it — a different creator from anything on the main thread.'),
  };
}

export type ServicePairKind =
  | 'absent'
  | 'no-renderer-reading'
  | 'renderer-not-spinning'
  | 'service-idle'
  | 'service-busy';

/**
 * IS THE GPU SERVICE DRAINING, WHILE THE RENDERER SPINS?
 *
 * 2026-09-09 measured the ramping renderer's MAIN thread at 100% of a core against a control
 * renderer at 0%. That named WHY no CDP instrument can reach it — the main thread is where CDP
 * is serviced — and it left the creator of the 16,384 anonymous 2 MB sections unnamed.
 *
 * `MappedMemoryManager` is the candidate that fits every reading taken so far:
 * `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is 2,097,152 bytes against a 2-4M bucket
 * of 32,778 MB / 16,387 = 2.0000 MB; one shared region per chunk; in the renderer; anonymous
 * and READWRITE; with the JS heap flat at 8-11 MB so it is not JS retention. Its `FreeUnused()`
 * reclaims a chunk only when the command buffer's TOKENS have passed, and a main thread that
 * never returns to its message loop cannot advance them — so every allocation takes a fresh
 * chunk and nothing is ever given back.
 *
 * That story makes a prediction about a SECOND process, and the prediction can be checked from
 * OUTSIDE without asking Chromium anything: a service nobody is pumping is a service that is
 * not busy. The census already runs on Windows' own thread times, so this costs one more
 * subject and no new instrument.
 *
 * THE TWO BRANCHES ARE DIFFERENT INVESTIGATIONS, which is what makes the reading worth taking:
 * an idle service is consistent with the client filling a queue nobody drains; a service that
 * is itself burning CPU is not that shape at all, and would move the question to what the GPU
 * process is doing.
 *
 * IT TAKES KINDS, NOT NUMBERS, ON PURPOSE. `busyThreadReading` owns the definition of "busy"
 * (`BUSY_THREAD_SHARE`); deriving a second one here would let the renderer's verdict and this
 * pairing disagree about the same process on the same scan.
 */
export function servicePairReading(
  args: {
    /** The TARGET renderer's census verdict, or undefined when it has none. */
    renderer?: BusyThreadKind;
    /** The GPU process's census verdict, or undefined when the scan carries no GPU line. */
    gpu?: BusyThreadKind;
    /** Why no GPU line, when the scan said so — a not-found report reads differently from silence. */
    gpuNote?: string;
  },
): { kind: ServicePairKind; text: string } {
  if (!args.gpu || args.gpu === 'unavailable') {
    return {
      kind: 'absent',
      text: 'no GPU-process reading in this scan'
        + (args.gpuNote ? ` — ${args.gpuNote}` : ' — the box predates the GPU census, or the census refused')
        + '. That is an ABSENCE, not a reading: it says nothing about whether the service was draining, and '
        + 'must not be read as an idle one.',
    };
  }
  const gpuBusy = args.gpu === 'spinning-main' || args.gpu === 'spinning-worker';
  if (!args.renderer || args.renderer === 'unavailable') {
    return {
      kind: 'no-renderer-reading',
      text: `the GPU process reads ${gpuBusy ? 'BUSY' : 'IDLE'}, but there is no renderer census beside it. `
        + 'One process is a number and not a pairing — the whole reading is the comparison.',
    };
  }
  if (args.renderer === 'blocked') {
    return {
      kind: 'renderer-not-spinning',
      text: `the renderer is BLOCKED rather than spinning, so the client-allocates-service-never-drains pairing `
        + `does not arise: that shape needs a client that is filling a queue. The GPU process reads `
        + `${gpuBusy ? 'BUSY' : 'IDLE'}, and neither value says anything about the candidate on this scan. `
        + 'Read the renderer verdict above first.',
    };
  }
  if (gpuBusy) {
    return {
      kind: 'service-busy',
      text: 'the renderer is SPINNING and the GPU process is BURNING CPU TOO. That is NOT the '
        + 'client-allocates-service-never-drains shape: a service that is itself looping is being pumped, or is '
        + 'looping on its own account, and either way the question moves to what the GPU process is doing. '
        + 'This is the branch that argues AGAINST MappedMemoryManager — take it as a new investigation, not a '
        + 'failed one.',
    };
  }
  return {
    kind: 'service-idle',
    text: 'the renderer is SPINNING and the GPU process is IDLE — the client-allocates-service-never-drains '
      + 'shape, and what MappedMemoryManager predicts: the command buffer\'s tokens cannot advance while the '
      + 'main thread never returns to its message loop, so chunks are taken and never reclaimed. '
      + 'CONSISTENT WITH, NOT PROOF. An idle service is also exactly what you see if nothing was ever sent to '
      + 'it, and the same hypothesis\'s failure mode predicts an idle GPU either way — this narrows the field '
      + 'and names no creator. What would have refuted it is the other branch, and it did not fire.',
  };
}

export type MappedSpanKind = 'unavailable' | 'packed' | 'scattered';

/**
 * ARE THE 16k SECTIONS SUB-ALLOCATIONS OF ONE RESERVATION, OR TAKEN ONE AT A TIME?
 *
 * The walk already established there is one allocation base per region — 16k separate
 * `MapViewOfFile` calls, not a few big mappings carved up. What it never reported is WHERE
 * those bases sit, and that separates two different creators:
 *
 *   • PACKED — the span is about what the regions themselves occupy, so they are consecutive
 *     sub-allocations of a single reservation: a cage, a pool, a sandbox. `VMTOP` in the same
 *     scan names which reservation the span falls inside.
 *   • SCATTERED — the span is orders of magnitude larger than the regions, so each was taken
 *     from wherever the allocator happened to land. That is ordinary shared memory.
 *
 * Free: `AllocationBase` is already in the MEMORY_BASIC_INFORMATION the walk reads.
 */
export function mappedSpanReading(
  args: { spanMb?: unknown; packedMb?: unknown; regions?: unknown },
): { kind: MappedSpanKind; text: string } {
  const span = Number(args.spanMb);
  const packed = Number(args.packedMb);
  const regions = Number(args.regions) || 0;
  if (!Number.isFinite(span) || !Number.isFinite(packed) || packed <= 0) {
    return {
      kind: 'unavailable',
      text: 'no address span in this scan — the box predates VMSPAN. An absence, not a reading.',
    };
  }
  // Twice the packed size still reads as one reservation: a cage holds other things too, and
  // demanding exactness would call a real pool "scattered" over ordinary internal gaps.
  if (span <= packed * 2) {
    return {
      kind: 'packed',
      text: `PACKED: ${regions} region(s) totalling ${packed} MB sit inside a ${span} MB span, so they are `
        + 'consecutive sub-allocations of ONE reservation rather than 16k independent mappings. Read the span '
        + "against VMTOP in the same scan — whichever reservation contains it names the allocator, and that "
        + 'is a cage/pool/sandbox, not ordinary shared memory.',
    };
  }
  return {
    kind: 'scattered',
    text: `SCATTERED: ${regions} region(s) totalling ${packed} MB are spread over a ${span} MB span `
      + `(${Math.round(span / packed)}x), so each was taken from wherever the allocator landed rather than `
      + 'carved from one reservation. That is the shape of ordinary shared memory taken one mapping at a time.',
  };
}

/**
 * Is there a FILE behind those mappings?
 *
 * Anonymous is what `base::SharedMemory`, discardable segments and mojo data pipes all are,
 * so it hands the question to Chromium's own dump. A file NAMES the creator outright and
 * needs nobody's cooperation — which is the branch that would end this in one reading.
 *
 * ACCESS AND SAMPLE SIZE COME BEFORE THE VERDICT. A census that could not run and one that
 * ran and found every region anonymous are opposite readings that render identically without
 * them, and here that absent-reading-as-a-negative would retire the only branch that can name
 * a creator without Chromium.
 */
export function mappedNameReading(
  args: { access?: unknown; sampled?: unknown; named?: unknown },
): { kind: MappedNameKind; text: string } {
  const access = Number(args.access) || 0;
  const sampled = Number(args.sampled) || 0;
  const named = Number(args.named) || 0;
  if (access < NAME_CENSUS_ACCESS) {
    return {
      kind: 'no-access',
      text: `name census did NOT run: the walk got access=${access} and GetMappedFileName needs `
        + `${NAME_CENSUS_ACCESS} (PROCESS_VM_READ). That is a refusal, NOT "no region has a file behind it".`,
    };
  }
  if (sampled === 0) return { kind: 'unsampled', text: 'name census sampled nothing in that band.' };
  if (named === 0) {
    return {
      kind: 'anonymous',
      text: `name census: ${sampled} sampled, ALL ANONYMOUS — pagefile-backed sections with no file behind `
        + "them. That is what base::SharedMemory, discardable segments and mojo pipes all are, so the memory "
        + "dump's owner column is what names the creator.",
    };
  }
  return {
    kind: 'file-backed',
    text: `name census: ${named} of ${sampled} sampled are FILE-BACKED — the file names the creator without `
      + 'asking Chromium anything.',
  };
}

export type SpinSiteKind =
  | 'unavailable' | 'not-sampled' | 'unmeasured' | 'unread' | 'no-modules'
  | 'suspect-offset' | 'module' | 'jit' | 'mixed';

/**
 * The leading class must carry this share of the samples that were read before it is named.
 * Below it the two classes are reported as a MIXED reading rather than one of them being
 * called the answer — the same share gate, and the same reason, as the bucket verdict in the
 * readout: a verdict that fires on every input fires on the ones that mean nothing.
 */
export const SPIN_SITE_DOMINANCE = 0.6;

/**
 * WHAT IS THE SPINNING MAIN THREAD ACTUALLY EXECUTING?
 *
 * The thread census named the symptom — the ramping renderer's main thread burns 100% of a
 * core against a control renderer at 0% — and that one fact explains every CDP instrument
 * that has ever failed here, because CDP is serviced on that thread. It does not say what the
 * loop IS, and the loop is the bug. `VMSTACK` samples the thread's instruction pointer from
 * outside the process (see `ramp-scan.mjs`) and this turns the counts into the sentence.
 *
 * THE TWO ANSWERS NEED OPPOSITE FIXES, which is the whole reason the reading is worth taking:
 *
 *   • MODULE — the loop is native Chromium code. `chrome.dll+0x...` is fixed for a build, so
 *     it symbolizes offline against that version and names the function, and the fix is a
 *     Chromium-level one: a flag, or not using the feature.
 *   • JIT — the addresses are executable and belong to no loaded image, so they are generated
 *     code: RC's own page script is the loop. The fix is then on our side of the page and
 *     needs no Chromium change at all.
 *
 * AND IT REFUSES BEFORE IT NAMES EITHER. `Rip` sits at byte 248 of the x64 CONTEXT because
 * that struct carries six debug registers and not eight. Misremember that and the read returns
 * `Rbp` or `R15` — a stack or data pointer, which belongs to no module and would be reported
 * as JIT-compiled JavaScript: a plausible answer, for the wrong reason, pointing the next
 * session at the wrong half of the system. So every address is asked whether its page is
 * EXECUTABLE, on an axis kept independent of the module check, and a reading where the
 * non-executable samples dominate is refused rather than explained.
 */
export function spinSiteReading(
  args: {
    /** Whether the scan carried a VMSTACK line at all. */
    present?: boolean;
    /** `not-spinning` when the census found a blocked thread, which is not sampled. */
    status?: string;
    /** How many instruction pointers came back non-zero. */
    read?: unknown;
    executable?: unknown;
    notExecutable?: unknown;
    module?: unknown;
    anonExec?: unknown;
    /** Distinct addresses over the samples read — how tight the loop is, not whether it is one. */
    distinct?: unknown;
    /** The most-sampled address, for the line a human acts on. */
    topAt?: string;
    topCount?: unknown;
    /** chrome.dll's file version, without which an offset cannot be symbolized offline. */
    build?: string;
    /**
     * How many loaded images the scan could enumerate. LOAD-BEARING: classification is
     * `inside one of these, or not`, so an enumeration that returned NOTHING makes every
     * address fall outside every module and renders as JIT — a confident wrong answer built
     * out of a failed read. `Process.Modules` can throw part-way for a process under
     * pressure, which is exactly the process this runs against.
     */
    modules?: unknown;
    /** The script's own refusal, when it printed one. */
    note?: string;
  },
): { kind: SpinSiteKind; text: string } {
  if (!args.present) {
    return {
      kind: 'unavailable',
      text: 'no VMSTACK reading in this scan'
        + (args.note ? ` — ${args.note}` : ' — the box predates the sampler, or it refused')
        + '. That is an ABSENCE, not a reading: it says nothing about what the thread was doing.',
    };
  }
  if (args.status === 'unmeasured') {
    return {
      kind: 'unmeasured',
      text: 'the census could not compute a CPU delta for that thread, so the sampler stood down. That is a '
        + 'failed measurement and NOT a thread that was idle — it says nothing either way about a loop.',
    };
  }
  if (args.status === 'not-spinning') {
    return {
      kind: 'not-sampled',
      text: 'the thread was BLOCKED rather than spinning, so it was deliberately not sampled: a parked '
        + 'thread sits in a wait, which the census already reports as `wait=`, and there is no loop to name. '
        + 'Read the census verdict above instead.',
    };
  }
  const read = Number(args.read) || 0;
  if (read === 0) {
    return {
      kind: 'unread',
      text: 'the sampler ran and read NO instruction pointer — the thread could not be opened, or every '
        + 'GetThreadContext failed. That is a failed measurement, not a thread with nowhere to be, and it '
        + 'must not be read as either answer.',
    };
  }
  const notExec = Number(args.notExecutable) || 0;
  const exec = Number(args.executable) || 0;
  if (notExec > exec) {
    return {
      kind: 'suspect-offset',
      text: `REFUSED: ${notExec} of ${read} sampled addresses are NOT on an executable page (${exec} are). `
        + 'A spinning thread executes at every instant, so its instruction pointer is always code — these '
        + 'are not instruction pointers. The CONTEXT offset is wrong, or the samples are not what they claim. '
        + 'Do NOT read the classes below as an answer; fix the read first.',
    };
  }
  const mod = Number(args.module) || 0;
  const jit = Number(args.anonExec) || 0;
  // NO MODULE LIST, NO JIT VERDICT. `anonExec` means `executable and in no loaded image`, and
  // with an empty enumeration that is true of EVERY address — so a failed `Process.Modules`
  // read would manufacture a unanimous JIT answer out of nothing and send the next session
  // hunting a script that is not there. The module branch is unaffected: it cannot fire.
  // `== null` CATCHES BOTH, AND THE NULL HALF IS THE ONE THAT BITES. `Number(undefined)` is
  // NaN, which never equals 0 — but `Number(null)` IS 0, so a caller passing null for "not
  // reported" would be refused as "zero modules found". That exact trap made the ramp-dump
  // grace inert on 2026-09-08 (`Number(null)` read as an expiry at the epoch), and it is
  // cheap to close once rather than rediscover.
  const modules = args.modules == null ? null : Number(args.modules);
  if (modules === 0) {
    return {
      kind: 'no-modules',
      text: `REFUSED: the scan enumerated ZERO loaded modules, so every one of the ${read} addresses falls `
        + 'outside every image by construction and the JIT reading would be an artefact of a failed read, '
        + 'not a finding. A renderer always has dozens of modules; this is Process.Modules failing, which it '
        + 'can do against a process under pressure. Fix the enumeration before reading the classes.',
    };
  }
  const distinct = Number(args.distinct) || 0;
  const tight = distinct > 0
    ? ` ${distinct} distinct address(es) over ${read} samples`
      + (distinct <= 8 ? ' — a tight loop.' : ' — a wide loop body or several sites, not a handful of instructions.')
    : '';
  const top = args.topAt && Number(args.topCount)
    ? ` Most-sampled: ${args.topAt} (${Number(args.topCount)} of ${read}).`
    : '';
  if (mod / read >= SPIN_SITE_DOMINANCE) {
    return {
      kind: 'module',
      text: `the loop is in NATIVE CODE: ${mod} of ${read} samples fall inside a loaded module.${tight}${top} `
        + (args.build
          ? `chrome.dll is ${args.build}, so the offset symbolizes offline against that build and names the `
            + 'function. '
          : 'No chrome.dll version was reported, so an offset cannot be symbolized until one is. ')
        + 'This is the branch where the fix is Chromium-level — a flag, or not using the feature — and NOT in '
        + 'anything we serve to the page.',
    };
  }
  if (jit / read >= SPIN_SITE_DOMINANCE) {
    return {
      kind: 'jit',
      text: `the loop is in GENERATED CODE: ${jit} of ${read} samples are on executable pages that belong to `
        + `no loaded image, which is JIT-compiled JavaScript.${tight}${top} So the thread is spinning in `
        + "RC's own page script, not inside Chromium — the fix is on our side of the page (what we let that "
        + 'page run, and for how long) and needs no Chromium change. It does NOT by itself name which script.',
    };
  }
  return {
    kind: 'mixed',
    text: `NO CLASS DOMINATES: ${mod} of ${read} samples are in a loaded module and ${jit} are in generated `
      + `code, neither reaching ${Math.round(SPIN_SITE_DOMINANCE * 100)}%.${tight}${top} That is a real `
      + 'reading and not a failure — it says the thread is not sitting in one place — but it does not choose '
      + 'between a native loop and a script one, so do not quote it as either.',
  };
}
