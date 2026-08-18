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
  /** `browser` | `renderer` | `gpu-process` | `utility`. Null on a box predating migration 062. */
  maxType?: string | null;
  /** Per-type MB within the `rc` family, e.g. `{ renderer: 3052, 'gpu-process': 890 }`. */
  rcByType?: Record<string, number> | null;
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
  max_type: string | null;
  rc_by_type: Record<string, number> | null;
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

/**
 * The Chromium process types worth recording. An allow-list because this value crosses the
 * network from the box and is rendered on the admin page; anything else stores as null.
 *
 * `browser` is the PARENT, which carries no `--type` at all — an absent flag is not an unknown
 * type, it is the one process that identifies itself by having none.
 */
const PROCESS_TYPES = new Set([
  'browser', 'renderer', 'gpu-process', 'utility', 'zygote', 'ppapi', 'crashpad-handler',
]);

/**
 * Per-type MB for the family under suspicion, sanitised the same way.
 *
 * Returns null for anything unusable rather than `{}` — an empty object would read as "we
 * looked and every type was zero", which is a measurement nobody took. Same rule as the family
 * counts, which had to be taught it after a scan that never ran was stored as zero.
 */
function rcByType(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!PROCESS_TYPES.has(k)) continue;
    const n = num(raw, 4e6);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
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
        max_pid, max_mb, max_family, max_type, rc_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [
      source ? source.slice(0, 40) : null,
      // A 4 TB ceiling on memory figures and 1e7 on a pid: generous enough that no real
      // reading is ever discarded, tight enough that a garbage value never renders.
      num(sample.commitUsedMb, 4e6), num(sample.commitLimitMb, 4e6), num(sample.ramFreeMb, 4e6),
      num(sample.rcProcs, 1e4), num(sample.rcMb, 4e6),
      num(sample.recgovProcs, 1e4), num(sample.recgovMb, 4e6),
      num(sample.otherProcs, 1e4), num(sample.otherMb, 4e6),
      num(sample.maxPid, 1e7), num(sample.maxMb, 4e6), fam,
      // WHICH KIND OF PROCESS. Allow-listed rather than stored verbatim: this arrives from the
      // box over the network, and a column rendered on the admin page must not carry whatever
      // a caller feels like sending. An unrecognised type stores null — "not reported" — which
      // the readout already prints as a gap.
      typeof sample.maxType === 'string' && PROCESS_TYPES.has(sample.maxType) ? sample.maxType : null,
      // STRINGIFIED, NOT THE OBJECT. `sqlit` interpolates rather than binds, and its fallback
      // is `String(val)` — so a plain object becomes the literal `'[object Object]'`, which
      // Postgres rejects for a jsonb column. The whole INSERT then throws, and the `.catch`
      // below turns that into silence: no sample stored AT ALL, not merely a missing column.
      // Shipped 2026-08-18 and killed the memory series for ten minutes.
      rcByType(sample.rcByType),
    ],
  ).catch((e) => console.error('[chromium-memory] recordMemorySample failed:', e.message));
}

