import { clerkClient } from '@clerk/nextjs/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Stripe from 'stripe';
import { HawkMark } from '@/components/Logo';
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

  const [usersAgg, signupRows, subRows, activeSub, watchAgg, alertAgg, cgRows, beat, syncRows, canaryRows, costItems, usageRows] =
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
        }>(
          `SELECT DISTINCT ON (source) source, finished_at::text, facilities_synced, error, metadata
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
          `SELECT id, label, category, monthly_cents, notes, sort_order
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

  // 30-day signups series, zero-filled.
  const byDay = new Map(signupRows.map((r) => [r.d, r.n]));
  const days: { day: string; n: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, n: byDay.get(key) ?? 0 });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.n));

  // Usage this month, keyed by channel, for the Costs tab.
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
    maxDay,
    mrr,
    beat,
    workerHealthy,
    canaryRows,
    syncRows,
    costItems: costItems as CostItem[],
    usage,
    monthLabel,
  };

  return (
    <div className="min-h-dvh bg-ch-paper font-ch-body text-ch-ink">
      {/* Compact on purpose. This used the marketing <Logo/> lockup, whose badge is
          sized 3.8em — about 68px next to a 30px mark — so the brand art plus the
          Admin chip took more vertical space than the status banner underneath it.
          /admin is an internal tool opened many times a day, not a landing page, so
          it gets the bare mark and a one-line title. */}
      <header className="flex items-center justify-between gap-3 border-b border-ch-line bg-ch-card px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="flex items-center gap-2 text-ch-ink hover:text-ch-green-deep"
            aria-label="CampHawk home"
          >
            <HawkMark size={22} className="shrink-0 text-ch-green-deep" />
            <span className="font-ch-display text-ch-body font-semibold tracking-tight">
              CampHawk
            </span>
          </Link>
          <span className="rounded-ch-chip border border-[#E7C98C] bg-ch-ochre-soft px-2 py-0.5 text-ch-label font-bold uppercase tracking-[.1em] text-ch-ochre-ink">
            Admin
          </span>
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

