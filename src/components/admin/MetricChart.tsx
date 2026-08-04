'use client';

import { useId, useMemo, useRef, useState } from 'react';

/**
 * The ONE chart on the admin page. Overview and Users & Revenue both render this, so
 * there is a single thing to look at and a single thing to change.
 *
 * It replaced a stack of bare CSS `div`s with percentage heights: no axis, no
 * gridlines, no readout beyond a native `title` tooltip, and no way to see anything
 * but signups. You could tell "some days are taller"; you could not tell what any day
 * actually was. That chart had also silently rendered blank twice — once from a
 * percentage height resolving against `auto`, once from an `/alpha` colour modifier —
 * because nothing about it fails loudly.
 *
 * Form: single-series line + area wash. That is the default for trend-over-time with
 * one series, and only one metric is on screen at a time — which is also why there is
 * no legend (the title names the series) and one hue rather than a categorical
 * palette. #1E7A4C on white passes the lightness band, chroma floor and 3:1 contrast
 * checks; there are no adjacent pairs to separate because two series never coexist.
 *
 * Deliberate specs, from the dataviz guidance:
 *  - 2px line, round cap/join; area at ~10% opacity (a wash, never a saturated block).
 *  - gridlines hairline, SOLID, one step off the surface — recessive, never dashed.
 *  - end dot r=4 with a 2px surface ring so it stays legible over the line.
 *  - the crosshair finds the X: readers aim at a date, never at a 2px line.
 *  - values lead, labels follow, in the tooltip.
 *  - a table view exists, so no value is gated behind hovering.
 */

export type SeriesKey = 'users' | 'watches' | 'alerts' | 'subs';
export type MetricKey =
  | 'users_total'
  | 'users_new'
  | 'subs_total'
  | 'subs_new'
  | 'watches'
  | 'alerts';

export interface MetricDef {
  key: MetricKey;
  /** Which raw daily series this reads. */
  series: SeriesKey;
  /**
   * RUNNING TOTAL rather than per-bucket count. "Users" on a dashboard means how many
   * there are, not how many arrived on Tuesday — so the tile that says 1,240 users
   * plots a line that ends at 1,240, instead of one that ends at 3.
   */
  cumulative?: boolean;
  /** Short label for the switcher. */
  label: string;
  /** Chart title when selected. */
  title: string;
  /** Noun for the readout, e.g. "3 new users". */
  noun: string;
}

export const METRICS: MetricDef[] = [
  { key: 'users_total', series: 'users', cumulative: true, label: 'Total users', title: 'Total users', noun: 'users' },
  { key: 'users_new', series: 'users', label: 'New users', title: 'New users', noun: 'new users' },
  { key: 'subs_total', series: 'subs', cumulative: true, label: 'Total subscribers', title: 'Total subscribers', noun: 'subscribers' },
  { key: 'subs_new', series: 'subs', label: 'New subscribers', title: 'New subscribers', noun: 'new subscribers' },
  { key: 'watches', series: 'watches', label: 'Watches created', title: 'Watches created', noun: 'watches created' },
  { key: 'alerts', series: 'alerts', label: 'Alerts sent', title: 'Alerts sent', noun: 'alerts sent' },
];

export const metricDef = (k: MetricKey) => METRICS.find((m) => m.key === k) ?? METRICS[0];

/* ------------------------------------------------------------------ date range */

export type RangeKey = '30d' | '12m' | 'all';

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: '30d', label: '30 days' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All time' },
];

type Point = { day: string; n: number };
type Bucket = { key: string; label: string; n: number };

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Turn raw all-time daily rows into the buckets a range wants, zero-filling the gaps.
 *
 * ZERO-FILL IS THE WHOLE JOB. A day or month with no rows must plot as 0, not vanish:
 * a series that simply skips its empty buckets draws a shorter line with a misleading
 * slope, and the reader has no way to tell a quiet week from a missing one.
 *
 * `cumulative` sums forward across the WHOLE history, then keeps the visible tail —
 * so "total users" on a 30-day range starts from everyone who already existed rather
 * than restarting at zero.
 */
