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
  ada: false,
  electric: false,
  water: false,
  showers: false,
};

export default function HomePage() {
  const { isSignedIn } = useUser();
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

  // Load favorites when signed in
  useEffect(() => {
    if (!isSignedIn) { setFavorites(new Set()); return; }
    fetch('/api/favorites')
      .then((r) => r.ok ? r.json() : { favorites: [] })
      .then((data) => setFavorites(new Set(data.favorites ?? [])))
      .catch(() => {});
  }, [isSignedIn]);

  // Load subscription status when signed in
  useEffect(() => {
    if (!isSignedIn) { setIsSubscribed(false); return; }
    fetch('/api/subscription/status')
      .then((r) => r.ok ? r.json() : { active: false })
      .then((data) => setIsSubscribed(!!data.active))
      .catch(() => {});
  }, [isSignedIn]);

  async function openBillingPortal() {
    const res = await fetch('/api/stripe/portal', { method: 'POST' });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
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
        if (activeFilters.ada) results = results.filter((c) => c.adaAccessible);

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

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {watchesOpen && (
        <WatchesPanel onClose={() => setWatchesOpen(false)} />
      )}
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 z-10 shadow-sm">
        <div className="max-w-screen-2xl mx-auto space-y-3">
          {/* Top row: brand + actions (wraps cleanly on mobile) */}
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl font-bold text-green-800 shrink-0 flex items-center gap-1.5">
              <span className="text-2xl">🦅</span> Camp Hawk
            </h1>
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

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <QuickFilters onTonight={handleTonight} onThisWeekend={handleThisWeekend} />
              <Filters filters={filters} onChange={handleFiltersChange} />
            </div>

            {/* View toggle */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden bg-white shrink-0">
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
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden max-w-screen-2xl mx-auto w-full">
        {!searchState ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-5 overflow-y-auto py-8">
            <div className="text-6xl">🦅</div>
            <h2 className="text-3xl font-bold text-gray-800">Snag campsites the moment they open</h2>
            <p className="text-gray-500 max-w-md">
              Search thousands of campgrounds across US public lands and California State Parks —
              and when your spot is booked solid, Camp Hawk watches it and alerts you within
              seconds of a cancellation.
            </p>
            <div className="flex flex-wrap justify-center gap-3 max-w-lg">
              {[
                { icon: '⚡', label: 'Alerts in seconds, not hours' },
                { icon: '🏕️', label: 'Recreation.gov + CA State Parks' },
                { icon: '📱', label: 'Email & text notifications' },
              ].map((f) => (
                <span
                  key={f.label}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-600 bg-white border border-gray-200 rounded-full px-3 py-1.5 shadow-sm"
                >
                  <span>{f.icon}</span> {f.label}
                </span>
              ))}
            </div>
            <p className="text-sm text-gray-400">
              Or hit{' '}
              <button onClick={handleTonight} className="text-amber-600 font-medium underline">
                Available tonight
              </button>{' '}
              to find something right now.
            </p>
          </div>
        ) : (
          <div
            className={`h-full flex ${
              view === 'list' ? 'flex-col' : view === 'map' ? '' : 'flex-col md:flex-row'
            }`}
          >
            {/* Map panel */}
            {view !== 'list' && (
              <div
                className={`${
                  view === 'split' ? 'w-full md:w-1/2 h-2/5 md:h-full' : 'w-full h-full'
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
                  view === 'split' ? 'w-full md:w-1/2 h-3/5 md:h-full' : 'w-full h-full'
                } overflow-y-auto p-3`}
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
                  <div className="text-center py-12 text-gray-500">
                    <p className="text-lg font-medium">No campgrounds found</p>
                    <p className="text-sm mt-1">Try expanding your radius or adjusting filters.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-gray-500 mb-3">
                      {campgrounds.length} campground{campgrounds.length !== 1 ? 's' : ''} found
                    </p>
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
