import { clerkClient } from '@clerk/nextjs/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Stripe from 'stripe';
import BrandMark from '@/components/v2/BrandMark';
import AdminAutoRefresh from '@/components/AdminAutoRefresh';
import AdminTabs, { type AdminData } from '@/components/admin/AdminTabs';
import { query, queryOne } from '@/lib/db/client';
import { getShardCoverage, getPollerCapacity, type PollerCapacity, type ShardCoverage } from '@/lib/capacity';
import type { CostItem, UsageCounts } from '@/lib/costs';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Admin — CampHawk',
  robots: { index: false, follow: false },
};


/**
 * Exclude seed/test accounts from every counted metric.
 *
 * Clerk user ids are always `user_…`. The five rows that are not — `test-user-001/002/003`,
 * `test-rpc-check`, `webhook-test-user`, all dated 2026-06-30 — were inserted by hand while
 * building the RPC and webhook paths, and they were being counted as real users everywhere
 * on this page except the headline. They also own **5 of the 33 watches**, so "Watches"
 * was inflated too; that one was less obvious because nothing about a watch says who made
 * it.
 *
 * Worst of all they were HIDING a discrepancy: the Users tile reads Clerk, everything else
 * reads this table, and both said 25 — which looked like agreement and was actually five
 * fake rows papering over five signups who never took an action. Real users are 20.
 *
 * ONE constant, applied to users/watches by id shape rather than a hardcoded list of five
 * ids, so a sixth test row inserted tomorrow is excluded without anyone remembering to add
 * it. `\_` is escaped because `_` is a single-character wildcard in LIKE — unescaped,
 * `'user_%'` would also match a `userX…` id.
 */
const REAL_USER = (col = 'user_id') => `${col} LIKE 'user\\_%'`;

