'use client';

import { useEffect, useState } from 'react';
import { Loader2, CalendarDays, ExternalLink } from 'lucide-react';
import type { CampgroundAvailability } from '@/lib/types';
import { bookingLink } from '@/lib/booking-url';

// Month availability grid for the campground detail page. Tapping an open day reveals
// the specific open sites for that day: rec.gov gets verified per-site deep links,
// UseDirect (ReserveCalifornia + the *stateparks* portals) lists the sites but shares
// the park-level booking link; sources with no per-site data fall back to a single
// link per day. Extracted from the detail page so it can be screenshotted/tested in
// isolation (see scripts/screenshot-component.mts).
export default function AvailabilityCalendar({
  campgroundId,
  month,
  reservationsUrl,
  providerName,
  source,
}: {
  campgroundId: string;
  month: string;
  reservationsUrl?: string | null;
  providerName?: string;
  source?: string;
}) {
  const [data, setData] = useState<CampgroundAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelectedDate(null); // a picked day from the old month has no meaning in the new one
    fetch(`/api/campgrounds/${campgroundId}/availability?month=${month}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [campgroundId, month]);

  if (loading) return <div className="flex items-center gap-2 text-gray-400 py-4"><Loader2 size={16} className="animate-spin" /> Loading availability...</div>;
  if (!data) return null;

  // Collect ALL sites open on each date, not just one. rec.gov's per-site page
  // (`/camping/campsites/<id>`) is the most specific link that provably works
  // (dates aren't deep-linkable there — see booking-url.ts), so when several
  // sites are open we let the user pick rather than guessing one for them.
  const dateToOpenSites = new Map<string, typeof data.campsites>();
  for (const cs of data.campsites) {
    for (const d of cs.availability) {
      if (d.status === 'available') {
        const list = dateToOpenSites.get(d.date) ?? [];
        list.push(cs);
        dateToOpenSites.set(d.date, list);
      }
    }
  }
  const availDays = new Set(dateToOpenSites.keys());

  // rec.gov has a verified per-site deep link, so its sites get distinct links.
  // UseDirect (ReserveCalifornia + the other *stateparks* portals) returns per-site
  // availability too but only a park-level booking link — we can still list the
  // specific open sites for a tapped day, they just share the park link. Everyone
  // else (no per-site data) stays a single link to the provider's page.
  const perSiteLinks = source === 'ridb';
  const isUseDirect = source === 'reservecalifornia' || !!source?.endsWith('stateparks');
  const showSitePicker = perSiteLinks || isUseDirect;
  const selectedSites = selectedDate ? dateToOpenSites.get(selectedDate) ?? [] : [];

  // Build calendar grid
  const [year, mo] = month.split('-').map(Number);
  const firstDay = new Date(year, mo - 1, 1).getDay();
  const daysInMonth = new Date(year, mo, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);

  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <CalendarDays size={14} className="text-gray-400" />
        <span className="text-sm font-medium text-gray-700">
          {data.availableCount} site{data.availableCount !== 1 ? 's' : ''} with open dates this month
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-xs">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-center text-gray-400 font-medium py-1">{d}</div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`empty-${i}`} />;
          const dateStr = `${month}-${String(day).padStart(2, '0')}`;
          const isPast = dateStr < today;
          const isAvail = availDays.has(dateStr);
          const clickable = isAvail && !isPast && !!reservationsUrl;
          const isSelected = clickable && dateStr === selectedDate;
          const openCount = clickable ? dateToOpenSites.get(dateStr)?.length ?? 0 : 0;
          const cls = `block w-full text-center py-1.5 rounded font-medium ${
            isPast ? 'text-gray-300' : isAvail ? 'bg-green-100 text-green-700' : 'bg-red-50 text-red-400'
          } ${clickable ? 'cursor-pointer ring-1 ring-inset ring-green-300 hover:bg-green-200' : ''} ${
            isSelected ? 'ring-2 ring-green-500 bg-green-200' : ''
          }`;

          if (!clickable) return <div key={dateStr} className={cls}>{day}</div>;

          // rec.gov + UseDirect: multiple sites can be open — reveal the list so the user picks.
          if (showSitePicker) {
            return (
              <button
                key={dateStr}
                type="button"
                data-avail-day={dateStr}
                onClick={() => setSelectedDate((cur) => (cur === dateStr ? null : dateStr))}
                title={`${openCount} site${openCount !== 1 ? 's' : ''} open on ${dateStr} — tap to choose`}
                className={cls}
              >
                {day}
              </button>
            );
          }

          // Single verified link (park/reservations page, date-carrying for RA).
          return (
            <a
              key={dateStr}
              href={bookingLink({ source, reservationsUrl, campgroundId, date: dateStr })!}
              target="_blank"
              rel="noopener noreferrer"
              title={`See open sites for ${dateStr} and book${providerName ? ` on ${providerName}` : ''}`}
              className={cls}
            >
              {day}
            </a>
          );
        })}
      </div>

      {/* Open-site picker for the tapped day (rec.gov + UseDirect) */}
      {showSitePicker && selectedDate && (
        <div className="mt-3 rounded-xl border border-green-200 bg-green-50/60 p-3">
          <div className="text-xs font-medium text-gray-700 mb-2">
            {selectedSites.length} open site{selectedSites.length !== 1 ? 's' : ''} on {selectedDate}
            <span className="text-gray-400 font-normal"> — pick one to book on {providerName ?? 'the provider'}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {selectedSites.map((cs) => (
              <a
                key={cs.campsiteId}
                href={(perSiteLinks
                  ? bookingLink({ source, reservationsUrl, date: selectedDate, campsiteId: cs.campsiteId })
                  : bookingLink({ source, reservationsUrl, campgroundId, date: selectedDate }))!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded-lg bg-white border border-gray-100 px-3 py-2 text-xs hover:border-green-300 hover:bg-green-50 transition-colors"
              >
                <span className="min-w-0">
                  <span className="font-medium text-gray-700">{cs.campsiteName ?? cs.campsiteId}</span>
                  {cs.loop && <span className="text-gray-400"> · Loop {cs.loop}</span>}
                  {cs.campsiteType && <span className="block text-gray-400 capitalize">{cs.campsiteType.toLowerCase()}</span>}
                </span>
                <ExternalLink size={12} className="shrink-0 text-green-600" />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-100 inline-block" /> Available</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-50 inline-block" /> Unavailable</span>
        {reservationsUrl && availDays.size > 0 && (
          <span className="text-green-700">
            {showSitePicker ? 'Tap an available day to choose an open site →' : 'Tap an available day to see open sites & book →'}
          </span>
        )}
      </div>
    </div>
  );
}
