'use client';

import { Sun, CalendarDays } from 'lucide-react';

interface QuickFiltersProps {
  onTonight: () => void;
  onThisWeekend: () => void;
}

function getTonight(): { start: string; end: string } {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  return {
    start: today.toISOString().slice(0, 10),
    end: tomorrow.toISOString().slice(0, 10),
  };
}

function getThisWeekend(): { start: string; end: string } {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 6=Sat
  const daysToFriday = day <= 5 ? 5 - day : 6; // days until next Friday
  const friday = new Date(today);
  friday.setDate(today.getDate() + daysToFriday);
  const sunday = new Date(friday);
  sunday.setDate(friday.getDate() + 2);
  return {
    start: friday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

export { getTonight, getThisWeekend };

export default function QuickFilters({ onTonight, onThisWeekend }: QuickFiltersProps) {
  return (
    <div className="flex gap-2">
      <button
        onClick={onTonight}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors"
      >
        <Sun size={13} />
        Available tonight
      </button>
      <button
        onClick={onThisWeekend}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors"
      >
        <CalendarDays size={13} />
        This weekend
      </button>
    </div>
  );
}
