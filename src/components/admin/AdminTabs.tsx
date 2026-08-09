'use client';

import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
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
import type { SmsDelivery } from '@/lib/health-thresholds';
import type { PollerCapacity, ShardCoverage } from '@/lib/capacity';

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
 *
 * BUT COLOUR IS NEVER THE ONLY CHANNEL (2026-08-05). The owner of this dashboard is
 * colour-blind, and green/ochre/red dots are three grey dots to a deuteranope — this
 * page's entire job is "is anything broken?", answered in the one channel they can't
 * read. Every status now carries a distinct ICON SHAPE and a WORD (`LEVEL_MARK`);
 * hue is the redundant third channel, not the signal. If you add a status anywhere on
 * this page, route it through `StatusMark`/`LEVEL_MARK` rather than picking a
 * `bg-ch-*` class — a bare coloured dot is a regression, not a style choice.
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
  /** Shard coverage + demand-vs-capacity. Computed by lib/capacity, same functions the
   *  pager uses — see the note there about two copies of a rule. */
  shardCov: ShardCoverage;
  capacity: PollerCapacity;
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
  /** Carrier outcomes for SMS (migration 038). `alertAgg.sent` counts messages Twilio
   *  ACCEPTED; this counts messages that actually landed. Carries BOTH windows: the 30d
   *  figures are the history, the `r_*` 7d figures are what the status level is judged
   *  on — see the query in app/admin/page.tsx for why they are not the same question. */
  smsDelivery: SmsDelivery & {
    r_delivered: number; r_dropped: number; r_pending: number; r_untracked: number;
  };
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
  SMS_MIN_SAMPLE,
  smsLevel,
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
  // Texts that never arrive belong in the banner: the canaries prove we CAN send one,
  // and a carrier dropping real alerts is invisible to them.
  //
  // JUDGED ON THE LAST 7 DAYS, matching the panel below. On the 30-day window this
  // banner announced "33% of texts are not reaching phones" for three days after the
  // cause was fixed — every one of those drops was 2026-08-05, before the camphawk.app
  // link came out of SMS, and there have been none since. A banner that keeps shouting
  // about a solved problem is how the one person who reads it learns to scroll past it.
  // CAPACITY IS A LEADING INDICATOR — the only one on this page. Everything else here
  // reports a thing that has already broken; this reports one that is going to. It was
  // computed in /api/health/status and shown NOWHERE, so the pager knew and the dashboard
  // did not, and the person who has to clone the machine reads the dashboard.
  if (data.shardCov.level === 'fail') {
    problems.push(data.shardCov.detail);
  }
  if (data.capacity.level === 'fail') {
    problems.push(`the poller is over capacity by ${-data.capacity.free} campground-months`);
  } else if (data.capacity.level === 'warn') {
    canaryWarnings.push(
      `poller capacity — ${data.capacity.free} slot(s) free, clone a machine`,
    );
  }

  const sms = data.smsDelivery;
  const smsRecent = {
    delivered: sms.r_delivered, dropped: sms.r_dropped,
    pending: sms.r_pending, untracked: sms.r_untracked,
  };
  const smsLvl = smsLevel(smsRecent);
  const smsAnswered = smsRecent.delivered + smsRecent.dropped;
  const smsNote =
    smsAnswered === 0
      ? 'no SMS delivery receipts are coming back from Twilio'
      : `${((smsRecent.dropped / smsAnswered) * 100).toFixed(0)}% of texts are not reaching phones`;
  if (smsLvl === 'fail') problems.push(smsNote);
  else if (smsLvl === 'warn') canaryWarnings.push(smsNote);

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

/**
 * The three levels, in every channel at once: a distinct icon SHAPE, a WORD, and only
 * then a colour. One record so a new status surface can't invent its own vocabulary —
 * the previous version of this file had "green dot / ochre dot / red dot" spelled out
 * inline in three different places, which is exactly how a page ends up legible only
 * to people who can separate those three hues.
 *
 * The shapes are chosen to differ at 12px in silhouette alone: a round tick, a
 * triangle, a round cross. Two triangles for warn and fail would have been prettier
 * and useless.
 */
const LEVEL_MARK: Record<
  Level,
  { Icon: typeof CheckCircle2; word: string; box: string; text: string }
> = {
  ok: {
    Icon: CheckCircle2,
    word: 'OK',
    box: 'border-[#BFDDC9] bg-ch-green-soft',
    text: 'text-ch-green-deep',
  },
  warn: {
    Icon: AlertTriangle,
    word: 'Warning',
    box: 'border-[#E7C98C] bg-ch-ochre-soft',
    text: 'text-ch-ochre-ink',
  },
  fail: {
    Icon: XCircle,
    word: 'Failing',
    box: 'border-[#E7BFB4] bg-ch-alert-soft',
    text: 'text-ch-alert-deep',
  },
};

