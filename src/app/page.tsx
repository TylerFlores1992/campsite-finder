'use client';

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, Map as MapIcon, List, AlertCircle, Bell } from 'lucide-react';
import { useUser, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import SearchBar from '@/components/SearchBar';
import CampgroundCard from '@/components/CampgroundCard';
import Filters, { FilterState } from '@/components/Filters';
import QuickFilters, { getTonight, getThisWeekend } from '@/components/QuickFilters';
import WatchesPanel from '@/components/WatchesPanel';
import Logo from '@/components/Logo';
import SubscribeGate from '@/components/SubscribeGate';
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
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [watchesOpen, setWatchesOpen] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [everSubscribed, setEverSubscribed] = useState(false);
  const [subLoaded, setSubLoaded] = useState(false);

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
      setSearchState(state);

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

  // Signed-in users without an active subscription (new, expired, or cancelled)
  // get the full-screen subscribe gate — no usable app without a subscription.
  if (isSignedIn && subLoaded && !isSubscribed) {
    return <SubscribeGate returning={everSubscribed} />;
  }

  return (
    <div className="flex flex-col min-h-screen md:h-screen bg-gray-50">
      {watchesOpen && (
        <WatchesPanel onClose={() => setWatchesOpen(false)} />
      )}
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 z-10 shadow-sm">
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
              }}
              aria-label="CampHawk home"
              className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
            >
              <Logo markSize={34} />
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (!isSignedIn) { window.location.href = '/sign-in'; return; }
                  setWatchesOpen(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 transition-colors"
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
                <div className="flex items-center gap-2">
                  <SignInButton mode="redirect">
                    <button className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                      Sign in
                    </button>
                  </SignInButton>
                  <SignUpButton mode="redirect">
                    <button className="text-sm px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors">
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
      <main className="flex-1 md:overflow-hidden max-w-screen-2xl mx-auto w-full">
        {!searchState ? (
          <div className="relative isolate h-full flex flex-col items-center justify-center text-center px-4 gap-6 overflow-y-auto pt-10 pb-24 bg-[#F3EFE0]">
            {/* CampHawk hero scene + soft scrim so text stays legible over it */}
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/hero-bg.png" alt="" className="h-full w-full object-cover object-center" />
              <div className="absolute inset-0 bg-gradient-to-b from-[#F3EFE0]/45 via-[#F3EFE0]/25 to-[#F3EFE0]/55" />
            </div>
            <h2 className="font-display text-4xl sm:text-5xl font-extrabold text-green-800 max-w-2xl leading-[1.08] [text-shadow:_0_1px_10px_rgb(255_255_255_/_0.7)]">
              Get notified the instant a campsite opens up
            </h2>
            <p className="text-gray-700 max-w-md text-lg leading-relaxed [text-shadow:_0_1px_8px_rgb(255_255_255_/_0.85)]">
              Search thousands of campgrounds across US public lands and California State Parks.
              When your spot is booked solid, CampHawk watches it around the clock and alerts you
              within seconds of a cancellation.
            </p>

            {/* Sample alert — shows the product's payoff at a glance */}
            <div className="w-full max-w-sm rounded-2xl bg-white border border-gray-100 shadow-lg p-4 text-left">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🦅</span>
                <span className="font-display font-semibold text-sm text-gray-800">CampHawk alert</span>
                <span className="ml-auto text-[10px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">just now</span>
              </div>
              <p className="text-sm text-gray-700">
                ⛺ <strong>Lower Pines, Yosemite</strong> just opened up for your dates
                <strong> Jul 10–12</strong>.
              </p>
              <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-amber-500 rounded-lg px-3 py-1.5">
                Book now on Recreation.gov →
              </div>
              <p className="mt-2 text-[11px] text-gray-400">⏱ Sent within seconds — act before it&apos;s gone.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2.5 max-w-lg">
              {[
                { icon: '⚡', label: 'Alerts in seconds, not hours' },
                { icon: '🏕️', label: 'Recreation.gov + CA State Parks' },
                { icon: '📱', label: 'Email & text notifications' },
              ].map((f) => (
                <span
                  key={f.label}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-600 bg-white border border-gray-100 rounded-full px-3.5 py-1.5 shadow-sm"
                >
                  <span>{f.icon}</span> {f.label}
                </span>
              ))}
            </div>
            {isSignedIn ? (
              <button
                onClick={handleTonight}
                className="mt-1 px-6 py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 text-white font-display font-semibold text-base shadow-md shadow-amber-500/25 transition-all hover:shadow-lg hover:-translate-y-0.5"
              >
                ⛺ Find a site for tonight
              </button>
            ) : (
              <div className="mt-1 flex flex-col items-center gap-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <SignUpButton mode="redirect">
                    <button className="px-7 py-3.5 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold text-base shadow-md transition-all hover:-translate-y-0.5">
                      Start your free trial
                    </button>
                  </SignUpButton>
                  <SignInButton mode="redirect">
                    <button className="px-7 py-3.5 rounded-2xl bg-white border border-gray-200 text-gray-700 font-display font-semibold text-base hover:bg-gray-50 transition-all">
                      Sign in
                    </button>
                  </SignInButton>
                </div>
                <p className="text-sm text-gray-600">7-day free trial · then $2.50/mo or $20/yr · cancel anytime</p>
              </div>
            )}

            <footer className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-4 text-xs text-gray-600 [text-shadow:_0_1px_6px_rgb(255_255_255_/_0.8)]">
              <span>© {new Date().getFullYear()} CampHawk</span>
              <a href="/terms" className="hover:text-green-800 underline-offset-2 hover:underline">Terms</a>
              <a href="/privacy" className="hover:text-green-800 underline-offset-2 hover:underline">Privacy</a>
            </footer>
          </div>
        ) : (
          <div
            id="search-results"
            className={`flex md:h-full ${
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
                  onSelect={setSelectedId}
                  center={searchState ? { lat: searchState.lat, lng: searchState.lng } : undefined}
                  radiusMiles={searchState?.radiusMiles}
                />
              </div>
            )}

            {/* List panel */}
            {view !== 'map' && (
              <div
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
                      {campgrounds.map((cg) => (
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
        )}
      </main>
    </div>
  );
}
