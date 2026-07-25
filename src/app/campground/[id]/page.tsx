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
  TrendingUp,
} from 'lucide-react';
import type { Campground, Campsite } from '@/lib/types';
import Logo from '@/components/Logo';
import AvailabilityCalendar from '@/components/AvailabilityCalendar';

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


interface LadderBucket {
  bucket: string;
  label: string;
  rate: number | null;
  samples: number;
  openings: number;
  enough: boolean;
}

/**
 * Cancellation-likelihood ladder (feature E): how often this site has had a bookable
 * opening lately, by how far out the stay is. Renders nothing until there's any
 * history; shows a "still learning" note while buckets are too thin to be honest.
 */
function CancellationOdds({ campgroundId }: { campgroundId: string }) {
  const [buckets, setBuckets] = useState<LadderBucket[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/likelihood?campgroundId=${encodeURIComponent(campgroundId)}`)
      .then((r) => (r.ok ? r.json() : { buckets: [] }))
      .then((d) => { if (live) setBuckets(d.buckets ?? []); })
      .catch(() => { if (live) setBuckets([]); });
    return () => { live = false; };
  }, [campgroundId]);

  // Feature E likelihood ladder is paused for now — with limited history the numbers
  // skew to discouraging readings. Flip to true to restore (boolean-typed so the code
  // below stays reachable for TypeScript/lint). Restore all three % surfaces together.
  const SHOW_LIKELIHOOD: boolean = false;
  if (!SHOW_LIKELIHOOD) return null;

  if (!buckets) return null; // still loading — no flash
  const hasAny = buckets.some((b) => b.samples > 0);
  if (!hasAny) return null; // no history for this site → don't show the card at all
  const ready = buckets.filter((b) => b.enough && b.rate != null);

  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
        <TrendingUp size={16} className="text-green-600" /> How often it opens up
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Share of recent checks that found a bookable opening, by how far ahead you&rsquo;re looking.
      </p>
      {ready.length === 0 ? (
        <p className="text-sm text-gray-500">
          Still learning this site&rsquo;s pattern — we started tracking recently. Check back soon.
        </p>
      ) : (
        <div className="space-y-2">
          {ready.map((b) => {
            const pct = Math.round((b.rate ?? 0) * 100);
            return (
              <div key={b.bucket} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-28 shrink-0 capitalize">{b.label}</span>
                <div className="flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full bg-green-500" style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
                <span className="text-xs font-semibold text-gray-700 w-9 text-right">{pct}%</span>
              </div>
            );
          })}
          <p className="text-[11px] text-gray-400 pt-1">
            Based on {ready.reduce((n, b) => n + b.samples, 0)} recent checks. Past openings don&rsquo;t guarantee future ones.
          </p>
        </div>
      )}
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
      {/* Header: back nav + CampHawk logo (consistent with the rest of the site) */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-green-700 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to results
          </button>
          <button
            onClick={() => router.push('/')}
            aria-label="CampHawk home"
            className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
          >
            <Logo markSize={34} />
          </button>
        </div>
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

        {/* Cancellation likelihood (feature E) — hidden until this site has history */}
        <CancellationOdds campgroundId={params.id} />

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
