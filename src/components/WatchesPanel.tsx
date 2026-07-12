'use client';

import { useEffect, useState } from 'react';
import { X, Bell, Trash2, Loader2, CalendarDays } from 'lucide-react';
import SmsOptIn from './SmsOptIn';

interface Watch {
  id: string;
  campground_name: string;
  campground_id: string;
  start_date: string;
  end_date: string;
  site_type: string | null;
  created_at: string;
  notification_sent_at: string | null;
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
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                Search with dates and click "Notify me" on a booked campground.
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

        <div className="border-t px-5 py-4 space-y-3">
          {phoneLoaded && (
            <SmsOptIn
              initialPhone={phone ?? ''}
              initialSaved={!!phone}
              onSaved={(p) => setPhone(p)}
            />
          )}
          <p className="text-xs text-gray-400 text-center">
            You'll get one email{phone ? ' and text' : ''} per opening. Remove anytime.
          </p>
        </div>
      </div>
    </div>
  );
}
