// How often to re-check a watch whose provider has no scheduler in front of it.
//
// rec.gov rides `recgov-scheduler.ts`, which already tiers by lead time: a
// campground-month more than RECGOV_HOT_LEAD_DAYS out is served from a 60s cache instead
// of fetched fresh every cycle. Every OTHER provider — the ten UseDirect states,
// ReserveAmerica, GoingToCamp, TN/SC — had no such layer and re-fetched every 15s
// regardless of whether the stay was this weekend or next April.
//
// ## Why slowing far-out watches is safe, measured
//
// Feature E's frozen dataset (137k observations, July 2026) says how often an opening
// seen at one probe was still there ~70 minutes later:
//
//     reservecalifornia   14-29d 93.8%   30d+ 97.3%
//     ridb (rec.gov)      14-29d 84.9%   30d+ 85.3%
//     goingtocamp                        30d+ 97.9%
//     wyoming/nevada/illinois/arizona/missouri   99.6-100%
//     florida             14-29d 95.8%   30d+ 98.8%
//     virginia            14-29d 70.1%   30d+ 74.6%   <-- the outlier
//
// rec.gov is the LEAST durable source measured and is already tiered. Everything else was
// being polled four times harder while being more stable, which is backwards.
//
// ## The two honest limits on that data
//
// 1. **There is no 0-13 day bucket.** The probe roster clustered at 14-20 and 45-51 days
//    out, so nothing here says anything about short-lead openings — the "this weekend"
//    case, and plausibly the fastest-moving one. So HOT_LEAD_DAYS is a floor, not a knob:
//    inside it nothing changes, because there is no evidence that it could.
// 2. **The ladder beyond 14 days is not measured.** 14-29 and 30+ are within a few points
//    of each other everywhere, so the data supports "hot vs cold" and does NOT establish
//    that 90 days out is safer than 30. The longer steps are justified by cost, not by
//    evidence, and they are deliberately gentle for that reason.
//
// ReserveAmerica has NO measurement at all — it was never in the probe roster (it is an
// HTML scrape, not an API). It gets the ladder because a stay six months out cannot
// reasonably need a 15-second check, but that is reasoning, not data, and it is the first
// thing to revisit if RA detections start looking late.

/** Inside this many days, nothing changes — see limit (1) above. */
export const HOT_LEAD_DAYS = Number(process.env.POLL_HOT_LEAD_DAYS ?? 14);

/**
 * Per-source intervals, in ms, for stays beyond HOT_LEAD_DAYS.
 *
 * VIRGINIA IS DELIBERATELY ABSENT and therefore never slows down. At 70-75% hourly
 * survival it is the one source where a longer gap would measurably cost detections —
 * roughly one opening in four is gone within the hour, against one in twenty for its
 * UseDirect siblings. Treating ten portals as interchangeable because they run the same
 * software is exactly the kind of averaging that hides a case like this.
 */
const NEVER_TIERED = new Set(['virginiastateparks']);

/**
 * The ladder. Deliberately shallow: three steps, none of them dramatic.
 *
 * The point is to stop spending a 15-second cadence on a stay in April, not to squeeze
 * every possible request out. A watch 200 days out checked every 5 minutes is still 288
 * checks a day, which is far more than enough to catch an opening that survives an hour
 * 97% of the time.
 */
const LADDER: ReadonlyArray<{ minLeadDays: number; intervalMs: number }> = [
  { minLeadDays: 90, intervalMs: 300_000 },
  { minLeadDays: 30, intervalMs: 120_000 },
  { minLeadDays: HOT_LEAD_DAYS, intervalMs: 60_000 },
];

/**
 * How long may this watch's result be, given how far out its first night is?
 *
 * `0` means "every cycle" — the hot path, and the default for anything we have no reason
 * to slow down. Callers gate on `dueNow`, so returning 0 is always safe.
 */
export function intervalForLead(leadDays: number, source: string, baseMs = 0): number {
  if (NEVER_TIERED.has(source)) return baseMs;
  if (!Number.isFinite(leadDays)) return baseMs; // a bad date must not slow a watch down
  for (const step of LADDER) if (leadDays >= step.minLeadDays) return Math.max(baseMs, step.intervalMs);
  return baseMs;
}

/**
 * Tracks when each watch was last checked, so a cycle can skip the far-out ones.
 *
 * Keyed by watch id and PRUNED against the live set every cycle. Without the prune this
 * grows for the life of the process as watches expire — small, but the poller is a
 * long-running 512MB machine that has already been killed once by memory pressure during
 * a catalog sync, and an unbounded map in the hot loop is not something to leave for
 * later.
 */
export class DueTracker {
  private last = new Map<string, number>();

  /** Watches from `all` that are due this cycle. Prunes anything no longer present. */
  due<T extends { id: string; source: string; leadDays: number }>(
    all: readonly T[],
    now: number,
    baseMs = 0,
  ): T[] {
    const live = new Set(all.map((w) => w.id));
    for (const id of this.last.keys()) if (!live.has(id)) this.last.delete(id);

    const out: T[] = [];
    for (const w of all) {
      const interval = intervalForLead(w.leadDays, w.source, baseMs);
      const prev = this.last.get(w.id);
      // Never checked is always due: a fresh deploy must not sit out a full interval, and
      // a new watch must not wait five minutes for its first look.
      // A `prev` in the future (clock step on a resumed Fly machine) also counts as due —
      // failing toward checking costs one fetch.
      if (prev === undefined || prev > now || now - prev >= interval) {
        this.last.set(w.id, now);
        out.push(w);
      }
    }
    return out;
  }

  /** For the heartbeat line. */
  get size(): number {
    return this.last.size;
  }
}
