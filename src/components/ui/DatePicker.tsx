"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "./cx";
import {
  addDays,
  addMonths,
  daysInMonth,
  firstDayOfWeek,
  formatRange,
  isBefore,
  isWithin,
  longDate,
  monthLabel,
  nightsBetween,
  parseISO,
  shortDate,
  startOfMonth,
  toISO,
  todayISO,
  type ISODate,
} from "./date";

/**
 * Shared control: DatePicker — collapsed bar that opens a month grid.
 * One instance on Explore, one on New watch.
 *
 * CROSS-MONTH RANGES WORK, IN A SINGLE-MONTH VIEW. The range is two ISO dates
 * (see ./date.ts), so paging the calendar never touches the selection — the old
 * `{y,m,a,b}` model restarted the range whenever the visible month changed,
 * which made Aug 29 → Sep 1 impossible. When the check-in is behind the visible
 * month, a continuation strip says so and the leading cells are tinted, rather
 * than the range silently vanishing.
 *
 * KEYBOARD: the grid is a real `role="grid"` with roving tabindex —
 * arrows move a day, Up/Down a week, Home/End the week's edges, PageUp/PageDown
 * a month, Enter/Space selects. The handoff brief listed calendar keyboard
 * navigation as unimplemented; this is that.
 */
export interface DateRange {
  start: ISODate | null;
  end: ISODate | null;
}

