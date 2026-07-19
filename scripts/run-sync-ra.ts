#!/usr/bin/env tsx
// Sync ReserveAmerica state parks (all contracts in RA_CONTRACTS).
// Usage: npx tsx scripts/run-sync-ra.ts        # every contract
//        npx tsx scripts/run-sync-ra.ts DE     # one contract
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(process.cwd(), '.env.local');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
} catch {
  // rely on env already set
}

import { syncAllReserveAmerica, syncReserveAmerica } from '../src/lib/sources/reserveamerica/sync';
import { contractByCode } from '../src/lib/sources/reserveamerica/client';

// Optional contract code arg syncs a single state (e.g. `run-sync-ra.ts DE`),
// which is what you want when adding one — a full run is ~18 states of scraping.
const only = process.argv[2]?.toUpperCase();
const contract = only ? contractByCode(only) : undefined;
if (only && !contract) {
  console.error(`[run-sync-ra] Unknown contract code '${only}'. Add it to RA_CONTRACTS first.`);
  process.exit(1);
}

(contract ? syncReserveAmerica(contract) : syncAllReserveAmerica())
  .then((result) => {
    console.log('Total:', JSON.stringify({ ...result, errors: result.errors.length }, null, 2));
    if (result.errors.length > 0 && result.facilitiesSynced === 0) {
      console.error('[run-sync-ra] All contracts errored — treating as failure.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('RA sync failed:', err);
    process.exit(1);
  });
