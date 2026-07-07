'use client';

import { useEffect, useState } from 'react';
import { X, Bell, Trash2, Loader2, CalendarDays, MessageSquare, Check } from 'lucide-react';

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
  const [phone, setPhone] = useState('');
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/watches')
      .then((r) => r.json())
      .then((d) => setWatches(d.watches ?? []))
      .finally(() => setLoading(false));
    fetch('/api/user/phone')
      .then((r) => (r.ok ? r.json() : { phone: null }))
      .then((d) => {
        if (d.phone) {
          setPhone(d.phone);
          setPhoneSaved(true);
        }
      })
      .catch(() => {});
  }, []);

  async function savePhone() {
    setPhoneSaving(true);
    setPhoneError(null);
    try {
      const res = await fetch('/api/user/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const d = await res.json();
      if (!res.ok) {
        setPhoneError(d.error ?? 'Could not save');
        setPhoneSaved(false);
      } else {
        setPhone(d.phone ?? '');
        setPhoneSaved(!!d.phone);
      }
    } catch {
      setPhoneError('Could not save');
    } finally {
      setPhoneSaving(false);
    }
  }

  async function removeWatch(id: string) {
    setDeleting(id);
    await fetch(`/api/watches?id=${id}`, { method: 'DELETE' });
    setWatches((w) => w.filter((x) => x.id !== id));
    setDeleting(null);
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 mb-1.5">
              <MessageSquare size={12} className="text-green-600" />
              Text me too (optional)
            </label>
            <div className="flex gap-2">
              <input
                type="tel"
                placeholder="(805) 555-1234"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setPhoneSaved(false);
                }}
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <button
                onClick={savePhone}
                disabled={phoneSaving || phoneSaved}
                className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                {phoneSaving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : phoneSaved ? (
                  <Check size={13} />
                ) : (
                  'Save'
                )}
              </button>
            </div>
            {phoneError && <p className="text-xs text-red-500 mt-1">{phoneError}</p>}
          </div>
          <p className="text-xs text-gray-400 text-center">
            You'll get one email{phoneSaved ? ' and text' : ''} per opening. Remove anytime.
          </p>
        </div>
      </div>
    </div>
  );
}
