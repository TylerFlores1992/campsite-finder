'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import BetaTesters from '@/components/BetaTesters';
import CostsPanel from '@/components/admin/CostsPanel';
import type { CostItem, UsageCounts } from '@/lib/costs';

/**
 * Admin dashboard, in the redesign's ch-* system.
 *
 * NOTHING WAS REMOVED. Every figure the old page showed is still here — a
 * restyle that quietly drops metrics is just a smaller dashboard.
 *
 * The one structural addition is the STATUS BANNER. Previously you had to open
 * the System Health tab to find out the poller had stopped, which is exactly
 * backwards: "is anything broken right now" is the question this page exists to
 * answer, and it was a click away from the answer. The banner derives its state
 * from the same worker/canary/sync data that tab shows, names the specific
 * problem rather than counting problems, and jumps to the detail.
 *
 * Colour is used sparingly and consistently: green healthy, ochre
 * degraded-but-working, red broken. That's the ch-* Tag vocabulary the rest of
 * the app already uses, so the dashboard reads the way the product does.
 */

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
  /** ALL-TIME alert counts, for lifetime spend. Distinct from `usage` (this month). */
  lifetimeUsage: UsageCounts;
  monthLabel: string;
}

import {
  DELIVERY_STALE_SECONDS,
  DETECT_STALE_SECONDS,
  DELIVERY_DEAD_SECONDS,
  DETECT_DEAD_SECONDS,
} from '@/lib/health-thresholds';

const TABS = ['Overview', 'Users & Revenue', 'Engagement', 'System Health', 'Costs'] as const;
type Tab = (typeof TABS)[number];

type Level = 'ok' | 'warn' | 'fail';


/** A canary's state. Thresholds come from lib/health-thresholds — see the note there
 *  about the three copies that disagreed. */
function canaryLevel(c: CanaryRow): Level {
  const skipped = (c.detail ?? '').startsWith('skipped');
  const isDelivery = c.key.startsWith('delivery:');
  const staleAfter = isDelivery ? DELIVERY_STALE_SECONDS : DETECT_STALE_SECONDS;
  const deadAfter = isDelivery ? DELIVERY_DEAD_SECONDS : DETECT_DEAD_SECONDS;
  const age = c.age_s ?? 0;
  if (skipped) return 'warn';
  // One failure is a blip; two in a row is a problem.
  if (!c.ok && c.consecutive_failures < 2) return 'warn';
  if (!c.ok) return 'fail';
  // OVERDUE IS NOT FAILED — but STOPPED is. Late gets a warning, matching
  // /api/health/status; calling it "failing" put three red lines in the banner every
  // day for a healthy pipeline. Past the dead threshold it has not slipped, it has
  // stopped, and that earns the banner it was wrongly getting before.
  if (age > deadAfter) return 'fail';
  if (age > staleAfter) return 'warn';
  return 'ok';
}

function syncLevel(s: SyncRow): Level {
  if (!s.finished_at) return 'warn'; // in progress
  if ((s.facilities_synced ?? 0) === 0) return 'fail';
  return s.error ? 'warn' : 'ok';
}

/**
 * One sentence answering "is anything broken?".
 *
 * Names the failing thing rather than reporting "1 issue" — a count still needs
 * a click to be useful, and not needing one is the point.
 */
