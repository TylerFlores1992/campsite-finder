#!/usr/bin/env tsx
// Sync Tennessee / South Carolina State Parks (ColdFusion portal).
// Usage: npx tsx scripts/run-sync-tnsc.ts        # every VERIFIED provider (TN)
//        npx tsx scripts/run-sync-tnsc.ts TN     # one provider
//
// Reachability: residential works, and so does a Claude-web session via the agent
// proxy — run it with `NODE_USE_ENV_PROXY=1` (verified 2026-08-04, TN 39 + SC 34
// parks, 0 errors). Node's fetch ignores the proxy without that flag and you get a
// WAF 403 that reads like a hard block. FLY is genuinely blocked and is why the
// worker goes through `/api/tnsc-availability` — see docs/CONTEXT.md.
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      // Strip surrounding quotes: newer Vercel CLI writes KEY="value", and a
      // literal quote in e.g. NEXT_PUBLIC_SUPABASE_URL makes it an invalid URL.
      process.env[key.trim()] = rest.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch {
  // rely on env already set
}

import { syncAllTnsc, syncTnsc } from '../src/lib/sources/tnsc/sync';
import { tnscProviderByState } from '../src/lib/sources/tnsc/providers';

const only = process.argv[2]?.toUpperCase();
const provider = only ? tnscProviderByState(only) : undefined;
if (only && !provider) {
  console.error(`[run-sync-tnsc] Unknown state '${only}'. Add it to TNSC_PROVIDERS first.`);
  process.exit(1);
}

(provider ? syncTnsc(provider) : syncAllTnsc())
  .then((result) => {
    console.log('Total:', JSON.stringify({ ...result, errors: result.errors.length }, null, 2));
    if (result.errors.length > 0 && result.facilitiesSynced === 0) {
      console.error('[run-sync-tnsc] Errored with zero parks synced — treating as failure.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('TNSC sync failed:', err);
    process.exit(1);
  });
