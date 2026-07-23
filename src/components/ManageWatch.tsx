'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2,
  Bell,
  CalendarDays,
  Pause,
  Play,
  BellOff,
  Bell as BellOn,
  Tent,
  Trash2,
  Map as MapIcon,
  ExternalLink,
} from 'lucide-react';

interface Watch {
  id: string;
  campground_id: string;
  campground_name: string;
  source: string;
  reservations_url: string | null;
  latitude: number | null;
  longitude: number | null;
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
  loop: string | null;
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
  const [allSites, setAllSites] = useState<Site[] | null>(null); // null = still loading
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/manage/${token}`);
      if (!r.ok) {
        setError(r.status === 404 ? 'This manage link is invalid or has expired.' : 'Could not load this watch.');
        return;
      }
      const d = await r.json();
      const w: Watch = d.watch;
      setWatch(w);
      setAlerts(d.alerts ?? []);
      setMuted(new Set(w.muted_site_ids ?? []));
      // Seed the site list with sites we already know about (from alert history), then
      // enrich with the campground's FULL site list from the availability endpoint.
      const seed: Site[] = (d.sites ?? []).map((s: { id: string; name: string | null }) => ({
        id: s.id,
        name: s.name,
        loop: null,
      }));
      void loadAllSites(w, seed);
    } catch {
      setError('Could not load this watch.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Pull the campground's full campsite list so sites can be muted ahead of time.
  // Best-effort: providers other than rec.gov / ReserveCalifornia may not enumerate,
  // in which case we fall back to whatever seed sites we have.
  async function loadAllSites(w: Watch, seed: Site[]) {
    try {
      const month = w.start_date.slice(0, 7);
      const r = await fetch(`/api/campgrounds/${w.campground_id}/availability?month=${month}`);
      if (r.ok) {
        const a = await r.json();
        const sites: Site[] = (a.campsites ?? []).map((cs: { campsiteId: string; campsiteName: string | null; loop: string | null }) => ({
          id: cs.campsiteId,
          name: cs.campsiteName,
          loop: cs.loop,
        }));
        if (sites.length > 0) {
          // Merge in any seed/muted site not present in this month's inventory.
          const ids = new Set(sites.map((s) => s.id));
          for (const s of seed) if (!ids.has(s.id)) sites.push(s);
          sites.sort((x, y) => (x.loop ?? '').localeCompare(y.loop ?? '') || (x.name ?? x.id).localeCompare(y.name ?? y.id));
          setAllSites(sites);
          return;
        }
      }
      setAllSites(seed);
    } catch {
      setAllSites(seed);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  async function act(op: string, siteId?: string) {
    const key = op + (siteId ?? '');
    setBusy(key);
    // Optimistic mute/unmute.
    if (op === 'mute' || op === 'unmute') {
      setMuted((prev) => {
        const next = new Set(prev);
        if (op === 'mute') next.add(siteId!);
        else next.delete(siteId!);
        return next;
      });
    }
    try {
      const r = await fetch(`/api/manage/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, siteId }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.removed) setRemoved(true);
        else if (d.watch) setWatch(d.watch);
      }
    } finally {
      setBusy(null);
    }
  }

  function removeWatch() {
    if (!confirm('Remove this watch permanently? You will stop getting alerts for it.')) return;
    act('remove');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }
  if (removed) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <div className="text-3xl mb-3">🗑️</div>
        <p className="text-gray-700 font-medium">Watch removed.</p>
        <p className="text-gray-500 text-sm mt-1">You won&apos;t get any more alerts for it.</p>
        <a href="https://camphawk.app" className="inline-block mt-5 text-sm text-green-700 hover:underline">
          Back to CampHawk
        </a>
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

  const isRecGov = watch.source === 'ridb';
  const mapUrl =
    isRecGov
      ? `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`
      : watch.reservations_url;
  const token_ = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const staticMap =
    watch.latitude != null && watch.longitude != null && token_
      ? `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/static/pin-l+2e7d32(${watch.longitude},${watch.latitude})/${watch.longitude},${watch.latitude},12/600x240@2x?access_token=${token_}`
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

        {/* Pause / resume + Remove */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => act(watch.active ? 'stop' : 'resume')}
            disabled={busy === 'stop' || busy === 'resume'}
            className={`flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-50 ${
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
            {watch.active ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={removeWatch}
            disabled={busy === 'remove'}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm text-red-600 bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            {busy === 'remove' ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Remove
          </button>
        </div>
        {!watch.active && (
          <p className="text-xs text-gray-400 mt-2 text-center">Paused — you won&apos;t get alerts until you resume.</p>
        )}
      </div>

      {/* Sites */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Tent size={15} className="text-green-600" /> Sites
        </h2>
        <p className="text-xs text-gray-400 mt-1">Mute any site to skip alerts for it — even before it opens.</p>
        {allSites === null ? (
          <div className="flex items-center gap-2 text-gray-400 text-xs py-6 justify-center">
            <Loader2 size={14} className="animate-spin" /> Loading sites…
          </div>
        ) : allSites.length === 0 ? (
          <p className="text-xs text-gray-400 mt-3">
            No individual sites to list for this campground.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
            {allSites.map((s) => {
              const isMuted = muted.has(s.id);
              return (
                <li key={s.id} className="flex items-center justify-between gap-3">
                  <span className={`text-sm truncate ${isMuted ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                    {s.name || `Site ${s.id}`}
                    {s.loop && <span className="text-gray-400 font-normal"> · {s.loop}</span>}
                  </span>
                  <button
                    onClick={() => act(isMuted ? 'unmute' : 'mute', s.id)}
                    disabled={busy === (isMuted ? 'unmute' : 'mute') + s.id}
                    className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${
                      isMuted
                        ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        : 'bg-green-50 text-green-700 hover:bg-green-100'
                    }`}
                  >
                    {busy === (isMuted ? 'unmute' : 'mute') + s.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : isMuted ? (
                      <BellOff size={12} />
                    ) : (
                      <BellOn size={12} />
                    )}
                    {isMuted ? 'Muted' : 'Mute'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Campsite map */}
        {(staticMap || mapUrl) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h3 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-2">
              <MapIcon size={13} className="text-green-600" /> Campsite map
            </h3>
            {staticMap && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={staticMap}
                alt={`Map of ${watch.campground_name}`}
                className="w-full rounded-xl border border-gray-100"
              />
            )}
            {mapUrl && (
              <a
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-green-700 hover:underline"
              >
                <ExternalLink size={12} />
                {isRecGov ? 'Open the interactive campsite map on Recreation.gov' : 'View campsite map on the booking site'}
              </a>
            )}
          </div>
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
          <ul className="mt-3 space-y-2.5 max-h-72 overflow-y-auto pr-1">
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