export interface DatePickerProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  /** Accessible name, e.g. "Trip dates" or "Watch window". */
  label: string;
  placeholder?: string;
  /** Replaces the nights readout, e.g. "any 2-night weekend in this window". */
  meta?: string;
  /** Earliest selectable day. Defaults to today — you can't camp in the past. */
  minDate?: ISODate;
  /** Month to open on. Defaults to the check-in's month, else the floor. */
  defaultMonth?: ISODate;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const DOW_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function DatePicker({
  value,
  onChange,
  label,
  placeholder = "Add dates",
  meta,
  minDate,
  defaultMonth,
  open: openProp,
  onOpenChange,
  className,
}: DatePickerProps) {
  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;
  const gridLabelId = `${id}-gridlabel`;

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const floor = minDate ?? todayISO();
  const [view, setView] = useState<ISODate>(() =>
    startOfMonth(defaultMonth ?? value.start ?? floor),
  );
  const [focusedDay, setFocusedDay] = useState<ISODate>(() => value.start ?? floor);

  // Only pull focus when the user is driving with the keyboard — otherwise
  // clicking a day would yank focus around under the pointer.
  const keyboardRef = useRef(false);
  const dayRefs = useRef(new Map<ISODate, HTMLButtonElement>());

  useEffect(() => {
    if (!open || !keyboardRef.current) return;
    dayRefs.current.get(focusedDay)?.focus();
    keyboardRef.current = false;
  }, [focusedDay, open, view]);

  const monthStart = startOfMonth(view);
  const pad = firstDayOfWeek(monthStart);
  const total = daysInMonth(monthStart);

  const days = useMemo(() => {
    const base = parseISO(monthStart);
    return Array.from({ length: total }, (_, i) =>
      toISO(new Date(base.getFullYear(), base.getMonth(), i + 1)),
    );
  }, [monthStart, total]);

  // Chunk into weeks so the grid can have real rows.
  const weeks = useMemo(() => {
    const cells: Array<ISODate | null> = [...Array(pad).fill(null), ...days];
    while (cells.length % 7 !== 0) cells.push(null);
    const out: Array<Array<ISODate | null>> = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [days, pad]);

  const { start, end } = value;
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  // A stay that spans months has one of its ends off-screen in a single-month
  // view. Say which, in both directions — seeing "29" selected and the 30th/31st
  // tinted with no hint of where the stay ends is exactly as confusing as the
  // reverse, and it's the common case for a long weekend.
  const carriesIn = Boolean(start && isBefore(start, monthStart));
  const carriesOut = Boolean(end && isBefore(monthEnd, end));
  const monthNameOf = (iso: ISODate) => monthLabel(iso).split(" ")[0];

  function select(day: ISODate) {
    if (day < floor) return;
    // No start yet, or a complete range: begin a new one.
    if (!start || end) {
      onChange({ start: day, end: null });
      return;
    }
    // Clicking on or before the check-in moves the check-in rather than
    // producing a zero/negative stay.
    if (day <= start) {
      onChange({ start: day, end: null });
      return;
    }
    onChange({ start, end: day });
  }

  function moveFocus(next: ISODate) {
    if (next < floor) return;
    keyboardRef.current = true;
    setFocusedDay(next);
    if (next.slice(0, 7) !== monthStart.slice(0, 7)) setView(startOfMonth(next));
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    const k = e.key;
    let next: ISODate | null = null;
    if (k === "ArrowLeft") next = addDays(focusedDay, -1);
    else if (k === "ArrowRight") next = addDays(focusedDay, 1);
    else if (k === "ArrowUp") next = addDays(focusedDay, -7);
    else if (k === "ArrowDown") next = addDays(focusedDay, 7);
    else if (k === "Home") next = addDays(focusedDay, -parseISO(focusedDay).getDay());
    else if (k === "End") next = addDays(focusedDay, 6 - parseISO(focusedDay).getDay());
    else if (k === "PageUp") next = addMonths(focusedDay, -1);
    else if (k === "PageDown") next = addMonths(focusedDay, 1);
    else if (k === "Escape") {
      setOpen(false);
      return;
    } else return;

    e.preventDefault();
    moveFocus(next);
  }

  function shiftMonth(delta: number) {
    setView(addMonths(monthStart, delta));
  }

  const rangeLabel = formatRange(start, end);
  const nights = start && end ? nightsBetween(start, end) : 0;
  const metaLine =
    meta ??
    (nights ? `${nights} ${nights === 1 ? "night" : "nights"}` : "Choose your check-in and check-out");

  return (
    <div className={className}>
      <button
        type="button"
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className={cx(
          "flex w-full cursor-pointer items-center gap-2.5 border bg-ch-card px-3.5 py-3 text-left",
          "transition-colors motion-reduce:transition-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
          open ? "rounded-t-ch-input border-ch-green" : "rounded-ch-input border-ch-line hover:border-ch-muted",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="sr-only">{label}: </span>
          <span
            className={cx(
              "block font-ch-display text-[14px] font-semibold",
              rangeLabel ? "text-ch-ink" : "text-ch-faint",
            )}
          >
            {rangeLabel ?? placeholder}
          </span>
          <span className="mt-0.5 block text-ch-fine text-ch-muted">{metaLine}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cx(
            "size-3.5 shrink-0 text-ch-muted transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          id={panelId}
          className="rounded-b-ch-input border border-t-0 border-ch-green bg-ch-card p-3"
        >
          {(carriesIn || carriesOut) && (
            <p
              // Announced, because paging the calendar is what reveals it and a
              // sighted user gets the cue from the tinted cells.
              aria-live="polite"
              className="mb-2.5 flex items-start gap-2 rounded-[9px] border border-[#BFDDC9] bg-ch-green-soft px-2.5 py-2 text-ch-fine leading-snug text-ch-green-deep"
            >
              <span aria-hidden="true" className="mt-px shrink-0 text-[9px] opacity-75">
                {carriesIn ? "◀" : "▶"}
              </span>
              <span>
                {carriesIn && start && (
                  <>
                    Check-in <strong className="font-extrabold">{shortDate(start)}</strong> is in{" "}
                    {monthNameOf(start)}
                    {carriesOut ? ", " : " — pick your check-out below."}
                  </>
                )}
                {carriesOut && end && (
                  <>
                    {carriesIn ? "check-out " : <>Check-out </>}
                    <strong className="font-extrabold">{shortDate(end)}</strong> is in{" "}
                    {monthNameOf(end)}.
                  </>
                )}
              </span>
            </p>
          )}

          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="size-[26px] cursor-pointer rounded-lg border border-ch-line bg-ch-paper text-ch-ink-2 hover:border-ch-green hover:text-ch-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
            >
              <ChevronLeft aria-hidden="true" className="mx-auto size-3.5" />
            </button>
            <div id={gridLabelId} aria-live="polite" className="font-ch-display text-[13.5px] font-bold">
              {monthLabel(monthStart)}
            </div>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="size-[26px] cursor-pointer rounded-lg border border-ch-line bg-ch-paper text-ch-ink-2 hover:border-ch-green hover:text-ch-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
            >
              <ChevronRight aria-hidden="true" className="mx-auto size-3.5" />
            </button>
          </div>

          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role */}
          <div role="grid" aria-labelledby={gridLabelId} onKeyDown={onGridKeyDown}>
            <div role="row" className="mb-1 grid grid-cols-7">
              {DOW_SHORT.map((d, i) => (
                <span
                  key={i}
                  role="columnheader"
                  aria-label={DOW_FULL[i]}
                  className="text-center text-[9.5px] font-bold text-ch-faint"
                >
                  {d}
                </span>
              ))}
            </div>

            {weeks.map((week, wi) => (
              <div role="row" key={wi} className="grid grid-cols-7 gap-[3px]">
                {week.map((day, di) => {
                  if (!day) {
                    // Blanks at either edge get tinted when the range continues
                    // past them, so the selection visibly runs off the month
                    // instead of just stopping.
                    const tint =
                      (wi === 0 && carriesIn && (!end || !isBefore(end, monthStart))) ||
                      (wi === weeks.length - 1 && carriesOut);
                    return (
                      <div
                        key={`b-${di}`}
                        role="gridcell"
                        aria-hidden="true"
                        className={cx(
                          "aspect-square rounded",
                          tint && "bg-ch-green-soft/60",
                        )}
                      />
                    );
                  }
                  const disabled = day < floor;
                  const isStart = day === start;
                  const isEnd = day === end;
                  const isMid = Boolean(start && end && isWithin(day, start, end));
                  const selected = isStart || isEnd;
                  return (
                    <button
                      key={day}
                      ref={(el) => {
                        if (el) dayRefs.current.set(day, el);
                        else dayRefs.current.delete(day);
                      }}
                      type="button"
                      role="gridcell"
                      aria-selected={selected || isMid}
                      aria-label={longDate(day)}
                      aria-disabled={disabled || undefined}
                      tabIndex={day === focusedDay ? 0 : -1}
                      onClick={() => {
                        setFocusedDay(day);
                        select(day);
                      }}
                      className={cx(
                        "flex aspect-square items-center justify-center font-ch-body text-[12px] font-semibold",
                        "transition-colors motion-reduce:transition-none",
                        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green",
                        isMid ? "rounded-[4px]" : "rounded-lg",
                        disabled && "cursor-not-allowed text-ch-faint/60",
                        !disabled && !selected && !isMid && "cursor-pointer text-ch-ink-2 hover:bg-ch-green-soft",
                        selected && "cursor-pointer bg-ch-green font-bold text-white",
                        isMid && "cursor-pointer bg-ch-green-soft font-bold text-ch-green-deep",
                      )}
                    >
                      {parseISO(day).getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="mt-2.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => onChange({ start: null, end: null })}
              className="cursor-pointer px-0.5 py-1.5 text-ch-meta font-semibold text-ch-muted hover:text-ch-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded-lg bg-ch-green px-4 py-2 font-ch-body text-[12px] font-bold text-white hover:bg-[#228554] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
