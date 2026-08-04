'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import BetaTesters from '@/components/BetaTesters';
import CostsPanel from '@/components/admin/CostsPanel';
import MetricChart, {
  MetricSwitcher,
  RangeSwitcher,
  METRICS,
  metricDef,
  type MetricKey,
  type RangeKey,
  type SeriesKey,
} from '@/components/admin/MetricChart';
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
  /** Seconds since finished_at, computed by Postgres — see the note in admin/page.tsx. */
  age_s: number | null;
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
  /**
   * RAW all-time daily counts per series, ascending. The chart buckets these to the
   * selected range — see MetricChart.bucket().
   */
  series: Record<SeriesKey, { day: string; n: number }[]>;
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

/**
 * Fraction of a source's campgrounds that may fail before it is worth looking at.
 *
 * ANY error used to mean "warn", which made 19 of 35 sources warn and the banner say
 * "19 catalog syncs finished with warnings" every day. One skipped campground out of
 * forty is not a problem — providers rate-limit individual facilities constantly, and
 * the next run picks them up. Flagging it anyway buried the sources that genuinely
 * lost a big share: Recreation.gov at 1,051 of 5,519, Virginia at 83 of 276.
 */
const SYNC_SKIP_TOLERANCE = 0.1;

function syncLevel(s: SyncRow): Level {
  if (!s.finished_at) return 'warn'; // in progress
  const synced = s.facilities_synced ?? 0;
  if (synced === 0) return 'fail'; // nothing landed — this source is absent from search
  const skipped = s.metadata?.totalErrors ?? 0;
  if (!skipped) return 'ok';
  return skipped / (synced + skipped) >= SYNC_SKIP_TOLERANCE ? 'warn' : 'ok';
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
      // "finished with warnings" tells you nothing about whether to care. What
      // actually happened is that some individual campgrounds could not be read —
      // usually a provider rate-limiting us mid-sync — so they are missing from
      // SEARCH until the next run. Naming that is the difference between a line you
      // can act on and one you learn to scroll past.
      `${syncWarnings} ${syncWarnings === 1 ? 'source' : 'sources'} skipped some campgrounds`
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
  // Shared so switching tabs keeps the metric you were looking at — the two tabs
  // render the SAME chart, and having it silently reset would look like a bug.
  const [metric, setMetric] = useState<MetricKey>('users_total');
  // Range is shared too: it scopes the same chart on both tabs.
  const [range, setRange] = useState<RangeKey>('30d');
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

      {/* WRAPS, never scrolls. `overflow-x-auto` + `min-w-max` put a horizontal
          scrollbar under the tabs on narrower windows — a scroll affordance for five
          short words, and the only scrollbar on the page that wasn't the window's. */}
      <div className="mb-5 border-b border-ch-line">
        <nav className="flex flex-wrap gap-1">
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

      {tab === 'Overview' && (
        <OverviewPanel
          data={data}
          metric={metric}
          onMetricChange={setMetric}
          range={range}
          onRangeChange={setRange}
        />
      )}
      {tab === 'Users & Revenue' && (
        <UsersRevenuePanel
          data={data}
          metric={metric}
          onMetricChange={setMetric}
          range={range}
          onRangeChange={setRange}
        />
      )}
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

function OverviewPanel({
  data,
  metric,
  onMetricChange,
  range,
  onRangeChange,
}: {
  data: AdminData;
  metric: MetricKey;
  onMetricChange: (k: MetricKey) => void;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
}) {
  const { clerkTotal, usersAgg, activeSub, subMap, watchAgg, alertAgg, mrr } = data;
  const def = metricDef(metric);
  const rows = data.series?.[def.series] ?? [];
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
          metric="users_total"
          selected={def.series === 'users'}
          onSelect={onMetricChange}
        />
        <Kpi
          label="Subscribers"
          value={activeSub.n.toLocaleString()}
          sub={`${subMap['trialing'] ?? 0} on trial`}
          metric="subs_total"
          selected={def.series === 'subs'}
          onSelect={onMetricChange}
        />
        <Kpi
          label="Active watches"
          value={watchAgg.active.toLocaleString()}
          sub={`${watchAgg.watchers} watchers`}
          metric="watches"
          selected={metric === 'watches'}
          onSelect={onMetricChange}
        />
        <Kpi
          label="Alerts sent"
          value={alertAgg.sent.toLocaleString()}
          sub={`+${alertAgg.sent_7d} this week`}
          metric="alerts"
          selected={metric === 'alerts'}
          onSelect={onMetricChange}
        />
      </div>
      {/* The KPI row IS the metric switcher; only the range needs its own control,
          and it sits above the card like any filter. */}
      <RangeSwitcher range={range} onRangeChange={onRangeChange} />
      <MetricChart metric={def} rows={rows} range={range} />
      <QuickLinks />
    </div>
  );
}

