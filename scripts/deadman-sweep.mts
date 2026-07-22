#!/usr/bin/env tsx
// Dead-man's switch (feature D). Runs daily (see .github/workflows/deadman.yml).
// Two phases:
//   1. Auto-pause watches we prompted > GRACE_DAYS ago that never answered.
//   2. Prompt "still want this?" on watches that have gone quiet for STALE_DAYS.
// Both reuse the one-tap /w/ action links (keep / cancel / reopen).
//
// Env: Supabase creds, RESEND_API_KEY/EMAIL_FROM, TWILIO_*, NEXT_PUBLIC_APP_URL.
import { readFileSync } from 'fs';
import { resolve } from 'path';
try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, ...r] = t.split('=');
    if (k && r.length && !process.env[k.trim()]) process.env[k.trim()] = r.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* CI injects env directly */ }

const { query, mutate } = await import('../src/lib/db/client');
const { actionUrlFor } = await import('../src/lib/notifications/actions');
const { sendEmail } = await import('../src/lib/notifications/email');
const { sendSms } = await import('../src/lib/notifications/sms');

const STALE_DAYS = Number(process.env.DEADMAN_STALE_DAYS ?? 21);
const GRACE_DAYS = Number(process.env.DEADMAN_GRACE_DAYS ?? 7);
const smsOk = !!process.env.TWILIO_ACCOUNT_SID;

interface Row { id: string; email: string | null; phone: string | null; name: string; start_date: string; end_date: string }

async function notify(row: Row, subject: string, html: string, sms: string) {
  await Promise.allSettled([
    row.email ? sendEmail({ to: row.email, subject, html }) : Promise.resolve(),
    row.phone && smsOk ? sendSms({ to: row.phone, body: sms }) : Promise.resolve(),
  ]);
}

// ── Phase 1: auto-pause the unanswered ────────────────────────────────────────
const toPause = await query<Row>(
  `SELECT wt.id, u.email, u.phone, c.name, wt.start_date::text, wt.end_date::text
     FROM watches wt JOIN users u ON u.id = wt.user_id JOIN campgrounds c ON c.id = wt.campground_id
    WHERE wt.active = true AND wt.deadman_prompted_at IS NOT NULL
      AND wt.deadman_prompted_at < NOW() - ($1 || ' days')::interval
    LIMIT 500`,
  [String(GRACE_DAYS)]
);
let paused = 0;
for (const row of toPause) {
  const changed = await mutate<{ id: string }>(`UPDATE watches SET active = false WHERE id = $1 AND active = true RETURNING id`, [row.id]);
  if (changed.length === 0) continue;
  const reopen = (await actionUrlFor(row.id, 'reopen')) ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://camphawk.app';
  await notify(
    row,
    `Paused your watch on ${row.name}`,
    `<p>We hadn't heard back, so we paused your watch on <b>${row.name}</b> (${row.start_date} → ${row.end_date}) to keep your alerts tidy.</p><p>Still want it? <a href="${reopen}">Resume this watch</a>.</p>`,
    `CampHawk: paused your quiet watch on ${row.name}. Resume: ${reopen}`
  );
  paused++;
}

// ── Phase 2: prompt the newly-stale ───────────────────────────────────────────
const toPrompt = await query<Row>(
  `SELECT wt.id, u.email, u.phone, c.name, wt.start_date::text, wt.end_date::text
     FROM watches wt JOIN users u ON u.id = wt.user_id JOIN campgrounds c ON c.id = wt.campground_id
    WHERE wt.active = true AND wt.deadman_prompted_at IS NULL
      AND wt.created_at < NOW() - ($1 || ' days')::interval
      AND (wt.notification_sent_at IS NULL OR wt.notification_sent_at < NOW() - ($1 || ' days')::interval)
      AND wt.end_date > CURRENT_DATE
    LIMIT 500`,
  [String(STALE_DAYS)]
);
let prompted = 0;
for (const row of toPrompt) {
  const [keepUrl, cancelUrl] = await Promise.all([actionUrlFor(row.id, 'keep'), actionUrlFor(row.id, 'cancel')]);
  if (!keepUrl || !cancelUrl) continue;
  await mutate(`UPDATE watches SET deadman_prompted_at = NOW() WHERE id = $1`, [row.id]);
  await notify(
    row,
    `Still watching ${row.name}?`,
    `<p>Your watch on <b>${row.name}</b> (${row.start_date} → ${row.end_date}) has been quiet for a while.</p><p><a href="${keepUrl}">Yes, keep watching</a> &nbsp;·&nbsp; <a href="${cancelUrl}">No, stop</a></p><p style="font-size:12px;color:#999">If we don't hear back, we'll pause it in ${GRACE_DAYS} days.</p>`,
    `CampHawk: still want ${row.name}? Keep: ${keepUrl} Stop: ${cancelUrl}`
  );
  prompted++;
}

console.log(`[deadman] paused ${paused} unanswered, prompted ${prompted} newly-stale (stale=${STALE_DAYS}d grace=${GRACE_DAYS}d)`);
process.exit(0);
