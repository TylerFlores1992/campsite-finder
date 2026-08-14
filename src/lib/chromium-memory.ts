/**
 * THE CHROMIUM MEMORY SERIES — storing it, and reading a verdict out of it.
 *
 * See migration 059 for why it is recorded rather than asked for. The short version: the leak
 * that has needed a power cycle is on a profile family nobody has ever identified, one
 * candidate family (rec.gov) exists only in ~30-minute bursts, and the prescribed remedy of
 * "take two `memory` readings five minutes apart" was run on 2026-08-14 and sampled zero
 * processes of that family while returning a confident negative growth rate.
 *
 * ── THE VERDICT REFUSES TO BE EARNED CHEAPLY ───────────────────────────────────────────────
 * Same posture as `recgov-429-profile.mts` refusing until all 24 hours have data, and
 * `rc-session-verdict` counting only the probes that actually TESTED renewal. A rate needs two
 * samples of the SAME pid; a family total across a restart is not a rate, it is two different
 * browsers subtracted from each other. Every guard below exists because the alternative is a
 * number that looks like a measurement and is not one.
 */
import { query, mutate } from '@/lib/db/client';

/** What the box sends. Every field may be absent; nothing here may be assumed. */
export interface MemorySampleInput {
  commitUsedMb?: number | null;
  commitLimitMb?: number | null;
  ramFreeMb?: number | null;
  rcProcs?: number | null;
  rcMb?: number | null;
  recgovProcs?: number | null;
  recgovMb?: number | null;
  otherProcs?: number | null;
  otherMb?: number | null;
  maxPid?: number | null;
  maxMb?: number | null;
  maxFamily?: string | null;
}

export interface MemorySampleRow {
  taken_at: string;
  source: string | null;
  commit_used_mb: number | null;
  commit_limit_mb: number | null;
  ram_free_mb: number | null;
  rc_procs: number | null;
  rc_mb: number | null;
  recgov_procs: number | null;
  recgov_mb: number | null;
  other_procs: number | null;
  other_mb: number | null;
  max_pid: number | null;
  max_mb: number | null;
  max_family: string | null;
}

/** Only these three, so a malformed report cannot invent a family the readout never shows. */
const FAMILIES = new Set(['rc', 'recgov', 'other']);

/**
 * Bound a number before it reaches SQL.
 *
 * Any holder of AUTOCART_TOKEN sets these and they are rendered on the admin page, so the
 * rule is the same one applied to the `x-bot-commit` header: anything that is not a plausible
 * value of this field is dropped rather than stored. `null` survives as null — "not reported"
 * and "reported as zero" are different facts and this table exists to keep them apart.
 */
function num(v: unknown, max: number): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

