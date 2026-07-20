// Prove the GoingToCamp ALERT path end-to-end against the LIVE system.
//
// Creates one watch on a GoingToCamp campground that currently has availability,
// waits for the Fly poller to notice and dispatch, reports the notification rows,
// then deletes the watch and its notifications.
//
// ⚠ THIS SENDS A REAL EMAIL AND SMS to the target account. That is the point —
// it's the difference between "the code path looks right" and "an alert arrived".
// Run it deliberately, not in CI.
//
// Usage: npx tsx scripts/e2e-gtc-alert.mts
//        E2E_OWNER_EMAIL=someone@example.com npx tsx scripts/e2e-gtc-alert.mts
//
// Adapting it to another source: change the campground query and the availability
// helper. Two things this got wrong first time, both fixed here — pick a REAL
// account (a seeded test user has no deliverable address, so dispatch silently
// records nothing), and don't read the notifications table the instant
// `notification_sent_at` appears: the poller claims that BEFORE dispatch runs,
// so an immediate read races the send and reports a false failure.
import { readFileSync } from 'fs';
import { resolve } from 'path';
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [k, ...r] = t.split('=');
  if (k && r.length && !process.env[k.trim()]) process.env[k.trim()] = r.join('=').trim();
}

const { query, mutate } = await import('../src/lib/db/client');
const { hasGoingToCampAvailabilityInRange } = await import('../src/lib/availability/goingtocamp');

const TAG = 'e2e-gtc-alert';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- cleanup helper, used on every exit path -------------------------------
async function cleanup(watchId?: string) {
  if (!watchId) return;
  await mutate(`DELETE FROM notifications WHERE watch_id = $1`, [watchId]).catch(() => {});
  await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]).catch(() => {});
  console.log(`[${TAG}] cleaned up watch ${watchId}`);
}

// --- pick the owner --------------------------------------------------------
// Target a REAL account — a seeded test user has no deliverable address, so the
// dispatch would "run" without proving email/SMS actually work.
const ownerEmail = process.env.E2E_OWNER_EMAIL ?? 'tylerflores1992@gmail.com';
const owner = await query<{ id: string; email: string; phone: string | null }>(
  `SELECT id, email, phone FROM users WHERE email = $1 LIMIT 1`,
  [ownerEmail]
);
if (owner.length === 0) {
  console.error(`no user with email ${ownerEmail} — aborting`);
  process.exit(1);
}
const user = owner[0];
console.log(`[${TAG}] owner: ${user.email} (${user.id}) phone=${user.phone ?? 'none'}`);

// --- find a GoingToCamp campground that is actually available now -----------
const start = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
const end = new Date(Date.now() + 47 * 86400000).toISOString().slice(0, 10);

const candidates = await query<{ id: string; name: string }>(
  `SELECT id, name FROM campgrounds
    WHERE source = 'goingtocamp' AND id LIKE 'gtc-MS-%'
    ORDER BY name LIMIT 6`
);

let target: { id: string; name: string } | null = null;
for (const c of candidates) {
  const ok = await hasGoingToCampAvailabilityInRange(c.id, start, end, 1).catch(() => false);
  console.log(`[${TAG}]   ${c.name} available=${ok}`);
  if (ok) { target = c; break; }
  await sleep(1500); // stay under the WAF burst threshold
}
if (!target) {
  console.error(`[${TAG}] no available GTC campground found for ${start}..${end} — try other dates`);
  process.exit(1);
}
console.log(`[${TAG}] target: ${target.name} (${target.id}) ${start} -> ${end}`);

// --- create the watch ------------------------------------------------------
const [row] = await mutate<{ id: string }>(
  `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, site_type)
   VALUES ($1, $2, $3, $4, 1, NULL) RETURNING id`,
  [user.id, target.id, start, end]
);
const watchId = row.id;
console.log(`[${TAG}] created watch ${watchId} — waiting for the Fly poller (15s cadence)...`);

// --- wait for the poller to notify -----------------------------------------
let notified = false;
for (let i = 1; i <= 12; i++) {
  await sleep(15000);
  const [w] = await query<{ notification_sent_at: string | null; last_checked_at: string | null }>(
    `SELECT notification_sent_at, last_checked_at FROM watches WHERE id = $1`,
    [watchId]
  );
  const notes = await query<{ id: string; channel: string; status: string | null }>(
    `SELECT id, channel, status FROM notifications WHERE watch_id = $1`,
    [watchId]
  ).catch(() => [] as { id: string; channel: string; status: string | null }[]);

  console.log(
    `[${TAG}] t+${i * 15}s checked=${w?.last_checked_at ?? 'never'} notified=${w?.notification_sent_at ?? 'no'} notifications=${notes.length}`
  );
  if (w?.notification_sent_at) {
    notified = true;
    // `notification_sent_at` is claimed BEFORE dispatch runs, so checking rows
    // immediately races the send. Give delivery a moment, then read them.
    await sleep(12000);
    const final = await query<{ channel: string; status: string | null; error: string | null }>(
      `SELECT channel, status, error FROM notifications WHERE watch_id = $1`,
      [watchId]
    ).catch(() => [] as { channel: string; status: string | null; error: string | null }[]);
    console.log(`[${TAG}] dispatched ${final.length} notification row(s):`);
    for (const n of final) {
      console.log(`[${TAG}]   -> ${n.channel} status=${n.status ?? 'n/a'}${n.error ? ` error=${n.error}` : ''}`);
    }
    if (final.length === 0) {
      console.log(`[${TAG}]   (none recorded — check worker logs for the dispatch error)`);
      notified = false;
    }
    break;
  }
}

console.log(notified ? `\n[${TAG}] PASS — poller detected availability and dispatched.` : `\n[${TAG}] FAIL — no notification within 3 minutes.`);
await cleanup(watchId);
process.exit(notified ? 0 : 1);
