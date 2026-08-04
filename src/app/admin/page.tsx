import { clerkClient } from '@clerk/nextjs/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Stripe from 'stripe';
import BrandMark from '@/components/v2/BrandMark';
import AdminAutoRefresh from '@/components/AdminAutoRefresh';
import AdminTabs, { type AdminData } from '@/components/admin/AdminTabs';
import { query, queryOne } from '@/lib/db/client';
import type { CostItem, UsageCounts } from '@/lib/costs';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Admin — CampHawk',
  robots: { index: false, follow: false },
};


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

  const [usersAgg, signupRows, seriesRows, subRows, activeSub, watchAgg, alertAgg, cgRows, beat, syncRows, canaryRows, costItems, usageRows, lifetimeUsageRows] =
    await Promise.all([
      safe(
        queryOne<{ total: number; new_7d: number; new_30d: number }>(
          `SELECT count(*)::int total,
                  count(*) FILTER (WHERE created_at > now() - interval '7 days')::int new_7d,
                  count(*) FILTER (WHERE created_at > now() - interval '30 days')::int new_30d
           FROM users`
        ),
        { total: 0, new_7d: 0, new_30d: 0 }
      ),
      safe(
        query<{ d: string; n: number }>(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, count(*)::int AS n
           FROM users WHERE created_at > now() - interval '30 days'
           GROUP BY 1 ORDER BY 1`
        ),
        []
      ),
      // The other three daily series, for the chart's metric switcher. ONE query
      // rather than three round trips, and deliberately SEPARATE from the signups
      // query above so a failure here empties the switchable metrics rather than the
      // default one the page opens on.
      safe(
        query<{ metric: string; d: string; n: number }>(
          `SELECT 'watches' AS metric, to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, count(*)::int AS n
             FROM watches WHERE created_at > now() - interval '30 days' GROUP BY 2
           UNION ALL
           SELECT 'alerts', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(*)::int
             FROM notifications WHERE status = 'sent' AND created_at > now() - interval '30 days' GROUP BY 2
           UNION ALL
           SELECT 'subs', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), count(*)::int
             FROM subscriptions WHERE created_at > now() - interval '30 days' GROUP BY 2
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
                  count(DISTINCT user_id)::int watchers FROM watches`
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
    ]);

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

  // 30-day series, zero-filled off ONE date spine so every metric shares an x-axis —
  // a day with no rows must plot as 0, not vanish and shorten the line.
  const spine: string[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    spine.push(d.toISOString().slice(0, 10));
  }
  const fill = (rows: { d: string; n: number }[]) => {
    const byDay = new Map(rows.map((r) => [r.d, r.n]));
    return spine.map((day) => ({ day, n: byDay.get(day) ?? 0 }));
  };
  const pick = (metric: string) => seriesRows.filter((r) => r.metric === metric);
  const days = fill(signupRows);
  const series = {
    users: days,
    watches: fill(pick('watches')),
    alerts: fill(pick('alerts')),
    subs: fill(pick('subs')),
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
    activeSub,
    subMap,
    watchAgg,
    alertAgg,
    cgRows,
    cgTotal,
    days,
    series,
    mrr,
    beat,
    workerHealthy,
    canaryRows,
    syncRows,
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
      <header className="flex items-center justify-between gap-3 border-b border-ch-line bg-ch-card px-4 py-2.5">
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

