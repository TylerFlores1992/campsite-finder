#!/usr/bin/env tsx
/**
 * Seed the feature-E probe roster (probe_targets) by DEMAND-SCAN.
 *
 * Cancellation-likelihood only matters for campgrounds that are hard to get, so we
 * pick roster targets by demand: probe a broad random sample for a peak weekend and
 * keep the ones that are BOOKED SOLID (no whole-stay opening). A site that's already
 * open has no cancellation signal worth surfacing. The poller then probes this
 * roster hourly (probeRosterIfDue) and records availability_observations over time.
 *
 * Defaults to rec.gov (source='ridb'); pass --source to scan another catalog. The
 * poller's probe path is already source-agnostic, so any source landed in
 * probe_targets is probed automatically — this seed just needs an availability
 * checker that's reachable from where it runs. Supported here: rec.gov ('ridb') and
 * any UseDirect source (reservecalifornia, ohiostateparks, …). UseDirect routes
 * through the agent proxy, so run those with NODE_USE_ENV_PROXY=1.
 *
 * Run (from a machine that can reach the source + Supabase; from a web session add
 * NODE_USE_ENV_PROXY=1):
 *   npx tsx scripts/seed-probe-targets.ts [--source=ridb] [--sample=600] [--cap=200] [--arrival=YYYY-MM-DD] [--nights=2] [--dry]
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

import { query, mutate, sqlit } from '../src/lib/db/client';
import { hasAvailabilityInRange } from '../src/lib/availability/recgov';
import { hasRCAvailabilityInRange } from '../src/lib/availability/reservecalifornia';
import { isUseDirectSource } from '../src/lib/sources/reservecalifornia/providers';

function arg(name: string, def?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const DRY = process.argv.includes('--dry');
const SOURCE = arg('source', 'ridb')!;
const SAMPLE = Number(arg('sample', '600'));
const CAP = Number(arg('cap', '200'));
const NIGHTS = Number(arg('nights', '2'));
const CONCURRENCY = 3;

/** Whole-stay availability for the demand scan, dispatched by source. Throws on an
 *  unsupported source (so we never silently seed a catalog we can't actually probe). */
function isOpenInRange(id: string, arrival: string, end: string, nights: number): Promise<boolean> {
  if (SOURCE === 'ridb') return hasAvailabilityInRange(id, arrival, end, nights);
  if (isUseDirectSource(SOURCE)) return hasRCAvailabilityInRange(id, arrival, end, nights);
  throw new Error(`--source=${SOURCE} not supported by this seed yet (add a checker in isOpenInRange)`);
}

/** First Saturday roughly a month out — a representative peak-demand weekend. */
function defaultArrival(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 30);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function checkout(arrival: string, nights: number): string {
  const d = new Date(arrival + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function main() {
  const arrival = arg('arrival', defaultArrival())!;
  const end = checkout(arrival, NIGHTS);
  console.log(`[seed] demand-scan: sample ${SAMPLE} ${SOURCE} campgrounds for a ${NIGHTS}-night stay ${arrival}→${end}, keep booked-solid up to ${CAP}${DRY ? ' (DRY RUN)' : ''}`);

  const sample = await query<{ id: string; name: string }>(
    `SELECT id, name FROM campgrounds WHERE source = ${sqlit(SOURCE)} AND reservable ORDER BY random() LIMIT ${SAMPLE}`
  );
  console.log(`[seed] probing ${sample.length} campgrounds…`);

  let probed = 0, open = 0, errors = 0;
  const bookedSolid: { id: string; name: string }[] = [];
  await pMap(
    sample,
    async (cg) => {
      try {
        const isOpen = await isOpenInRange(cg.id, arrival, end, NIGHTS);
        probed++;
        if (isOpen) open++;
        else bookedSolid.push(cg); // no whole-stay opening = high demand
      } catch {
        errors++; // transport error → don't treat as demand
      }
      if ((probed + errors) % 100 === 0) console.log(`[seed]   …${probed + errors}/${sample.length} (booked-solid so far: ${bookedSolid.length})`);
    },
    CONCURRENCY
  );

  console.log(`[seed] scan done: ${probed} probed, ${open} had an opening, ${bookedSolid.length} booked-solid, ${errors} errors`);

  const keep = bookedSolid.slice(0, CAP);
  console.log(`[seed] roster = ${keep.length} campgrounds`);
  if (DRY) {
    keep.slice(0, 15).forEach((c) => console.log(`   - ${c.id}  ${c.name}`));
    if (keep.length > 15) console.log(`   … and ${keep.length - 15} more`);
    return;
  }
  if (keep.length === 0) { console.log('[seed] nothing to insert'); return; }

  const reason = `demand-scan ${arrival} booked-solid`;
  const values = keep.map((c) => `(${sqlit(c.id)}, ${sqlit(SOURCE)}, ${sqlit(reason)})`).join(', ');
  await mutate(
    `INSERT INTO probe_targets (campground_id, source, reason)
     VALUES ${values}
     ON CONFLICT (campground_id) DO UPDATE SET active = TRUE, reason = EXCLUDED.reason`
  );
  const total = await query<{ n: number }>(`SELECT COUNT(*)::int n FROM probe_targets WHERE active`);
  console.log(`[seed] inserted/updated ${keep.length}; roster now ${total[0].n} active targets`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[seed] FAILED:', e); process.exit(1); });
