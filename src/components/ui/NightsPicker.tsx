"use client";

import { useId } from "react";
import Chip from "./Chip";
import { cx } from "./cx";

/**
 * Shared control: NightsPicker — "any N consecutive nights", optionally
 * weekends-only.
 *
 * Maps directly onto the flexible-dates columns (migration 019):
 *   nights       -> watches.flex_nights
 *   weekendsOnly -> watches.flex_days ('weekend' | null)
 * and onto ?flexNights= on the search route.
 *
 * WEEKENDS-ONLY IS DELIBERATELY HERE. The handoff mockup's NightsPicker dropped
 * it, but the backend supports it and today's SearchBar exposes it, so shipping
 * without it would be a silent feature regression. A "weekend" run is one that
 * includes a Saturday night — enforced by the matcher, not by this control.
 *
 * 1-5 are chips because those are the overwhelming majority of stays; "Other"
 * reveals a number input for the long tail rather than padding the row with
 * chips nobody taps.
 */
export interface NightsPickerProps {
  nights: number;
  onNightsChange: (nights: number) => void;
  weekendsOnly: boolean;
  onWeekendsOnlyChange: (weekendsOnly: boolean) => void;
  /** Hide the weekends-only toggle where it doesn't apply (e.g. plain search). */
  showWeekendsOnly?: boolean;
  min?: number;
  max?: number;
  className?: string;
}

const QUICK = [1, 2, 3, 4, 5];

export default function NightsPicker({
  nights,
  onNightsChange,
  weekendsOnly,
  onWeekendsOnlyChange,
  showWeekendsOnly = true,
  min = 1,
  max = 30,
  className,
}: NightsPickerProps) {
  const id = useId();
  const custom = !QUICK.includes(nights);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  return (
    <div className={className}>
      <div
        role="group"
        aria-label="Stay length"
        className="flex flex-wrap gap-1.5"
      >
        {QUICK.map((n) => (
          <Chip
            key={n}
            size="sm"
            selected={!custom && nights === n}
            onClick={() => onNightsChange(n)}
          >
            {n} {n === 1 ? "night" : "nights"}
          </Chip>
        ))}
        <Chip
          size="sm"
          selected={custom}
          // Jumping straight to 7 gives the input a sensible starting value and
          // makes the reveal feel like a choice rather than an empty box.
          onClick={() => onNightsChange(custom ? nights : 7)}
        >
          Other
        </Chip>
      </div>

      {custom && (
        <div className="mt-2.5 flex items-center gap-2.5">
          <label htmlFor={`${id}-n`} className="sr-only">
            Number of nights
          </label>
          <input
            id={`${id}-n`}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={nights}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              onNightsChange(Number.isFinite(v) ? clamp(v) : min);
            }}
            className={cx(
              "w-[74px] rounded-[10px] border border-ch-green bg-ch-card px-2.5 py-2",
              "font-ch-display text-[14.5px] font-bold text-ch-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
            )}
          />
          <span className="text-ch-meta font-semibold text-ch-muted">nights in a row</span>
        </div>
      )}

      {showWeekendsOnly && (
        <div className="mt-2.5">
          <Chip
            size="sm"
            selected={weekendsOnly}
            onClick={() => onWeekendsOnlyChange(!weekendsOnly)}
          >
            Weekends only
          </Chip>
          {weekendsOnly && (
            <p className="mt-1.5 px-0.5 text-ch-fine leading-normal text-ch-muted">
              Only runs that include a Saturday night count as a match.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
