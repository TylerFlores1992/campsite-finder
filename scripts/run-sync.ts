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

const stateCode = process.argv[2] ?? 'CA';
const maxFacilities = Number(process.argv[3] ?? 500);

syncRIDB({ stateCode, maxFacilities })
  .then((result) => {
    console.log('\nSync result:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
