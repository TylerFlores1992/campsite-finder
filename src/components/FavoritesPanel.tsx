'use client';

import { useEffect, useState } from 'react';
import { X, Heart, Loader2, MapPin, Search } from 'lucide-react';

export interface FavoriteCampground {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  source: string;
  reservations_url: string | null;
}

interface FavoritesPanelProps {
  onClose: () => void;
  /** Start a search centered on this favorite (page pins it to the top of results). */
  onSelect: (fav: FavoriteCampground) => void;
}

export default function FavoritesPanel({ onClose, onSelect }: FavoritesPanelProps) {
  const [favorites, setFavorites] = useState<FavoriteCampground[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/favorites?details=1')
      .then((r) => (r.ok ? r.json() : { favorites: [] }))
      .then((d) => setFavorites(d.favorites ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function removeFavorite(id: string) {
    setRemoving(id);
    // Optimistic — drop it immediately; the DELETE is idempotent.
    setFavorites((f) => f.filter((x) => x.id !== id));
    await fetch(`/api/favorites?campgroundId=${id}`, { method: 'DELETE' }).catch(() => {});
    setRemoving(null);
  }

  function locationLabel(f: FavoriteCampground): string | null {
    return [f.city, f.state].filter(Boolean).join(', ') || null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white w-full max-w-sm h-full shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Heart size={18} className="text-rose-500 fill-rose-500" />
            <h2 className="font-semibold text-gray-900">Favorites</h2>
            {favorites.length > 0 && (
              <span className="text-xs bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full font-medium">
                {favorites.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-0">
          {favorites.length > 2 && (
            <div className="pointer-events-none absolute bottom-0 inset-x-0 h-6 bg-gradient-to-t from-white to-transparent z-10" />
          )}
          <div className="h-full overflow-y-auto p-4 space-y-3">
            {loading && (
              <div className="flex items-center justify-center py-12 text-gray-400">
                <Loader2 size={20} className="animate-spin" />
              </div>
            )}

            {!loading && favorites.length === 0 && (
              <div className="text-center py-12">
                <Heart size={32} className="mx-auto text-gray-200 mb-3" />
                <p className="text-sm text-gray-500 font-medium">No favorites yet</p>
                <p className="text-xs text-gray-400 mt-1">
                  Tap the heart on any campground to save it here.
                </p>
              </div>
            )}

            {!loading &&
              favorites.map((f) => (
                <div
                  key={f.id}
                  className="bg-gray-50 rounded-xl p-4 flex items-start justify-between gap-3"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(f)}
                    className="min-w-0 text-left group focus:outline-none"
                    title="Search this campground"
                  >
                    <p className="font-medium text-sm text-gray-900 truncate group-hover:text-green-800 transition-colors">
                      {f.name}
                    </p>
                    {locationLabel(f) && (
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-500">
                        <MapPin size={11} />
                        <span className="truncate">{locationLabel(f)}</span>
                      </div>
                    )}
                    <span className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-green-700 group-hover:underline">
                      <Search size={11} />
                      Search this campground
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeFavorite(f.id)}
                    disabled={removing === f.id}
                    className="shrink-0 text-rose-400 hover:text-rose-600 disabled:opacity-50 transition-colors"
                    title="Remove from favorites"
                    aria-label="Remove from favorites"
                  >
                    {removing === f.id ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Heart size={16} className="fill-current" />
                    )}
                  </button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
