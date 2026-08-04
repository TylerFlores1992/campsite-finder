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

export type MetricKey = 'users' | 'watches' | 'alerts' | 'subs';

export interface MetricDef {
  key: MetricKey;
  /** Short label for the switcher. */
  label: string;
  /** What the chart is titled when this metric is selected. */
  title: string;
  /** Singular/plural noun for the tooltip, e.g. "3 new users". */
  noun: string;
}

export const METRICS: MetricDef[] = [
  { key: 'users', label: 'New users', title: 'New users', noun: 'new users' },
  { key: 'subs', label: 'New subscribers', title: 'New subscribers', noun: 'new subscribers' },
  { key: 'watches', label: 'Watches created', title: 'Watches created', noun: 'watches created' },
  { key: 'alerts', label: 'Alerts sent', title: 'Alerts sent', noun: 'alerts sent' },
];

type Point = { day: string; n: number };

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
}: {
  metric: MetricKey;
  onMetricChange: (key: MetricKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {METRICS.map((m) => (
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

/** "2026-08-04" → "Aug 4". Parsed as UTC to match the server's date spine. */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function MetricChart({
  metric,
  data,
  total,
}: {
  metric: MetricDef;
  data: Point[];
  /** Headline sum for the window, shown beside the title. */
  total: number;
}) {
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
        <h2 className="font-ch-display text-ch-h font-bold">{metric.title} · last 30 days</h2>
        <span className="text-ch-meta text-ch-muted">
          {total.toLocaleString()} total
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[200px] w-full touch-none"
        role="img"
        aria-label={`${metric.title}, last 30 days. ${total} total. Use arrow keys to read each day.`}
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
              key={pts[i].day}
              x={pts[i].x}
              y={H - 8}
              textAnchor={k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'}
              className="fill-ch-muted"
              style={{ fontSize: 10 }}
            >
              {shortDay(pts[i].day)}
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
              {metric.noun} · {shortDay(active.day)}
            </span>
          </>
        ) : (
          <span className="text-ch-muted">
            Hover or focus the chart and use ← → to read any day.
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
                <th className="py-1 font-bold">Day</th>
                <th className="py-1 text-right font-bold">{metric.label}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-t border-ch-line">
                  <td className="py-1 text-ch-muted">{shortDay(d.day)}</td>
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
