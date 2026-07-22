#!/usr/bin/env tsx
/**
 * Feature-E readout — a sanity check on the cancellation-likelihood pipeline BEFORE
 * we build any user-facing UI. Prints what availability_observations (migration 020)
 * actually contains: how fast it's accruing, whether rows land where the recorder +
 * probe roster should put them (lead_days near the probe leads, nights=2 for roster),
 * the overall open rate (a demand-scanned roster should skew mostly-booked with a
 * minority of openings), and per-bucket / per-campground rates so we can eyeball
 * whether the numbers look believable.
 *
 * Read-only. Run from a machine that can reach Supabase (from a web session add
 * NODE_USE_ENV_PROXY=1):
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/likelihood-readout.mts [--window=45] [--min=20]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local locally; on Fly/web-session the env is already populated.
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, ...rest] = t.split('=');
    if (k && rest.length && !process.env[k.trim()]) process.env[k.trim()] = rest.join('=').trim();
  }
} catch { /* rely on environment */ }

import { query } from '../src/lib/db/client';
import { campgroundBuckets, LEAD_BUCKETS } from '../src/lib/likelihood';

const arg = (name: string, def: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(n) ? n : def;
};
const WINDOW = arg('window', 45);
const MIN = arg('min', 20);

const pct = (n: number | null): string => (n == null ? '  —  ' : `${(n * 100).toFixed(0).padStart(3)}%`);
const bar = (n: number | null, width = 20): string =>
  n == null ? '' : '█'.repeat(Math.round(n * width)) + '·'.repeat(width - Math.round(n * width));

async function main() {
  console.log(`\n=== Feature-E likelihood readout (trailing ${WINDOW}d, min ${MIN} samples) ===\n`);

  // 1. Corpus summary.
  const [sum] = await query<{ n: number; cgs: number; first: string; last: string; open: number }>(
    `SELECT count(*)::int n, count(DISTINCT campground_id)::int cgs,
            min(observed_at)::text first, max(observed_at)::text last,
            count(*) FILTER (WHERE had_opening)::int open
       FROM availability_observations
      WHERE observed_at >= now() - ($1 || ' days')::interval`,
    [WINDOW]
  );
  if (!sum || sum.n === 0) {
    console.log('No observations yet in the window. The recorder/probe roster may not be running.\n');
    return;
  }
  console.log(`observations : ${sum.n}   distinct campgrounds: ${sum.cgs}`);
  console.log(`time span    : ${sum.first}  →  ${sum.last}`);
  console.log(`overall open : ${pct(sum.open / sum.n)}  (${sum.open}/${sum.n} checks saw an opening)\n`);

  // 2. Accrual rate — rows per hour over the last day (is it actually logging?).
  const perHour = await query<{ hr: string; n: number }>(
    `SELECT to_char(date_trunc('hour', observed_at), 'MM-DD HH24:00') hr, count(*)::int n
       FROM availability_observations
      WHERE observed_at >= now() - interval '12 hours'
      GROUP BY 1 ORDER BY 1`
  );
  console.log('rows / hour (last 12h):');
  for (const r of perHour) console.log(`  ${r.hr}  ${String(r.n).padStart(4)}  ${'▪'.repeat(Math.min(r.n, 60))}`);
  console.log();

  // 3. lead_days spread — roster probes land near PROBE_LEAD_DAYS (14, 45) snapped to
  //    the next Saturday, so expect clusters ~14–20 and ~45–51; watches add others.
  const leads = await query<{ lead_days: number; n: number; open: number }>(
    `SELECT lead_days, count(*)::int n, count(*) FILTER (WHERE had_opening)::int open
       FROM availability_observations
      WHERE observed_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [WINDOW]
  );
  console.log('lead_days distribution (n, open%):');
  for (const r of leads) console.log(`  ${String(r.lead_days).padStart(4)}d  n=${String(r.n).padStart(4)}  ${pct(r.open / r.n)}`);
  console.log();

  // 4. nights + source breakdown.
  const nights = await query<{ nights: number; n: number }>(
    `SELECT nights, count(*)::int n FROM availability_observations
      WHERE observed_at >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`,
    [WINDOW]
  );
  console.log('nights:', nights.map((r) => `${r.nights}n×${r.n}`).join('  '));
  const sources = await query<{ source: string; n: number; open: number }>(
    `SELECT source, count(*)::int n, count(*) FILTER (WHERE had_opening)::int open
       FROM availability_observations
      WHERE observed_at >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC`,
    [WINDOW]
  );
  console.log('source (n, open%):', sources.map((r) => `${r.source}=${r.n}/${pct(r.open / r.n).trim()}`).join('  '), '\n');

  // 5. Overall open rate per lead bucket — the shape the signal will surface.
  const buckets = await query<{ bucket: string; n: number; open: number }>(
    `SELECT CASE
              WHEN lead_days BETWEEN 0 AND 3 THEN '0-3'
              WHEN lead_days BETWEEN 4 AND 7 THEN '4-7'
              WHEN lead_days BETWEEN 8 AND 21 THEN '8-21'
              WHEN lead_days BETWEEN 22 AND 45 THEN '22-45'
              ELSE '46+'
            END bucket, count(*)::int n, count(*) FILTER (WHERE had_opening)::int open
       FROM availability_observations
      WHERE observed_at >= now() - ($1 || ' days')::interval
      GROUP BY 1`,
    [WINDOW]
  );
  const bmap = new Map(buckets.map((b) => [b.bucket, b]));
  console.log('open rate by lead bucket (all campgrounds pooled):');
  for (const lb of LEAD_BUCKETS) {
    const b = bmap.get(lb.key);
    const rate = b ? b.open / b.n : null;
    console.log(`  ${lb.key.padEnd(6)} ${lb.label.padEnd(18)} n=${String(b?.n ?? 0).padStart(5)}  ${pct(rate)}  ${bar(rate)}`);
  }
  console.log();

  // 6. Per-campground readout for the best-sampled sites — do the numbers look sane?
  //    (Booked-solid roster picks should mostly show low rates with occasional opens.)
  const top = await query<{ campground_id: string; name: string; n: number; open: number }>(
    `SELECT o.campground_id, c.name, count(*)::int n, count(*) FILTER (WHERE o.had_opening)::int open
       FROM availability_observations o JOIN campgrounds c ON c.id = o.campground_id
      WHERE o.observed_at >= now() - ($1 || ' days')::interval
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`,
    [WINDOW]
  );
  console.log(`best-sampled campgrounds (top ${top.length} by observation count):`);
  for (const r of top) {
    const enough = r.n >= MIN ? ' ' : '~'; // ~ = still thin, don't trust yet
    console.log(`  ${enough} ${pct(r.open / r.n)} (${String(r.open).padStart(3)}/${String(r.n).padStart(3)})  ${r.name?.slice(0, 48) ?? r.campground_id}`);
  }
  console.log();

  // 7. Example of the reusable aggregation the UI will call, on the top site.
  if (top[0]) {
    console.log(`example campgroundBuckets("${top[0].name?.slice(0, 40)}"):`);
    const rows = await campgroundBuckets(top[0].campground_id, { windowDays: WINDOW, minSamples: MIN });
    for (const r of rows) {
      console.log(`  ${r.bucket.padEnd(6)} ${pct(r.rate)}  n=${String(r.samples).padStart(4)}  ${r.enough ? 'show' : 'still learning'}`);
    }
  }
  console.log('\n=== end readout ===\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
