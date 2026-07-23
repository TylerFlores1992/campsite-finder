'use client';

import { useEffect, useState } from 'react';
import { X, Bell, Trash2, Loader2, CalendarDays, SlidersHorizontal } from 'lucide-react';
import SmsOptIn from './SmsOptIn';
import AutoCartToggle from './AutoCartToggle';

interface Watch {
  id: string;
  campground_name: string;
  campground_id: string;
  start_date: string;
  end_date: string;
  site_type: string | null;
  created_at: string;
  notification_sent_at: string | null;
  muted_site_ids?: string[];
  flex_nights?: number | null;
  flex_days?: string | null;
  likelihood?: { rate: number; samples: number }; // feature E, present only when honest
  manage_url?: string;
}

interface WatchesPanelProps {
  onClose: () => void;
}

export default function WatchesPanel({ onClose }: WatchesPanelProps) {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneLoaded, setPhoneLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/watches')
      .then((r) => r.json())
      .then((d) => setWatches(d.watches ?? []))
      .finally(() => setLoading(false));
    fetch('/api/user/phone')
      .then((r) => (r.ok ? r.json() : { phone: null }))
      .then((d) => setPhone(d.phone ?? null))
      .catch(() => {})
      .finally(() => setPhoneLoaded(true));
  }, []);

  async function removeWatch(id: string) {
    setDeleting(id);
    await fetch(`/api/watches?id=${id}`, { method: 'DELETE' });
    setWatches((w) => w.filter((x) => x.id !== id));
    setDeleting(null);
  }

  async function unmuteSite(id: string, siteId: string) {
    setWatches((ws) =>
      ws.map((x) => (x.id === id ? { ...x, muted_site_ids: (x.muted_site_ids ?? []).filter((s) => s !== siteId) } : x))
    );
    await fetch('/api/watches', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, unmuteSiteId: siteId }),
    }).catch(() => {});
  }

  function formatDate(d: string) {
    // Parse as local midnight ('T00:00:00'), not UTC, so a YYYY-MM-DD date
    // doesn't shift a day earlier in negative-offset timezones.
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white w-full max-w-sm h-full shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Bell size={18} className="text-amber-500" />
            <h2 className="font-semibold text-gray-900">Active Watches</h2>
            {watches.length > 0 && (
              <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                {watches.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-0">
          {watches.length > 2 && (
            <div className="pointer-events-none absolute bottom-0 inset-x-0 h-6 bg-gradient-to-t from-white to-transparent z-10" />
          )}
          <div className="h-full overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 size={20} className="animate-spin" />
            </div>
          )}

          {!loading && watches.length === 0 && (
            <div className="text-center py-12">
              <Bell size={32} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm text-gray-500 font-medium">No active watches</p>
              <p className="text-xs text-gray-400 mt-1">
                Search with dates and click &ldquo;Notify me&rdquo; on a booked campground.
              </p>
            </div>
          )}

          {watches.map((w) => (
            <div
              key={w.id}
              className="bg-gray-50 rounded-xl p-4 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-medium text-sm text-gray-900 truncate">{w.campground_name}</p>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500">
                  <CalendarDays size={11} />
                  <span>
                    {formatDate(w.start_date)} – {formatDate(w.end_date)}
                  </span>
                  {w.flex_nights ? (
                    <span className="bg-green-100 px-1.5 py-0.5 rounded text-green-700 font-medium">
                      {w.flex_nights} night{w.flex_nights > 1 ? 's' : ''}
                      {w.flex_days === 'weekend' ? ', weekends' : ', flexible'}
                    </span>
                  ) : null}
                  {w.site_type && (
                    <span className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-600">
                      {w.site_type}
                    </span>
                  )}
                </div>
                {w.notification_sent_at && (
                  <p className="text-xs text-green-600 mt-1.5 font-medium">
                    ✓ Alert sent {new Date(w.notification_sent_at).toLocaleDateString()}
                  </p>
                )}
                {/* Per-watch cancellation-likelihood "% chance for your dates" is hidden
                    for now: with limited history many watches read a discouraging 0%.
                    The data is still computed (w.likelihood) so this can be restored. */}
                {(w.muted_site_ids?.length ?? 0) > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-gray-500">
                    <span>Muted:</span>
                    {w.muted_site_ids!.map((s) => (
                      <button
                        key={s}
                        onClick={() => unmuteSite(w.id, s)}
                        className="bg-gray-200 hover:bg-gray-300 px-1.5 py-0.5 rounded text-gray-600"
                        title={`Unmute site ${s}`}
                      >
                        {s} ✕
                      </button>
                    ))}
                  </div>
                )}
                {w.manage_url && (
                  <a
                    href={w.manage_url}
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-green-700 hover:underline"
                  >
                    <SlidersHorizontal size={11} />
                    Manage
                  </a>
                )}
              </div>
              <button
                onClick={() => removeWatch(w.id)}
                disabled={deleting === w.id}
                className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                title="Remove watch"
              >
                {deleting === w.id ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Trash2 size={15} />
                )}
              </button>
            </div>
          ))}
          </div>
        </div>

        <div className="border-t px-4 py-3 space-y-2">
          <AutoCartToggle />
          {phoneLoaded && (
            <SmsOptIn
              compact
              initialPhone={phone ?? ''}
              initialSaved={!!phone}
              onSaved={(p) => setPhone(p)}
            />
          )}
          <p className="text-[11px] text-gray-400 text-center">
            One email{phone ? ' + text' : ''} per opening · remove anytime
          </p>
        </div>
      </div>
    </div>
  );
}