/* -------------------------------------------------------- Users & Revenue */

function UsersRevenuePanel({
  data,
  metric,
  onMetricChange,
  range,
  onRangeChange,
}: {
  data: AdminData;
  metric: MetricKey;
  onMetricChange: (k: MetricKey) => void;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
}) {
  const { mrr, subMap, usersAgg } = data;
  // This tab is about users and revenue, so it offers only those four. Watches and
  // alerts are engagement — they live on Overview and Engagement.
  const tabMetrics = METRICS.filter((m) => m.series === 'users' || m.series === 'subs');
  const def = tabMetrics.some((m) => m.key === metric) ? metricDef(metric) : tabMetrics[0];
  const rows = data.series?.[def.series] ?? [];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2 space-y-3">
          {/* Controls ABOVE the card, not inside it — same chart as Overview, whose
              KPI row plays the metric-switcher role. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <MetricSwitcher
              metric={def.key}
              onMetricChange={onMetricChange}
              metrics={tabMetrics}
            />
            <RangeSwitcher range={range} onRangeChange={onRangeChange} />
          </div>
          <MetricChart metric={def} rows={rows} range={range} />
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
                {/* Same labels as System Health. These chips still read "ridb" and
                    "virginiastateparks" after that panel was cleaned up — the source
                    key is a database value, not a name anyone outside the code uses. */}
                {`${syncSourceLabel(r.source)} · `}
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

/**
 * Plain-English name and purpose for each canary key.
 *
 * The panel used to print the raw key — "delivery:email", "detect:ridb" — which
 * says nothing to a reader who isn't holding the code in their head. Worse, it left
 * the two KINDS of canary looking identical when they answer opposite questions:
 * detection is "can we still see an opening", delivery is "can we still tell you
 * about one". Either failing loses a booking, for completely different reasons.
 */
const CANARY_META: Record<string, { label: string; what: string }> = {
  'detect:ridb': { label: 'Recreation.gov', what: 'reading live availability' },
  'detect:reserveamerica': { label: 'ReserveAmerica', what: 'reading live availability' },
  'detect:reservecalifornia': { label: 'ReserveCalifornia', what: 'reading live availability' },
  'detect:goingtocamp': { label: 'GoingToCamp', what: 'reading live availability' },
  'detect:tnsc': { label: 'TN / SC parks', what: 'reading live availability' },
  'delivery:email': { label: 'Email', what: 'Resend accepted a test alert' },
  'delivery:sms': { label: 'Text', what: 'Twilio accepted a test alert' },
  'delivery:push': { label: 'Push', what: 'Firebase credentials still valid' },
};

/** "just now" / "4m ago" / "14h ago" / "3d ago" — never a raw 873m. */
function ago(seconds: number | null | undefined): string {
  if (seconds == null) return 'never run';
  if (seconds < 90) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "reserveamerica-AK" -> "ReserveAmerica · AK". Keeps the state, drops the slug. */
function syncSourceLabel(source: string): string {
  const NAMES: Record<string, string> = {
    ridb: 'Recreation.gov',
    reserveamerica: 'ReserveAmerica',
    reservecalifornia: 'ReserveCalifornia',
    goingtocamp: 'GoingToCamp',
    tnsc: 'TN / SC parks',
  };
  const [head, state] = source.split('-');
  const base = NAMES[head] ?? head.replace(/stateparks$/, ' state parks').replace(/^./, (c) => c.toUpperCase());
  return state ? `${base} · ${state}` : base;
}

function HealthRow({
  level,
  label,
  sub,
  right,
  title,
}: {
  level: Level;
  label: string;
  sub?: string;
  right: string;
  title?: string;
}) {
  const dot = level === 'ok' ? 'bg-ch-green' : level === 'warn' ? 'bg-ch-ochre' : 'bg-ch-alert';
  return (
    <li
      className="flex items-start justify-between gap-3 border-b border-ch-line py-2 last:border-b-0"
      title={title}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0">
          <span className="block truncate text-ch-body text-ch-ink">{label}</span>
          {sub && <span className="block text-ch-fine leading-normal text-ch-muted">{sub}</span>}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-ch-meta whitespace-nowrap text-ch-muted">{right}</span>
    </li>
  );
}

function SystemHealthPanel({ data }: { data: AdminData }) {
  const { beat, workerHealthy, canaryRows, syncRows } = data;

  const detect = canaryRows.filter((c) => c.key.startsWith('detect:'));
  const delivery = canaryRows.filter((c) => c.key.startsWith('delivery:'));

  // Catalog sync is ~30 near-identical rows, and reading them meant scanning every
  // one for a coloured dot. Split so the ones needing attention are the only ones
  // shown by default; the healthy majority collapses to a count.
  const syncWithLevel = syncRows.map((s) => ({ s, lvl: syncLevel(s) }));
  const syncProblems = syncWithLevel.filter((x) => x.lvl !== 'ok');
  const syncFine = syncWithLevel.filter((x) => x.lvl === 'ok');

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel title="Alerting">
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full ${workerHealthy ? 'bg-ch-green' : 'bg-ch-alert'}`} />
          <span className="text-ch-body font-bold">
            {workerHealthy ? 'Running' : beat ? 'Stalled' : 'Never started'}
          </span>
        </div>
        <p className="mt-1 text-ch-meta leading-normal text-ch-muted">
          {beat
            ? workerHealthy
              ? `Checking ${beat.watches_checked} watches every 15 seconds. Last check ${ago(beat.age_s)}.`
              : // Only claim alerts are down when the gap is actually long enough to
                // mean it; "Last check just now — alerts are not going out" reads as a
                // broken dashboard rather than a broken worker.
                `Last check ${ago(beat.age_s)}. The poller should check every 15 seconds — alerts may not be going out.`
            : 'The worker has never recorded a heartbeat.'}
        </p>

        {/* The two questions, named. Grouping them is the point: a reader should be
            able to tell at a glance whether we have stopped SEEING openings or
            stopped SENDING them, without decoding a key prefix. */}
        <h3 className="mt-4 mb-0.5 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
          Can we still find openings?
        </h3>
        <p className="mb-1 text-ch-fine text-ch-muted">
          One real lookup per reservation system, every 2 minutes.
        </p>
        <ul>
          {detect.map((c) => {
            const meta = CANARY_META[c.key];
            return (
              <HealthRow
                key={c.key}
                level={canaryLevel(c)}
                label={meta?.label ?? c.key}
                sub={
                  c.consecutive_failures > 0
                    ? `${c.consecutive_failures} failed ${c.consecutive_failures === 1 ? 'check' : 'checks'} in a row`
                    : undefined
                }
                right={ago(c.age_s)}
                title={c.detail ?? undefined}
              />
            );
          })}
        </ul>

        <h3 className="mt-4 mb-0.5 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
          Can we still reach you?
        </h3>
        <p className="mb-1 text-ch-fine text-ch-muted">
          A real test alert to the owner, once a day — so &ldquo;hours ago&rdquo; is normal here.
        </p>
        <ul>
          {delivery.map((c) => {
            const meta = CANARY_META[c.key];
            return (
              <HealthRow
                key={c.key}
                level={canaryLevel(c)}
                label={meta?.label ?? c.key}
                sub={meta?.what}
                right={ago(c.age_s)}
                title={c.detail ?? undefined}
              />
            );
          })}
        </ul>
        {canaryRows.length === 0 && (
          <p className="text-ch-fine text-ch-muted">No canary runs recorded.</p>
        )}
      </Panel>

      <Panel title="Campground catalog">
        <p className="text-ch-meta leading-normal text-ch-muted">
          How many campgrounds each reservation system last handed us. This is the
          SEARCHABLE list, not live availability — a stale catalog means a campground is
          missing from search, never a missed alert.
        </p>

        {syncProblems.length === 0 ? (
          <p className="mt-3 text-ch-body font-bold text-ch-ink">
            All {syncFine.length} sources synced normally.
          </p>
        ) : (
          <>
            <h3 className="mt-4 mb-1 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
              Worth a look ({syncProblems.length})
            </h3>
            <ul>
              {syncProblems.map(({ s, lvl }) => {
                const synced = s.facilities_synced ?? 0;
                const skipped = s.metadata?.totalErrors ?? null;
                return (
                  <HealthRow
                    key={s.source}
                    level={lvl}
                    label={syncSourceLabel(s.source)}
                    sub={
                      !s.finished_at
                        ? 'still running'
                        : lvl === 'fail'
                          ? 'returned nothing — this source is not in search'
                          : // A "warning" is per-campground: the sync finished, but some
                            // individual facilities could not be read. Saying "skipped"
                            // names what actually happened; "1,051 warnings" sounds like
                            // an outage and is routine.
                            `${synced.toLocaleString()} synced${
                              skipped ? `, ${skipped.toLocaleString()} skipped` : ''
                            }`
                    }
                    right={s.finished_at ? ago(s.age_s) : ''}
                    title={s.error ?? undefined}
                  />
                );
              })}
            </ul>
          </>
        )}

        {syncFine.length > 0 && syncProblems.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-ch-meta font-bold text-ch-muted hover:text-ch-green-deep">
              {syncFine.length} synced normally
            </summary>
            <ul className="mt-1">
              {syncFine.map(({ s, lvl }) => (
                <HealthRow
                  key={s.source}
                  level={lvl}
                  label={syncSourceLabel(s.source)}
                  sub={`${(s.facilities_synced ?? 0).toLocaleString()} campgrounds`}
                  right={s.finished_at ? ago(s.age_s) : ''}
                />
              ))}
            </ul>
          </details>
        )}

        {syncRows.length === 0 && <p className="text-ch-fine text-ch-muted">No sync runs recorded.</p>}
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

/**
 * A headline number, and on Overview also the chart's metric switcher.
 *
 * Passing `metric` turns the tile into a button. Reusing the KPI row rather than
 * adding a second control row is the point: the tiles were already there, already
 * name the four metrics, and already sit in one row above the chart.
 *
 * MRR deliberately stays a plain tile — it is a Stripe snapshot with no daily series
 * behind it, and a tile that looks clickable but plots nothing is worse than one that
 * plainly isn't.
 */
function Kpi({
  label,
  value,
  sub,
  accent,
  metric,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'green' | 'alert';
  metric?: MetricKey;
  selected?: boolean;
  onSelect?: (k: MetricKey) => void;
}) {
  const color =
    accent === 'green' ? 'text-ch-green-deep' : accent === 'alert' ? 'text-ch-alert' : 'text-ch-ink';
  const body = (
    <>
      <p className="text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">{label}</p>
      <p className={`mt-1 font-ch-display text-[26px] leading-none font-extrabold ${color}`}>
        {value}
      </p>
      {sub && <p className="mt-1.5 text-ch-fine text-ch-muted">{sub}</p>}
    </>
  );
  const base = 'rounded-ch-card border bg-ch-card p-4 text-left shadow-ch-card';
  if (!metric || !onSelect) {
    return <div className={`${base} border-ch-line`}>{body}</div>;
  }
  return (
    <button
      onClick={() => onSelect(metric)}
      aria-pressed={selected}
      title={`Chart ${label.toLowerCase()}`}
      className={`${base} cursor-pointer transition-colors ${
        selected
          ? 'border-ch-green ring-1 ring-ch-green'
          : 'border-ch-line hover:border-ch-green'
      }`}
    >
      {body}
    </button>
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
