'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, MapPin, Loader2, Tent } from 'lucide-react';

interface SearchBarProps {
  onSearch: (params: {
    lat: number;
    lng: number;
    radiusMiles: number;
    startDate?: string;
    endDate?: string;
  }) => void;
}

interface PlaceSuggestion {
  name: string;
  lat: number;
  lng: number;
}

interface CampgroundSuggestion {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

const RADIUS_OPTIONS = [25, 50, 100, 200];

export default function SearchBar({ onSearch }: SearchBarProps) {
  const router = useRouter();
  const [location, setLocation] = useState('');
  const [radiusMiles, setRadiusMiles] = useState(50);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);

  const [places, setPlaces] = useState<PlaceSuggestion[]>([]);
  const [campgroundHits, setCampgroundHits] = useState<CampgroundSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lng: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close suggestions on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function handleLocationInput(value: string) {
    setLocation(value);
    setPickedCoords(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2 || value === 'Current location') {
      setPlaces([]);
      setCampgroundHits([]);
      setShowSuggestions(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
      const [placeRes, cgRes] = await Promise.allSettled([
        fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?country=US&types=place,region&access_token=${token}&limit=4`
        ).then((r) => r.json()),
        fetch(`/api/suggest?q=${encodeURIComponent(value)}`).then((r) => r.json()),
      ]);

      const newPlaces: PlaceSuggestion[] =
        placeRes.status === 'fulfilled'
          ? (placeRes.value.features ?? []).map((f: { place_name: string; center: [number, number] }) => ({
              name: f.place_name.replace(', United States', ''),
              lng: f.center[0],
              lat: f.center[1],
            }))
          : [];
      const newCgs: CampgroundSuggestion[] =
        cgRes.status === 'fulfilled' ? cgRes.value.campgrounds ?? [] : [];

      setPlaces(newPlaces);
      setCampgroundHits(newCgs);
      setShowSuggestions(newPlaces.length > 0 || newCgs.length > 0);
    }, 250);
  }

  function pickPlace(p: PlaceSuggestion) {
    setLocation(p.name);
    setPickedCoords({ lat: p.lat, lng: p.lng });
    setShowSuggestions(false);
    onSearch({
      lat: p.lat,
      lng: p.lng,
      radiusMiles,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
  }

  function pickCampground(cg: CampgroundSuggestion) {
    setShowSuggestions(false);
    router.push(`/campground/${cg.id}`);
  }

  function useCurrentLocation() {
    setLocating(true);
    setShowSuggestions(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocation('Current location');
        setPickedCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        onSearch({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          radiusMiles,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        });
      },
      () => {
        setLocating(false);
        alert('Could not get your location. Try entering a city or address instead.');
      },
      { timeout: 10000 }
    );
  }

  async function geocodeAndSearch() {
    if (!location) return;
    setGeocoding(true);
    try {
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?country=US&types=place,address,region&access_token=${token}&limit=1`
      );
      const data = await res.json();
      const [lng, lat] = data.features?.[0]?.center ?? [];
      if (!lat || !lng) {
        alert('Could not find that location. Try a city name like "Denver, CO".');
        return;
      }
      onSearch({ lat, lng, radiusMiles, startDate: startDate || undefined, endDate: endDate || undefined });
    } catch {
      alert('Geocoding failed. Check your Mapbox token.');
    } finally {
      setGeocoding(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setShowSuggestions(false);
    if (pickedCoords) {
      onSearch({
        lat: pickedCoords.lat,
        lng: pickedCoords.lng,
        radiusMiles,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
    } else if (location === 'Current location') {
      navigator.geolocation.getCurrentPosition((pos) => {
        onSearch({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          radiusMiles,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        });
      });
    } else {
      geocodeAndSearch();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap gap-2 items-end bg-white rounded-2xl shadow-lg border border-gray-200 p-3"
    >
      {/* Location input + suggestions */}
      <div className="flex-1 min-w-48 relative" ref={wrapperRef}>
        <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
        <div className="relative flex items-center">
          <Search size={14} className="absolute left-2.5 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder="City, park, or campground name"
            value={location}
            onChange={(e) => handleLocationInput(e.target.value)}
            onFocus={() => {
              if (places.length > 0 || campgroundHits.length > 0) setShowSuggestions(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowSuggestions(false);
            }}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
          />
          <button
            type="button"
            onClick={useCurrentLocation}
            title="Use my location"
            className="absolute right-2 text-gray-400 hover:text-green-600 transition-colors"
          >
            {locating ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
          </button>
        </div>

        {showSuggestions && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden z-50">
            {places.length > 0 && (
              <div>
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Places</p>
                {places.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => pickPlace(p)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-green-50 flex items-center gap-2"
                  >
                    <MapPin size={13} className="text-gray-400 shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
            {campgroundHits.length > 0 && (
              <div className={places.length > 0 ? 'border-t border-gray-100' : ''}>
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Campgrounds</p>
                {campgroundHits.map((cg) => (
                  <button
                    key={cg.id}
                    type="button"
                    onClick={() => pickCampground(cg)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-green-50 flex items-center gap-2"
                  >
                    <Tent size={13} className="text-green-600 shrink-0" />
                    <span className="truncate">{cg.name}</span>
                    {(cg.city || cg.state) && (
                      <span className="text-xs text-gray-400 shrink-0 ml-auto">
                        {[cg.city, cg.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Radius */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Radius</label>
        <select
          value={radiusMiles}
          onChange={(e) => setRadiusMiles(Number(e.target.value))}
          className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 bg-white"
        >
          {RADIUS_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r} mi
            </option>
          ))}
        </select>
      </div>

      {/* Dates */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Check-in</label>
        <input
          type="date"
          value={startDate}
          min={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setStartDate(e.target.value)}
          className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Check-out</label>
        <input
          type="date"
          value={endDate}
          min={startDate || new Date().toISOString().slice(0, 10)}
          onChange={(e) => setEndDate(e.target.value)}
          className="py-2 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
        />
      </div>

      <button
        type="submit"
        disabled={!location || geocoding}
        className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
      >
        {geocoding ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        Search
      </button>
    </form>
  );
}
