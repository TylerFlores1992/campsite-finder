#!/usr/bin/env tsx
/**
 * Run once to apply the database schema.
 * Usage: npx tsx scripts/setup-db.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local before anything else
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
  // no .env.local — rely on environment variables already set
}

import { runMigrations } from '../src/lib/db/client';

runMigrations()
  .then(() => {
    console.log('Database schema applied successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
