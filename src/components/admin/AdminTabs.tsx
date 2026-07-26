'use client';

import { useState } from 'react';
import BetaTesters from '@/components/BetaTesters';
import CostsPanel from '@/components/admin/CostsPanel';
import type { CostItem, UsageCounts } from '@/lib/costs';

type Beat = { beat_at: string; watches_checked: number; age_s: number } | null;
type CanaryRow = { key: string; ok: boolean; age_s: number | null; consecutive_failures: number; detail: string | null };
type SyncRow = {
  source: string;
  finished_at: string | null;
  facilities_synced: number | null;
  error: string | null;
  metadata: { totalErrors?: number } | null;
};

export interface AdminData {
  clerkTotal: number | null;
  usersAgg: { total: number; new_7d: number; new_30d: number };
  activeSub: { n: number };
  subMap: Record<string, number>;
  watchAgg: { active: number; total: number; watchers: number };
  alertAgg: { sent: number; sent_7d: number; failed: number };
  cgRows: { source: string; n: number }[];
  cgTotal: number;
  days: { day: string; n: number }[];
  maxDay: number;
  mrr: { monthly: number; activeCount: number } | null;
  beat: Beat;
  workerHealthy: boolean;
  canaryRows: CanaryRow[];
  syncRows: SyncRow[];
  costItems: CostItem[];
  usage: UsageCounts;
  monthLabel: string;
}

const TABS = ['Overview', 'Users & Revenue', 'Engagement', 'System Health', 'Costs'] as const;
type Tab = (typeof TABS)[number];