/**
 * The status marker used everywhere on this page.
 *
 * `showWord` only controls the VISIBLE word — it is always present for screen readers,
 * so hiding it never costs the label, just the pixels. Callers that already print the
 * word elsewhere in the row (the Alerting header says "Running"/"Stalled") pass false.
 */
function StatusMark({ level, showWord = true }: { level: Level; showWord?: boolean }) {
  const { Icon, word, text } = LEVEL_MARK[level];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-bold ${text}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {showWord ? word : <span className="sr-only">{word}</span>}
    </span>
  );
}

export default function AdminTabs({ data }: { data: AdminData }) {
  const [tab, setTab] = useState<Tab>('Overview');
  // Shared so switching tabs keeps the metric you were looking at — the two tabs
  // render the SAME chart, and having it silently reset would look like a bug.
  const [metric, setMetric] = useState<MetricKey>('users_total');
  // Range is shared too: it scopes the same chart on both tabs.
  const [range, setRange] = useState<RangeKey>('30d');
  const mrrCents = data.mrr ? Math.round(data.mrr.monthly * 100) : null;
  const status = overallStatus(data);
  const style = LEVEL_MARK[status.level];
  // Distinct shape per level. This used to be "tick if ok, triangle otherwise", so
  // warn and fail — the two the banner exists to tell apart — shared one glyph and
  // differed only in hue.
  const BannerIcon = style.Icon;

  return (
    <div className="font-ch-body text-ch-ink">
      {/* Status above the tabs — it's true regardless of which tab you're on,
          and it's the reason most visits to this page happen. */}
      <div className={`mb-5 flex items-start gap-3 rounded-ch-card border p-4 ${style.box}`}>
        <BannerIcon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${style.text}`} />
        <div className="min-w-0">
          {/* The level, spelled out. The headline names the problem but not its
              severity — "3 catalog syncs finished with warnings" and "the poller has
              stopped" were the same sentence shape in two shades of pastel. */}
          <p
            className={`text-ch-label font-bold tracking-[.12em] uppercase opacity-80 ${style.text}`}
          >
            {style.word}
          </p>
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
        {/* TWO SOURCES, SAID OUT LOUD. The big number is Clerk's signup count; everything
            else about users — this subtitle, and the chart you get by clicking the tile —
            comes from our own `users` table, which only gains a row once somebody takes an
            authenticated action. So the tile's number is always >= the chart's running
            total, and until 2026-08-09 nothing said why: five hand-inserted test rows
            happened to make both read 25, which looked like agreement and was five fakes
            covering five signups who never came back. The label now names each source, so
            a gap reads as "signed up but never used it" — which is the useful metric —
            rather than as a broken page. */}
        <Kpi
          label="Signups"
          value={(clerkTotal ?? usersAgg.total).toLocaleString()}
          sub={
            clerkTotal == null
              ? `${usersAgg.total} active · Clerk unavailable`
              : `${usersAgg.total} active · +${usersAgg.new_7d} this week`
          }
          title={
            clerkTotal == null
              ? 'Clerk could not be reached, so this is the active count (people who have used the app), not signups.'
              : `${clerkTotal} accounts created (Clerk). ${usersAgg.total} of them have actually used the app — that is what the chart plots. Seed/test rows are excluded.`
          }
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
          sub={
            alertAgg.sent === 0
              ? 'no sends yet'
              : // The red number was the only thing saying "and that is too many".
                `${failRate.toFixed(1)}% of sends${failRate > 2 ? ' — above the 2% ceiling' : ''}`
          }
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
/**
 * Why were campgrounds skipped? — the one fact "8 skipped" was missing.
 *
 * The reasons were already being stored (sync_log.error, first ten lines) and shown only
 * as a hover title, which nobody hovers. So ReserveAmerica DE quietly skipped 8 of its 13
 * parks for weeks — including Cape Henlopen and Delaware Seashore, the two biggest
 * campgrounds in the state — and the page said "8 skipped", which reads like rounding.
 *
 * Takes the reason off the FIRST line and strips the identifiers, because the lines are
 * `DE 360108 (Cape Henlopen State Park): no coords and no street address` and the useful
 * half is the last clause. One shared cause is the common case; when they differ, the
 * first is still a better starting point than a number. The full list stays in the title.
 */
function skipReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const first = error.split('\n')[0] ?? '';
  const why = first.includes(': ') ? first.slice(first.indexOf(': ') + 2) : first;
  const trimmed = why.trim();
  if (!trimmed) return null;
  // These carry a whole HTML error document (a WAF 403 body). Naming the shape beats
  // pasting the first 60 characters of a DOCTYPE into the admin page.
  if (/^\s*<|DOCTYPE/i.test(trimmed)) return 'upstream refused the request';
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

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
  const { Icon, word, text } = LEVEL_MARK[level];
  return (
    <li
      className="flex items-start justify-between gap-3 border-b border-ch-line py-2 last:border-b-0"
      title={title}
    >
      <span className="flex min-w-0 items-start gap-2">
        {/* Icon left (where the coloured dot was, so the rows still align), word right
            next to the age. Both, not either: the shape survives a screenshot, the word
            survives a shape you don't recognise. */}
        <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${text}`} />
        <span className="min-w-0">
          <span className="block truncate text-ch-body text-ch-ink">{label}</span>
          {sub && <span className="block text-ch-fine leading-normal text-ch-muted">{sub}</span>}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-ch-meta whitespace-nowrap text-ch-muted">
        <span className={`font-bold ${text}`}>{word}</span>
        {right && ` · ${right}`}
      </span>
    </li>
  );
}

