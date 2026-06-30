#!/usr/bin/env tsx
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(process.cwd(), '.env.local');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {
  // rely on env already set
}

import { syncRIDB } from '../src/lib/sources/ridb/sync';

const ALL_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

const arg = process.argv[2] ?? 'CA';
const maxFacilities = Number(process.argv[3] ?? 500);
const states = arg === 'ALL' ? ALL_STATES : arg.split(',').map((s) => s.trim().toUpperCase());

async function run() {
  // Verify Supabase connectivity before starting the loop.
  console.log('[run-sync] Checking Supabase connectivity...');
  const { getSupabaseAdmin } = await import('../src/lib/db/client');
  const { data, error } = await getSupabaseAdmin().rpc('exec_select', { query_text: 'SELECT 1 AS ok' });
  if (error) throw new Error(`Supabase connectivity check failed: ${error.message}`);
  console.log('[run-sync] Supabase connected. Starting sync for:', states.join(', '));

  const totals = { facilitiesSynced: 0, campsitesSynced: 0, errors: 0 };

  for (const stateCode of states) {
    console.log(`\n=== Syncing ${stateCode} ===`);
    try {
      const result = await syncRIDB({ stateCode, maxFacilities });
      totals.facilitiesSynced += result.facilitiesSynced;
      totals.campsitesSynced += result.campsitesSynced;
      totals.errors += result.errors.length;
    } catch (err) {
      console.error(`Sync failed for ${stateCode}:`, err);
      totals.errors++;
    }
  }

  console.log('\nTotal:', JSON.stringify(totals, null, 2));

  // Exit 1 if every state errored (real connectivity/auth failure, not just empty results).
  if (totals.errors > 0 && totals.facilitiesSynced === 0 && totals.campsitesSynced === 0) {
    console.error('[run-sync] All states errored with 0 synced — treating as failure.');
    process.exit(1);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Sync run failed:', err);
    process.exit(1);
  });
