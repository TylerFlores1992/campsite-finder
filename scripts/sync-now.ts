#!/usr/bin/env tsx
// One-shot sync script. Usage: npx tsx scripts/sync-now.ts
// Loads .env.local automatically.

import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const lines = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
} catch { /* rely on env */ }

import { runMigrations } from '../src/lib/db/client';
import { syncRIDB } from '../src/lib/sources/ridb/sync';

async function main() {
  console.log('Ensuring schema is up to date...');
  await runMigrations();

  console.log('Starting RIDB sync — California (state-wide, ~678 campgrounds)...');
  const result = await syncRIDB({
    stateCode: 'CA',
    maxFacilities: 2000,
  });

  console.log(`\nSync complete:`);
  console.log(`  Campgrounds: ${result.facilitiesSynced}`);
  console.log(`  Campsites:   ${result.campsitesSynced}`);
  console.log(`  Duration:    ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`);
    result.errors.slice(0, 5).forEach(e => console.log(`    - ${e}`));
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
