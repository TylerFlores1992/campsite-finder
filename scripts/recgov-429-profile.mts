// Readout for the full-day rec.gov 429 profile (recgov_rate_profile, migration 033).
//
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/recgov-429-profile.mts [--days=N]
//
// Aggregates the worker's 5-minute buckets by UTC hour of day and answers the one
// question this table exists for: does the 15/min budget survive every hour, and is
// there headroom for a sub-15s hot lane? The verdict separates rec.gov's behaviour
// (429/timeout rate) from our own throttling (denials) — headroom means hours that
// are BOTH clean upstream AND running at or near full budget.

import { query } from '../src/lib/db/client';

const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 3);

interface HourRow {
  hour: number;
  buckets: number;
  ok: number;
  t429: number;
  timeout: number;
  error: number;
  denied: number;
  skipped: number;
}

const rows = await query<HourRow>(
  `SELECT EXTRACT(HOUR FROM bucket_start)::int AS hour,
          COUNT(*)::int                        AS buckets,
          SUM(ok)::int                         AS ok,
          SUM(throttled_429)::int              AS t429,
          SUM(timeout)::int                    AS timeout,
          SUM(error)::int                      AS error,
          SUM(denied)::int                     AS denied,
          SUM(breaker_skipped)::int            AS skipped
     FROM recgov_rate_profile
    WHERE bucket_start > NOW() - ($1 || ' days')::interval
    GROUP BY 1 ORDER BY 1`,
  [String(days)]
);

const span = await query<{ first: string; last: string; buckets: number }>(
  `SELECT MIN(bucket_start)::text AS first, MAX(bucket_start)::text AS last, COUNT(*)::int AS buckets
     FROM recgov_rate_profile WHERE bucket_start > NOW() - ($1 || ' days')::interval`,
  [String(days)]
);

if (!rows.length) {
  console.log('No profile rows yet — the worker flushes its first bucket ~5 minutes after boot.');
  process.exit(0);
}

console.log(`rec.gov rate profile — last ${days}d (${span[0].buckets} buckets, ${span[0].first} → ${span[0].last})`);
console.log('UTC hr | req/min | 429/min | timeo/min | err | denied/min | brk-skip | 429+timeo %');
console.log('-------|---------|---------|-----------|-----|------------|----------|------------');

let worst = { hour: -1, rate: 0 };
let cleanFullBudgetHours = 0;
for (const r of rows) {
  const mins = r.buckets * 5; // each bucket is 5 minutes of one machine
  const attempts = r.ok + r.t429 + r.timeout + r.error;
  const throttlePct = attempts ? ((r.t429 + r.timeout) / attempts) * 100 : 0;
  if (throttlePct > worst.rate) worst = { hour: r.hour, rate: throttlePct };
  // "Clean at full budget": <1% throttle while pushing >=13 req/min of a 15 budget.
  if (throttlePct < 1 && attempts / mins >= 13) cleanFullBudgetHours++;
  console.log(
    `${String(r.hour).padStart(6)} | ${(attempts / mins).toFixed(1).padStart(7)} | ${(r.t429 / mins).toFixed(2).padStart(7)} | ` +
    `${(r.timeout / mins).toFixed(2).padStart(9)} | ${String(r.error).padStart(3)} | ${(r.denied / mins).toFixed(1).padStart(10)} | ` +
    `${String(r.skipped).padStart(8)} | ${throttlePct.toFixed(1).padStart(10)}%`
  );
}

const hoursCovered = rows.length;
console.log('');
console.log(`Coverage: ${hoursCovered}/24 UTC hours have data.` + (hoursCovered < 24 ? ' NOT a full day yet — no verdict until 24/24.' : ''));
if (hoursCovered === 24) {
  console.log(`Worst hour: ${worst.hour}:00 UTC at ${worst.rate.toFixed(1)}% throttled (429+timeout / attempts).`);
  console.log(`Hours clean (<1% throttle) while at full budget (>=13 req/min): ${cleanFullBudgetHours}/24.`);
  console.log(
    worst.rate < 1
      ? 'VERDICT: budget holds all day — headroom for a faster hot lane exists; raise cautiously and re-profile.'
      : worst.rate < 5
        ? 'VERDICT: mostly clean with a soft hour — a faster lane should avoid the worst hour(s) or the budget should flex by hour.'
        : 'VERDICT: rec.gov throttles at current budget in at least one hour — do NOT raise rates; consider lowering during the affected hours.'
  );
}
process.exit(0);
