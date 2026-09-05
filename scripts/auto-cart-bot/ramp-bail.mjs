/**
 * THE TWO-MINUTE BAIL — end a ramp at two minutes instead of twelve, without spawning.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 * On 2026-09-04 22:19 the instruments finally said what ENDS a ramp: the twelve-minute
 * wedge watchdog. `checkAndReport` drives the resident page, whose renderer had stopped
 * answering, so the loop parked there until `HUNG_MS` bailed the process — and that twelve
 * minutes is the ten-to-twelve-minute ramp duration this repo has puzzled over since 08-17.
 * The RAM arm sat out sixteen consecutive ramps and could never fire: the 35 GB is committed
 * and UNTOUCHED, and untouched commit never lowers free RAM. The size arm sits in the loop
 * body, which is by definition not advancing during a ramp.
 *
 * A bail at two minutes costs exactly the session the twelve-minute one costs today. What
 * it buys is a two-minute ramp, ~7 GB less commit on the box, and the request counts taken
 * at the ONSET rather than at the peak.
 *
 * ── THE TWO CONDITIONS, BOTH ALWAYS ────────────────────────────────────────────────────────
 * A. The resident renderer has answered no CDP call for `stallMs`. The signal already
 *    exists: `sampleHeap` returns null on `no answer`, so the heap trail stops growing and
 *    the age of its newest sample IS the silence. Requires a heap probe and at least one
 *    prior sample — an EMPTY trail is "never answered", which is the fresh-launch state, and
 *    reads as UNKNOWN. The throwaway tabs have their own renderers (measured 09-04), so a
 *    live Okta trip does not silence the resident page; this arm cannot fire on a working
 *    sign-in the way the RAM arm did on 08-19.
 * B. The rc family is past `thresholdMb`, read from a FILE that `bot.mjs`'s sampler writes
 *    on every sample. THE TIMER MUST NOT SPAWN: `rcFamilyMb()` runs PowerShell and spawning
 *    is what fails first at high commit — it is how `supervise.ps1` could not start a shell
 *    on 08-12. A file read is not a spawn. `os.freemem()` cannot serve here for the reason
 *    above. The reading is AGE-GATED: older than `maxAgeMs` is UNKNOWN, because a sampler
 *    that has stopped is not a family that has shrunk.
 *
 * A silent renderer alone is RC's app tier failing to render for five minutes (observed
 * 08-31 and 09-02). A big family alone is a ramp the loop may still be advancing through,
 * which the size arm handles once the loop returns. Neither alone earns spending the session.
 * Any UNKNOWN stands down — the same rule as `hasAvailabilityInRange` returning null.
 *
 * A pure module for the reason `session-coverage.mjs` and `tab-close.mjs` are: the decision
 * lives in a `setInterval` inside a loop that starts on import, and its firing arm only runs
 * during a ramp.
 */
import fs from 'node:fs';

/** Where the sampler leaves its newest reading, beside the bot scripts. */
export const MEMORY_LATEST_FILE = '.memory-latest.json';
/** CDP silence on the resident renderer before it counts as a ramp in progress. */
export const RAMP_STALL_MS_DEFAULT = 120_000;
/** rc family total at which a silent renderer is a ramp. The same bar `ramp-scan.mjs` uses. */
export const RAMP_MB_DEFAULT = 3000;
/** A memory reading older than this is UNKNOWN — the sampler runs every two minutes. */
export const RAMP_READING_MAX_AGE_MS_DEFAULT = 5 * 60_000;

/**
 * Write the newest sample atomically: a temp name, then `renameSync`, so a reader never sees
 * half a file. Never throws — a failed write is a log line, and the reader's age gate turns a
 * stale file into UNKNOWN rather than into a reading.
 * @param {string} file
 * @param {{ rcMb?: number|null, maxPid?: number|null, maxType?: string|null, [k: string]: unknown }} sample
 * @param {{ now?: () => number, log?: (l: string) => void }} [opts]
 */
