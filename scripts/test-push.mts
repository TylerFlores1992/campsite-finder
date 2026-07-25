#!/usr/bin/env tsx
/**
 * Fire a REAL native push at registered devices — the last unverified step of the
 * mobile-app milestone ("a device token lands in push_tokens" is already done; this
 * proves a push actually arrives on the device). Uses the SAME sendPush path the
 * worker's alert dispatch uses (src/lib/notifications/push.ts, FCM HTTP v1), so a
 * success here means live alerts will deliver to that device too.
 *
 * Requires FCM_SERVICE_ACCOUNT + Supabase creds in the environment (they live on
 * Vercel + the Fly worker; from a web session the CampHawk env must also carry
 * FCM_SERVICE_ACCOUNT, and run with NODE_USE_ENV_PROXY=1 so Node reaches Supabase +
 * oauth2.googleapis.com + fcm.googleapis.com through the proxy).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/test-push.mts [--user=<clerk_id>] [--platform=android|ios] [--prune]
 *
 * No filter = every registered device. --prune deletes any token FCM reports dead.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local locally; on Fly/web-session the env is already populated.
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, ...rest] = t.split('=');
    if (k && rest.length && !process.env[k.trim()]) process.env[k.trim()] = rest.join('=').trim();
  }
} catch { /* rely on environment */ }

import { query, mutate } from '../src/lib/db/client';
import { isPushConfigured, sendPush } from '../src/lib/notifications/push';

const flag = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main() {
  if (!isPushConfigured()) {
    console.error(
      '✗ FCM_SERVICE_ACCOUNT is not set (or not valid JSON) in this environment.\n' +
      '  It lives on Vercel + the Fly worker; add it to this env config to send from here.'
    );
    process.exit(1);
  }

  const user = flag('user');
  const platform = flag('platform');
  const wheres: string[] = [];
  if (user) wheres.push(`user_id = '${user.replace(/'/g, "''")}'`);
  if (platform) wheres.push(`platform = '${platform.replace(/'/g, "''")}'`);
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  const rows = await query<{ token: string; platform: string; user_id: string }>(
    `SELECT token, platform, user_id FROM push_tokens ${where} ORDER BY last_seen_at DESC`
  );

  if (rows.length === 0) {
    console.error(`✗ No push_tokens match${where ? ` (${where})` : ''}.`);
    process.exit(1);
  }

  console.log(`Sending test push to ${rows.length} device(s):`);
  for (const r of rows) console.log(`  - ${r.platform}  user=${r.user_id}  …${r.token.slice(-12)}`);

  const result = await sendPush({
    tokens: rows.map((r) => r.token),
    title: 'CampHawk test 🏕️',
    body: 'Push delivery is working — this is a manual test, not a real opening.',
    data: { kind: 'test', url: 'https://camphawk.app/watches' },
  });

  console.log(`\n✓ FCM accepted: ${result.sent} sent, ${result.deadTokens.length} dead token(s).`);

  if (result.deadTokens.length && has('prune')) {
    const list = result.deadTokens.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    await mutate(`DELETE FROM push_tokens WHERE token IN (${list})`);
    console.log(`  Pruned ${result.deadTokens.length} dead token(s) from push_tokens.`);
  } else if (result.deadTokens.length) {
    console.log('  (re-run with --prune to delete dead tokens)');
  }

  console.log('\nNow check the device — the notification should have arrived.');
}

main().catch((e) => {
  console.error('✗ test-push failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