/** Store one sample. Never throws — a measurement must not break the poll that carries it. */
export async function recordMemorySample(
  sample: MemorySampleInput, source: string | null,
): Promise<void> {
  const fam = typeof sample.maxFamily === 'string' && FAMILIES.has(sample.maxFamily)
    ? sample.maxFamily : null;
  await mutate(
    `INSERT INTO chromium_memory_samples
       (source, commit_used_mb, commit_limit_mb, ram_free_mb,
        rc_procs, rc_mb, recgov_procs, recgov_mb, other_procs, other_mb,
        max_pid, max_mb, max_family)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      source ? source.slice(0, 40) : null,
      // A 4 TB ceiling on memory figures and 1e7 on a pid: generous enough that no real
      // reading is ever discarded, tight enough that a garbage value never renders.
      num(sample.commitUsedMb, 4e6), num(sample.commitLimitMb, 4e6), num(sample.ramFreeMb, 4e6),
      num(sample.rcProcs, 1e4), num(sample.rcMb, 4e6),
      num(sample.recgovProcs, 1e4), num(sample.recgovMb, 4e6),
      num(sample.otherProcs, 1e4), num(sample.otherMb, 4e6),
      num(sample.maxPid, 1e7), num(sample.maxMb, 4e6), fam,
    ],
  ).catch((e) => console.error('[chromium-memory] recordMemorySample failed:', e.message));
}

export async function recentMemorySamples(hours: number, limit = 5000): Promise<MemorySampleRow[]> {
  return await query<MemorySampleRow>(
    `SELECT taken_at::text, source, commit_used_mb, commit_limit_mb, ram_free_mb,
            rc_procs, rc_mb, recgov_procs, recgov_mb, other_procs, other_mb,
            max_pid, max_mb, max_family
       FROM chromium_memory_samples
      WHERE taken_at > NOW() - ($1 || ' hours')::interval
      ORDER BY taken_at ASC
      LIMIT $2`,
    [String(Math.max(1, Math.floor(hours))), limit],
  ).catch(() => []);
}

/** The steepest sustained climb found, and what it was. */
export interface GrowthFinding {
  family: string;
  pid: number;
  mbPerMin: number;
  fromMb: number;
  toMb: number;
  fromAt: string;
  toAt: string;
  minutes: number;
}

export interface MemoryVerdict {
  samples: number;
  /** Consecutive pairs that could actually be compared — the real denominator. */
  comparablePairs: number;
  enough: boolean;
  /** Longest run of minutes with no sample at all. A gap IS the signature of the crash. */
  worstGapMin: number;
  peakCommitPct: number | null;
  /** Families that were observed at all. A family never seen has been RULED OUT OF NOTHING. */
  familiesSeen: string[];
  worst: GrowthFinding | null;
  verdict: string;
}

/**
 * How many comparable pairs before this will say anything.
 *
 * Two samples is one pair, and one pair is an anecdote — the same reason
 * `MIN_RENEWAL_TESTS` is 2 rather than 1 for the RC session probe. Ten pairs at a
 * two-minute cadence is twenty minutes of continuous observation, which is roughly the
 * whole duration of the 08-12 event.
 */
export const MIN_COMPARABLE_PAIRS = 10;

/** Growth at or above this is the event, not ordinary browser behaviour. */
export const LEAK_MB_PER_MIN = 100;

/**
 * Read a verdict out of the series.
 *
 * ── WHY IT PAIRS ON `max_pid` ──────────────────────────────────────────────────────────────
 * A rate is a difference over a time, and subtracting two numbers only means something if
 * they describe the SAME process. The rec.gov browsers open and close every thirty minutes,
 * so a family total that goes 40 MB -> 900 MB may be a leak or may simply be a browser that
 * did not exist in the first sample. Pairing on the pid is what makes the difference a rate
 * rather than a coincidence — and it is why `memory` prints pids at all.
 *
 * A pid is reused by Windows eventually. Over a two-minute window that is vanishingly
 * unlikely, and the failure it would cause is one overstated rate in a series, not a wrong
 * family — so it is accepted rather than defended against with machinery that would itself
 * need testing.
 */
export function readMemoryVerdict(rows: MemorySampleRow[]): MemoryVerdict {
  const familiesSeen = new Set<string>();
  for (const r of rows) {
    if ((r.rc_procs ?? 0) > 0) familiesSeen.add('rc');
    if ((r.recgov_procs ?? 0) > 0) familiesSeen.add('recgov');
    if ((r.other_procs ?? 0) > 0) familiesSeen.add('other');
  }

  let worst: GrowthFinding | null = null;
  let comparablePairs = 0;
  let worstGapMin = 0;
  let peakCommitPct: number | null = null;

  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const minutes = (Date.parse(b.taken_at) - Date.parse(a.taken_at)) / 60_000;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    if (minutes > worstGapMin) worstGapMin = minutes;

    // SAME PROCESS OR IT IS NOT A RATE. See above.
    if (a.max_pid === null || b.max_pid === null || a.max_pid !== b.max_pid) continue;
    if (a.max_mb === null || b.max_mb === null) continue;
    comparablePairs++;
    const mbPerMin = (Number(b.max_mb) - Number(a.max_mb)) / minutes;
    if (!worst || mbPerMin > worst.mbPerMin) {
      worst = {
        family: b.max_family ?? 'unknown',
        pid: b.max_pid,
        mbPerMin,
        fromMb: Number(a.max_mb),
        toMb: Number(b.max_mb),
        fromAt: a.taken_at,
        toAt: b.taken_at,
        minutes,
      };
    }
  }

  for (const r of rows) {
    if (r.commit_used_mb === null || !r.commit_limit_mb) continue;
    const pct = (Number(r.commit_used_mb) / Number(r.commit_limit_mb)) * 100;
    if (peakCommitPct === null || pct > peakCommitPct) peakCommitPct = pct;
  }

  const enough = comparablePairs >= MIN_COMPARABLE_PAIRS;
  let verdict: string;
  if (rows.length === 0) {
    verdict = 'NO DATA — nothing has been sampled. The sampler runs inside bot.mjs; if that ' +
      'is not running on the box, nothing here can fill in.';
  } else if (!enough) {
    verdict = `NOT ENOUGH DATA — ${comparablePairs} comparable pair(s), and this refuses a ` +
      `verdict under ${MIN_COMPARABLE_PAIRS}.`;
  } else if (worst && worst.mbPerMin >= LEAK_MB_PER_MIN) {
    verdict = `LEAK OBSERVED — ${worst.family} pid ${worst.pid} grew ` +
      `${Math.round(worst.mbPerMin)} MB/min. That is the family, measured, not guessed.`;
  } else {
    // NEVER "there is no leak". The 08-12 event was minutes long on a family that exists in
    // bursts; a quiet window is a quiet window.
    verdict = `NO LEAK IN THIS WINDOW — steepest climb ` +
      `${worst ? Math.round(worst.mbPerMin) : 0} MB/min. This does NOT mean there is no leak; ` +
      'it means the window did not contain one.';
  }

  return {
    samples: rows.length,
    comparablePairs,
    enough,
    worstGapMin,
    peakCommitPct,
    familiesSeen: [...familiesSeen],
    worst,
    verdict,
  };
}
