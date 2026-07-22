'use client';

import { useState, useRef, useEffect } from 'react';
import { Search, MapPin, Loader2, Tent } from 'lucide-react';
import DateRangePicker from './DateRangePicker';

interface SearchBarProps {
  onSearch: (params: {
    lat: number;
    lng: number;
    radiusMiles: number;
    startDate?: string;
    endDate?: string;
    flexNights?: number;
    flexDays?: 'weekend';
    focusCampgroundId?: string;
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
  latitude: number;
  longitude: number;
}

const RADIUS_OPTIONS = [10, 25, 50, 100, 200];

interface MapboxFeature {
  center?: [number, number];
  place_name?: string;
  id?: string;
  properties?: { short_code?: string };
  context?: { id: string; short_code?: string; text?: string }[];
}

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** Parse a US state from the tail of a query, e.g. "Yosemite, CA" or "Bend, Oregon". */
function stateFromQuery(q: string): string | null {
  const seg = q.split(',').pop()?.trim().toLowerCase() ?? '';
  if (/^[a-z]{2}$/.test(seg)) return seg.toUpperCase();
  return US_STATES[seg] ?? null;
}

/** The two-letter state code a Mapbox feature sits in (from its region context). */
function featureStateCode(f: MapboxFeature): string | null {
  if (f.id?.startsWith('region')) {
    return f.properties?.short_code?.replace(/^US-/i, '').toUpperCase() ?? null;
  }
  const region = (f.context ?? []).find((c) => c.id?.startsWith('region'));
  return region?.short_code?.replace(/^US-/i, '').toUpperCase() ?? null;
}

export default function SearchBar({ onSearch }: SearchBarProps) {
  const [location, setLocation] = useState('');
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Flexible dates (feature C): treat [startDate, endDate] as a window and match any
  // `flexNights` consecutive nights inside it, optionally weekends-only.
  const [flexOn, setFlexOn] = useState(false);
  const [flexNights, setFlexNights] = useState(2);
  const [flexWeekend, setFlexWeekend] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);

  const [places, setPlaces] = useState<PlaceSuggestion[]>([]);
  const [campgroundHits, setCampgroundHits] = useState<CampgroundSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [focusCampgroundId, setFocusCampgroundId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Dates + flexible-date payload shared by every search entry point.
  function dateParams() {
    return {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      ...(flexOn && startDate && endDate
        ? { flexNights, ...(flexWeekend ? { flexDays: 'weekend' as const } : {}) }
        : {}),
    };
  }

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
    setFocusCampgroundId(null);

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
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?country=US&types=place,locality,region,poi&access_token=${token}&limit=5`
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
      ...dateParams(),
    });
  }

  // Fill the location with the campground so the user can finish dates/radius;
  // the search will center on it and pin it to the top of the results.
  function pickCampground(cg: CampgroundSuggestion) {
    setLocation(cg.name);
    setPickedCoords({ lat: cg.latitude, lng: cg.longitude });
    setFocusCampgroundId(cg.id);
    setShowSuggestions(false);
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
          ...dateParams(),
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
      // 1. Prefer our own campground DB — it knows park/area names (e.g.
      //    "Yosemite") that Mapbox mis-geocodes to a tiny town in Kentucky.
      const sug = await fetch(`/api/suggest?q=${encodeURIComponent(location)}`)
        .then((r) => r.json())
        .catch(() => ({ campgrounds: [] }));
      const cg = sug.campgrounds?.[0];
      if (cg?.latitude && cg?.longitude) {
        onSearch({
          lat: cg.latitude,
          lng: cg.longitude,
          radiusMiles,
          ...dateParams(),
        });
        return;
      }

      // 2. Fall back to Mapbox for plain place/city names.
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
      // autocomplete=false: this is a full submitted query, so do real geocoding
      // (prefix/autocomplete mode fuzzy-matches tokens and never surfaces
      // "Yosemite, CA" as the park). Include POIs (parks are POIs) + several
      // candidates so we can prefer the one in the state the user typed.
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?country=US&types=place,locality,region,poi&autocomplete=false&limit=5&access_token=${token}`
      );
      const data = await res.json();
      const feats: MapboxFeature[] = data.features ?? [];
      if (feats.length === 0) {
        alert('Could not find that location. Try a city name like "Denver, CO".');
        return;
      }

      // If the query names a US state, prefer a candidate actually in that state.
      const wantState = stateFromQuery(location);
      const chosen =
        (wantState && feats.find((f) => featureStateCode(f) === wantState)) || feats[0];
      const [lng, lat] = chosen.center ?? [];
      if (!lat || !lng) {
        alert('Could not find that location. Try a city name like "Denver, CO".');
        return;
      }
      onSearch({ lat, lng, radiusMiles, ...dateParams() });
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
        ...dateParams(),
        focusCampgroundId: focusCampgroundId ?? undefined,
      });
    } else if (location === 'Current location') {
      navigator.geolocation.getCurrentPosition((pos) => {
        onSearch({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          radiusMiles,
          ...dateParams(),
        });
      });
    } else {
      geocodeAndSearch();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap gap-2 items-end bg-white rounded-2xl shadow-lg ring-1 ring-black/5 border border-gray-100 p-2.5"
    >
      {/* Location input + suggestions */}
      <div className="flex-1 min-w-48 relative" ref={wrapperRef}>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1 ml-1">Location</label>
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
            className="w-full pl-8 pr-9 py-2 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
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
      <div className="sm:border-l sm:border-gray-200 sm:pl-3">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1 ml-0.5">Radius</label>
        <select
          value={radiusMiles}
          onChange={(e) => setRadiusMiles(Number(e.target.value))}
          className="py-2 px-3 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400 bg-white cursor-pointer hover:bg-gray-50 transition-colors"
        >
          {RADIUS_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r} mi
            </option>
          ))}
        </select>
      </div>

      {/* Dates — single smooth range picker */}
      <div className="flex flex-col">
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={(s, e) => { setStartDate(s); setEndDate(e); }}
        />
        {/* Flexible dates: the range above becomes a search window. */}
        <div className="flex items-center gap-2 mt-1.5 ml-1 flex-wrap">
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={flexOn}
              onChange={(e) => setFlexOn(e.target.checked)}
              className="rounded border-gray-300 text-green-600 focus:ring-green-400"
            />
            Flexible dates
          </label>
          {flexOn && (
            <>
              <select
                value={flexNights}
                onChange={(e) => setFlexNights(Number(e.target.value))}
                className="py-1 px-1.5 text-xs rounded-md border border-gray-200 bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-400"
                aria-label="Nights"
              >
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>{n} night{n > 1 ? 's' : ''}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={flexWeekend}
                  onChange={(e) => setFlexWeekend(e.target.checked)}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-400"
                />
                Weekends only
              </label>
            </>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={!location || geocoding}
        className="w-full sm:w-auto justify-center px-6 py-3 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
      >
        {geocoding ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        Search
      </button>
    </form>
  );
}