export function bucket(rows: Point[], range: RangeKey, cumulative = false): Bucket[] {
  const now = new Date();
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  const first = rows.length ? rows[0].day : now.toISOString().slice(0, 10);

  let keys: string[];
  let labelOf: (k: string) => string;

  if (range === '30d') {
    keys = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      keys.push(d.toISOString().slice(0, 10));
    }
    labelOf = (k) => {
      const [, m, dd] = k.split('-').map(Number);
      return `${MONTHS[m - 1]} ${dd}`;
    };
  } else {
    // Months for both 12m and all-time. Years would be 1-2 points for a product this
    // young — a two-point "chart" is a table with extra steps.
    const startMonth =
      range === '12m'
        ? (() => {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
            return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
          })()
        : first.slice(0, 7);
    keys = [];
    const [sy, sm] = startMonth.split('-').map(Number);
    const cur = new Date(Date.UTC(sy, sm - 1, 1));
    const endKey = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
    for (let guard = 0; guard < 600; guard++) {
      const k = `${cur.getUTCFullYear()}-${pad(cur.getUTCMonth() + 1)}`;
      keys.push(k);
      if (k === endKey) break;
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    labelOf = (k) => {
      const [y, m] = k.split('-').map(Number);
      return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
    };
  }

  const width = range === '30d' ? 10 : 7; // key length: YYYY-MM-DD vs YYYY-MM
  const sums = new Map<string, number>();
  for (const [day, n] of byDay) sums.set(day.slice(0, width), (sums.get(day.slice(0, width)) ?? 0) + n);

  if (!cumulative) {
    return keys.map((k) => ({ key: k, label: labelOf(k), n: sums.get(k) ?? 0 }));
  }
  // Everything before the first visible bucket, so the total starts where it really is.
  let running = 0;
  for (const [day, n] of byDay) if (day.slice(0, width) < keys[0]) running += n;
  return keys.map((k) => {
    running += sums.get(k) ?? 0;
    return { key: k, label: labelOf(k), n: running };
  });
}

/**
 * The metric switcher, rendered ABOVE the chart card — never inside it. A control
 * that scopes a chart belongs in a row above the thing it scopes; dropping it into
 * the card makes it read as chart furniture and puts it in a different place on every
 * page that mounts the chart.
 *
 * Overview does not use this: its KPI row already names all four metrics and already
 * sits above the chart, so the tiles ARE the switcher.
 */