function overallStatus(data: AdminData): { level: Level; headline: string; detail: string } {
  const problems: string[] = [];
  // Canaries are few and each names a distinct failure, so they're listed.
  const canaryWarnings: string[] = [];
  // Syncs are MANY — one per state per provider — and a partial sync is routine.
  // Listing them produced a banner naming fifteen sources, which is a wall of
  // text that says less than a count does. They're aggregated.
  let syncWarnings = 0;

  if (!data.workerHealthy) {
    problems.push(
      data.beat
        ? `the poller last checked in ${Math.round(data.beat.age_s / 60)} min ago`
        : 'the poller has never checked in'
    );
  }
  for (const c of data.canaryRows) {
    const lvl = canaryLevel(c);
    if (lvl === 'fail') problems.push(`${c.key} is failing`);
    else if (lvl === 'warn') canaryWarnings.push(c.key);
  }
  for (const sy of data.syncRows) {
    const lvl = syncLevel(sy);
    if (lvl === 'fail') problems.push(`the ${sy.source} sync returned nothing`);
    else if (lvl === 'warn' && sy.error) syncWarnings++;
  }

  if (problems.length) {
    return {
      level: 'fail',
      headline:
        problems.length === 1 ? 'Something needs attention' : `${problems.length} things need attention`,
      // Even the failure list gets capped. Ten named failures is a wall too.
      detail: `${summarise(problems, 3)}.`,
    };
  }

  const parts: string[] = [];
  if (canaryWarnings.length) parts.push(summarise(canaryWarnings, 3));
  if (syncWarnings) {
    parts.push(
      `${syncWarnings} catalog ${syncWarnings === 1 ? 'sync' : 'syncs'} finished with warnings`
    );
  }

  if (parts.length) {
    return {
      level: 'warn',
      headline: 'Running, with warnings',
      // A partial sync means rows landed and some records errored — normal for
      // the per-state providers, and not something to act on at a glance. Say
      // that, so the banner doesn't read as an outage every single day.
      detail: `${parts.join('; ')}. Nothing is down and alerts are going out — open System Health for the detail.`,
    };
  }

  return {
    level: 'ok',
    headline: 'All systems normal',
    detail: data.beat
      ? `Poller checked in ${data.beat.age_s}s ago, ${data.beat.watches_checked} watches per cycle.`
      : 'Every check is reporting healthy.',
  };
}

