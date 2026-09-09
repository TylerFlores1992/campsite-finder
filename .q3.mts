import { query } from './src/lib/db/client.ts';
const first = (await query<any>(`select okta_checked_at, okta_expires_at from rc_runner_heartbeat where id=1`))[0];
console.log('BEFORE', first.okta_checked_at, '->', first.okta_expires_at);
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 60000));
  const n = (await query<any>(`select okta_checked_at, okta_expires_at,
    round(extract(epoch from (okta_expires_at - okta_checked_at))/3600.0, 4) as h from rc_runner_heartbeat where id=1`))[0];
  if (n.okta_checked_at !== first.okta_checked_at) {
    console.log('AFTER ', n.okta_checked_at, '->', n.okta_expires_at, ` (+${n.h}h from check)`);
    console.log(n.okta_expires_at === first.okta_expires_at
      ? 'VERDICT: FROZEN — the check advanced and the expiry did not. Absolute cap.'
      : 'VERDICT: ROLLING — the expiry moved with the check. Not a cap.');
    process.exit(0);
  }
}
console.log('no new probe within 30 min');
