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
 * A. The RESIDENT LOOP HAS NOT ADVANCED for `stallMs` — `Date.now() - lastTick`, the same
 *    signal the wedge and RUNAWAY arms already use, and the one thing in this process that
 *    cannot itself go quiet. It is never UNKNOWN.
 *
 *    IT WAS CDP SILENCE UNTIL 2026-09-05, AND THAT MADE THIS ARM INERT ON ITS FIRST RAMP.
 *    The ramp began at 07:30 PT and the bail landed at 07:42 — twelve minutes, `HUNG_MS` to
 *    the minute, i.e. the WEDGE arm — while `ramp-scan` had already triggered at 07:31:28
 *    with the family at 3,203 MB. So condition B was satisfiable eleven minutes before the
 *    exit and this arm still did not fire: the renderer went on answering
 *    `Performance.getMetrics` while the process grew to 8,879 MB. (Which arm fired cannot be
 *    read back — `tail-log` returns 16,000 characters and that window had rolled — so the
 *    arithmetic is the evidence, not a log line. The arm now names itself for exactly this
 *    reason.)
 *
 *    That is the house failure one more time: an instrument gated on a signal that does not
 *    change during the event. `lastTick` DOES: both observed ramps stalled the loop, 09-04
 *    for 634s in `checkAndReport` and 09-05 for the full twelve minutes.
 * B. The rc family is past `thresholdMb`, read from a FILE that `bot.mjs`'s sampler writes
 *    on every sample. THE TIMER MUST NOT SPAWN: `rcFamilyMb()` runs PowerShell and spawning
 *    is what fails first at high commit — it is how `supervise.ps1` could not start a shell
 *    on 08-12. A file read is not a spawn. `os.freemem()` cannot serve here for the reason
 *    above. The reading is AGE-GATED: older than `maxAgeMs` is UNKNOWN, because a sampler
 *    that has stopped is not a family that has shrunk.
 *
 * A stalled loop alone is an unattended sign-in doing its job, or RC's app tier failing to
 * render for five minutes (observed 08-31 and 09-02) — which is why `HUNG_MS` tolerates
 * twelve. A big family alone is a ramp the loop may still be advancing through, which the
 * size arm handles once the loop returns. Neither alone earns spending the session, and any
 * UNKNOWN stands down — the same rule as `hasAvailabilityInRange` returning null.
 *
 * BOTH-CONDITIONS SURVIVES THE SWAP, AND THAT IS DELIBERATE. The rule was written for the
 * RAM arm, where free RAM alone is ambiguous — it is the owner using their own desktop. It
 * is kept here for the same reason and not weakened into a size-only arm: the loop-body size
 * guard already acts on `rcFamilyMb` alone at 1,500 MB and can RECYCLE, which is cheaper than
 * the exit this arm spends. This arm exists only for the case that guard cannot reach.
 *
 * A pure module for the reason `session-coverage.mjs` and `tab-close.mjs` are: the decision
 * lives in a `setInterval` inside a loop that starts on import, and its firing arm only runs
 * during a ramp.
 */
import fs from 'node:fs';

/** Where the sampler leaves its newest reading, beside the bot scripts. */
export const MEMORY_LATEST_FILE = '.memory-latest.json';
/** How long the resident loop must have been stalled before it counts as a ramp in progress. */
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
 *   stalledMs: number|null|undefined,
 *   memory: ReturnType<typeof readLatestMemory>,
 *   stallMs?: number, thresholdMb?: number,
 * }} input
 * @returns {{ fire: boolean, stalledMs: number|null, rcMb: number|null, readingAgeMs: number|null, why: string }}
 */
export function rampBailDecision({
  stalledMs, memory,
  stallMs = RAMP_STALL_MS_DEFAULT, thresholdMb = RAMP_MB_DEFAULT,
}) {
  const out = { fire: false, stalledMs: null, rcMb: null, readingAgeMs: null, why: '' };
  // Condition A — the loop's own stall. NEVER UNKNOWN: `lastTick` is a local number the
  // timer sets, so unlike the CDP silence this replaced there is no "we could not tell".
  if (!Number.isFinite(Number(stalledMs))) { out.why = 'no stall reading, so the loop state is UNKNOWN'; return out; }
  out.stalledMs = Number(stalledMs);
  // Condition B — the rc family, from the sampler's file.
  if (!memory?.known) {
    out.why = memory?.why ?? 'memory reading UNKNOWN';
    if (Number.isFinite(memory?.ageMs)) out.readingAgeMs = memory.ageMs;
    return out;
  }
  out.rcMb = memory.rcMb;
  out.readingAgeMs = memory.ageMs;
  const stalled = out.stalledMs > stallMs;
  const big = memory.rcMb > thresholdMb;
  if (stalled && big) {
    out.fire = true;
    out.why = 'the loop is stalled AND the rc family is over the bar';
  } else if (stalled) {
    out.why = `the loop has been stalled ${Math.round(out.stalledMs / 1000)}s but rc family ${Math.round(memory.rcMb)} MB is under the bar (${thresholdMb})`;
  } else if (big) {
    out.why = `rc family ${Math.round(memory.rcMb)} MB is over the bar but the loop advanced ${Math.round(out.stalledMs / 1000)}s ago`;
  } else {
    out.why = 'healthy';
  }
  return out;
}

/** The bail line. One shape, so the readout and a human grep for the same thing. */
export function rampBailLine(d) {
  return `✗ RAMP — the loop has not advanced in ${Math.round((d.stalledMs ?? 0) / 1000)}s, `
    + `rc family ${Math.round(d.rcMb ?? 0)} MB (reading ${Math.round((d.readingAgeMs ?? 0) / 1000)}s old). `
    + 'Both conditions met; bailing now rather than at the twelve-minute wedge so the box keeps ~7 GB of commit.';
}
