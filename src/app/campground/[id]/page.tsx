'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  MapPin,
  Phone,
  Mail,
  Dog,
  Accessibility,
  ExternalLink,
  Loader2,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
} from 'lucide-react';
import type { Campground, Campsite, CampgroundAvailability } from '@/lib/types';
import { bookingLink } from '@/lib/booking-url';

const CampgroundMap = dynamic(() => import('@/components/Map'), { ssr: false });

/** RIDB descriptions arrive as HTML markup. Strip tags to clean, readable text
 * while preserving paragraph/list breaks (rendered via whitespace-pre-line). */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/h[1-6]|\/li|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&(#39|apos|rsquo|lsquo);/gi, "'")
    .replace(/&(quot|ldquo|rdquo);/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function AvailabilityCalendar({
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

  // rec.gov is the only source with a verified per-site deep link, so it's the
  // only one where listing individual sites gives distinct links. For everyone
  // else the day is a single link to the provider's park/reservations page.
  const hasPerSiteLinks = source === 'ridb';
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

          // rec.gov: multiple sites can be open — reveal the list so the user picks.
          if (hasPerSiteLinks) {
            return (
              <button
                key={dateStr}
                type="button"
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

      {/* Open-site picker for the tapped rec.gov day */}
      {hasPerSiteLinks && selectedDate && (
        <div className="mt-3 rounded-xl border border-green-200 bg-green-50/60 p-3">
          <div className="text-xs font-medium text-gray-700 mb-2">
            {selectedSites.length} open site{selectedSites.length !== 1 ? 's' : ''} on {selectedDate}
            <span className="text-gray-400 font-normal"> — pick one to book on {providerName ?? 'the provider'}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {selectedSites.map((cs) => (
              <a
                key={cs.campsiteId}
                href={bookingLink({ source, reservationsUrl, date: selectedDate, campsiteId: cs.campsiteId })!}
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
            {hasPerSiteLinks ? 'Tap an available day to choose an open site →' : 'Tap an available day to see open sites & book →'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function CampgroundDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [campground, setCampground] = useState<Campground | null>(null);
  const [campsites, setCampsites] = useState<Campsite[]>([]);
  const [loading, setLoading] = useState(true);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [availMonth, setAvailMonth] = useState(new Date().toISOString().slice(0, 7));

  useEffect(() => {
    fetch(`/api/campgrounds/${params.id}`)
      .then((r) => r.json())
      .then((data) => {
        setCampground(data.campground);
        setCampsites(data.campsites ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen gap-2 text-gray-500">
        <Loader2 size={20} className="animate-spin" />
        Loading...
      </div>
    );
  }

  if (!campground) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-gray-500">Campground not found.</p>
        <button onClick={() => router.back()} className="text-green-600 hover:underline text-sm">
          Go back
        </button>
      </div>
    );
  }

  const photos = campground.photos.length > 0 ? campground.photos : [];
  const address = [campground.address.street, campground.address.city, campground.address.state]
    .filter(Boolean)
    .join(', ');

  function prevMonth() {
    const [y, m] = availMonth.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    setAvailMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  function nextMonth() {
    const [y, m] = availMonth.split('-').map(Number);
    const d = new Date(y, m, 1);
    setAvailMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Back nav */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-green-700 transition-colors"
        >
          <ArrowLeft size={16} />
          Back to results
        </button>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Photo carousel */}
        {photos.length > 0 ? (
          <div className="relative rounded-2xl overflow-hidden h-72 bg-gray-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photos[photoIndex].url}
              alt={photos[photoIndex].title ?? campground.name}
              className="w-full h-full object-cover"
            />
            {photos.length > 1 && (
              <>
                <button
                  onClick={() => setPhotoIndex((i) => (i - 1 + photos.length) % photos.length)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  onClick={() => setPhotoIndex((i) => (i + 1) % photos.length)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/40 text-white hover:bg-black/60"
                >
                  <ChevronRight size={18} />
                </button>
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1">
                  {photos.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setPhotoIndex(i)}
                      className={`w-1.5 h-1.5 rounded-full transition-colors ${i === photoIndex ? 'bg-white' : 'bg-white/50'}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="rounded-2xl h-48 bg-green-50 border border-green-100 flex items-center justify-center text-5xl">
            ⛺
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{campground.name}</h1>
            {address && (
              <div className="flex items-center gap-1 mt-1 text-gray-500 text-sm">
                <MapPin size={13} />
                {address}
              </div>
            )}
            <div className="flex items-center gap-3 mt-2">
              {campground.petsAllowed && (
                <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                  <Dog size={11} /> Pet-friendly
                </span>
              )}
              {campground.adaAccessible && (
                <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                  <Accessibility size={11} /> ADA accessible
                </span>
              )}
            </div>
          </div>

          {campground.reservationsUrl && (
            <a
              href={campground.reservationsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 flex items-center gap-1.5 px-5 py-2.5 bg-amber-500 text-white font-display font-semibold text-sm rounded-xl shadow-md shadow-amber-500/25 hover:bg-amber-600 hover:shadow-lg transition-all"
            >
              {campground.source === 'reservecalifornia'
                ? 'Book on ReserveCalifornia'
                : 'Book on Recreation.gov'}
              <ExternalLink size={13} />
            </a>
          )}
        </div>

        {/* Availability calendar — first */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">Availability</h2>
            <div className="flex items-center gap-2">
              <button onClick={prevMonth} className="p-1 rounded hover:bg-gray-100">
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium text-gray-700 min-w-24 text-center">
                {new Date(availMonth + '-15').toLocaleString('default', { month: 'long', year: 'numeric' })}
              </span>
              <button onClick={nextMonth} className="p-1 rounded hover:bg-gray-100">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <AvailabilityCalendar
            campgroundId={params.id}
            month={availMonth}
            reservationsUrl={campground.reservationsUrl}
            source={campground.source}
            providerName={
              campground.source === 'reservecalifornia'
                ? 'ReserveCalifornia'
                : campground.source === 'reserveamerica'
                ? 'ReserveAmerica'
                : 'Recreation.gov'
            }
          />
        </div>

        {/* Location map — second */}
        {campground.latitude != null && campground.longitude != null && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">Location</h2>
            <div className="h-64 rounded-xl overflow-hidden">
              <CampgroundMap
                campgrounds={[campground]}
                center={{ lat: campground.latitude, lng: campground.longitude }}
              />
            </div>
          </div>
        )}

        {/* Description */}
        {campground.description && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-2">About</h2>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
              {htmlToText(campground.description)}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Amenities */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">Amenities</h2>
            {campground.amenities.length > 0 ? (
              <ul className="space-y-1">
                {campground.amenities.map((a) => (
                  <li key={a} className="text-sm text-gray-600 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                    {a}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">No amenity data available</p>
            )}
          </div>

          {/* Activities */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">Activities</h2>
            {campground.activities.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {campground.activities.map((a) => (
                  <span
                    key={a}
                    className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600 capitalize"
                  >
                    {a}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No activity data available</p>
            )}
          </div>
        </div>

        {/* Campsites list */}
        {campsites.length > 0 && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">
              Sites ({campsites.length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {campsites.slice(0, 24).map((cs) => (
                <div
                  key={cs.id}
                  className="text-xs p-2 rounded-lg border border-gray-100 bg-gray-50"
                >
                  <div className="font-medium text-gray-700">{cs.name ?? cs.id}</div>
                  <div className="text-gray-400 capitalize mt-0.5">{cs.type}</div>
                  {cs.loop && <div className="text-gray-400">Loop {cs.loop}</div>}
                  {cs.maxOccupants && <div className="text-gray-400">Max {cs.maxOccupants} people</div>}
                </div>
              ))}
              {campsites.length > 24 && (
                <div className="text-xs p-2 text-gray-400 flex items-center justify-center">
                  +{campsites.length - 24} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contact */}
        {(campground.phone || campground.email) && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">Contact</h2>
            <div className="space-y-2">
              {campground.phone && (
                <a
                  href={`tel:${campground.phone}`}
                  className="flex items-center gap-2 text-sm text-gray-600 hover:text-green-700"
                >
                  <Phone size={14} />
                  {campground.phone}
                </a>
              )}
              {campground.email && (
                <a
                  href={`mailto:${campground.email}`}
                  className="flex items-center gap-2 text-sm text-gray-600 hover:text-green-700"
                >
                  <Mail size={14} />
                  {campground.email}
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