/** "a, b and 4 more" — a banner has to stay one readable sentence. */
function summarise(items: string[], max: number): string {
  if (items.length <= max) {
    return items.length > 1
      ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
      : (items[0] ?? '');
  }
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

const LEVEL_STYLE: Record<Level, { box: string; text: string }> = {
  ok: { box: 'border-[#BFDDC9] bg-ch-green-soft', text: 'text-ch-green-deep' },
  warn: { box: 'border-[#E7C98C] bg-ch-ochre-soft', text: 'text-ch-ochre-ink' },
  fail: { box: 'border-[#E7BFB4] bg-ch-alert-soft', text: 'text-ch-alert-deep' },
};

export default function AdminTabs({ data }: { data: AdminData }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const mrrCents = data.mrr ? Math.round(data.mrr.monthly * 100) : null;
  const status = overallStatus(data);
  const style = LEVEL_STYLE[status.level];

  return (
    <div className="font-ch-body text-ch-ink">
      {/* Status above the tabs — it's true regardless of which tab you're on,
          and it's the reason most visits to this page happen. */}
      <div className={`mb-5 flex items-start gap-3 rounded-ch-card border p-4 ${style.box}`}>
        {status.level === 'ok' ? (
          <CheckCircle2 aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${style.text}`} />
        ) : (
          <AlertTriangle aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${style.text}`} />
        )}
        <div className="min-w-0">
          <p className={`font-ch-display text-ch-h font-bold ${style.text}`}>{status.headline}</p>
          <p className={`mt-0.5 text-ch-meta leading-normal opacity-90 ${style.text}`}>
            {status.detail}
          </p>
          {status.level !== 'ok' && tab !== 'System Health' && (
            <button
              onClick={() => setTab('System Health')}
              className={`mt-1.5 cursor-pointer text-ch-meta font-bold underline underline-offset-2 ${style.text}`}
            >
              Open System Health
            </button>
          )}
        </div>
      </div>

      <div className="mb-5 overflow-x-auto border-b border-ch-line">
        <nav className="flex min-w-max gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-current={tab === t ? 'page' : undefined}
              className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-ch-body font-bold whitespace-nowrap transition-colors ${
                tab === t
                  ? 'border-ch-green text-ch-green-deep'
                  : 'border-transparent text-ch-muted hover:border-ch-line hover:text-ch-ink-2'
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
          lifetimeUsage={data.lifetimeUsage}
          mrrCents={mrrCents}
          monthLabel={data.monthLabel}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Overview */

function OverviewPanel({ data }: { data: AdminData }) {
  const { clerkTotal, usersAgg, activeSub, subMap, watchAgg, alertAgg, mrr } = data;
  return (
    <div className="space-y-4">
      {/* MRR promoted into the headline row. It was on a second tab, and "how
          much are we making" belongs beside "how many users are there". */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label="MRR"
          value={mrr ? `$${mrr.monthly.toFixed(2)}` : '—'}
          sub={mrr ? `${mrr.activeCount} paying` : 'Stripe unavailable'}
          accent="green"
        />
        <Kpi
          label="Users"
          value={(clerkTotal ?? usersAgg.total).toLocaleString()}
          sub={`+${usersAgg.new_7d} this week`}
        />
        <Kpi
          label="Subscribers"
          value={activeSub.n.toLocaleString()}
          sub={`${subMap['trialing'] ?? 0} on trial`}
        />
        <Kpi
          label="Active watches"
          value={watchAgg.active.toLocaleString()}
          sub={`${watchAgg.watchers} watchers`}
        />
        <Kpi
          label="Alerts sent"
          value={alertAgg.sent.toLocaleString()}
          sub={`+${alertAgg.sent_7d} this week`}
        />
      </div>
      <SignupsChart data={data} />
      <QuickLinks />
    </div>
  );
}

/* -------------------------------------------------------- Users & Revenue */

function UsersRevenuePanel({ data }: { data: AdminData }) {
  const { mrr, subMap, usersAgg } = data;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <SignupsChart data={data} />
        </div>
        <Panel title="Subscriptions">
          <p className="font-ch-display text-[28px] font-extrabold text-ch-green-deep">
            {mrr ? `$${mrr.monthly.toFixed(2)}` : '—'}
            <span className="text-ch-body font-normal text-ch-muted"> /mo</span>
          </p>
          <p className="mb-4 text-ch-fine text-ch-muted">
            {mrr ? `${mrr.activeCount} paying · normalised monthly` : 'Stripe unavailable'}
          </p>
          <ul>
            <StatusRow label="Active" value={subMap['active'] ?? 0} dot="bg-ch-green" />
            <StatusRow label="Trialing" value={subMap['trialing'] ?? 0} dot="bg-ch-blue" />
            <StatusRow label="Past due" value={subMap['past_due'] ?? 0} dot="bg-ch-ochre" />
            <StatusRow label="Canceled" value={subMap['canceled'] ?? 0} dot="bg-ch-faint" />
          </ul>
          <a
            href="https://dashboard.stripe.com/subscriptions"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1 text-ch-meta font-bold text-ch-green hover:text-ch-green-deep"
          >
            Revenue &amp; cash flow in Stripe
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </Panel>
      </div>
      <p className="text-ch-fine text-ch-muted">
        {`${usersAgg.new_30d.toLocaleString()} new users in the last 30 days.`}
      </p>
      <BetaTesters />
    </div>
  );
}

/* -------------------------------------------------------------- Engagement */

function EngagementPanel({ data }: { data: AdminData }) {
  const { cgTotal, watchAgg, alertAgg, cgRows } = data;
  const failRate = alertAgg.sent > 0 ? (alertAgg.failed / alertAgg.sent) * 100 : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Campgrounds synced" value={cgTotal.toLocaleString()} />
        <Kpi label="Watches created" value={watchAgg.total.toLocaleString()} sub="all time" />
        <Kpi label="Alerts sent" value={alertAgg.sent.toLocaleString()} sub="all time" />
        {/* A raw failure count means nothing without the denominator — 40 out of
            80 and 40 out of 40,000 are very different mornings. */}
        <Kpi
          label="Failed alerts"
          value={alertAgg.failed.toLocaleString()}
          sub={alertAgg.sent > 0 ? `${failRate.toFixed(1)}% of sends` : 'no sends yet'}
          accent={failRate > 2 ? 'alert' : undefined}
        />
      </div>
      {cgRows.length > 0 && (
        <Panel title="Campgrounds by source">
          <div className="flex flex-wrap gap-1.5">
            {cgRows.map((r) => (
              <span
                key={r.source}
                className="rounded-ch-chip border border-ch-line px-3 py-1.5 text-ch-meta text-ch-ink-2"
              >
                {`${r.source} · `}
                <span className="font-bold text-ch-ink">{r.n.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- System Health */

function SystemHealthPanel({ data }: { data: AdminData }) {
  const { beat, workerHealthy, canaryRows, syncRows } = data;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel title="Poller worker">
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full ${workerHealthy ? 'bg-ch-green' : 'bg-ch-alert'}`} />
          <span className="text-ch-body font-bold">
            {workerHealthy ? 'Healthy' : beat ? 'Stale' : 'No heartbeat'}
          </span>
        </div>
        <p className="mt-1 text-ch-meta leading-normal text-ch-muted">
          {beat
            ? workerHealthy
              ? `Last beat ${beat.age_s}s ago · ${beat.watches_checked} watches per cycle`
              : `Last beat ${Math.round(beat.age_s / 60)} minutes ago — alerts are not going out`
            : 'The worker has never recorded a heartbeat.'}
        </p>

        <h3 className="mt-4 mb-1.5 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
          Alert canary
        </h3>
        {canaryRows.length === 0 && (
          <p className="text-ch-fine text-ch-muted">No canary runs recorded.</p>
        )}
        <ul>
          {canaryRows.map((c) => {
            const lvl = canaryLevel(c);
            const dot = lvl === 'ok' ? 'bg-ch-green' : lvl === 'warn' ? 'bg-ch-ochre' : 'bg-ch-alert';
            const age =
              c.age_s == null ? 'never' : c.age_s < 90 ? `${c.age_s}s` : `${Math.round(c.age_s / 60)}m`;
            return (
              <li
                key={c.key}
                className="flex items-center justify-between gap-2 border-b border-ch-line py-1.5 last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-2 text-ch-meta text-ch-ink-2">
                  <span className={`size-2 shrink-0 rounded-full ${dot}`} />
                  <span className="truncate">{c.key}</span>
                </span>
                <span className="shrink-0 text-ch-meta text-ch-muted" title={c.detail ?? undefined}>
                  {age}
                  {c.consecutive_failures > 0 ? ` · ${c.consecutive_failures} fails` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Catalog sync">
        {syncRows.length === 0 && (
          <p className="text-ch-fine text-ch-muted">No sync runs recorded.</p>
        )}
        <ul>
          {syncRows.map((s) => {
            const lvl = syncLevel(s);
            const dot = lvl === 'ok' ? 'bg-ch-green' : lvl === 'warn' ? 'bg-ch-ochre' : 'bg-ch-alert';
            const synced = s.facilities_synced ?? 0;
            const errCount = s.metadata?.totalErrors ?? null;
            const stamp = s.finished_at ? new Date(s.finished_at).toLocaleString() : null;
            return (
              <li
                key={s.source}
                className="flex items-center justify-between gap-2 border-b border-ch-line py-1.5 last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-2 text-ch-meta text-ch-ink-2">
                  <span className={`size-2 shrink-0 rounded-full ${dot}`} />
                  <span className="truncate">{s.source}</span>
                </span>
                <span className="shrink-0 text-ch-meta text-ch-muted" title={s.error ?? undefined}>
                  {!stamp
                    ? 'in progress'
                    : lvl === 'fail'
                      ? `failed · ${stamp}`
                      : `${synced.toLocaleString()} rows · ${stamp}${
                          lvl === 'warn' ? ` · ${errCount ?? 'some'} warnings` : ''
                        }`}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------ shared components */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <h2 className="mb-3 font-ch-display text-ch-h font-bold">{title}</h2>
      {children}
    </div>
  );
}

function SignupsChart({ data }: { data: AdminData }) {
  const { days, maxDay, usersAgg } = data;
  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-ch-display text-ch-h font-bold">New users · last 30 days</h2>
        <span className="text-ch-meta text-ch-muted">{usersAgg.new_30d} total</span>
      </div>
      <div className="flex h-28 items-end gap-[3px]">
        {days.map((d) => (
          // h-full matters: with only `items-end` the column is content-sized,
          // so the bar's percentage height resolved against `auto` and every bar
          // computed to zero. The chart has been rendering blank.
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div
              // Solid token, no /alpha modifier: the opacity form rendered the
              // bars invisible, which made an empty chart look like no signups.
              className="w-full rounded-t bg-ch-green transition-colors group-hover:bg-ch-green-deep"
              style={{ height: `${Math.max(2, (d.n / maxDay) * 100)}%` }}
              title={`${d.day}: ${d.n}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-ch-fine text-ch-muted">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

function QuickLinks() {
  // Grouped, because twelve equal tiles is a wall you have to read every time.
  // Money first (opened most), then the things you open at 2am, then the rest.
  const groups: Array<[string, Array<[string, string, string]>]> = [
    [
      'Money',
      [
        ['https://dashboard.stripe.com', 'Stripe', 'Revenue · MRR · payouts'],
        ['https://console.twilio.com', 'Twilio', 'SMS · delivery · A2P'],
      ],
    ],
    [
      'When something breaks',
      [
        ['https://fly.io/apps/campsite-finder-worker', 'Fly.io', 'Poller worker · logs'],
        ['https://camphawk.sentry.io/issues', 'Sentry', 'Errors · crashes'],
        ['https://supabase.com/dashboard', 'Supabase', 'Database · SQL'],
        ['https://vercel.com/dashboard', 'Vercel', 'Deploys · Web Vitals'],
      ],
    ],
    [
      'Everything else',
      [
        ['https://dashboard.clerk.com', 'Clerk', 'User accounts'],
        ['https://resend.com/emails', 'Resend', 'Email delivery'],
        ['https://dash.cloudflare.com', 'Cloudflare', 'DNS · broker tunnel'],
        ['https://search.google.com/search-console', 'Search Console', 'Indexing · queries'],
        ['https://account.mapbox.com', 'Mapbox', 'Maps · usage'],
        ['https://ridb.recreation.gov/profile', 'RIDB', 'Recreation.gov API'],
        ['https://github.com/TylerFlores1992/campsite-finder', 'GitHub', 'Code · deploys'],
      ],
    ],
  ];
  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <h2 className="mb-3 font-ch-display text-ch-h font-bold">Open the deep dashboards</h2>
      <div className="space-y-4">
        {groups.map(([heading, links]) => (
          <div key={heading}>
            <h3 className="mb-2 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
              {heading}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {links.map(([href, label, desc]) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-ch-input border border-ch-line p-2.5 transition-colors hover:border-ch-green hover:bg-ch-green-soft"
                >
                  <p className="flex items-center gap-1 text-ch-body font-bold text-ch-ink">
                    {label}
                    <ExternalLink aria-hidden="true" className="size-3 text-ch-muted" />
                  </p>
                  <p className="mt-0.5 text-ch-fine text-ch-muted">{desc}</p>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
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
  value: string;
  sub?: string;
  accent?: 'green' | 'alert';
}) {
  const color =
    accent === 'green' ? 'text-ch-green-deep' : accent === 'alert' ? 'text-ch-alert' : 'text-ch-ink';
  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <p className="text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">{label}</p>
      <p className={`mt-1 font-ch-display text-[26px] leading-none font-extrabold ${color}`}>
        {value}
      </p>
      {sub && <p className="mt-1.5 text-ch-fine text-ch-muted">{sub}</p>}
    </div>
  );
}

function StatusRow({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <li className="flex items-center gap-2 border-b border-ch-line py-1.5 last:border-b-0">
      <span className={`size-2.5 rounded-full ${dot}`} />
      <span className="flex-1 text-ch-body text-ch-ink-2">{label}</span>
      <span className="text-ch-body font-bold text-ch-ink">{value.toLocaleString()}</span>
    </li>
  );
}
