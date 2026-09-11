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
import { MEM_DUMP_TIMEOUT_MS } from './rc-mem-dump.mjs';
// ONE DEFINITION OF THE COMMIT BAR, IMPORTED RATHER THAN COPIED. `ramp-scan.mjs` backtested
// 9000 over every recorded event and the two arms must not disagree about which EVENT they
// see — the same rule that pins `RAMP_SCAN_MB` and `RAMP_MB` equal. That module has no
// top-level side effects, so importing it for a constant starts nothing.
import { RAMP_SCAN_COMMIT_MB } from './ramp-scan.mjs';

/** Where the sampler leaves its newest reading, beside the bot scripts. */
export const MEMORY_LATEST_FILE = '.memory-latest.json';

/**
 * A figure or NULL — never 0, and never a coerced `NaN`. A scan that could not run writes
 * null, and null is UNKNOWN: `Number(undefined)` is NaN and `Number(null)` is 0, and a 0
 * commit reading would read as "the box is idle" at exactly the moment it is not.
 * @param {unknown} v
 */
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
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
    // COMMIT IS WHY THIS FILE EXISTS FOR THE SECOND ARM. `memory-sample.mjs` has computed
    // these all along and this writer dropped them, so the bail arm — in a DIFFERENT process,
    // whose timer must never spawn PowerShell — had no way to see the one figure that moves
    // during the burst. `rc_mb` is private bytes, i.e. the pages actually touched, and it is
    // still under 2 GB when the ~32 GiB mapping is already complete.
    commitUsedMb: num(sample?.commitUsedMb),
    commitLimitMb: num(sample?.commitLimitMb),
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
 *
 * `notBefore` IS THE CURRENT BROWSER'S START, AND A READING OLDER THAN IT DESCRIBES THE
 * BROWSER BEFORE IT. The sampler is a different process on a 2-minute cadence and it totals
 * the whole rc FAMILY, so after a bail — which kills the browser and restarts this process
 * within seconds — the newest reading on disk is still the dead generation's, and it is well
 * inside `maxAgeMs`. That is not hypothetical: on 2026-09-07 the memory dump fired its `ramp`
 * phase against a browser five seconds old, on a 39-second-old reading of the browser that had
 * just been killed, and stored 2 MB of shared memory as if it were the ramp's own reading —
 * which is the ONE false elimination this instrument can manufacture (see rc-mem-dump.mjs).
 * The bail arm has the same exposure and a worse outcome: it would exit the process on a
 * reading about a browser that no longer exists.
 *
 * A reading taken before this browser existed cannot be about this browser, so it is UNKNOWN
 * and BOTH arms stand down — the rule they already follow everywhere else. It costs at most
 * one sampler cadence (2 min) against a `maxAgeMs` of 5 and a ramp that takes ~10 minutes to
 * peak, and the bail needs 120s of stall on top, so nothing real is lost.
 * @param {string} file
 * @param {{ now?: () => number, maxAgeMs?: number, notBefore?: number|null }} [opts]
 * @returns {{ known: boolean, why?: string, at?: number, ageMs?: number, rcMb?: number|null, maxPid?: unknown, maxType?: unknown }}
 */
