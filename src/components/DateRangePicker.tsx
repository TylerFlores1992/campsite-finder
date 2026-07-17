'use client';

import { useEffect, useRef, useState } from 'react';
import { Calendar, X } from 'lucide-react';

interface DateRangePickerProps {
  startDate: string; // YYYY-MM-DD or ''
  endDate: string;   // YYYY-MM-DD or ''
  onChange: (startDate: string, endDate: string) => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`; // m: 0-indexed
function todayStr() {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmtShort(s: string): string {
  const [y, m, d] = s.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}
function nightsBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const today = todayStr();
  // Month the left calendar shows; defaults to the selected check-in's month.
  const init = startDate || today;
  const [view, setView] = useState(() => ({ y: +init.slice(0, 4), m: +init.slice(5, 7) - 1 }));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(day: string) {
    if (day < today) return;
    if (!startDate || (startDate && endDate)) {
      onChange(day, ''); // start a fresh range
    } else if (day < startDate) {
      onChange(day, ''); // clicked before check-in → reset check-in
    } else {
      onChange(startDate, day); // set check-out
      setTimeout(() => setOpen(false), 150);
    }
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(Date.UTC(v.y, v.m + delta, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });
  }

  // The provisional end while hovering (before check-out is locked in).
  const provisionalEnd = endDate || (startDate && hover && hover >= startDate ? hover : '');

  const label =
    startDate && endDate
      ? `${fmtShort(startDate)} – ${fmtShort(endDate)}`
      : startDate
        ? `${fmtShort(startDate)} – Add checkout`
        : 'Add dates';

  return (
    <div className="relative" ref={ref}>
      <label className="block text-xs font-medium text-gray-500 mb-1">Dates</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 py-2 px-3 text-sm border rounded-lg bg-white transition-colors min-w-[11rem] ${
          open ? 'border-green-400 ring-2 ring-green-400' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        <Calendar size={14} className="text-gray-400 shrink-0" />
        <span className={startDate ? 'text-gray-800' : 'text-gray-400'}>{label}</span>
        {(startDate || endDate) && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange('', ''); }}
            className="ml-auto text-gray-300 hover:text-gray-600"
            aria-label="Clear dates"
          >
            <X size={14} />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 bg-white rounded-2xl shadow-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex items-start gap-6">
            {/* Both nav arrows live on the first month so paging works at every
                width (the second month is hidden on mobile). */}
            <MonthGrid y={view.y} m={view.m} today={today} startDate={startDate} endDate={provisionalEnd}
              onPick={pick} onHover={setHover} showPrev showNext onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)} />
            <div className="hidden sm:block">
              <MonthGrid y={view.m === 11 ? view.y + 1 : view.y} m={(view.m + 1) % 12} today={today}
                startDate={startDate} endDate={provisionalEnd} onPick={pick} onHover={setHover} />
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
            <span className="text-xs text-gray-500">
              {startDate && endDate
                ? `${nightsBetween(startDate, endDate)} night${nightsBetween(startDate, endDate) !== 1 ? 's' : ''} selected`
                : startDate
                  ? 'Pick your check-out date'
                  : 'Pick your check-in date'}
            </span>
            <div className="flex items-center gap-3">
              {(startDate || endDate) && (
                <button type="button" onClick={() => onChange('', '')} className="text-xs text-gray-500 hover:text-gray-700">
                  Clear
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} className="text-xs font-semibold text-green-700 hover:text-green-800">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  y, m, today, startDate, endDate, onPick, onHover, showPrev, showNext, onPrev, onNext,
}: {
  y: number; m: number; today: string; startDate: string; endDate: string;
  onPick: (d: string) => void; onHover: (d: string | null) => void;
  showPrev?: boolean; showNext?: boolean; onPrev?: () => void; onNext?: () => void;
}) {
  const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="w-[15.5rem]">
      <div className="flex items-center justify-between mb-2 h-6">
        {showPrev ? (
          <button type="button" onClick={onPrev} className="w-6 h-6 rounded-full hover:bg-gray-100 text-gray-500 flex items-center justify-center">‹</button>
        ) : <span className="w-6" />}
        <span className="text-sm font-display font-semibold text-gray-800">{MONTHS[m]} {y}</span>
        {showNext ? (
          <button type="button" onClick={onNext} className="w-6 h-6 rounded-full hover:bg-gray-100 text-gray-500 flex items-center justify-center">›</button>
        ) : <span className="w-6" />}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[10px] font-medium text-gray-400 h-5 flex items-center justify-center">{w}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const ds = ymd(y, m, day);
          const past = ds < today;
          const isStart = ds === startDate;
          const isEnd = ds === endDate;
          const inRange = !!startDate && !!endDate && ds > startDate && ds < endDate;
          const selectedEdge = isStart || isEnd;
          return (
            <div key={i} className={`h-8 flex items-center justify-center ${inRange ? 'bg-green-50' : ''} ${isStart && endDate ? 'rounded-l-full bg-green-50' : ''} ${isEnd && startDate ? 'rounded-r-full bg-green-50' : ''}`}>
              <button
                type="button"
                disabled={past}
                onClick={() => onPick(ds)}
                onMouseEnter={() => onHover(ds)}
                className={`w-8 h-8 rounded-full text-sm flex items-center justify-center transition-colors ${
                  past ? 'text-gray-300 cursor-not-allowed'
                  : selectedEdge ? 'bg-green-600 text-white font-semibold'
                  : inRange ? 'text-green-800 hover:bg-green-100'
                  : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
