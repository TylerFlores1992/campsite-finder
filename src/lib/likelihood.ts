// Cancellation-likelihood signal (feature E) — the AGGREGATION half.
//
// Reads the availability_observations time series (migration 020, written by the
// worker's recorder + probe roster) and turns it into "this site had a bookable
// opening on ~X% of recent checks for a stay this far out". Openings behave very
// differently by lead time (a site 3 days out vs 45 days out is a different game),
// so everything is bucketed on lead_days, and we only call a number "honest" once
// enough samples have accrued.
//
// Server-only (uses the service-role DB client). The UI/API half consumes this.

import { query } from '@/lib/db/client';
import type { CampgroundLikelihood } from '@/lib/types';

const BUCKET_CASE = `CASE
              WHEN lead_days BETWEEN 0 AND 3 THEN '0-3'
              WHEN lead_days BETWEEN 4 AND 7 THEN '4-7'
              WHEN lead_days BETWEEN 8 AND 21 THEN '8-21'
              WHEN lead_days BETWEEN 22 AND 45 THEN '22-45'
              ELSE '46+'
            END`;

/** Opening rate for one (campground, lead-window) slice of history. */
export interface OpeningRate {
  samples: number; // observations counted in the window
  openings: number; // how many of them had a bookable whole-stay opening
  rate: number | null; // openings / samples, or null when samples === 0
  enough: boolean; // samples >= minSamples — only then is `rate` honest to show
}

export interface RateOptions {
  /** Restrict to a stay length (nights). Default: any length. */
  nights?: number;
  /** ± days of lead_days around the target to pool (default 7). */
  leadTolerance?: number;
  /** Trailing observed_at window in days (default 45). */
  windowDays?: number;
  /** Minimum samples before `enough` is true (default 20). */
  minSamples?: number;
}

const DEFAULTS = { leadTolerance: 7, windowDays: 45, minSamples: 20 };

/**
 * Opening rate for a stay arriving ~`leadDays` out at `campgroundId`, pooled over a
 * trailing window and a ± lead tolerance. This is what a per-watch UI would call:
 * "your stay is 30 days out → here's how often this site has had an opening 30 days
 * out lately."
 */
export async function getOpeningRate(
  campgroundId: string,
  leadDays: number,
  opts: RateOptions = {}
): Promise<OpeningRate> {
  const { nights, leadTolerance, windowDays, minSamples } = { ...DEFAULTS, ...opts };
  const params: unknown[] = [campgroundId, windowDays, leadDays - leadTolerance, leadDays + leadTolerance];
  if (nights != null) params.push(nights);
  const rows = await query<{ samples: number; openings: number }>(
    `SELECT count(*)::int AS samples,
            count(*) FILTER (WHERE had_opening)::int AS openings
       FROM availability_observations
      WHERE campground_id = $1
        AND observed_at >= now() - ($2 || ' days')::interval
        AND lead_days BETWEEN $3 AND $4
        ${nights != null ? 'AND nights = $5' : ''}`,
    params
  );
  const samples = rows[0]?.samples ?? 0;
  const openings = rows[0]?.openings ?? 0;
  return { samples, openings, rate: samples > 0 ? openings / samples : null, enough: samples >= minSamples };
}

/** Lead-time buckets. Openings behave differently by how far out the stay is, so we
 *  never blend across these. Labels are user-facing phrasings. */
export interface LeadBucket {
  key: string;
  label: string;
  min: number;
  max: number;
}

export const LEAD_BUCKETS: LeadBucket[] = [
  { key: '0-3', label: 'a few days out', min: 0, max: 3 },
  { key: '4-7', label: 'about a week out', min: 4, max: 7 },
  { key: '8-21', label: '1–3 weeks out', min: 8, max: 21 },
  { key: '22-45', label: '3–6 weeks out', min: 22, max: 45 },
  { key: '46+', label: '6+ weeks out', min: 46, max: 1_000_000 },
];

export function bucketOfLead(leadDays: number): LeadBucket {
  return LEAD_BUCKETS.find((b) => leadDays >= b.min && leadDays <= b.max) ?? LEAD_BUCKETS[LEAD_BUCKETS.length - 1];
}

export interface BucketRate extends OpeningRate {
  bucket: string;
  label: string;
}

/**
 * Opening rate per lead-time bucket for one campground over a trailing window.
 * Returns every bucket (samples 0, rate null when none), in LEAD_BUCKETS order, so a
 * caller can render a full ladder and mark thin buckets as "still learning".
 */
export async function campgroundBuckets(
  campgroundId: string,
  opts: { windowDays?: number; minSamples?: number } = {}
): Promise<BucketRate[]> {
  const windowDays = opts.windowDays ?? DEFAULTS.windowDays;
  const minSamples = opts.minSamples ?? DEFAULTS.minSamples;
  const rows = await query<{ bucket: string; samples: number; openings: number }>(
    `SELECT ${BUCKET_CASE} AS bucket,
            count(*)::int AS samples,
            count(*) FILTER (WHERE had_opening)::int AS openings
       FROM availability_observations
      WHERE campground_id = $1
        AND observed_at >= now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [campgroundId, windowDays]
  );
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return LEAD_BUCKETS.map((b) => {
    const r = byKey.get(b.key);
    const samples = r?.samples ?? 0;
    const openings = r?.openings ?? 0;
    return {
      bucket: b.key,
      label: b.label,
      samples,
      openings,
      rate: samples > 0 ? openings / samples : null,
      enough: samples >= minSamples,
    };
  });
}

/**
 * Batched cancellation-likelihood headline for many campgrounds at once — one query
 * for a whole page of search results. For each campground we pick its BEST-SAMPLED
 * bucket that clears `minSamples` (most reliable, not cherry-picked by rate) and
 * return that bucket's rate + label. Campgrounds with no bucket yet at `minSamples`
 * are simply absent from the map (no honest number to show → no badge).
 */
export async function getHeadlines(
  campgroundIds: string[],
  opts: { windowDays?: number; minSamples?: number } = {}
): Promise<Map<string, CampgroundLikelihood>> {
  const out = new Map<string, CampgroundLikelihood>();
  if (campgroundIds.length === 0) return out;
  const windowDays = opts.windowDays ?? DEFAULTS.windowDays;
  const minSamples = opts.minSamples ?? DEFAULTS.minSamples;

  const rows = await query<{ campground_id: string; bucket: string; samples: number; openings: number }>(
    `SELECT campground_id, ${BUCKET_CASE} AS bucket,
            count(*)::int AS samples,
            count(*) FILTER (WHERE had_opening)::int AS openings
       FROM availability_observations
      WHERE campground_id = ANY($1)
        AND observed_at >= now() - ($2 || ' days')::interval
      GROUP BY 1, 2`,
    [campgroundIds, windowDays]
  );

  // Per campground, keep the enough-sampled bucket with the most samples.
  const best = new Map<string, { samples: number; openings: number; bucket: string }>();
  for (const r of rows) {
    if (r.samples < minSamples) continue;
    const cur = best.get(r.campground_id);
    if (!cur || r.samples > cur.samples) best.set(r.campground_id, r);
  }
  const labelOf = (key: string) => LEAD_BUCKETS.find((b) => b.key === key)?.label ?? key;
  for (const [id, b] of best) {
    out.set(id, { rate: b.openings / b.samples, label: labelOf(b.bucket), samples: b.samples });
  }
  return out;
}
