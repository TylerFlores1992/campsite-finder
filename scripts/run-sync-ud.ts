#!/usr/bin/env tsx
// Sync every UseDirect / RDR provider (ReserveCalifornia, Arizona, Minnesota,
// Missouri, Florida, Nevada, Ohio, Wyoming, Illinois, Virginia).
// Run from a residential IP (datacenter IPs are WAF-blocked on some hosts).
// Usage: npx tsx scripts/run-sync-ud.ts
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

// Force direct (residential) RDR access — never route through the Vercel proxy locally.
delete process.env.RC_PROXY_URL;

import { syncAllUseDirect } from '../src/lib/sources/reservecalifornia/sync';

syncAllUseDirect()
  .then((result) => {
    console.log('Total:', JSON.stringify({ ...result, errors: result.errors.length }, null, 2));
    if (result.errors.length > 0 && result.facilitiesSynced === 0) {
      console.error('[run-sync-ud] All providers errored — treating as failure.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('UseDirect sync failed:', err);
    process.exit(1);
  });