export function MetricSwitcher({
  metric,
  onMetricChange,
  metrics = METRICS,
}: {
  metric: MetricKey;
  onMetricChange: (key: MetricKey) => void;
  /** Which metrics this tab offers. Users & Revenue shows only user/revenue ones. */
  metrics?: MetricDef[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {metrics.map((m) => (
        <button
          key={m.key}
          onClick={() => onMetricChange(m.key)}
          aria-pressed={m.key === metric}
          className={`cursor-pointer rounded-ch-input border px-2.5 py-1 text-ch-fine font-bold transition-colors ${
            m.key === metric
              ? 'border-ch-green bg-ch-green-soft text-ch-green-deep'
              : 'border-ch-line text-ch-muted hover:border-ch-green hover:text-ch-ink-2'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Date range presets. One row, above the chart — never inside the card. */
export function RangeSwitcher({
  range,
  onRangeChange,
}: {
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RANGES.map((r) => (
        <button
          key={r.key}
          onClick={() => onRangeChange(r.key)}
          aria-pressed={r.key === range}
          className={`cursor-pointer rounded-ch-input border px-2.5 py-1 text-ch-fine font-bold transition-colors ${
            r.key === range
              ? 'border-ch-ink-2 bg-ch-shell text-ch-ink'
              : 'border-ch-line text-ch-muted hover:border-ch-ink-2 hover:text-ch-ink-2'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

const SERIES = '#1E7A4C'; // --color-ch-green
const W = 720;
const H = 200;
const PAD = { top: 12, right: 14, bottom: 26, left: 34 };

/** Clean axis ceiling: 1/2/5 × 10^n at or above the data's max. */
function niceMax(max: number): number {
  if (max <= 4) return Math.max(1, max);
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const c = step * pow;
    if (c >= max) return c;
  }
  return 10 * pow;
}

export default function MetricChart({
  metric,
  rows,
  range,
}: {
  metric: MetricDef;
  /** RAW all-time daily rows; the chart buckets them for the selected range. */
  rows: Point[];
  range: RangeKey;
}) {
  const data = useMemo(() => bucket(rows, range, metric.cumulative), [rows, range, metric]);
  // A cumulative series ends at the total; a per-bucket one sums to it.
  const total = metric.cumulative
    ? (data[data.length - 1]?.n ?? 0)
    : data.reduce((sum, d) => sum + d.n, 0);
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? '';
  const gradId = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { pts, top, area, line } = useMemo(() => {
    const top = niceMax(Math.max(0, ...data.map((d) => d.n)));
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    // n === 1 would divide by zero; a single point sits at the left edge.
    const dx = data.length > 1 ? iw / (data.length - 1) : 0;
    const pts = data.map((d, i) => ({
      ...d,
      x: PAD.left + i * dx,
      y: PAD.top + ih - (d.n / top) * ih,
    }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const base = PAD.top + ih;
    const area = pts.length
      ? `${line} L${pts[pts.length - 1].x.toFixed(1)},${base} L${pts[0].x.toFixed(1)},${base} Z`
      : '';
    return { pts, top, area, line };
  }, [data]);

  const ticks = useMemo(() => {
    const out = [0, top / 2, top].filter((v, i, a) => a.indexOf(v) === i);
    return out.map((v) => ({
      v,
      y: PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top),
    }));
  }, [top]);

  const last = pts[pts.length - 1];
  const active = hover !== null ? pts[hover] : null;

  /** Nearest point to the pointer — readers aim at a date, not at a 2px line. */
  function locate(clientX: number) {
    const svg = svgRef.current;
    if (!svg || pts.length === 0) return;
    const r = svg.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hover ?? pts.length - 1;
    setHover(Math.min(pts.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
  }

  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="font-ch-display text-ch-h font-bold">
          {metric.title} · {rangeLabel}
        </h2>
        <span className="text-ch-meta text-ch-muted">
          {total.toLocaleString()} {metric.cumulative ? 'now' : 'total'}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[200px] w-full touch-none"
        role="img"
        aria-label={`${metric.title}, ${rangeLabel}. ${total} ${metric.cumulative ? 'now' : 'total'}. Use arrow keys to read each point.`}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerMove={(e) => locate(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES} stopOpacity="0.22" />
            <stop offset="100%" stopColor={SERIES} stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* Gridlines + y ticks. Hairline, solid, one step off the surface. */}
        {ticks.map((t) => (
          <g key={t.v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={t.y}
              y2={t.y}
              stroke="#DDE3D8"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={t.y + 3.5}
              textAnchor="end"
              className="fill-ch-muted"
              style={{ fontSize: 10 }}
            >
              {Number.isInteger(t.v) ? t.v.toLocaleString() : t.v.toFixed(1)}
            </text>
          </g>
        ))}

        {area && <path d={area} fill={`url(#${gradId})`} />}
        {line && (
          <path
            d={line}
            fill="none"
            stroke={SERIES}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* End dot: 2px surface ring keeps it legible where it meets the line. */}
        {last && (
          <circle cx={last.x} cy={last.y} r="4" fill={SERIES} stroke="#FFFFFF" strokeWidth="2" />
        )}

        {/* Crosshair. */}
        {active && (
          <g>
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="#A9B5AA"
              strokeWidth="1"
            />
            <circle
              cx={active.x}
              cy={active.y}
              r="4.5"
              fill={SERIES}
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>
        )}

        {/* X labels: first, middle, last. Enough to orient without crowding. */}
        {[0, Math.floor(pts.length / 2), pts.length - 1]
          .filter((i, k, a) => pts[i] && a.indexOf(i) === k)
          .map((i, k, a) => (
            <text
              key={pts[i].key}
              x={pts[i].x}
              y={H - 8}
              textAnchor={k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'}
              className="fill-ch-muted"
              style={{ fontSize: 10 }}
            >
              {pts[i].label}
            </text>
          ))}
      </svg>

      {/* Readout. Fixed row under the chart rather than a floating box: it cannot
          collide with the marks, cannot leave the card, and needs no positioning
          maths. Values lead, labels follow. Reserves its height so hovering does
          not shift the layout. */}
      <p className="mt-1 min-h-[20px] text-ch-meta" aria-live="polite">
        {active ? (
          <>
            <span className="font-bold text-ch-ink">
              {active.n.toLocaleString()}
            </span>{' '}
            <span className="text-ch-muted">
              {metric.noun} · {active.label}
            </span>
          </>
        ) : (
          <span className="text-ch-muted">
            Hover or focus the chart and use ← → to read any point.
          </span>
        )}
      </p>

      {/* Table view: every value reachable without hovering. */}
      <details className="mt-2">
        <summary className="cursor-pointer text-ch-fine text-ch-muted hover:text-ch-ink-2">
          Show the numbers
        </summary>
        {/* No max-height/overflow: a nested scrollbar inside a card is exactly the
            clutter this rebuild removed from the tab row, and 30 rows is short. */}
        <div className="mt-2">
          <table className="w-full text-ch-fine">
            <thead>
              <tr className="text-left text-ch-muted">
                <th className="py-1 font-bold">{range === '30d' ? 'Day' : 'Month'}</th>
                <th className="py-1 text-right font-bold">{metric.label}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key} className="border-t border-ch-line">
                  <td className="py-1 text-ch-muted">{d.label}</td>
                  <td className="py-1 text-right tabular-nums text-ch-ink">
                    {d.n.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
