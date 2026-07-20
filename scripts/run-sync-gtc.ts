#!/usr/bin/env tsx
// Sync GoingToCamp (Camis) state parks — WA, MI, WI, MS.
// Usage: npx tsx scripts/run-sync-gtc.ts        # every tenant
//        npx tsx scripts/run-sync-gtc.ts WA     # one tenant
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
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

import { syncAllGoingToCamp, syncGoingToCamp } from '../src/lib/sources/goingtocamp/sync';
import { gtcProviderByState } from '../src/lib/sources/goingtocamp/providers';

const only = process.argv[2]?.toUpperCase();
const provider = only ? gtcProviderByState(only) : undefined;
if (only && !provider) {
  console.error(`[run-sync-gtc] Unknown state '${only}'. Add it to GOINGTOCAMP_PROVIDERS first.`);
  process.exit(1);
}

(provider ? syncGoingToCamp(provider) : syncAllGoingToCamp())
  .then((result) => {
    console.log('Total:', JSON.stringify({ ...result, errors: result.errors.length }, null, 2));
    if (result.errors.length > 0 && result.facilitiesSynced === 0) {
      console.error('[run-sync-gtc] All tenants errored — treating as failure.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('GTC sync failed:', err);
    process.exit(1);
  });