/**
 * The delivery panel the canaries could never be.
 *
 * `delivery:sms` proves Twilio ACCEPTS a message from us. It cannot prove a carrier
 * delivered one — those are different systems failing in different ways, and the gap
 * between them is exactly where a real alert went missing on 2026-08-05: email and
 * push arrived, the text did not, and every row in our own database said `sent`.
 *
 * Counts, not just a percentage: "2 of 47" and "2 of 3" are the same 4%-vs-67% trap
 * the Failed alerts KPI already learned about, in reverse.
 */
function SmsDeliveryPanel({
  d,
}: {
  d: SmsDelivery & { r_delivered: number; r_dropped: number; r_pending: number; r_untracked: number };
}) {
  const answered = d.delivered + d.dropped;
  const total = answered + d.pending + d.untracked;

  // THE LEVEL COMES FROM THE LAST 7 DAYS, the headline rate with it. A 30-day rate keeps
  // reporting a fixed outage as a live one: all 13 drops were on 2026-08-05, and this
  // panel still read "33% of texts are not reaching phones" three days after the cause
  // was removed. The 30-day counts stay on screen underneath — the history is not the
  // problem, presenting it as the present was.
  const recent = { delivered: d.r_delivered, dropped: d.r_dropped, pending: d.r_pending, untracked: d.r_untracked };
  const rAnswered = recent.delivered + recent.dropped;
  const lvl = smsLevel(recent);
  const olderDrops = d.dropped - recent.dropped;

  return (
    <Panel title="Did the texts arrive?">
      <div className="flex items-center gap-2 text-ch-body">
        <StatusMark level={lvl} showWord={false} />
        <span className="font-bold">
          {total === 0
            ? 'No texts sent in the last 30 days'
            : rAnswered === 0 && recent.pending > 0
              ? 'No delivery receipts yet'
              : rAnswered === 0
                ? 'No texts to measure in the last 7 days'
                : `${((recent.delivered / rAnswered) * 100).toFixed(0)}% delivered this week`}
        </span>
      </div>
      <p className="mt-1 text-ch-meta leading-normal text-ch-muted">
        Twilio&rsquo;s carrier receipt for every alert text, last 30 days. This is the
        only place that distinguishes &ldquo;we sent it&rdquo; from &ldquo;their phone
        buzzed&rdquo; — everything else on this page, including the SMS canary, stops at
        Twilio accepting the message.
        {rAnswered > 0 && rAnswered < SMS_MIN_SAMPLE && ' Too few this week to read a rate into.'}
      </p>
      {/* Say plainly that older drops exist and are NOT in the headline. Quietly
          narrowing the window would be indistinguishable from hiding a problem, and the
          whole reason this panel is trusted is that it never assumes good news. */}
      {olderDrops > 0 && (
        <p className="mt-1 text-ch-meta leading-normal text-ch-muted">
          The counts below cover 30 days and include{' '}
          <strong className="font-semibold text-ch-ink-2">{olderDrops}</strong> older
          failure{olderDrops === 1 ? '' : 's'} from before a fix — outside the 7-day window
          the status above is judged on. They age out on their own.
        </p>
      )}
      {/* Counts, each with what it means underneath — no dots, no colour key. Reading
          this needs no legend, which is the whole point of the change that added it. */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {(
          [
            ['Delivered', d.delivered, 'reached a handset'],
            ['Never arrived', d.dropped, 'rejected or filtered'],
            ['Awaiting receipt', d.pending, 'sent, no answer yet'],
            ['Not tracked', d.untracked, 'sent before receipts'],
          ] as const
        ).map(([label, n, what]) => (
          <div key={label}>
            <dt className="text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
              {label}
            </dt>
            <dd className="font-ch-display text-[20px] leading-none font-extrabold">
              {n.toLocaleString()}
            </dd>
            <dd className="mt-0.5 text-ch-fine text-ch-muted">{what}</dd>
          </div>
        ))}
      </dl>
      {d.untracked > 0 && (
        <p className="mt-2 text-ch-fine text-ch-muted">
          &ldquo;Not tracked&rdquo; is texts sent before delivery receipts existed. It
          only shrinks — nothing new lands there — and it is counted separately rather
          than assumed delivered.
        </p>
      )}
    </Panel>
  );
}

/**
 * "Ring my phone" — the only canary that cannot be automated.
 *
 * The three delivery canaries above run themselves daily, because sending an email or a
 * text to yourself is free and silent. A phone call is neither, so this one is a button.
 *
 * It is worth having a button for. The alarm only ever fires on a morning when something
 * else is already broken, which is the worst possible moment to find out that the Twilio
 * number is SMS-only (a 21210 at call time — not knowable from the code) or that the phone
 * on file is wrong. It places a REAL call on the REAL path; only the words differ.
 */
function AlarmTest() {
  const [state, setState] = useState<'idle' | 'calling' | 'done'>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  async function ring() {
    setState('calling');
    setDetail(null);
    try {
      const res = await fetch('/api/admin/test-alarm', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setDetail(body?.detail ?? `Request failed (HTTP ${res.status}).`);
    } catch (e) {
      setDetail(`Could not reach the server: ${(e as Error).message}`);
    }
    setState('done');
  }

  return (
    <div className="mt-4 border-t border-ch-line pt-3">
      <h3 className="mb-0.5 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
        Can we wake you up?
      </h3>
      <p className="mb-2 text-ch-fine text-ch-muted">
        If the ReserveCalifornia session dies within 45 minutes of a hold releasing, CampHawk
        phones you — twice, because a repeat call is what gets through Do Not Disturb. This is
        the one delivery check that can&rsquo;t run itself.
      </p>
      <button
        type="button"
        onClick={ring}
        disabled={state === 'calling'}
        className="rounded-ch border border-ch-line px-3 py-1.5 text-ch-meta font-bold text-ch-ink hover:bg-ch-surface disabled:opacity-60"
      >
        {state === 'calling' ? 'Calling…' : 'Ring my phone now'}
      </button>
      {detail && <p className="mt-2 text-ch-fine leading-normal text-ch-muted">{detail}</p>}
    </div>
  );
}

/**
 * "Does ReserveCalifornia's sign-in work inside our in-app webview?"
 *
 * THE ONE QUESTION NO AMOUNT OF RESEARCH COULD SETTLE, and it needs a button for the same
 * reason the alarm does: it cannot run itself. RC's Okta fingerprints aggressively — it is
 * why the bot must run headful — and whether it accepts an Android WebView decides whether
 * mobile auto-cart is possible at all.
 *
 * Reaching it through the real flow needs a live 8am hold, which happens a few times a
 * month. This exercises the same `openRcHandoff` seam with no hold, so the answer is
 * available in ten seconds instead of at the next release.
 *
 * It also reports WHICH path was taken, which answers a second question for free: whether
 * the installed binary actually has the InAppBrowser plugin. 'browser' from inside the app
 * means the capability probe found nothing — a build that shipped without it, which is
 * exactly the silent failure the Codemagic assertion exists to prevent.
 */
function RcWebviewTest() {
  const [result, setResult] = useState<string | null>(null);
  const [diag, setDiag] = useState<Record<string, string> | null>(null);

  // WHAT THIS RUNTIME HAS, shown BEFORE anything is opened. The first version reported
  // "not running inside the app, or no plugin" — two causes, two different fixes, one
  // sentence — and it said that from inside the app, which told us nothing. Facts first.
  async function inspect() {
    const { rcHandoffDiagnostics } = await import('@/lib/native/rc-handoff');
    setDiag(await rcHandoffDiagnostics());
  }

  async function run() {
    await inspect();
    setResult('opening…');
    const { openRcHandoff } = await import('@/lib/native/rc-handoff');
    // A real park loop, no unit — this tests the SIGN-IN, which is the unknown. Carting
    // needs a genuine held site, and inventing one would fail for reasons that say nothing
    // about the webview.
    const how = await openRcHandoff({ url: 'https://www.reservecalifornia.com/Web/#!park/720/715' });
    setResult(
      how === 'injected'
        ? 'Opened in the in-app webview WITH injection — the plugin is present.'
        : how === 'in-app'
          ? 'Opened in the system browser (SFSafariViewController / Custom Tabs). No injectable webview in this build.'
          : 'Opened in the browser — not running inside the app, or no plugin.',
    );
  }

  return (
    <div className="mt-4 border-t border-ch-line pt-3">
      <h3 className="mb-0.5 text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
        Can we sign in to RC in the app?
      </h3>
      <p className="mb-2 text-ch-fine text-ch-muted">
        Open this <strong>from the CampHawk app</strong>, not from a browser — the whole
        question is what the app&rsquo;s own webview does, and a browser tells you nothing.
        If ReserveCalifornia&rsquo;s sign-in loads and accepts your password inside the
        window that opens, mobile auto-cart works. Read the line below the button first: it
        says which kind of window you got.
      </p>
      <button
        type="button"
        onClick={run}
        className="rounded-ch border border-ch-line px-3 py-1.5 text-ch-meta font-bold text-ch-ink hover:bg-ch-surface"
      >
        Open ReserveCalifornia
      </button>
      <button
        type="button"
        onClick={inspect}
        className="mt-2 ml-2 rounded-ch border border-ch-line px-3 py-1.5 text-ch-meta font-bold text-ch-ink hover:bg-ch-surface"
      >
        What does this device have?
      </button>
      {result && <p className="mt-2 text-ch-fine leading-normal text-ch-muted">{result}</p>}
      {diag && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ch-fine text-ch-muted">
          {Object.entries(diag).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="font-bold">{k}</dt>
              <dd className="break-all">{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function SystemHealthPanel({ data }: { data: AdminData }) {
  const { beat, workerHealthy, canaryRows, syncRows, shardCov, capacity } = data;

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
        <div className="flex items-center gap-2 text-ch-body">
          {/* showWord={false}: the state is already spelled out beside it. */}
          <StatusMark level={workerHealthy ? 'ok' : 'fail'} showWord={false} />
          <span className="font-bold">
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

        <AlarmTest />
        <RcWebviewTest />
      </Panel>

      <Panel title="Poller capacity">
        <p className="text-ch-meta leading-normal text-ch-muted">
          rec.gov rate-limits per egress IP, so capacity grows by adding MACHINES, not by
          working the ones we have harder. This is the only number here that predicts a
          problem instead of reporting one.
        </p>
        <ul className="mt-2">
          <HealthRow
            level={shardCov.level}
            label="Shard coverage"
            sub={shardCov.missing.length ? 'those campgrounds are polled by NOBODY' : 'every shard has a live machine'}
            right={`${shardCov.held}/${shardCov.expected || 1}`}
            title={shardCov.detail}
          />
          <HealthRow
            level={capacity.level}
            label="rec.gov demand"
            sub={
              capacity.level === 'fail'
                ? `over by ${-capacity.free} — refresh is already slower than 15s`
                : capacity.level === 'warn'
                  ? `only ${capacity.free} free — clone a machine`
                  : `${capacity.free} campground-months spare`
            }
            right={`${capacity.demand}/${capacity.capacity}`}
            title={capacity.detail}
          />
        </ul>
        {capacity.level !== 'ok' && (
          <p className="mt-2 text-ch-fine leading-normal text-ch-muted">
            {/* The ORDER is the whole instruction. Raising SHARD_COUNT first leaves the new
                shard unheld, and its campgrounds polled by nobody, while every other check
                stays green — the silent-blindness case this dashboard exists to prevent. */}
            <strong>Clone first, then raise the count.</strong> <code>flyctl machine clone</code>,
            then <code>SHARD_COUNT</code> and <code>min_machines_running</code> in{' '}
            <code>worker/fly.toml</code>. Doing it the other way round leaves a shard unheld
            and its campgrounds unpolled.
          </p>
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
                            }${skipReason(s.error) ? ` — ${skipReason(s.error)}` : ''}`
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

      {/* Full width: it is a four-across stat row, and the two panels above it are
          different heights, so anything narrower leaves a column-shaped hole. */}
      <div className="md:col-span-2">
        <SmsDeliveryPanel d={data.smsDelivery} />
      </div>
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
  title,
  accent,
  metric,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Hover text. For a tile whose number and subtitle come from DIFFERENT sources, this
   *  is where the difference gets spelled out — the subtitle has room to name them, not
   *  to explain them. */
  title?: string;
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
    return <div className={`${base} border-ch-line`} title={title}>{body}</div>;
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