export async function recentMemorySamples(hours: number, limit = 5000): Promise<MemorySampleRow[]> {
  return await query<MemorySampleRow>(
    `SELECT taken_at::text, source, commit_used_mb, commit_limit_mb, ram_free_mb,
            rc_procs, rc_mb, recgov_procs, recgov_mb, other_procs, other_mb,
            max_pid, max_mb, max_family, max_type, rc_by_type
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
  /** The largest single process ever seen. Attribution even when the ramp outran the cadence. */
  peak: { family: string; pid: number; mb: number; at: string } | null;
  /** How long since the NEWEST sample. A trailing gap is a gap; see `seriesEnded`. */
  lastSampleAgeMin: number | null;
  /** COMMIT% at the last sample — what the box was doing when it stopped reporting. */
  lastCommitPct: number | null;
  /** The series has gone silent. This is the crash shape, and it has no internal gap. */
  seriesEnded: boolean;
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
 * How long the series may be silent before it counts as ENDED rather than merely current.
 *
 * Five sample intervals. One or two missed samples is an ordinary PowerShell hiccup and must
 * not read as a crash — the cost of crying wolf here is that the next real one gets skimmed,
 * which this log has already paid three times.
 */
export const SERIES_SILENT_MIN = 10;

/**
 * COMMIT% at or above which a series that stops looks like the box going down rather than the
 * bot being switched off. 70% is where `kill-chrome` still works and the box is still
 * reachable — the window in which a human could still act.
 */
export const COMMIT_HOT_PCT = 70;

/**
 * A single Chromium process this large is the event, whatever rate was observed.
 *
 * ── WHY SIZE AND NOT ONLY RATE ─────────────────────────────────────────────────────────────
 * The 08-12 process reached 7.9 GB in FORTY-SIX SECONDS, which is faster than this samples.
 * A climb that fast is invisible to a two-minute cadence: it shows up as a pid that did not
 * exist last time, already huge — and the pairing rule (same pid, two samples) correctly
 * refuses to call that a rate, because for a rec.gov browser it usually is not one.
 *
 * So a verdict keyed only on rate can read `NO LEAK IN THIS WINDOW` over a sample containing a
 * 7.9 GB browser. The rate rule is right and stays; this is the second question, asked
 * separately: not "did anything climb?" but "was anything ENORMOUS?"
 *
 * 1.5 GB, against measured normals of 40-114 MB per process on these profiles. Far enough
 * above ordinary that a busy browser does not trip it, far enough below 7.9 GB that the event
 * is caught long before commit is gone.
 */
export const BIG_PROCESS_MB = 1500;

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
 *
 * ── WHY THE TRAILING GAP IS COMPUTED SEPARATELY ────────────────────────────────────────────
 * `worstGapMin` is the longest hole BETWEEN two samples, and for a while that was the whole
 * gap story — which missed the one shape this table was built to catch. Sampling spawns
 * PowerShell, and spawning is exactly what fails at 99% commit, so the box does not record a
 * peak and then recover: THE SERIES STOPS. A series that stops has no internal gap at all, so
 * a box that died mid-ramp at 03:00 and a box sitting quietly idle produced the identical
 * `NO LEAK IN THIS WINDOW` — a failure and a success printing the same thing, in the
 * instrument built to tell them apart.
 *
 * `now` is injected so this stays a pure function of its inputs; the readout passes nothing.
 */
export function readMemoryVerdict(
  rows: MemorySampleRow[], { now = Date.now() }: { now?: number } = {},
): MemoryVerdict {
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

  // THE BIGGEST SINGLE PROCESS EVER SEEN — asked over the rows themselves, with no pairing at
  // all, because this is the question the pairing rule cannot answer. See BIG_PROCESS_MB.
  let peak: MemoryVerdict['peak'] = null;
  for (const r of rows) {
    if (r.max_mb === null || r.max_pid === null) continue;
    const mb = Number(r.max_mb);
    if (peak === null || mb > peak.mb) {
      peak = { family: r.max_family ?? 'unknown', pid: r.max_pid, mb, at: r.taken_at };
    }
  }

  // THE TRAILING GAP. Scanned backwards for the last row that actually reported a commit
  // figure: a null reading is "we could not tell", and letting it erase the last real one
  // would throw away the single most useful fact about how the series ended.
  let lastSampleAgeMin: number | null = null;
  let lastCommitPct: number | null = null;
  const newest = rows[rows.length - 1];
  if (newest) {
    const t = Date.parse(newest.taken_at);
    if (Number.isFinite(t)) lastSampleAgeMin = Math.max(0, (now - t) / 60_000);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.commit_used_mb === null || !r.commit_limit_mb) continue;
    lastCommitPct = (Number(r.commit_used_mb) / Number(r.commit_limit_mb)) * 100;
    break;
  }
  const seriesEnded = lastSampleAgeMin !== null && lastSampleAgeMin > SERIES_SILENT_MIN;

  const enough = comparablePairs >= MIN_COMPARABLE_PAIRS;
  const big = peak && peak.mb >= BIG_PROCESS_MB ? peak : null;
  let verdict: string;
  if (rows.length === 0) {
    verdict = 'NO DATA — nothing has been sampled. The sampler runs inside bot.mjs; if that ' +
      'is not running on the box, nothing here can fill in.';
  // A MEASURED RATE LEADS. It is the stronger evidence — two readings of one process — so it
  // keeps the headline it has always had, and the size becomes a corroborating clause.
  } else if (enough && worst && worst.mbPerMin >= LEAK_MB_PER_MIN) {
    verdict = `LEAK OBSERVED — ${worst.family} pid ${worst.pid} grew ` +
      `${Math.round(worst.mbPerMin)} MB/min. That is the family, measured, not guessed.` +
      (big ? ` It reached ${Math.round(big.mb)} MB, so size and rate agree.` : '');
  // SIZE ALONE, AND AHEAD OF THE PAIR COUNT DELIBERATELY. `MIN_COMPARABLE_PAIRS` gates a RATE,
  // which needs two samples of one process. A browser sitting at several GB needs no pairing to
  // be evidence, and declining to name it for want of pairs would be the instrument refusing to
  // report the very thing it was built to find.
  } else if (big) {
    verdict = `OVERSIZED PROCESS — ${big.family} pid ${big.pid} reached ` +
      `${Math.round(big.mb)} MB at ${big.at.slice(0, 19)}. That is the family, measured, ` +
      'not guessed. No comparable climb was caught, and that does NOT weaken it: 08-12 ' +
      'reached 7.9 GB in 46 seconds, faster than this samples, so the ramp can pass entirely ' +
      'between two readings and leave only its result.';
  } else if (!enough) {
    verdict = `NOT ENOUGH DATA — ${comparablePairs} comparable pair(s), and this refuses a ` +
      `verdict under ${MIN_COMPARABLE_PAIRS}.`;
  } else {
    // NEVER "there is no leak". The 08-12 event was minutes long on a family that exists in
    // bursts; a quiet window is a quiet window.
    verdict = `NO LEAK IN THIS WINDOW — steepest climb ` +
      `${worst ? Math.round(worst.mbPerMin) : 0} MB/min. This does NOT mean there is no leak; ` +
      'it means the window did not contain one.';
  }

  // ADDITIVE, NEVER A REPLACEMENT. "It climbed AND THEN the series stopped" is the strongest
  // reading this table can produce, and a branch that overwrote the growth verdict with the
  // silence would throw away the half that names the family.
  if (seriesEnded && lastSampleAgeMin !== null) {
    const hot = lastCommitPct !== null && lastCommitPct >= COMMIT_HOT_PCT;
    const commitSays = lastCommitPct === null
      ? 'the last sample reported no commit figure'
      : `last COMMIT ${Math.round(lastCommitPct)}%`;
    verdict += ` — AND THE SERIES HAS STOPPED: nothing sampled for ` +
      `${Math.round(lastSampleAgeMin)} min (${commitSays}). ` +
      (hot
        // At high commit, spawning is the first thing to fail — and taking a sample IS a
        // spawn. So the series ending here is not an absence of data, it is the reading.
        ? 'It stopped while commit was already high, which is what the crash looks like from ' +
          'here: sampling spawns PowerShell, and spawning is what fails first. Treat the end ' +
          'of the series as where the box got to, NOT as a quiet box.'
        // Do not cry wolf. A box switched off, a bot stopped for an update, and a crash all
        // end the series; only the commit figure tells them apart, and at a normal figure the
        // dull explanation is the likely one.
        : 'Commit was NOT high at the last reading, so the likelier cause is the bot being ' +
          'stopped (an update, a reboot, the box switched off) rather than the leak.');
  }

  return {
    samples: rows.length,
    comparablePairs,
    enough,
    worstGapMin,
    peakCommitPct,
    familiesSeen: [...familiesSeen],
    worst,
    peak,
    lastSampleAgeMin,
    lastCommitPct,
    seriesEnded,
    verdict,
  };
}
