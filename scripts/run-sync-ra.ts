#!/usr/bin/env tsx
// Sync ReserveAmerica state parks (NY, TX, OR, UT, NC, KY, IA, IN, GA, NE).
// Usage: npx tsx scripts/run-sync-ra.ts
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

import { syncAllReserveAmerica } from '../src/lib/sources/reserveamerica/sync';

syncAllReserveAmerica()
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