export function readLatestMemory(file, { now = () => Date.now(), maxAgeMs = RAMP_READING_MAX_AGE_MS_DEFAULT, notBefore = null } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { known: false, why: 'no memory reading on disk' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { known: false, why: 'memory reading unparseable' }; }
  const at = Number(j?.at);
  if (!Number.isFinite(at)) return { known: false, why: 'memory reading carries no time' };
  const ageMs = now() - at;
  if (ageMs > maxAgeMs) return { known: false, why: `memory reading ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s)`, at, ageMs };
  // AFTER the age check, so a genuinely old reading keeps the more general reason. What is
  // left here is the dangerous case: FRESH, and about the wrong browser.
  if (Number.isFinite(Number(notBefore)) && at < Number(notBefore)) {
    return { known: false, why: `memory reading predates this browser by ${Math.round((Number(notBefore) - at) / 1000)}s — it describes the one before it`, at, ageMs };
  }
  const rcMb = j?.rcMb == null ? null : Number(j.rcMb);
  if (rcMb == null || !Number.isFinite(rcMb)) return { known: false, why: 'memory reading has no rc figure', at, ageMs };
  // COMMIT IS OPTIONAL AND ITS ABSENCE IS NOT AN UNKNOWN READING. A box running a build older
  // than this writes no commit field, and the whole reading must stay usable there — the arm
  // then behaves exactly as it does today, on `rcMb` alone. `known` therefore still turns on
  // the rc figure only.
  return {
    known: true, at, ageMs, rcMb,
    commitUsedMb: num(j?.commitUsedMb), commitLimitMb: num(j?.commitLimitMb),
    maxPid: j?.maxPid ?? null, maxType: j?.maxType ?? null,
  };
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
  commitThresholdMb = RAMP_SCAN_COMMIT_MB,
}) {
  const out = { fire: false, stalledMs: null, rcMb: null, commitUsedMb: null, trigger: null, readingAgeMs: null, why: '' };
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
  out.commitUsedMb = num(memory.commitUsedMb);
  out.readingAgeMs = memory.ageMs;
  const stalled = out.stalledMs > stallMs;
  /**
   * CONDITION B IS TWO READINGS OF ONE EVENT, AND COMMIT IS THE ONE THAT MOVES FIRST.
   *
   * `rcMb` is PRIVATE bytes — the pages actually TOUCHED — and the ~32 GiB mapping is charged
   * to commit in ≤34 seconds while private bytes are still under 2 GB. Backtested over the 19
   * onsets in the seven days to 2026-09-11, a commit condition fires EARLIER on 11 of them by
   * a median 77s (max 162s) and NEVER later, taking a median 1,984 MB off the peak commit
   * (max 7,009). On the 48h to 09-11 it caps the peak at 44,354 MB instead of 46,807, i.e. the
   * tightest headroom against a 47,870 MB limit goes 1,063 → 3,516 MB.
   *
   * WHAT IT CANNOT DO, STATED SO NOBODY EXPECTS IT: at the sample where this first fires the
   * commit is ALREADY 35,794-48,444 MB — the mapping is complete. This buys one sampler tick
   * less of the private-byte tail. It does not touch the burst, and nothing that reads a file
   * another process writes every two minutes ever could.
   *
   * IT IS A SECOND TRIGGER, NOT A REPLACEMENT, for `ramp-scan.mjs`'s reason: commit is a
   * WHOLE-BOX figure that the owner's own desktop shares, so a reading that only ever came
   * from commit could be about something that is not Chromium at all. `rcMb` still fires on
   * its own, and BOTH-CONDITIONS with the stall is what makes the whole-box figure safe to
   * act on here — across 133 recorded tab-closes the longest trip is 71,552 ms and not one
   * exceeds 90,000, so a 120-second stall is very nearly diagnostic of a ramp by itself.
   *
   * POSITIVELY, NEVER `!(commitMb < threshold)`. An absent figure is UNKNOWN and must not
   * fire: a box on a build older than this writes none, and the negated form would fire on
   * every tick of one. Same trap `ramp-scan.mjs` names at its own commit trigger.
   */
  const byRc = memory.rcMb > thresholdMb;
  const byCommit = out.commitUsedMb != null && out.commitUsedMb >= commitThresholdMb;
  const big = byRc || byCommit;
  // WHICH ONE FIRED IS THE READING, NOT BOOKKEEPING — an in-burst bail and an after-the-fact
  // one are different events and must not arrive looking identical. Same field, same three
  // values, as the scan's `detail.trigger`.
  if (big) out.trigger = byRc && byCommit ? 'both' : byRc ? 'rcMb' : 'commitUsedMb';
  const commitSaid = out.commitUsedMb == null
    ? 'commit not reported'
    : `commit ${Math.round(out.commitUsedMb)} MB vs ${commitThresholdMb}`;
  if (stalled && big) {
    out.fire = true;
    out.why = `the loop is stalled AND the box is over a bar (${out.trigger})`;
  } else if (stalled) {
    out.why = `the loop has been stalled ${Math.round(out.stalledMs / 1000)}s but rc family ${Math.round(memory.rcMb)} MB is under the bar (${thresholdMb}), ${commitSaid}`;
  } else if (big) {
    out.why = `over a bar (${out.trigger}) but the loop advanced ${Math.round(out.stalledMs / 1000)}s ago`;
  } else {
    out.why = 'healthy';
  }
  return out;
}

/** The bail line. One shape, so the readout and a human grep for the same thing. */
export function rampBailLine(d) {
  // THE TRIGGER IS NAMED IN THE LINE, because `commitUsedMb` alone means this fired while the
  // private bytes were still climbing — a tick earlier than `rcMb` could have — and that is
  // the difference the whole second trigger exists to make. A line that read the same either
  // way would make the improvement unobservable from the log.
  const commit = d.commitUsedMb == null ? 'commit not reported' : `commit ${Math.round(d.commitUsedMb)} MB`;
  return `✗ RAMP — the loop has not advanced in ${Math.round((d.stalledMs ?? 0) / 1000)}s, `
    + `rc family ${Math.round(d.rcMb ?? 0)} MB, ${commit} `
    + `(reading ${Math.round((d.readingAgeMs ?? 0) / 1000)}s old, trigger ${d.trigger ?? 'none'}). `
    + 'Both conditions met; bailing now rather than at the twelve-minute wedge so the box keeps ~7 GB of commit.';
}

