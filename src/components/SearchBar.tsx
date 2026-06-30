'use client';

import { useState, useRef } from 'react';
import { Search, MapPin, Loader2 } from 'lucide-react';

interface SearchBarProps {
  onSearch: (params: {
    lat: number;
    lng: number;
    radiusMiles: number;
    startDate?: string;
    endDate?: string;
  }) => void;
}

const RADIUS_OPTIONS = [25, 50, 100, 200];

export default function SearchBar({ onSearch }: SearchBarProps) {
  const [location, setLocation] = useState('');
  const [radiusMiles, setRadiusMiles] = useState(50);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function useCurrentLocation() {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocation('Current location');
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
    if (!location || location === 'Current location') return;
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
    if (location === 'Current location') {
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
      {/* Location input */}
      <div className="flex-1 min-w-48">
        <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
        <div className="relative flex items-center">
          <Search size={14} className="absolute left-2.5 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder="City, state, or park name"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
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
