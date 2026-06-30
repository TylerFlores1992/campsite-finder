'use client';

import { Dog, Accessibility, Zap, Droplets, Home, Car, Tent } from 'lucide-react';

export interface FilterState {
  siteType: string | null;
  pets: boolean;
  ada: boolean;
  electric: boolean;
  water: boolean;
  showers: boolean;
}

interface FiltersProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const SITE_TYPES = [
  { value: null, label: 'All types' },
  { value: 'tent', label: 'Tent', icon: <Tent size={13} /> },
  { value: 'rv', label: 'RV', icon: <Car size={13} /> },
  { value: 'cabin', label: 'Cabin', icon: <Home size={13} /> },
];

export default function Filters({ filters, onChange }: FiltersProps) {
  function toggle(key: keyof FilterState, value?: string | null) {
    if (key === 'siteType') {
      onChange({ ...filters, siteType: value as string | null });
    } else {
      onChange({ ...filters, [key]: !filters[key as keyof typeof filters] });
    }
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {/* Site type */}
      {SITE_TYPES.map(({ value, label, icon }) => (
        <button
          key={String(value)}
          onClick={() => toggle('siteType', value)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filters.siteType === value
              ? 'bg-green-600 text-white'
              : 'bg-white border border-gray-200 text-gray-600 hover:border-green-400'
          }`}
        >
          {icon}
          {label}
        </button>
      ))}

      <div className="w-px h-6 bg-gray-200 mx-1" />

      {/* Amenity toggles */}
      {[
        { key: 'pets' as const, label: 'Pet-friendly', icon: <Dog size={13} /> },
        { key: 'ada' as const, label: 'ADA', icon: <Accessibility size={13} /> },
        { key: 'electric' as const, label: 'Electric', icon: <Zap size={13} /> },
        { key: 'water' as const, label: 'Water', icon: <Droplets size={13} /> },
      ].map(({ key, label, icon }) => (
        <button
          key={key}
          onClick={() => toggle(key)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filters[key]
              ? 'bg-green-600 text-white'
              : 'bg-white border border-gray-200 text-gray-600 hover:border-green-400'
          }`}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}
