'use client';

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, Map as MapIcon, List, AlertCircle, Bell } from 'lucide-react';
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
}

const DEFAULT_FILTERS: FilterState = {
  siteType: null,
  pets: false,
  ada: false,
  electric: false,
  water: false,
  showers: false,
};

function getUserId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem('campsite-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('campsite-user-id', id);
  }
  return id;
}

export default function HomePage() {
  const [view, setView] = useState<'split' | 'map' | 'list'>('split');
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [campgrounds, setCampgrounds] = useState<Campground[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [watchesOpen, setWatchesOpen] = useState(false);

  // Load favorites on mount
  useEffect(() => {
    const userId = getUserId();
    if (!userId) return;
    fetch(`/api/favorites?userId=${userId}`)
      .then((r) => r.json())
      .then((data) => setFavorites(new Set(data.favorites ?? [])))
      .catch(() => {});
  }, []);

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
        ...(amenities.length > 0 ? { amenities: amenities.join(',') } : {}),
      });

      try {
        const res = await fetch(`/api/search?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Search failed');

        let results: Campground[] = data.campgrounds ?? [];
        if (activeFilters.pets) results = results.filter((c) => c.petsAllowed);
        if (activeFilters.ada) results = results.filter((c) => c.adaAccessible);

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
    const userId = getUserId();
    const isFav = favorites.has(campgroundId);
    const next = new Set(favorites);

    if (isFav) {
      next.delete(campgroundId);
      setFavorites(next);
      await fetch(`/api/favorites?campgroundId=${campgroundId}&userId=${userId}`, {
        method: 'DELETE',
      });
    } else {
      next.add(campgroundId);
      setFavorites(next);
      await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
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
        <WatchesPanel userId={getUserId()} onClose={() => setWatchesOpen(false)} />
      )}
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 z-10 shadow-sm">
        <div className="max-w-screen-2xl mx-auto space-y-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-green-700 shrink-0">⛺ CampsiteFinder</h1>
            <div className="flex-1">
              <SearchBar onSearch={(p) => search(p)} />
            </div>
            <button
              onClick={() => setWatchesOpen(true)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 transition-colors"
              title="My watches"
            >
              <Bell size={15} />
              <span className="hidden sm:inline">Watches</span>
            </button>
          </div>

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
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-4">
            <div className="text-6xl">⛺</div>
            <h2 className="text-2xl font-bold text-gray-800">Find your next campsite</h2>
            <p className="text-gray-500 max-w-md">
              Search by location to see available campsites near you. Filter by dates, site type,
              and amenities to find the perfect spot.
            </p>
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
              view === 'list' ? 'flex-col' : view === 'map' ? '' : 'flex-row'
            }`}
          >
            {/* Map panel */}
            {view !== 'list' && (
              <div className={`${view === 'split' ? 'w-1/2' : 'w-full'} h-full p-3`}>
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
                className={`${view === 'split' ? 'w-1/2' : 'w-full'} h-full overflow-y-auto p-3`}
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
                          userId={getUserId()}
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
