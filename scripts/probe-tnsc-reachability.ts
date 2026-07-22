#!/usr/bin/env tsx
// Reachability + semantics probe for the TN/SC ColdFusion portal.
//
// This is the test that settles the two open items before TN can ship (see
// docs/CONTEXT.md, "TN + SC"). It's read-only, hits no DB, and sends no alerts —
// safe to run anywhere. Run it from EACH environment and compare:
//
//   • Residential IP:  npx tsx scripts/probe-tnsc-reachability.ts
//   • Fly worker:      flyctl ssh console -C "npx tsx scripts/probe-tnsc-reachability.ts" --config worker/fly.toml
//   • Vercel:          (adapt into a throwaway route, or run from a Vercel function)
//
// What it answers:
//   1. REACHABILITY — does the availability POST return JSON (not a WAF/HTML page)
//      from this IP? This decides worker-direct vs a proxy, the way the
//      GoingToCamp / UseDirect split was decided.
//   2. WHOLE-STAY — it queries the same park at 1, 3 and 5 nights. If `available`
//      counts SHRINK (or hold) as nights grow, the API is evaluating the whole
//      consecutive stay (what we want). If the count is identical regardless of
//      length, it's answering "any night in range" and the adapter needs a
//      per-night intersection after all.
//
// Optional arg: state code (default TN). Only TN is verified; SC will likely work
// the same but is unproven.

import { tnscProviderByState } from '../src/lib/sources/tnsc/providers';
import { fetchParkCatalog, fetchAvailabilityBatch } from '../src/lib/sources/tnsc/client';

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function main() {
  const state = (process.argv[2] ?? 'TN').toUpperCase();
  const provider = tnscProviderByState(state);
  if (!provider) {
    console.error(`Unknown state '${state}'. Known: TN, SC.`);
    process.exit(1);
  }
  console.log(`\n=== TN/SC reachability probe — ${provider.name} (${provider.host}) ===\n`);

  // ── 1. Catalog (also proves the landing GET + CSRF scrape works) ──
  let parks: Awaited<ReturnType<typeof fetchParkCatalog>> = [];
  try {
    parks = await fetchParkCatalog(provider);
    const withCamping = parks.filter((p) => p.products.some((x) => /camp/i.test(x)));
    console.log(`CATALOG: ok — ${parks.length} parks parsed, ${withCamping.length} offering camping.`);
    console.log(`  sample: ${parks.slice(0, 3).map((p) => `${p.name} (key ${p.key})`).join('; ')}`);
  } catch (err) {
    console.error(`CATALOG: FAILED — ${(err as Error).message}`);
    console.error('  → landing GET or CSRF scrape blocked from this IP. Likely a WAF/HTML challenge.');
    process.exit(2);
  }

  // ── 2. Reachability + whole-stay: same park at 1/3/5 nights ──
  // Pick a park likely to have inventory — the one with the most camping products,
  // ~30 days out (inside the booking window, not booked solid).
  const from = addDaysIso(new Date().toISOString().slice(0, 10), 30);
  const target = parks.find((p) => p.products.some((x) => /camp/i.test(x))) ?? parks[0];
  if (!target) {
    console.error('No parks to test availability against.');
    process.exit(2);
  }
  console.log(`\nAVAILABILITY: park "${target.name}" (key ${target.key}), starting ${from}`);

  const counts: Record<number, number | string> = {};
  for (const nights of [1, 3, 5]) {
    const to = addDaysIso(from, nights);
    try {
      const batch = await fetchAvailabilityBatch(provider, from, to);
      const row = batch.get(target.key);
      counts[nights] = row?.availableSites ?? 0;
      console.log(
        `  ${nights} night(s) [${from}→${to}]: ${row?.availableSites ?? 0} camping sites available` +
          (row ? ` (templates: ${row.templates.map((t) => `${t.templateKey}:${t.available}/${t.total}`).join(', ')})` : ' (park not in response)')
      );
    } catch (err) {
      counts[nights] = 'ERR';
      console.error(`  ${nights} night(s): FAILED — ${(err as Error).message}`);
      console.error('  → availability POST blocked/garbled from this IP (WAF or CSRF/session).');
    }
  }

  // ── Verdict ──
  console.log('\n--- verdict ---');
  const nums = [1, 3, 5].map((n) => counts[n]).filter((v): v is number => typeof v === 'number');
  if (nums.length < 3) {
    console.log('REACHABILITY: PARTIAL/BLOCKED from this IP — see errors above.');
  } else {
    console.log('REACHABILITY: ok — JSON availability returned from this IP.');
    const [c1, c3, c5] = [counts[1], counts[3], counts[5]] as number[];
    if (c1 >= c3 && c3 >= c5 && (c1 > c5 || (c1 === c3 && c3 === c5))) {
      console.log(
        c1 === c5
          ? 'WHOLE-STAY: inconclusive — counts identical across lengths (park may be wide open). Retry a busier park/date.'
          : 'WHOLE-STAY: LIKELY YES — counts shrink as nights grow, consistent with whole-consecutive-stay evaluation.'
      );
    } else {
      console.log('WHOLE-STAY: SUSPECT — counts do not monotonically shrink; inspect before trusting whole-stay.');
    }
  }
  console.log('\nRun this from residential AND the Fly worker; compare the REACHABILITY lines.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(1);
});