export default function AdminTabs({ data }: { data: AdminData }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const mrrCents = data.mrr ? Math.round(data.mrr.monthly * 100) : null;

  return (
    <div>
      {/* Tab bar */}
      <div className="border-b border-gray-200 mb-6 overflow-x-auto">
        <nav className="flex gap-1 min-w-max">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                tab === t
                  ? 'border-green-600 text-green-700'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'Overview' && <OverviewPanel data={data} />}
      {tab === 'Users & Revenue' && <UsersRevenuePanel data={data} />}
      {tab === 'Engagement' && <EngagementPanel data={data} />}
      {tab === 'System Health' && <SystemHealthPanel data={data} />}
      {tab === 'Costs' && (
        <CostsPanel
          initialItems={data.costItems}
          usage={data.usage}
          mrrCents={mrrCents}
          monthLabel={data.monthLabel}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Overview */

function OverviewPanel({ data }: { data: AdminData }) {
  const { clerkTotal, usersAgg, activeSub, subMap, watchAgg, alertAgg } = data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Users" value={clerkTotal ?? usersAgg.total} sub={`${usersAgg.total} in app · +${usersAgg.new_7d} this week`} />
        <Kpi label="Active subscribers" value={activeSub.n} sub={`${subMap['trialing'] ?? 0} on trial`} accent="green" />
        <Kpi label="Active watches" value={watchAgg.active} sub={`${watchAgg.watchers} watchers`} />
        <Kpi label="Alerts sent" value={alertAgg.sent} sub={`+${alertAgg.sent_7d} this week`} accent="amber" />
      </div>
      <SignupsChart data={data} />
      <WorkerStrip data={data} />
      <QuickLinks />
    </div>
  );
}

/* -------------------------------------------------------- Users & Revenue */

function UsersRevenuePanel({ data }: { data: AdminData }) {
  const { mrr, subMap, usersAgg } = data;
  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <SignupsChart data={data} />
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
      </div>
      <p className="text-xs text-gray-400">{usersAgg.new_30d} new users in the last 30 days.</p>
      <BetaTesters />
    </div>
  );
}

/* -------------------------------------------------------------- Engagement */

function EngagementPanel({ data }: { data: AdminData }) {
  const { cgTotal, watchAgg, alertAgg, cgRows } = data;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="font-display font-semibold text-gray-800 mb-4">Content &amp; engagement</h2>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <Metric label="Campgrounds synced" value={cgTotal.toLocaleString()} />
        <Metric label="Total watches" value={watchAgg.total.toLocaleString()} />
        <Metric label="Alerts (all time)" value={alertAgg.sent.toLocaleString()} />
        <Metric label="Failed alerts" value={alertAgg.failed.toLocaleString()} />
      </dl>
      {cgRows.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">Campgrounds by source</p>
          <div className="flex flex-wrap gap-2">
            {cgRows.map((r) => (
              <span key={r.source} className="text-xs bg-gray-50 border border-gray-200 rounded-full px-3 py-1 text-gray-600">
                {r.source} · <span className="font-semibold text-gray-800">{r.n.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- System Health */

function SystemHealthPanel({ data }: { data: AdminData }) {
  const { beat, workerHealthy, canaryRows, syncRows } = data;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="font-display font-semibold text-gray-800 mb-4">Worker &amp; canary</h2>
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
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Alert canary</p>
          {canaryRows.length === 0 && <p className="text-gray-400 text-xs">No canary runs recorded.</p>}
          {canaryRows.map((c) => {
            const skipped = (c.detail ?? '').startsWith('skipped');
            const staleS = c.key.startsWith('delivery:') ? 7 * 3600 : 600;
            const stale = c.age_s != null && c.age_s > staleS;
            const color =
              skipped || (!c.ok && c.consecutive_failures < 2)
                ? 'bg-amber-500'
                : c.ok && !stale
                  ? 'bg-green-500'
                  : 'bg-red-500';
            const ageLabel = c.age_s == null ? 'never' : c.age_s < 90 ? `${c.age_s}s` : `${Math.round(c.age_s / 60)}m`;
            return (
              <div key={c.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-gray-600">
                  <span className={`h-2 w-2 rounded-full ${color}`} />
                  {c.key}
                </span>
                <span className="text-gray-500 truncate max-w-[60%]" title={c.detail ?? undefined}>
                  {ageLabel}
                  {c.consecutive_failures > 0 ? ` · ${c.consecutive_failures}✗` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="font-display font-semibold text-gray-800 mb-4">Catalog sync</h2>
        <div className="space-y-1.5 text-sm">
          {syncRows.length === 0 && <p className="text-gray-400 text-xs">No sync runs recorded.</p>}
          {syncRows.map((s) => {
            const synced = s.facilities_synced ?? 0;
            const errCount = s.metadata?.totalErrors ?? null;
            const stamp = s.finished_at ? new Date(s.finished_at).toLocaleString() : null;
            if (!stamp) {
              return (
                <div key={s.source} className="flex items-center justify-between">
                  <span className="text-gray-600">{s.source}</span>
                  <span className="text-gray-500">in progress</span>
                </div>
              );
            }
            const failed = synced === 0;
            const partial = !failed && !!s.error;
            return (
              <div key={s.source} className="flex items-center justify-between">
                <span className="text-gray-600">{s.source}</span>
                <span
                  className={failed ? 'text-red-600' : partial ? 'text-amber-600' : 'text-gray-500'}
                  title={s.error ?? undefined}
                >
                  {failed ? `failed · ${stamp}` : `${stamp} · ${synced}${partial ? ` · ${errCount ?? 'some'} warnings` : ''}`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ shared components */

function SignupsChart({ data }: { data: AdminData }) {
  const { days, maxDay, usersAgg } = data;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
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
  );
}

function WorkerStrip({ data }: { data: AdminData }) {
  const { workerHealthy, beat } = data;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${workerHealthy ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className="font-medium text-gray-700">Poller worker</span>
      <span className="text-gray-500">
        {beat
          ? workerHealthy
            ? `healthy · last beat ${beat.age_s}s ago`
            : `STALE · ${Math.round(beat.age_s / 60)} min`
          : 'no heartbeat'}
      </span>
      <span className="text-gray-300">— see System Health for details</span>
    </div>
  );
}

function QuickLinks() {
  const links = [
    ['https://console.twilio.com', 'Twilio', 'SMS · delivery · A2P'],
    ['https://dashboard.stripe.com', 'Stripe', 'Revenue · MRR · payouts'],
    ['https://supabase.com/dashboard', 'Supabase', 'Database · SQL'],
    ['https://fly.io/apps/campsite-finder-worker', 'Fly.io', 'Poller worker · logs'],
    ['https://resend.com/emails', 'Resend', 'Email delivery'],
    ['https://dashboard.clerk.com', 'Clerk', 'User accounts'],
    ['https://camphawk.sentry.io/issues', 'Sentry', 'Errors · crashes'],
    ['https://vercel.com/dashboard', 'Vercel', 'Deploys · Web Vitals'],
    ['https://dash.cloudflare.com', 'Cloudflare', 'DNS · broker tunnel'],
    ['https://github.com/TylerFlores1992/campsite-finder', 'GitHub', 'Code · deploys'],
    ['https://account.mapbox.com', 'Mapbox', 'Maps · usage'],
    ['https://ridb.recreation.gov/profile', 'RIDB', 'Recreation.gov API'],
  ];
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="font-display font-semibold text-gray-800 mb-4">Open the deep dashboards</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {links.map(([href, label, desc]) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-gray-200 p-3 hover:border-green-400 hover:bg-green-50/40 transition-colors"
          >
            <p className="font-display font-semibold text-gray-800 text-sm">{label}</p>
            <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: 'green' | 'amber' }) {
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
