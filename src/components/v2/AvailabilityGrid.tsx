"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "@/components/ui/cx";
import {
  addMonths,
  daysInMonth,
  firstDayOfWeek,
  longDate,
  monthLabel,
  parseISO,
  startOfMonth,
  toISO,
  todayISO,
  type ISODate,
} from "@/components/ui/date";
import type { CampsiteAvailability } from "@/lib/types";

/**
 * Month grid of a campground's availability, with a per-site list for the
 * selected day.
 *
 * FULLY-BOOKED DAYS ARE NEUTRAL, NEVER RED. This is the token system's rule and
 * it's the right call: nearly every day at a good campground is booked, and a
 * calendar bleeding red says "something is broken" when it should say "this is
 * popular, set a watch". Red is reserved for states the user must act on.
 *
 * Reads the existing /api/campgrounds/[id]/availability endpoint per month —
 * same contract the current calendar uses, no data-layer change.
 */

type DayState = "open" | "full" | "outside";

export interface AvailabilityGridProps {
  campgroundId: string;
  /** Month to open on, 'YYYY-MM'. Defaults to the current month. */
  initialMonth?: string;
  /** Pre-select this day if it falls in the opening month. */
  initialDay?: ISODate;
}

export default function AvailabilityGrid({
  campgroundId,
  initialMonth,
  initialDay,
}: AvailabilityGridProps) {
  const [month, setMonth] = useState<string>(initialMonth ?? todayISO().slice(0, 7));
  const [sites, setSites] = useState<CampsiteAvailability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ISODate | null>(initialDay ?? null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/campgrounds/${encodeURIComponent(campgroundId)}/availability?month=${month}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Couldn't load availability (${r.status})`);
        return r.json();
      })
      .then((j: { campsites?: CampsiteAvailability[] }) => {
        if (cancelled) return;
        setSites(j.campsites ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campgroundId, month]);

  /** date -> the sites open that night. */
  const openByDay = useMemo(() => {
    const map = new Map<ISODate, CampsiteAvailability[]>();
    for (const site of sites ?? []) {
      for (const day of site.availability) {
        if (day.status !== "available") continue;
        const list = map.get(day.date);
        if (list) list.push(site);
        else map.set(day.date, [site]);
      }
    }
    return map;
  }, [sites]);

  const monthStart = `${month}-01`;
  const pad = firstDayOfWeek(monthStart);
  const total = daysInMonth(monthStart);
  const base = parseISO(monthStart);

  const cells: Array<ISODate | null> = [
    ...Array(pad).fill(null),
    ...Array.from({ length: total }, (_, i) =>
      toISO(new Date(base.getFullYear(), base.getMonth(), i + 1)),
    ),
  ];

  const dayState = (day: ISODate): DayState => (openByDay.has(day) ? "open" : "full");
  const openDayCount = [...openByDay.keys()].filter((d) => d.startsWith(month)).length;
  const selectedSites = selected ? (openByDay.get(selected) ?? []) : [];

  const shift = (delta: number) => {
    setMonth(startOfMonth(addMonths(monthStart, delta)).slice(0, 7));
    setSelected(null);
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_288px]">
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous month"
            className="size-7 cursor-pointer rounded-lg border border-ch-line bg-ch-paper text-ch-ink-2 hover:border-ch-green hover:text-ch-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <ChevronLeft aria-hidden="true" className="mx-auto size-4" />
          </button>
          <h2 aria-live="polite" className="font-ch-display text-[17px] font-bold">
            {monthLabel(monthStart)}
          </h2>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next month"
            className="size-7 cursor-pointer rounded-lg border border-ch-line bg-ch-paper text-ch-ink-2 hover:border-ch-green hover:text-ch-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <ChevronRight aria-hidden="true" className="mx-auto size-4" />
          </button>
        </div>

        <div className="mb-1 grid grid-cols-7">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <span key={i} className="text-center text-[10px] font-bold text-ch-faint">
              {d}
            </span>
          ))}
        </div>

        <div className={cx("grid grid-cols-7 gap-[5px]", loading && "opacity-50")}>
          {cells.map((day, i) => {
            if (!day) return <div key={`b-${i}`} className="aspect-square" />;
            const state = dayState(day);
            const isOpen = state === "open";
            const picked = selected === day;
            const count = openByDay.get(day)?.length ?? 0;
            return (
              <button
                key={day}
                type="button"
                data-avail-day={day}
                // A fully-booked day is not actionable, and making it a live
                // button that does nothing is worse than disabling it.
                disabled={!isOpen}
                aria-label={
                  isOpen
                    ? `${longDate(day)} — ${count} site${count === 1 ? "" : "s"} open`
                    : `${longDate(day)} — fully booked`
                }
                aria-pressed={isOpen ? picked : undefined}
                onClick={() => setSelected(day)}
                className={cx(
                  "flex aspect-square items-center justify-center rounded-[11px] text-[15px] font-semibold",
                  "transition-colors motion-reduce:transition-none",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green",
                  isOpen && !picked && "cursor-pointer bg-ch-green-soft font-bold text-ch-green-deep hover:bg-[#D2E8DA]",
                  isOpen && picked && "cursor-pointer bg-ch-green font-bold text-white",
                  // Neutral, never red — booked is the normal state.
                  !isOpen && "cursor-default text-[#BFC9C0]",
                )}
              >
                {parseISO(day).getDate()}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3.5 text-ch-fine text-ch-muted">
          <span>
            <i className="mr-1.5 inline-block size-2.5 rounded-[3px] bg-ch-green-soft align-[-1px]" />
            Sites open
          </span>
          <span>
            <i className="mr-1.5 inline-block size-2.5 rounded-[3px] bg-[#EDF0EB] align-[-1px]" />
            Fully booked
          </span>
          <span className="ml-auto">
            {error
              ? "Availability unavailable"
              : loading
                ? "Checking…"
                : openDayCount
                  ? `${openDayCount} day${openDayCount === 1 ? "" : "s"} with openings`
                  : "Nothing open this month"}
          </span>
        </div>

        {error && (
          <p role="alert" className="mt-2 text-ch-fine text-ch-alert">
            {error} — this is usually the reservation provider, not your connection.
          </p>
        )}
      </div>

      <aside className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <h3 className="font-ch-display text-[13.5px] font-bold">
          {selected ? longDate(selected).replace(/, \d{4}$/, "") : "Pick a day"}
        </h3>
        <p className="mt-0.5 text-ch-fine text-ch-muted">
          {selected
            ? selectedSites.length
              ? `${selectedSites.length} site${selectedSites.length === 1 ? "" : "s"} open`
              : "Fully booked"
            : "Tap any highlighted day to see which sites are free."}
        </p>

        {selectedSites.length > 0 && (
          <ul className="mt-2">
            {selectedSites.map((s) => (
              <li
                key={s.campsiteId}
                className="flex items-center gap-2.5 border-b border-ch-line py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-ch-display text-[13px] font-bold">
                    {s.campsiteName ?? `Site ${s.campsiteId}`}
                  </div>
                  {(s.loop || s.campsiteType) && (
                    <div className="mt-0.5 text-ch-fine text-ch-muted">
                      {[s.loop, s.campsiteType].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
