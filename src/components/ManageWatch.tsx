'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, Bell, CalendarDays, Pause, Play, BellOff, Bell as BellOn, Tent } from 'lucide-react';

interface Watch {
  id: string;
  campground_name: string;
  start_date: string;
  end_date: string;
  min_nights: number;
  flex_nights: number | null;
  flex_days: string | null;
  site_type: string | null;
  active: boolean;
  auto_cart: boolean;
  muted_site_ids: string[];
}
interface Alert {
  created_at: string;
  channel: string;
  status: string;
  site_name: string | null;
  dates: string[] | null;
  kind: string | null;
}
interface Site {
  id: string;
  name: string | null;
  muted: boolean;
}

function fmtDate(d: string): string {
  return new Date(d + (d.length <= 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export default function ManageWatch({ token }: { token: string }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/manage/${token}`);
      if (!r.ok) {
        setError(r.status === 404 ? 'This manage link is invalid or has expired.' : 'Could not load this watch.');
        return;
      }
      const d = await r.json();
      setWatch(d.watch);
      setAlerts(d.alerts ?? []);
      setSites(d.sites ?? []);
    } catch {
      setError('Could not load this watch.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(op: string, siteId?: string) {
    setBusy(op + (siteId ?? ''));
    try {
      const r = await fetch(`/api/manage/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, siteId }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.watch) setWatch(d.watch);
        // Reflect mute changes in the local site list.
        if (op === 'mute' || op === 'unmute') {
          setSites((prev) => prev.map((s) => (s.id === siteId ? { ...s, muted: op === 'mute' } : s)));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }
  if (error || !watch) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <div className="text-3xl mb-3">⚠️</div>
        <p className="text-gray-600">{error ?? 'Watch not found.'}</p>
      </div>
    );
  }

  const flexLabel = watch.flex_nights
    ? `${watch.flex_nights} night${watch.flex_nights > 1 ? 's' : ''}${watch.flex_days === 'weekend' ? ', weekends' : ', flexible'}`
    : null;

  return (
    <div className="space-y-4">
      {/* Header / summary */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900">{watch.campground_name}</h1>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-gray-500">
              <CalendarDays size={12} />
              <span>{fmtDate(watch.start_date)} – {fmtDate(watch.end_date)}</span>
              {flexLabel && (
                <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">{flexLabel}</span>
              )}
              {watch.auto_cart && (
                <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">auto-cart</span>
              )}
            </div>
          </div>
          <span
            className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full ${
              watch.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'
            }`}
          >
            {watch.active ? 'Active' : 'Paused'}
          </span>
        </div>

        {/* Stop / resume */}
        <button
          onClick={() => act(watch.active ? 'stop' : 'resume')}
          disabled={busy === 'stop' || busy === 'resume'}
          className={`mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-50 ${
            watch.active
              ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              : 'bg-green-600 text-white hover:bg-green-700'
          }`}
        >
          {busy === 'stop' || busy === 'resume' ? (
            <Loader2 size={15} className="animate-spin" />
          ) : watch.active ? (
            <Pause size={15} />
          ) : (
            <Play size={15} />
          )}
          {watch.active ? 'Pause this watch' : 'Resume this watch'}
        </button>
        {!watch.active && (
          <p className="text-xs text-gray-400 mt-2 text-center">Paused — you won&apos;t get alerts until you resume.</p>
        )}
      </div>

      {/* Sites */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Tent size={15} className="text-green-600" /> Sites
        </h2>
        {sites.length === 0 ? (
          <p className="text-xs text-gray-400 mt-2">
            No specific sites yet — they show up here once you&apos;ve been alerted about openings. Mute a site to stop
            alerts for it while still hearing about the rest.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sites.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3">
                <span className={`text-sm truncate ${s.muted ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                  {s.name || `Site ${s.id}`}
                </span>
                <button
                  onClick={() => act(s.muted ? 'unmute' : 'mute', s.id)}
                  disabled={busy === (s.muted ? 'unmute' : 'mute') + s.id}
                  className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${
                    s.muted
                      ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      : 'bg-green-50 text-green-700 hover:bg-green-100'
                  }`}
                >
                  {busy === (s.muted ? 'unmute' : 'mute') + s.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : s.muted ? (
                    <BellOff size={12} />
                  ) : (
                    <BellOn size={12} />
                  )}
                  {s.muted ? 'Muted' : 'Mute'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Alert history */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Bell size={15} className="text-amber-500" /> Alert history
        </h2>
        {alerts.length === 0 ? (
          <p className="text-xs text-gray-400 mt-2">No alerts sent yet.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {alerts.map((a, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <span className="text-gray-800 font-medium">
                    {a.kind === 'carted' ? 'Carted' : a.kind === 'coming_soon' ? 'Opening soon' : 'Opening'}
                    {a.site_name ? ` — ${a.site_name}` : ''}
                  </span>
                  {a.dates && a.dates.length > 0 && (
                    <span className="text-gray-500"> · {a.dates.slice(0, 3).map(fmtDate).join(', ')}</span>
                  )}
                </div>
                <div className="shrink-0 text-right text-gray-400">
                  <div>{new Date(a.created_at).toLocaleDateString()}</div>
                  <div
                    className={`uppercase tracking-wide text-[10px] ${
                      a.status === 'sent' ? 'text-green-600' : a.status === 'failed' ? 'text-red-500' : 'text-gray-400'
                    }`}
                  >
                    {a.channel} {a.status}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-center text-xs text-gray-400">
        Manage link for this watch · <a href="https://camphawk.app" className="text-green-700 hover:underline">CampHawk</a>
      </p>
    </div>
  );
}