async function safe<T>(p: Promise<T | null>, fallback: T): Promise<T> {
  try {
    return (await p) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Realized MRR from Stripe: sum active subscriptions, normalized to monthly.
 *  (Trialing subs aren't paying yet, so they're excluded.) Returns null on error. */
async function computeMrr(): Promise<{ monthly: number; activeCount: number } | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const stripe = new Stripe(key.trim());
  let cents = 0;
  let activeCount = 0;
  for await (const sub of stripe.subscriptions.list({
    status: 'active',
    limit: 100,
    expand: ['data.items.data.price'],
  })) {
    activeCount++;
    for (const item of sub.items.data) {
      const amt = (item.price.unit_amount ?? 0) * (item.quantity ?? 1);
      const ivl = item.price.recurring?.interval;
      const ic = item.price.recurring?.interval_count ?? 1;
      if (ivl === 'year') cents += amt / (12 * ic);
      else if (ivl === 'month') cents += amt / ic;
      else if (ivl === 'week') cents += (amt * 52) / 12 / ic;
      else if (ivl === 'day') cents += (amt * 365) / 12 / ic;
    }
  }
  return { monthly: cents / 100, activeCount };
}

export default async function AdminPage() {
  // 404 (not 403) for non-admins so the page's existence isn't revealed.
  // Allowlist lives in lib/admin — see the note there about the four copies.
  if (!(await currentUserIsAdmin())) notFound();

  const [usersAgg, seriesRows, subRows, activeSub, watchAgg, alertAgg, cgRows, beat, syncRows, canaryRows, costItems, usageRows, lifetimeUsageRows, smsDelivery] =
    await Promise.all([
      safe(
        queryOne<{ total: number; new_7d: number; new_30d: number }>(
          `SELECT count(*)::int total,
                  count(*) FILTER (WHERE created_at > now() - interval '7 days')::int new_7d,
                  count(*) FILTER (WHERE created_at > now() - interval '30 days')::int new_30d
           FROM users WHERE ${REAL_USER('id')}`
        ),
        { total: 0, new_7d: 0, new_30d: 0 }
      ),
      // ALL-TIME daily counts for every charted metric, in one query.
      //
      // Not windowed to 30 days, because the chart now offers months and years and a
      // running TOTAL. Re-fetching per range would make every range click a round
      // trip; grouping by day server-side and re-bucketing in the browser makes them
      // instant, and a cumulative total needs the whole history anyway — you cannot
      // sum "users so far" from a 30-day slice. One row per metric per day, so this
      // is bounded by the age of the product, not by row count.
      safe(
        query<{ metric: string; d: string; n: number }>(
          `SELECT 'users' AS metric, to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, count(*)::int AS n
             FROM users WHERE ${REAL_USER('id')} GROUP BY 2
           UNION ALL
           SELECT 'subs', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(*)::int
             FROM subscriptions GROUP BY 2
           UNION ALL
           SELECT 'watches', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(*)::int
             FROM watches WHERE ${REAL_USER()} GROUP BY 2
           UNION ALL
           SELECT 'alerts', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(*)::int
             FROM notifications WHERE status = 'sent' GROUP BY 2
           ORDER BY 1, 2`
        ),
        []
      ),
      safe(
        query<{ status: string; n: number }>(
          `SELECT status, count(*)::int n FROM (
             SELECT DISTINCT ON (user_id) user_id, status FROM subscriptions
             ORDER BY user_id, created_at DESC) t GROUP BY status`
        ),
        []
      ),
      safe(
        queryOne<{ n: number }>(
          `SELECT count(*)::int n FROM (
             SELECT DISTINCT ON (user_id) user_id, status FROM subscriptions
             ORDER BY user_id, created_at DESC) t WHERE status IN ('active','trialing')`
        ),
        { n: 0 }
      ),
      safe(
        queryOne<{ active: number; total: number; watchers: number }>(
          `SELECT count(*) FILTER (WHERE active)::int active, count(*)::int total,
                  count(DISTINCT user_id)::int watchers FROM watches WHERE ${REAL_USER()}`
        ),
        { active: 0, total: 0, watchers: 0 }
      ),
      safe(
        queryOne<{ sent: number; sent_7d: number; failed: number }>(
          `SELECT count(*) FILTER (WHERE status='sent')::int sent,
                  count(*) FILTER (WHERE status='sent' AND created_at > now() - interval '7 days')::int sent_7d,
                  count(*) FILTER (WHERE status='failed')::int failed FROM notifications`
        ),
        { sent: 0, sent_7d: 0, failed: 0 }
      ),
      safe(
        query<{ source: string; n: number }>(
          `SELECT source, count(*)::int n FROM campgrounds GROUP BY source ORDER BY n DESC`
        ),
        []
      ),
      safe(
        queryOne<{ beat_at: string; watches_checked: number; age_s: number }>(
          `SELECT beat_at::text, watches_checked, extract(epoch FROM now()-beat_at)::int age_s
           FROM worker_heartbeat WHERE id = 1`
        ),
        null
      ),
      safe(
        query<{
          source: string;
          finished_at: string | null;
          facilities_synced: number | null;
          error: string | null;
          metadata: { totalErrors?: number } | null;
          age_s: number | null;
        }>(
          // age_s is computed HERE, by Postgres, not in the client component. Calling
          // Date.now() during render is impure — non-deterministic output and a
          // hydration mismatch waiting to happen — which is why canaryRows already
          // carries its age the same way.
          `SELECT DISTINCT ON (source) source, finished_at::text, facilities_synced, error, metadata,
                  extract(epoch from (now() - finished_at))::int AS age_s
           FROM sync_log ORDER BY source, started_at DESC`
        ),
        []
      ),
      safe(
        query<{ key: string; ok: boolean; age_s: number | null; consecutive_failures: number; detail: string | null }>(
          `SELECT key, ok, extract(epoch FROM now()-last_run_at)::int age_s, consecutive_failures, detail
           FROM alert_canary WHERE key LIKE 'detect:%' OR key LIKE 'delivery:%' ORDER BY key`
        ),
        []
      ),
      safe(
        query<CostItem>(
          // monthly_cents was RENAMED to amount_cents by migration 025. This select
          // was never updated, so it threw "column does not exist" on every render and
          // safe() swallowed it to [] — the Costs tab's server-side items silently
          // vanished. A caught error that returns an empty list is indistinguishable
          // from "no cost items", which is exactly why it went unnoticed.
          `SELECT id, label, category, amount_cents, billing_period, notes, sort_order,
                  started_at::text
             FROM cost_items ORDER BY sort_order, label`
        ),
        []
      ),
      safe(
        query<{ channel: string; n: number }>(
          `SELECT channel, count(*)::int n FROM notifications
            WHERE status = 'sent' AND created_at >= date_trunc('month', now())
            GROUP BY channel`
        ),
        []
      ),
      // ALL TIME, deliberately unscoped — the query above is this month only, and
      // lifetime spend needs every alert ever sent.
      safe(
        query<{ channel: string; n: number }>(
          `SELECT channel, count(*)::int n FROM notifications
            WHERE status = 'sent' GROUP BY channel`
        ),
        []
      ),
      // DID THE TEXTS ACTUALLY ARRIVE? (migration 038)
      //
      // `status = 'sent'` above counts messages TWILIO ACCEPTED, which is what we
      // could measure before delivery receipts existed and is not the same question.
      // These buckets are the carrier's answer:
      //   delivered   — it reached a handset.
      //   dropped     — undelivered/failed: carrier rejection, unreachable handset,
      //                 A2P filtering. The silent failure this whole feature is for.
      //   pending     — accepted, receipt not in yet. Normal for seconds, suspicious
      //                 for hours.
      //   untracked   — sent before 038, or sent with no SID captured. Kept visible
      //                 rather than folded into "delivered", so the denominator is
      //                 honest while the backlog ages out.
      // TWO WINDOWS, and the distinction is the point (2026-08-08).
      //
      // A single 30-day rate answers "did texts arrive over the last month?" and then
      // gets read as "are texts arriving?". Those are different questions, and after a
      // FIXED incident they give opposite answers: every one of the 13 drops happened on
      // 2026-08-05, before the camphawk.app link came out of SMS, and none since — yet
      // the banner read "33% of texts are not reaching phones" for three days after the
      // cause was gone. A dashboard that reports a resolved outage as a current one
      // trains its only reader to ignore it, which is the same failure the canary
      // thresholds exist to prevent.
      //
      // So: `recent` (7d) decides the LEVEL, `window` (30d) is shown as history. Nothing
      // is hidden and nothing is deleted — those rows are the evidence that the fix
      // worked, and four of their SIDs are in an open Twilio ticket.
      safe(
        queryOne<{
          delivered: number; dropped: number; pending: number; untracked: number;
          r_delivered: number; r_dropped: number; r_pending: number; r_untracked: number;
        }>(
          `SELECT count(*) FILTER (WHERE delivery_status = 'delivered')::int delivered,
                  count(*) FILTER (WHERE delivery_status IN ('undelivered','failed','canceled'))::int dropped,
                  count(*) FILTER (WHERE provider_id IS NOT NULL
                                     AND (delivery_status IS NULL
                                          OR delivery_status NOT IN ('delivered','undelivered','failed','canceled')))::int pending,
                  count(*) FILTER (WHERE provider_id IS NULL)::int untracked,
                  count(*) FILTER (WHERE delivery_status = 'delivered' AND recent)::int r_delivered,
                  count(*) FILTER (WHERE delivery_status IN ('undelivered','failed','canceled') AND recent)::int r_dropped,
                  count(*) FILTER (WHERE recent AND provider_id IS NOT NULL
                                     AND (delivery_status IS NULL
                                          OR delivery_status NOT IN ('delivered','undelivered','failed','canceled')))::int r_pending,
                  count(*) FILTER (WHERE recent AND provider_id IS NULL)::int r_untracked
             FROM (SELECT *, created_at > now() - interval '7 days' AS recent
                     FROM notifications
                    WHERE channel = 'sms' AND status = 'sent'
                      AND created_at > now() - interval '30 days') n`
        ),
        { delivered: 0, dropped: 0, pending: 0, untracked: 0,
          r_delivered: 0, r_dropped: 0, r_pending: 0, r_untracked: 0 }
      ),
    ]);

  // CAPACITY, on the page whose job is "is anything broken?". It answers the question one
  // step earlier than everything else here — not "is it broken" but "when will it be" —
  // and it lived only in /api/health/status, so nobody saw it unless they curled for it.
  // Same functions the pager uses, so the dashboard cannot quietly disagree with the page.
  const shardCov = await getShardCoverage().catch(
    (): ShardCoverage => ({ held: 0, expected: 0, missing: [], machines: 1, level: 'warn', detail: 'read failed' }),
  );
  const capacity = await getPollerCapacity(shardCov.machines).catch(
    (): PollerCapacity => ({ demand: 0, capacity: 0, machines: shardCov.machines, free: 0, level: 'warn', detail: 'read failed' }),
  );

  const mrr = await computeMrr().catch(() => null);

  // True signup count from Clerk (our users table only has rows for people who've
  // taken an action, so it undercounts — this is what the Clerk dashboard shows).
  const clerkTotal = await safe(
    (async () => (await clerkClient()).users.getCount())(),
    null as number | null
  );

  const subMap = Object.fromEntries(subRows.map((r) => [r.status, r.n]));
  const cgTotal = cgRows.reduce((s, r) => s + r.n, 0);
  const workerHealthy = !!beat && beat.age_s < 300;

  // Raw all-time daily counts per metric, ascending. The client zero-fills and
  // re-buckets these to whatever range is selected — see MetricChart.bucket().
  const pick = (metric: string) =>
    seriesRows.filter((r) => r.metric === metric).map((r) => ({ day: r.d, n: r.n }));
  const series = {
    users: pick('users'),
    subs: pick('subs'),
    watches: pick('watches'),
    alerts: pick('alerts'),
  };

  // Usage this month, keyed by channel, for the Costs tab.
  const lifetimeByChannel = Object.fromEntries(lifetimeUsageRows.map((r) => [r.channel, r.n]));
  const lifetimeUsage: UsageCounts = {
    sms: lifetimeByChannel['sms'] ?? 0,
    email: lifetimeByChannel['email'] ?? 0,
    push: lifetimeByChannel['push'] ?? 0,
  };
  const usageByChannel = Object.fromEntries(usageRows.map((r) => [r.channel, r.n]));
  const usage: UsageCounts = {
    sms: usageByChannel['sms'] ?? 0,
    email: usageByChannel['email'] ?? 0,
    push: usageByChannel['push'] ?? 0,
  };
  const monthLabel = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' });

  const data: AdminData = {
    clerkTotal,
    usersAgg,
    shardCov,
    capacity,
    activeSub,
    subMap,
    watchAgg,
    alertAgg,
    cgRows,
    cgTotal,
    series,
    mrr,
    beat,
    workerHealthy,
    canaryRows,
    syncRows,
    smsDelivery,
    costItems: costItems as CostItem[],
    usage,
    lifetimeUsage,
    monthLabel,
  };

  return (
    <div className="min-h-dvh bg-ch-paper font-ch-body text-ch-ink">
      {/* Matches the site header's lockup exactly — BrandMark (the real
          /brand/logo-badge.png art) at 28px beside the CampHawk wordmark, same font,
          weight and tracking as V2Nav. An earlier pass here used HawkMark from
          components/Logo.tsx, which is the LEGACY hand-drawn SVG that file's own
          header describes as an AI-coded concept pending a designer pass — so the one
          page the owner opens most was the one still showing the old mark.

          "Admin" is a quiet label rather than an ochre chip: there is exactly one
          person who can load this page, and they know where they are. */}
      <header
        // SAFE-AREA INSET. /admin sits OUTSIDE the (app) route group, so it never gets
        // V2Nav — and V2Nav is where every other screen's status-bar handling lives.
        // On Android the webview draws under the cutout, so this bar rendered beneath
        // the camera and the clock: the logo, "Admin" and the refresh control were all
        // partly hidden (reported on a real device, 2026-08-08). Same fix as V2Nav uses;
        // it resolves to 0px on the web and in a browser tab, so nothing else moves.
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.625rem)" }}
        className="flex items-center justify-between gap-3 border-b border-ch-line bg-ch-card px-4 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <BrandMark size={28} />
            <span className="font-ch-display text-[19px] font-extrabold tracking-[-.025em] whitespace-nowrap">
              CampHawk
            </span>
          </Link>
          <span className="text-ch-meta font-bold text-ch-muted">Admin</span>
        </div>
        <div className="flex items-center gap-4">
          <AdminAutoRefresh intervalMs={30000} />
          <Link href="/" className="text-ch-body font-bold text-ch-muted hover:text-ch-green-deep">
            ← Back to site
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <AdminTabs data={data} />
        <p className="mt-8 text-center text-ch-fine text-ch-muted">
          Live figures from the CampHawk database · auto-refreshes every 30s
        </p>
      </main>
    </div>
  );
}

