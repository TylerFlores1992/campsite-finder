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
export type DumpJoinVoidCause = 'generation' | 'target-silent' | 'unknown';

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
