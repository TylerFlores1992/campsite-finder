#!/usr/bin/env tsx
// Health pager — run on a cron (see .github/workflows/health-canary.yml). Hits
// /api/health/status and, when it reports `down` (503), emails + texts the owner
// via the same Resend/Twilio the product uses. This is what turns the silent-death
// traps in docs/CONTEXT.md into "paged in minutes".
//
// Re-page throttle: a sustained outage shouldn't text every 5 minutes, so we record
// the last page in alert_canary (key `paging:owner`) and stay quiet for
// PAGE_THROTTLE_MIN unless the set of failing checks CHANGES. Recovery is announced
// once, then the throttle row is cleared.
//
// Env: NEXT_PUBLIC_APP_URL (or defaults to https://camphawk.app), Supabase creds,
// RESEND_API_KEY/EMAIL_FROM, TWILIO_*, and HEALTH_ALERT_EMAIL / HEALTH_ALERT_PHONE.
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
const { sendEmail } = await import('../src/lib/notifications/email');
const { sendSms } = await import('../src/lib/notifications/sms');

const PAGE_THROTTLE_MIN = Number(process.env.HEALTH_PAGE_THROTTLE_MIN || 30);
// NB: use `||`, not `??` — GitHub Actions passes an unset/empty secret as "" (not
// undefined), and `?? ` wouldn't fall back on an empty string. An empty APP_URL
// there once made `base=""`, which failed the fetch and FALSE-paged "endpoint down".
const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
const email = process.env.HEALTH_ALERT_EMAIL || 'tylerflores1992@gmail.com';
const phone = process.env.HEALTH_ALERT_PHONE || null;

interface Check { name: string; level: 'ok' | 'warn' | 'fail'; detail: string }
interface Status { status: 'ok' | 'degraded' | 'down'; checkedAt: string; checks: Check[] }

const res = await fetch(`${base}/api/health/status`, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
  console.error('[health-page] fetch failed:', (e as Error).message);
  return null;
});
// A hard fetch failure (endpoint/site down) is itself a page-worthy outage.
const body: Status = res ? await res.json().catch(() => ({ status: 'down', checkedAt: new Date().toISOString(), checks: [{ name: 'endpoint', level: 'fail', detail: 'non-JSON response' }] })) : { status: 'down', checkedAt: new Date().toISOString(), checks: [{ name: 'endpoint', level: 'fail', detail: `unreachable ${base}/api/health/status` }] };

const failing = body.checks.filter((c) => c.level === 'fail');
const down = body.status === 'down' || (res != null && res.status === 503);
console.log(`[health-page] status=${body.status} http=${res?.status ?? 'none'} failing=[${failing.map((c) => c.name).join(', ')}]`);

// Prior page state (single row, key 'paging:owner'): detail = last failing-set signature.
const [prev] = await query<{ last_run_at: string | null; detail: string | null }>(
  `SELECT last_run_at::text, detail FROM alert_canary WHERE key = 'paging:owner'`
).catch(() => [] as { last_run_at: string | null; detail: string | null }[]);
const prevSig = prev?.detail ?? '';
const prevAgeMin = prev?.last_run_at ? (Date.now() - new Date(prev.last_run_at).getTime()) / 60000 : Infinity;

async function setPageState(sig: string) {
  await mutate(
    `INSERT INTO alert_canary (key, ok, last_run_at, detail) VALUES ('paging:owner', false, NOW(), $1)
     ON CONFLICT (key) DO UPDATE SET last_run_at = NOW(), detail = $1`,
    [sig.slice(0, 500)]
  ).catch((e) => console.error('[health-page] page-state write failed:', (e as Error).message));
}
async function clearPageState() {
  await mutate(`DELETE FROM alert_canary WHERE key = 'paging:owner'`).catch(() => {});
}

if (!down) {
  // Recovered: announce once (only if we had previously paged), then clear.
  if (prev) {
    const subject = 'CampHawk RECOVERED — alerting healthy again';
    const text = `Health is back to ${body.status} at ${body.checkedAt}.`;
    await sendEmail({ to: email, subject, html: `<p>${text}</p>` }).catch((e) => console.error('recovery email failed:', (e as Error).message));
    if (phone) await sendSms({ to: phone, body: `CampHawk RECOVERED — ${body.status} at ${body.checkedAt}` }).catch((e) => console.error('recovery sms failed:', (e as Error).message));
    await clearPageState();
    console.log('[health-page] recovery announced, throttle cleared');
  } else {
    console.log('[health-page] healthy, nothing to do');
  }
  process.exit(0);
}

// DOWN. Page unless throttled AND the failing set is unchanged.
const sig = failing.map((c) => c.name).sort().join(',');
if (prev && sig === prevSig && prevAgeMin < PAGE_THROTTLE_MIN) {
  console.log(`[health-page] down but throttled (paged ${prevAgeMin.toFixed(0)}m ago, same failures) — staying quiet`);
  process.exit(0);
}

const lines = failing.map((c) => `• ${c.name}: ${c.detail}`).join('\n');
const subject = `CampHawk DOWN — ${failing.length} alert-health check(s) failing`;
const textBody = `Alert-health is DOWN as of ${body.checkedAt}.\n\nFailing:\n${lines}\n\n${base}/api/health/status`;
await sendEmail({ to: email, subject, html: `<p><b>Alert-health is DOWN</b> as of ${body.checkedAt}.</p><pre>${lines}</pre><p><a href="${base}/api/health/status">${base}/api/health/status</a></p>` })
  .catch((e) => console.error('page email failed:', (e as Error).message));
if (phone) {
  await sendSms({ to: phone, body: `CampHawk DOWN: ${failing.map((c) => c.name).join(', ')}. See ${base}/api/health/status` })
    .catch((e) => console.error('page sms failed:', (e as Error).message));
}
await setPageState(sig);
console.log(`[health-page] PAGED owner (${email}${phone ? ' + sms' : ''}) — ${textBody.replace(/\n/g, ' ')}`);
process.exit(0);
