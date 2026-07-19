import { currentUser, clerkClient } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Stripe from 'stripe';
import Logo from '@/components/Logo';
import AdminAutoRefresh from '@/components/AdminAutoRefresh';
import BetaTesters from '@/components/BetaTesters';
import { query, queryOne } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Admin — CampHawk',
  robots: { index: false, follow: false },
};

// Owner-only. Override/extend via ADMIN_EMAILS (comma-separated) in env.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'tylerflores1992@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  // 404 (not 403) for non-admins so the page's existence isn't revealed.
  if (!email || !ADMIN_EMAILS.includes(email)) notFound();

  const [usersAgg, signupRows, subRows, activeSub, watchAgg, alertAgg, cgRows, beat, syncRows] =
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
        query<{ source: string; finished_at: string | null; facilities_synced: number | null; error: string | null }>(
          `SELECT DISTINCT ON (source) source, finished_at::text, facilities_synced, error
           FROM sync_log ORDER BY source, started_at DESC`
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

  return (
    <div className="min-h-screen bg-[#F3EFE0]">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/"><Logo markSize={30} /></Link>
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            Admin
          </span>
        </div>
        <div className="flex items-center gap-4">
          <AdminAutoRefresh intervalMs={30000} />
          <Link href="/" className="text-sm text-gray-500 hover:text-green-700">← Back to site</Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* KPI row */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi
            label="Users"
            value={clerkTotal ?? usersAgg.total}
            sub={`${usersAgg.total} active in app · +${usersAgg.new_7d} this week`}
          />
          <Kpi label="Active subscribers" value={activeSub.n} sub={`${subMap['trialing'] ?? 0} on trial`} accent="green" />
          <Kpi label="Active watches" value={watchAgg.active} sub={`${watchAgg.watchers} watchers`} />
          <Kpi label="Alerts sent" value={alertAgg.sent} sub={`+${alertAgg.sent_7d} this week`} accent="amber" />
        </section>

        {/* Signups chart + subscriptions */}
        <section className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-display font-semibold text-gray-800">New users · last 30 days</h2>
              <span className="text-sm text-gray-500">{usersAgg.new_30d} total</span>
            </div>
            <div className="flex items-end gap-[3px] h-28">
              {days.map((d) => (
                <div key={d.day} className="flex-1 group relative flex items-end">
                  <div
                    className="w-full rounded-t bg-green-500/80 group-hover:bg-green-600 transition-colors"
                    style={{ height: `${Math.max(2, (d.n / maxDay) * 100)}%` }}
                    title={`${d.day}: ${d.n}`}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2 text-[11px] text-gray-400">
              <span>{days[0]?.day.slice(5)}</span>
              <span>{days[days.length - 1]?.day.slice(5)}</span>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-display font-semibold text-gray-800">Subscriptions</h2>
            <p className="mt-1 font-display text-3xl font-extrabold text-green-700">
              {mrr ? `$${mrr.monthly.toFixed(2)}` : '—'}
              <span className="text-sm font-normal text-gray-400"> /mo MRR</span>
            </p>
            <p className="text-xs text-gray-400 mb-4">
              {mrr ? `${mrr.activeCount} paying · normalized monthly` : 'Stripe unavailable'}
            </p>
            <ul className="space-y-2.5 text-sm">
              <StatusRow label="Active" value={subMap['active'] ?? 0} color="bg-green-500" />
              <StatusRow label="Trialing" value={subMap['trialing'] ?? 0} color="bg-blue-500" />
              <StatusRow label="Past due" value={subMap['past_due'] ?? 0} color="bg-amber-500" />
              <StatusRow label="Canceled" value={subMap['canceled'] ?? 0} color="bg-gray-400" />
            </ul>
            <a
              href="https://dashboard.stripe.com/subscriptions"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-xs font-medium text-green-700 hover:text-green-800"
            >
              Revenue &amp; cash flow in Stripe →
            </a>
          </div>
        </section>

        {/* Engagement + system health */}
        <section className="grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-display font-semibold text-gray-800 mb-4">Content &amp; engagement</h2>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <Metric label="Campgrounds synced" value={cgTotal.toLocaleString()} />
              <Metric label="Total watches" value={watchAgg.total.toLocaleString()} />
              <Metric label="Alerts (all time)" value={alertAgg.sent.toLocaleString()} />
              <Metric label="Failed alerts" value={alertAgg.failed.toLocaleString()} />
            </dl>
            {cgRows.length > 0 && (
              <p className="mt-4 text-xs text-gray-400">
                {cgRows.map((r) => `${r.n.toLocaleString()} ${r.source}`).join(' · ')}
              </p>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-display font-semibold text-gray-800 mb-4">System health</h2>
            <div className="flex items-center gap-2 text-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${workerHealthy ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="font-medium text-gray-700">Poller worker</span>
              <span className="text-gray-500">
                {beat
                  ? workerHealthy
                    ? `healthy · last beat ${beat.age_s}s ago · ${beat.watches_checked} watches/cycle`
                    : `STALE · last beat ${Math.round(beat.age_s / 60)} min ago`
                  : 'no heartbeat recorded'}
              </span>
            </div>
            <div className="mt-4 space-y-1.5 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Last sync</p>
              {syncRows.length === 0 && <p className="text-gray-400 text-xs">No sync runs recorded.</p>}
              {syncRows.map((s) => (
                <div key={s.source} className="flex items-center justify-between">
                  <span className="text-gray-600">{s.source}</span>
                  <span className={s.error ? 'text-red-600' : 'text-gray-500'}>
                    {s.error ? 'failed' : s.finished_at ? `${new Date(s.finished_at).toLocaleString()} · ${s.facilities_synced ?? 0}` : 'in progress'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Beta testers */}
        <section>
          <BetaTesters />
        </section>

        {/* Quick links */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-display font-semibold text-gray-800 mb-4">Open the deep dashboards</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <QuickLink href="https://console.twilio.com" label="Twilio" desc="SMS · delivery · A2P" />
            <QuickLink href="https://dashboard.stripe.com" label="Stripe" desc="Revenue · MRR · payouts" />
            <QuickLink href="https://supabase.com/dashboard" label="Supabase" desc="Database · SQL" />
            <QuickLink href="https://fly.io/apps/campsite-finder-worker" label="Fly.io" desc="Poller worker · logs" />
            <QuickLink href="https://resend.com/emails" label="Resend" desc="Email delivery" />
            <QuickLink href="https://dashboard.clerk.com" label="Clerk" desc="User accounts" />
            <QuickLink href="https://camphawk.sentry.io/issues" label="Sentry" desc="Errors · crashes" />
            <QuickLink href="https://vercel.com/dashboard" label="Vercel" desc="Deploys · Web Vitals" />
            <QuickLink href="https://dash.cloudflare.com" label="Cloudflare" desc="DNS · broker tunnel" />
            <QuickLink href="https://github.com/TylerFlores1992/campsite-finder" label="GitHub" desc="Code · deploys" />
            <QuickLink href="https://account.mapbox.com" label="Mapbox" desc="Maps · usage" />
            <QuickLink href="https://ridb.recreation.gov/profile" label="RIDB" desc="Recreation.gov API" />
          </div>
        </section>

        <p className="text-center text-xs text-gray-400">
          Live figures from the CampHawk database · refresh to update
        </p>
      </main>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: 'green' | 'amber';
}) {
  const color = accent === 'green' ? 'text-green-700' : accent === 'amber' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`mt-1 font-display text-3xl font-extrabold ${color}`}>{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function StatusRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <span className="text-gray-600 flex-1">{label}</span>
      <span className="font-semibold text-gray-900">{value.toLocaleString()}</span>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className="font-display text-xl font-bold text-gray-900">{value}</dd>
    </div>
  );
}

function QuickLink({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-xl border border-gray-200 p-3 hover:border-green-400 hover:bg-green-50/40 transition-colors"
    >
      <p className="font-display font-semibold text-gray-800 text-sm">{label}</p>
      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
    </a>
  );
}
