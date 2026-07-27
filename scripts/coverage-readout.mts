#!/usr/bin/env tsx
/**
 * Coverage readout — re-derives the numbers in src/lib/coverage.ts.
 *
 * The catalog's state column is dirty (mixed USPS codes, full names, casing and
 * stray whitespace), so a naive `count(distinct address->>'state')` reports 67
 * values for 50 states. This pulls the raw values and runs them through the same
 * normaliser the app uses, so the printed figures match what users would see.
 *
 * Run after any catalog sync, then update the COVERAGE constants:
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/coverage-readout.mts
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeStateCode } from "../src/lib/coverage";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, key);

async function select<T>(sql: string): Promise<T[]> {
  const { data, error } = await sb.rpc("exec_select", { query_text: sql });
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

type Row = { state: string | null; source: string; n: number };

async function main() {
  const rows = await select<Row>(
    `select address->>'state' as state, source, count(*)::int as n
     from campgrounds group by 1, 2`,
  );

  const total = rows.reduce((a, r) => a + r.n, 0);
  const all = new Set<string>();
  const parks = new Set<string>();
  const federal = new Set<string>();
  let missing = 0;
  const unknown = new Map<string, number>();

  for (const r of rows) {
    const code = normalizeStateCode(r.state);
    if (!code) {
      missing += r.n;
      const raw = (r.state ?? "(null)").trim() || "(empty)";
      unknown.set(raw, (unknown.get(raw) ?? 0) + r.n);
      continue;
    }
    all.add(code);
    if (r.source === "ridb") federal.add(code);
    else parks.add(code);
  }

  console.log("\n=== CampHawk coverage ===");
  console.log(`campgrounds       ${total.toLocaleString()}`);
  console.log(`states (any)      ${all.size}`);
  console.log(`state-park states ${parks.size}`);
  console.log(`federal states    ${federal.size}`);
  console.log(`missing state     ${missing.toLocaleString()} campgrounds`);

  if (unknown.size) {
    console.log("\nUnnormalisable state values (fix belongs in the sync adapters):");
    for (const [raw, n] of [...unknown].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${JSON.stringify(raw).padEnd(24)} ${n}`);
    }
  }

  console.log("\nCopy-ready:");
  console.log(`  ${Math.floor(total / 1000).toLocaleString()},000+ campgrounds`);
  console.log(`  all ${all.size} states via Recreation.gov`);
  console.log(`  state parks in ${parks.size}`);
  console.log("\nUpdate COVERAGE in src/lib/coverage.ts if these have moved.\n");
}

main().catch((e) => {
  console.error("coverage-readout failed:", e.message);
  process.exit(1);
});