/**
 * HOW LONG THE BAIL WILL HOLD SO THE RAMP DUMP CAN BE TAKEN.
 *
 * ── WHY A HOLD AT ALL, WHEN THE THRESHOLDS WERE SUPPOSED TO BUY THE GAP ────────────────────
 * `MEM_DUMP_RAMP_MB` (1500) sits below `RAMP_MB` (3000) so the dump fires first. That is a gap
 * measured in MEGABYTES, and it is PAID IN SAMPLER TICKS: both arms read the same file, which
 * `bot.mjs` writes every two minutes, so a lower threshold only helps when a SAMPLE happens to
 * land between the two numbers. On 2026-09-08 none did, and the series says why:
 *
 *     09:01:10  rc =   238 MB   commit  7,273 / 17,150
 *     09:03:11  rc = 3,423 MB   commit 43,760 / 44,960   <- the only sample of the whole ramp
 *     09:05:11  rc =   205 MB   commit  7,000 / 17,150
 *
 * Onset, peak and bail inside ONE two-minute interval — ≥1,580 MB/min, nearly double the
 * ~850 MB/min the gap was sized against. The one reading above 1500 was also above 3000, both
 * arms went true on that tick, the arm returned, and `maybeMemoryDump` was never called. Third
 * consecutive ramp with no owner reading, third distinct mechanism.
 *
 * So NO threshold separation can guarantee the head start: the ramp can cross the entire gap
 * between two samples. The granularity that decides "same tick" is the sampler's period, not
 * the memory axis. #296 moved the number and left the mechanism.
 *
 * ── SO THE TICK IS WHAT IS GRANTED, NOT MEGABYTES ──────────────────────────────────────────
 * On a tick where the arm would fire and no ramp dump has been taken for this browser life,
 * the bail HOLDS and the dump is started instead. The next tick bails.
 *
 * BOUNDED BY A DEADLINE, ONCE PER BROWSER LIFE, AND THE DEADLINE IS THE POINT. `HUNG_MS`
 * already tolerates twelve minutes and this arm exists to cut that to two; a hold with no
 * bound would hand the twelve minutes back. The cost is real and it is the profile lock: the
 * bail is what releases it, and the lock staying held past 08:00 is what loses a cart. At
 * ≤2 ticks against a stall already 120s old and a bail whose own diagnostics take 2-8s, that
 * is a bounded ~12% and it is the only way the reading gets taken at all.
 *
 * TWO TICKS AT LEAST, deliberately. A refusal is not a reading, so `maybeMemoryDump` puts the
 * phase back and the next tick retries — and a BASELINE dump can be in flight when the arm
 * fires, which is not rare: the baseline is due three minutes into a browser life and every
 * burst-carrying ramp so far has landed in a browser 2-3 minutes old. One tick would spend the
 * grace on a call that could not start.
 *
 * ── AND ONE TICK IS EXACTLY WHAT IT SPENT, ON THE FIRST RAMP IT SAW (2026-09-08) ────────────
 * This used to read "THE GRACE IS SPENT WHETHER OR NOT THE DUMP LANDS — `dumpTaken` is set
 * when the dump STARTS, so the ordinary path holds exactly one tick." That is not a bound on
 * the wait, it is a REFUSAL to wait, and it cost the fourth consecutive ramp its owner column
 * ninety minutes after the grace reached the box:
 *
 *     14:47:50   * holding the bail up to 15s so the ramp dump can name what owns the 32 GB
 *     14:48:05 ✗ RAMP — the loop has not advanced in 139s, rc family 3739 MB
 *     14:48:06   Releasing the profile and exiting so the hold runner can use it.
 *                (no `memory dump (ramp) …` line, and no `did not run` line either)
 *
 * The grace was granted, the dump was STARTED, and `dumpTaken` went true synchronously — so
 * the very next tick took the `already under way` branch, ten seconds in, and `process.exit`
 * threw the accumulator away. The 15-second deadline was never consulted, because the
 * short-circuit sits above it.
 *
 * **AND THE DEADLINE WOULD NOT HAVE BEEN ENOUGH EITHER.** `MEM_DUMP_TIMEOUT_MS` is 20s and the
 * grace was 15 — two constants with no stated relationship, ordered the wrong way round, so
 * the bail was always going to kill a dump that was still inside its own budget. The pairing
 * the old guard checked was grace-against-TICK; the pairing that decides whether a reading is
 * possible is grace-against-DUMP-TIMEOUT, and nothing checked it. Same shape as `nextHoldRelease`
 * disagreeing with `dueHolds` about whether a hold existed. It is DERIVED now, and a guard pins
 * the relationship rather than the number.
 *
 * SO THE HOLD RUNS WHILE THE DUMP IS IN FLIGHT, TO THE DEADLINE — which is what "grace" meant
 * all along. `inFlight` is cleared in the dump's `.finally`, and `.finally` waits for the
 * `.then` chain, so it stays true until `reportBotEvent` has resolved: the hold covers the POST
 * as well as the dump, which is the half that actually gets the reading off the box.
 *
 * IT CAN DELAY THE BAIL, NEVER PREVENT IT. The deadline binds whatever the dump is doing, and
 * the bail fires on the first tick after it — so the worst case is `graceMs` plus one tick,
 * ~20-30s, against a stall already 120s old and a wedge that tolerates twelve minutes. The cost
 * is the profile lock arriving that much later, and it stays inside the hold runner's own 60s
 * preemption wait.
 */
