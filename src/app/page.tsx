'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, Map as MapIcon, List, AlertCircle, Bell } from 'lucide-react';
import { useUser, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import SearchBar from '@/components/SearchBar';
import CampgroundCard from '@/components/CampgroundCard';
import Filters, { FilterState } from '@/components/Filters';
import QuickFilters, { getTonight, getThisWeekend } from '@/components/QuickFilters';
import WatchesPanel from '@/components/WatchesPanel';
import Logo from '@/components/Logo';
import SubscribeGate, { SubscribeBanner } from '@/components/SubscribeGate';
import type { Campground } from '@/lib/types';

// Load map only client-side
const CampgroundMap = dynamic(() => import('@/components/Map'), { ssr: false });

interface SearchState {
  lat: number;
  lng: number;
  radiusMiles: number;
  startDate?: string;
  endDate?: string;
  focusCampgroundId?: string;
}

const DEFAULT_FILTERS: FilterState = {
  siteType: null,
  rvLength: null,
  pets: false,
  electric: false,
  water: false,
  showers: false,
};

export default function HomePage() {
  const { isSignedIn, user } = useUser();
  // Convenience link only; /admin is enforced server-side by ADMIN_EMAILS.
  const isAdmin = user?.primaryEmailAddress?.emailAddress?.toLowerCase() === 'tylerflores1992@gmail.com';
  const [view, setView] = useState<'split' | 'map' | 'list'>('split');
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [campgrounds, setCampgrounds] = useState<Campground[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Set only by a MAP PIN click, which hoists that campground to the top of the
  // list. Kept separate from selectedId on purpose: clicking a *card* selects it
  // too, and reordering the list under the cursor you just clicked is jarring.
  const [hoistId, setHoistId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [watchesOpen, setWatchesOpen] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [everSubscribed, setEverSubscribed] = useState(false);
  const [subLoaded, setSubLoaded] = useState(false);
  const [watchCount, setWatchCount] = useState<number | null>(null);

  // Clicking a pin puts that campground first in the list. Derived rather than a
  // splice of `campgrounds`, so the underlying distance ranking survives: picking
  // a different pin re-hoists from the original order instead of compounding
  // earlier moves, and clearing the selection restores it exactly.
  const orderedCampgrounds = useMemo(() => {
    if (!hoistId) return campgrounds;
    const idx = campgrounds.findIndex((c) => c.id === hoistId);
    if (idx <= 0) return campgrounds; // absent, or already first
    const next = campgrounds.slice();
    next.unshift(next.splice(idx, 1)[0]);
    return next;
  }, [campgrounds, hoistId]);

  // Pin click: select, hoist, and bring the hoisted card into view. In split view
  // on desktop the list is its own scroll container, so scrolling the page does
  // nothing — scroll the container itself. On mobile the list sits below the map
  // and isn't its own scroller, so bring the panel into view instead.
  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id);
    setHoistId(id);
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        el.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }, []);

  // Watch count for the subscriber home screen. Depends on watchesOpen so the
  // count refreshes after the panel closes (watches may have been removed).
  useEffect(() => {
    if (!isSignedIn || !isSubscribed) { setWatchCount(null); return; }
    fetch('/api/watches')
      .then((r) => (r.ok ? r.json() : { watches: [] }))
      .then((d) => setWatchCount((d.watches ?? []).length))
      .catch(() => {});
  }, [isSignedIn, isSubscribed, watchesOpen]);

  // Whether a phone number is saved — drives the "get text alerts" nudge on the
  // subscriber home. undefined = unknown, null = none saved. Refreshes when the
  // Watches panel closes (the compliant SMS opt-in form lives there).
  const [phone, setPhone] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isSignedIn || !isSubscribed) { setPhone(undefined); return; }
    fetch('/api/user/phone')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { phone?: string | null }) => setPhone(d.phone ?? null))
      .catch(() => {});
  }, [isSignedIn, isSubscribed, watchesOpen]);

  // Hide the Auto-cart nudge once setup is genuinely finished: toggle ON and the
  // one-time rec.gov sign-in completed on the bot machine (reported by the bot).
  const [autocartDone, setAutocartDone] = useState(false);
  useEffect(() => {
    if (!isSignedIn || !isSubscribed) { setAutocartDone(false); return; }
    fetch('/api/user/autocart')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { enabled?: boolean; connected?: boolean }) => setAutocartDone(!!d.enabled && !!d.connected))
      .catch(() => {});
  }, [isSignedIn, isSubscribed, watchesOpen]);

  // Restore a search from the URL on first load, so pressing "Back to results"
  // on a campground detail page returns to the results instead of the landing.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const lat = sp.get('lat');
    const lng = sp.get('lng');
    if (!lat || !lng) return;
    const restored: FilterState = {
      siteType: (sp.get('siteType') as FilterState['siteType']) ?? null,
      rvLength: sp.get('rvLength') ? Number(sp.get('rvLength')) : null,
      pets: sp.get('pets') === '1',
      electric: sp.get('electric') === '1',
      water: sp.get('water') === '1',
      showers: sp.get('showers') === '1',
    };
    setFilters(restored);
    search(
      {
        lat: Number(lat),
        lng: Number(lng),
        radiusMiles: Number(sp.get('radius') ?? 25),
        startDate: sp.get('startDate') ?? undefined,
        endDate: sp.get('endDate') ?? undefined,
        focusCampgroundId: sp.get('focus') ?? undefined,
      },
      restored
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load favorites when signed in
  useEffect(() => {
    if (!isSignedIn) { setFavorites(new Set()); return; }
    fetch('/api/favorites')
      .then((r) => r.ok ? r.json() : { favorites: [] })
      .then((data) => setFavorites(new Set(data.favorites ?? [])))
      .catch(() => {});
  }, [isSignedIn]);

  // Load subscription status when signed in. After returning from Stripe
  // (?subscribed=1) the webhook may lag, so poll a few times until active.
  useEffect(() => {
    if (!isSignedIn) { setIsSubscribed(false); setSubLoaded(true); return; }
    const justPaid = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('subscribed');
    let cancelled = false;
    let tries = 0;

    async function poll() {
      try {
        const r = await fetch('/api/subscription/status');
        const data = r.ok ? await r.json() : { active: false, everSubscribed: false };
        if (cancelled) return;
        setIsSubscribed(!!data.active);
        setEverSubscribed(!!data.everSubscribed);
        setSubLoaded(true);
        if (justPaid && !data.active && tries++ < 5) setTimeout(poll, 2000);
      } catch {
        if (!cancelled) setSubLoaded(true);
      }
    }
    setSubLoaded(false);
    poll();
    return () => { cancelled = true; };
  }, [isSignedIn]);

  async function openBillingPortal() {
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.message || "We couldn't open your billing portal. Please try again or contact support.");
      }
    } catch {
      alert("We couldn't open your billing portal. Please try again.");
    }
  }

  const search = useCallback(
    async (state: SearchState, activeFilters: FilterState = filters) => {
      setLoading(true);
      setError(null);
      setHoistId(null); // a pin hoist from the previous result set shouldn't carry over
      setSearchState(state);

      // Mirror the search into the URL so "Back to results" from a campground
      // detail page restores this exact search (see the restore-on-mount effect).
      if (typeof window !== 'undefined') {
        const urlp = new URLSearchParams({
          lat: String(state.lat),
          lng: String(state.lng),
          radius: String(state.radiusMiles),
          ...(state.startDate ? { startDate: state.startDate } : {}),
          ...(state.endDate ? { endDate: state.endDate } : {}),
          ...(state.focusCampgroundId ? { focus: state.focusCampgroundId } : {}),
          ...(activeFilters.siteType ? { siteType: activeFilters.siteType } : {}),
          ...(activeFilters.siteType === 'rv' && activeFilters.rvLength ? { rvLength: String(activeFilters.rvLength) } : {}),
          ...(activeFilters.pets ? { pets: '1' } : {}),
          ...(activeFilters.electric ? { electric: '1' } : {}),
          ...(activeFilters.water ? { water: '1' } : {}),
          ...(activeFilters.showers ? { showers: '1' } : {}),
        });
        window.history.replaceState(null, '', `/?${urlp.toString()}`);
      }

      const amenities: string[] = [];
      if (activeFilters.electric) amenities.push('electric hookup');
      if (activeFilters.water) amenities.push('drinking water');
      if (activeFilters.showers) amenities.push('showers');

      const params = new URLSearchParams({
        lat: String(state.lat),
        lng: String(state.lng),
        radius: String(state.radiusMiles),
        ...(state.startDate ? { startDate: state.startDate } : {}),
        ...(state.endDate ? { endDate: state.endDate } : {}),
        ...(activeFilters.siteType ? { siteType: activeFilters.siteType } : {}),
        ...(activeFilters.siteType === 'rv' && activeFilters.rvLength
          ? { rvLength: String(activeFilters.rvLength) }
          : {}),
        ...(amenities.length > 0 ? { amenities: amenities.join(',') } : {}),
      });

      try {
        const res = await fetch(`/api/search?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Search failed');

        let results: Campground[] = data.campgrounds ?? [];
        if (activeFilters.pets) results = results.filter((c) => c.petsAllowed);

        // If the user picked a specific campground from the suggestions,
        // pin it to the top of the list (even when fully booked) and select it.
        if (state.focusCampgroundId) {
          const idx = results.findIndex((c) => c.id === state.focusCampgroundId);
          if (idx > 0) {
            const [focus] = results.splice(idx, 1);
            results.unshift(focus);
          }
          if (idx >= 0) setSelectedId(state.focusCampgroundId);
        }

        setCampgrounds(results);

        // On mobile the search form fills the whole screen, pushing results below
        // the fold — scroll them into view so a search visibly produces results.
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          requestAnimationFrame(() =>
            setTimeout(
              () =>
                document
                  .getElementById('search-results')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
              80
            )
          );
        }
      } catch (err) {
        setError((err as Error).message);
        setCampgrounds([]);
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  function handleFiltersChange(newFilters: FilterState) {
    setFilters(newFilters);
    if (searchState) search(searchState, newFilters);
  }

  async function toggleFavorite(campgroundId: string) {
    if (!isSignedIn) { window.location.href = '/sign-in'; return; }
    const isFav = favorites.has(campgroundId);
    const next = new Set(favorites);

    if (isFav) {
      next.delete(campgroundId);
      setFavorites(next);
      await fetch(`/api/favorites?campgroundId=${campgroundId}`, { method: 'DELETE' });
    } else {
      next.add(campgroundId);
      setFavorites(next);
      await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campgroundId }),
      });
    }
  }

  function handleTonight() {
    if (!searchState) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { start, end } = getTonight();
        search({ lat: pos.coords.latitude, lng: pos.coords.longitude, radiusMiles: 50, startDate: start, endDate: end });
      });
    } else {
      const { start, end } = getTonight();
      search({ ...searchState, startDate: start, endDate: end });
    }
  }

  function handleThisWeekend() {
    if (!searchState) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { start, end } = getThisWeekend();
        search({ lat: pos.coords.latitude, lng: pos.coords.longitude, radiusMiles: 100, startDate: start, endDate: end });
      });
    } else {
      const { start, end } = getThisWeekend();
      search({ ...searchState, startDate: start, endDate: end });
    }
  }

  // Signed-in users without an active subscription can still SEARCH (same as
  // signed-out visitors) — the hero swaps to a marketing/subscribe panel and a
  // slim banner rides above results. Watch creation stays server-gated (402).
  const needsSubscription = isSignedIn && subLoaded && !isSubscribed;

  const showLandingBg = !searchState;

  return (
    <div className={`relative flex flex-col min-h-screen ${searchState ? 'md:h-screen' : ''} ${showLandingBg ? 'bg-transparent' : 'bg-gray-50'}`}>
      {/* Full-screen landing scene — one continuous background behind the header
          and hero on the landing views (hidden once a search is active). */}
      {showLandingBg && (
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/hero-bg-wide.png" alt="" className="h-full w-full object-cover object-[28%_22%] md:object-bottom md:translate-y-[12%]" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/85 via-background/70 to-background/60" />
        </div>
      )}
      {watchesOpen && (
        <WatchesPanel onClose={() => setWatchesOpen(false)} />
      )}
      {/* Header */}
      <header className={`${showLandingBg ? 'bg-transparent border-transparent' : 'bg-background/90 border-gray-200'} backdrop-blur px-3 sm:px-4 py-3 z-10 border-b`}>
        <div className="max-w-screen-2xl mx-auto space-y-3">
          {/* Top row: brand + actions (wraps cleanly on mobile) */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setSearchState(null);
                setCampgrounds([]);
                setSelectedId(null);
                setError(null);
                if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
              }}
              aria-label="CampHawk home"
              className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
            >
              <Logo markSize={40} />
            </button>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => {
                  if (!isSignedIn) { window.location.href = '/sign-in'; return; }
                  setWatchesOpen(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-amber-700 transition-colors"
                title="My watches"
              >
                <Bell size={15} />
                <span className="hidden sm:inline">Watches</span>
              </button>

              {/* Auth */}
              {isSignedIn ? (
                <div className="flex items-center gap-2">
                  {isAdmin && (
                    <a
                      href="/admin"
                      className="text-sm px-3 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                    >
                      Admin
                    </a>
                  )}
                  {isSubscribed && (
                    <button
                      onClick={openBillingPortal}
                      className="hidden sm:block text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      Manage subscription
                    </button>
                  )}
                  <UserButton />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <SignInButton mode="redirect">
                    <button className="text-sm font-medium px-2.5 sm:px-3 py-1.5 rounded-lg text-gray-700 hover:bg-gray-50 hover:text-green-800 transition-colors">
                      Sign in
                    </button>
                  </SignInButton>
                  <SignUpButton mode="redirect">
                    <button className="text-sm font-semibold px-4 sm:px-5 py-2 rounded-full bg-green-800 text-white hover:bg-green-900 shadow-sm transition-colors">
                      Sign up
                    </button>
                  </SignUpButton>
                </div>
              )}
            </div>
          </div>

          {/* Search row */}
          <SearchBar onSearch={(p) => search(p)} />

          {/* Filters + view toggle only matter once there are results. On mobile
              the filter chips scroll horizontally instead of stacking tall. */}
          {searchState && (
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              {/* Chips wrap onto multiple lines at every width so all filters are
                  visible without swiping (wide screens still fit on one row). */}
              <div className="order-2 md:order-1 flex flex-wrap items-center gap-2 md:gap-3">
                <QuickFilters onTonight={handleTonight} onThisWeekend={handleThisWeekend} />
                <Filters filters={filters} onChange={handleFiltersChange} />
              </div>

              {/* View toggle — own row (top-right) on mobile, right side on desktop */}
              <div className="order-1 md:order-2 self-end md:self-auto flex rounded-lg border border-gray-200 overflow-hidden bg-white shrink-0">
                {(['split', 'map', 'list'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      view === v ? 'bg-green-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {v === 'split' ? (
                      <span className="flex items-center gap-1"><MapIcon size={13} /><List size={13} /></span>
                    ) : v === 'map' ? (
                      <MapIcon size={13} />
                    ) : (
                      <List size={13} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main
        className={`flex-1 max-w-screen-2xl mx-auto w-full ${
          searchState ? 'md:flex md:flex-col md:overflow-hidden' : ''
        }`}
      >
        {!searchState && needsSubscription ? (
          <SubscribeGate returning={everSubscribed} />
        ) : !searchState && !isSignedIn ? (
          <SubscribeGate signedOut />
        ) : !searchState ? (
          <div className="relative isolate h-full flex flex-col items-center justify-center text-center px-4 gap-6 overflow-y-auto pt-10 pb-24">
            {/* Only active subscribers reach this hero (visitors and unsubscribed
                users get the SubscribeGate marketing panel instead) — so skip the
                sales pitch and get them moving. */}
            <h2 className="font-display text-3xl sm:text-4xl font-extrabold text-green-800 max-w-xl leading-tight [text-shadow:_0_1px_10px_rgb(255_255_255_/_0.7)]">
              Welcome back{user?.firstName ? `, ${user.firstName}` : ''} — where to next?
            </h2>
            <p className="text-gray-700 max-w-md text-base sm:text-lg leading-relaxed [text-shadow:_0_1px_8px_rgb(255_255_255_/_0.85)]">
              Search a spot above, jump into a quick trip, or check on your watches.
            </p>

            {/* Quick actions */}
            <div className="flex flex-wrap justify-center gap-3">
              <button
                onClick={handleTonight}
                className="px-6 py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 text-white font-display font-semibold text-base shadow-md shadow-amber-500/25 transition-all hover:shadow-lg hover:-translate-y-0.5"
              >
                ⛺ Tonight
              </button>
              <button
                onClick={handleThisWeekend}
                className="px-6 py-3 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold text-base shadow-md transition-all hover:shadow-lg hover:-translate-y-0.5"
              >
                🌲 This weekend
              </button>
              <button
                onClick={() => setWatchesOpen(true)}
                className="px-6 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-display font-semibold text-base shadow-sm hover:bg-gray-50 transition-all"
              >
                🔔 My watches{watchCount !== null ? ` (${watchCount})` : ''}
              </button>
            </div>

            {watchCount === 0 && (
              <p className="text-sm text-gray-600 max-w-sm [text-shadow:_0_1px_6px_rgb(255_255_255_/_0.8)]">
                No watches yet — search a booked campground and tap <strong>Watch</strong> to get
                cancellation alerts.
              </p>
            )}

            {/* Cross-sell the newest feature — hidden once auto-cart is on AND the
                one-time rec.gov sign-in has completed. */}
            {!autocartDone && (
              <button
                onClick={() => setWatchesOpen(true)}
                className="inline-flex items-center gap-2 text-sm text-gray-700 bg-white/90 border border-amber-200 rounded-full px-4 py-2 shadow-sm hover:bg-amber-50 transition-colors"
              >
                <span className="text-[10px] font-bold text-white bg-amber-500 rounded-full px-1.5 py-0.5">NEW</span>
                ⚡ Auto-cart — openings land in your recreation.gov cart automatically. Turn it on →
              </button>
            )}

            {/* Text-alert nudge — only when no number is saved. Opens the Watches
                panel, where the carrier-compliant SMS opt-in form lives. */}
            {phone === null && (
              <button
                onClick={() => setWatchesOpen(true)}
                className="inline-flex items-center gap-2 text-sm text-gray-700 bg-white/90 border border-green-200 rounded-full px-4 py-2 shadow-sm hover:bg-green-50 transition-colors"
              >
                📱 Get alerts by text too — add your phone number →
              </button>
            )}

            <footer className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-4 text-xs text-gray-600 [text-shadow:_0_1px_6px_rgb(255_255_255_/_0.8)]">
              <span>© {new Date().getFullYear()} CampHawk</span>
              <a href="/terms" className="hover:text-green-800 underline-offset-2 hover:underline">Terms</a>
              <a href="/privacy" className="hover:text-green-800 underline-offset-2 hover:underline">Privacy</a>
            </footer>
          </div>
        ) : (
          <div className="flex flex-col md:h-full">
            {needsSubscription && <SubscribeBanner returning={everSubscribed} />}
            <div
              id="search-results"
              className={`flex flex-1 min-h-0 ${
                view === 'list' ? 'flex-col' : view === 'map' ? '' : 'flex-col md:flex-row'
              }`}
            >
            {/* Map panel */}
            {view !== 'list' && (
              <div
                className={`${
                  view === 'split'
                    ? 'w-full md:w-1/2 h-[45vh] [@media(max-height:720px)]:h-[34vh] md:h-full'
                    : 'w-full h-[70vh] md:h-full'
                } p-3`}
              >
                <CampgroundMap
                  campgrounds={campgrounds}
                  selectedId={selectedId}
                  onSelect={selectFromMap}
                  center={searchState ? { lat: searchState.lat, lng: searchState.lng } : undefined}
                  radiusMiles={searchState?.radiusMiles}
                />
              </div>
            )}

            {/* List panel */}
            {view !== 'map' && (
              <div
                ref={listRef}
                className={`${
                  view === 'split' ? 'w-full md:w-1/2 md:h-full' : 'w-full md:h-full'
                } md:overflow-y-auto p-3`}
              >
                {loading ? (
                  <div className="flex items-center justify-center h-32 gap-2 text-gray-500">
                    <Loader2 size={20} className="animate-spin" />
                    <span>Searching...</span>
                  </div>
                ) : error ? (
                  <div className="flex items-center gap-2 p-4 bg-red-50 rounded-xl text-red-600 text-sm">
                    <AlertCircle size={16} />
                    {error}
                  </div>
                ) : campgrounds.length === 0 ? (
                  <div className="text-center py-14 px-6">
                    <div className="text-5xl mb-3">🌲</div>
                    <p className="font-display text-lg font-semibold text-gray-700">
                      Nothing out here but trees
                    </p>
                    <p className="text-sm mt-1.5 text-gray-500 max-w-xs mx-auto">
                      Try a wider radius, different dates, or fewer filters — or search another
                      area entirely.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-gray-500 mb-3">
                      {campgrounds.length} campground{campgrounds.length !== 1 ? 's' : ''} found
                    </p>
                    {(!searchState?.startDate || !searchState?.endDate) && (
                      <div className="mb-3 flex flex-row items-center gap-2 rounded-xl bg-green-50 border border-green-100 px-3 py-2">
                        <p className="text-xs sm:text-sm text-green-800 flex-1 leading-snug">
                          <span className="mr-1">📅</span>
                          Add dates to see availability and set a cancellation alert.
                        </p>
                        <button
                          onClick={handleThisWeekend}
                          className="shrink-0 self-start sm:self-auto text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg px-3 py-1.5 transition-colors"
                        >
                          Try this weekend
                        </button>
                      </div>
                    )}
                    <div
                      className={`grid gap-3 ${
                        view === 'list'
                          ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                          : 'grid-cols-1'
                      }`}
                    >
                      {orderedCampgrounds.map((cg) => (
                        <CampgroundCard
                          key={cg.id}
                          campground={cg}
                          isSelected={selectedId === cg.id}
                          isFavorited={favorites.has(cg.id)}
                          onSelect={() => setSelectedId(cg.id)}
                          onFavorite={() => toggleFavorite(cg.id)}
                          searchDates={
                            searchState?.startDate && searchState?.endDate
                              ? { startDate: searchState.startDate, endDate: searchState.endDate }
                              : undefined
                          }
                          siteType={filters.siteType}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