export function writeLatestMemory(file, sample, { now = () => Date.now(), log = () => {} } = {}) {
  const at = now();
  const body = JSON.stringify({
    at,
    rcMb: Number.isFinite(Number(sample?.rcMb)) && sample?.rcMb != null ? Number(sample.rcMb) : null,
    maxPid: sample?.maxPid ?? null,
    maxType: sample?.maxType ?? null,
  });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`  (could not write ${file}: ${e?.message ?? e})`);
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Read the sampler's newest reading. Anything missing, unparseable or stale is UNKNOWN, with
 * the reason attached so the log can say which.
 * @returns {{ known: boolean, why?: string, at?: number, ageMs?: number, rcMb?: number|null, maxPid?: unknown, maxType?: unknown }}
 */
export function readLatestMemory(file, { now = () => Date.now(), maxAgeMs = RAMP_READING_MAX_AGE_MS_DEFAULT } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { known: false, why: 'no memory reading on disk' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { known: false, why: 'memory reading unparseable' }; }
  const at = Number(j?.at);
  if (!Number.isFinite(at)) return { known: false, why: 'memory reading carries no time' };
  const ageMs = now() - at;
  if (ageMs > maxAgeMs) return { known: false, why: `memory reading ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s)`, at, ageMs };
  const rcMb = j?.rcMb == null ? null : Number(j.rcMb);
  if (rcMb == null || !Number.isFinite(rcMb)) return { known: false, why: 'memory reading has no rc figure', at, ageMs };
  return { known: true, at, ageMs, rcMb, maxPid: j?.maxPid ?? null, maxType: j?.maxType ?? null };
}

/**
 * The decision. `fire` is true only when BOTH conditions are known and met.
 * @param {{
 *   heapTrail: { at: number }[], heapProbe: unknown,
 *   memory: ReturnType<typeof readLatestMemory>,
 *   now?: () => number, stallMs?: number, thresholdMb?: number,
 * }} input
 * @returns {{ fire: boolean, silentMs: number|null, rcMb: number|null, readingAgeMs: number|null, why: string }}
 */
export function rampBailDecision({
  heapTrail, heapProbe, memory, now = () => Date.now(),
  stallMs = RAMP_STALL_MS_DEFAULT, thresholdMb = RAMP_MB_DEFAULT,
}) {
  const out = { fire: false, silentMs: null, rcMb: null, readingAgeMs: null, why: '' };
  // Condition A — the renderer's silence, from the trail's newest sample.
  if (!heapProbe) { out.why = 'no heap probe, so renderer silence is UNKNOWN'; return out; }
  const newest = Array.isArray(heapTrail) && heapTrail.length > 0 ? heapTrail[heapTrail.length - 1] : null;
  if (!newest || !Number.isFinite(Number(newest.at))) { out.why = 'the renderer has never answered, so its silence is UNKNOWN (fresh launch)'; return out; }
  out.silentMs = now() - Number(newest.at);
  // Condition B — the rc family, from the sampler's file.
  if (!memory?.known) {
    out.why = memory?.why ?? 'memory reading UNKNOWN';
    if (Number.isFinite(memory?.ageMs)) out.readingAgeMs = memory.ageMs;
    return out;
  }
  out.rcMb = memory.rcMb;
  out.readingAgeMs = memory.ageMs;
  const silent = out.silentMs > stallMs;
  const big = memory.rcMb > thresholdMb;
  if (silent && big) {
    out.fire = true;
    out.why = 'renderer silent AND rc family over the bar';
  } else if (silent) {
    out.why = `renderer silent ${Math.round(out.silentMs / 1000)}s but rc family ${Math.round(memory.rcMb)} MB is under the bar (${thresholdMb})`;
  } else if (big) {
    out.why = `rc family ${Math.round(memory.rcMb)} MB is over the bar but the renderer answered ${Math.round(out.silentMs / 1000)}s ago`;
  } else {
    out.why = 'healthy';
  }
  return out;
}

/** The bail line. One shape, so the readout and a human grep for the same thing. */
export function rampBailLine(d) {
  return `✗ RAMP — resident renderer silent ${Math.round((d.silentMs ?? 0) / 1000)}s, `
    + `rc family ${Math.round(d.rcMb ?? 0)} MB (reading ${Math.round((d.readingAgeMs ?? 0) / 1000)}s old). `
    + 'Both conditions met; bailing now rather than at the twelve-minute wedge so the box keeps ~7 GB of commit.';
}