export const MEM_DUMP_GRACE_MS_DEFAULT = MEM_DUMP_TIMEOUT_MS;

/**
 * Should the bail hold this tick so the ramp memory dump can be taken?
 *
 * `graceUntil` is the caller's stored deadline: null until the first hold, then the instant the
 * grace runs out. The caller stores what `until` returns.
 *
 * `dumpStarted` AND `dumpInFlight` ARE TWO FACTS AND THE OLD `dumpTaken` MERGED THEM. "Taken"
 * read as "we have the reading" and was implemented as "we asked for one"; the gap between
 * those is the whole event this instrument exists to measure. Only a dump that has STARTED and
 * is no longer RUNNING has actually been taken.
 * @param {{
 *   now: number,
 *   dumpStarted: boolean,
 *   dumpInFlight: boolean,
 *   graceUntil: number|null|undefined,
 *   canDump: boolean,
 *   graceMs?: number,
 * }} input
 * @returns {{ hold: boolean, started: boolean, until: number|null, why: string }}
 */
export function rampDumpGrace({ now, dumpStarted, dumpInFlight, graceUntil, canDump, graceMs = MEM_DUMP_GRACE_MS_DEFAULT }) {
  // `Number(null)` IS 0 AND `Number.isFinite(0)` IS TRUE, so a bare finite check reads "no
  // grace has been granted" as "the grace expired at the epoch" and bails on the first
  // firing tick — i.e. the fix present and inert. Caught by the guard on its first run.
  const until = graceUntil == null || !Number.isFinite(Number(graceUntil)) ? null : Number(graceUntil);
  // No CDP session means there is nothing to wait FOR. Holding the exit for a dump that
  // cannot be attempted is pure cost — the same rule as an UNKNOWN standing an arm down.
  if (!canDump) return { hold: false, started: false, until, why: 'no CDP probe, so there is no dump to wait for' };
  // TAKEN means started AND finished. This is the ordinary path: the dump answered, the event
  // was posted, `inFlight` cleared, and there is nothing left to wait for.
  if (dumpStarted && !dumpInFlight) {
    return { hold: false, started: false, until, why: 'the ramp dump for this browser life has been taken' };
  }
  if (until == null) {
    return {
      hold: true, started: true, until: now + graceMs,
      why: `holding the bail up to ${Math.round(graceMs / 1000)}s so the ramp dump can name what owns the 32 GB`,
    };
  }
  if (now < until) {
    // NOT PUSHED OUT. The deadline is set once, when the grace is granted; extending it on
    // every held tick is an unbounded hold wearing a bound's clothes.
    return {
      hold: true, started: false, until,
      why: dumpStarted
        ? `waiting for the ramp dump to answer, inside the ${Math.round(graceMs / 1000)}s grace`
        : `still inside the ${Math.round(graceMs / 1000)}s dump grace — retrying the ramp dump`,
    };
  }
  // NAMED, AND THE TWO EXPIRIES ARE DIFFERENT FINDINGS. A dump still running when the deadline
  // binds is a browser too slow to answer inside its own budget; a deadline reached with
  // nothing started is a dump that could never begin. Merging them is what made 2026-09-08
  // print no line at all.
  return {
    hold: false, started: false, until,
    why: dumpInFlight
      ? 'the dump grace expired with the dump still in flight — bailing, the owner reading is lost'
      : 'the dump grace expired without a dump — bailing with no owner reading',
  };
  return { hold: false, started: false, until, why: 'the dump grace expired without a dump — bailing with no owner reading' };
}
