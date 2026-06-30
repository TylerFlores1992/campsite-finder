'use client';

import Link from 'next/link';
import { MapPin, Tent, Car, Home, Dog, Accessibility, BookmarkPlus, BookmarkCheck } from 'lucide-react';
import type { Campground } from '@/lib/types';
import WatchButton from './WatchButton';

interface CampgroundCardProps {
  campground: Campground;
  isSelected?: boolean;
  isFavorited?: boolean;
  onSelect?: () => void;
  onFavorite?: () => void;
  // Pass these when a date search is active
  searchDates?: { startDate: string; endDate: string };
  siteType?: string | null;
}

const SITE_TYPE_ICONS: Record<string, React.ReactNode> = {
  tent: <Tent size={14} />,
  rv: <Car size={14} />,
  cabin: <Home size={14} />,
  yurt: <Home size={14} />,
  group: <Tent size={14} />,
};

const SITE_TYPE_LABELS: Record<string, string> = {
  tent: 'Tent',
  rv: 'RV',
  cabin: 'Cabin',
  yurt: 'Yurt',
  group: 'Group',
};

export default function CampgroundCard({
  campground,
  isSelected,
  isFavorited,
  onSelect,
  onFavorite,
  searchDates,
  siteType,
}: CampgroundCardProps) {
  const photo = campground.photos.find((p) => p.isPrimary) ?? campground.photos[0];
  const address = [campground.address.city, campground.address.state].filter(Boolean).join(', ');

  return (
    <div
      className={`bg-white rounded-xl overflow-hidden shadow-sm border transition-all cursor-pointer hover:shadow-md ${
        isSelected ? 'border-green-500 ring-1 ring-green-500' : 'border-gray-200'
      }`}
      onClick={onSelect}
    >
      {/* Photo */}
      <div className="relative h-40 bg-gray-100 overflow-hidden">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.url}
            alt={photo.title ?? campground.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-green-50">
            <Tent size={40} className="text-green-300" />
          </div>
        )}

        {/* Favorite button */}
        <button
          className="absolute top-2 right-2 p-1.5 rounded-full bg-white/80 backdrop-blur-sm hover:bg-white transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onFavorite?.();
          }}
          title={isFavorited ? 'Remove from favorites' : 'Save to favorites'}
        >
          {isFavorited ? (
            <BookmarkCheck size={16} className="text-green-600" />
          ) : (
            <BookmarkPlus size={16} className="text-gray-500" />
          )}
        </button>

        {/* Distance badge */}
        {campground.distanceMiles !== undefined && (
          <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs font-medium">
            {campground.distanceMiles < 1
              ? `< 1 mi`
              : `${campground.distanceMiles.toFixed(1)} mi`}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3">
        <h3 className="font-semibold text-gray-900 text-sm leading-tight line-clamp-2">
          {campground.name}
        </h3>

        {address && (
          <div className="flex items-center gap-1 mt-1 text-gray-500 text-xs">
            <MapPin size={11} />
            <span>{address}</span>
          </div>
        )}

        {/* Site type chips */}
        {campground.siteTypes.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {campground.siteTypes.slice(0, 4).map((type) => (
              <span
                key={type}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-xs font-medium"
              >
                {SITE_TYPE_ICONS[type]}
                {SITE_TYPE_LABELS[type] ?? type}
              </span>
            ))}
          </div>
        )}

        {/* Quick attribute icons */}
        <div className="flex items-center gap-2 mt-2">
          {campground.petsAllowed && (
            <span title="Pets allowed" className="text-gray-400">
              <Dog size={14} />
            </span>
          )}
          {campground.adaAccessible && (
            <span title="ADA accessible" className="text-gray-400">
              <Accessibility size={14} />
            </span>
          )}
          {campground.amenities.includes('showers') && (
            <span className="text-xs text-gray-400">Showers</span>
          )}
          {campground.amenities.includes('electric hookup') && (
            <span className="text-xs text-gray-400">Electric</span>
          )}
          {campground.environmentTags.slice(0, 2).map((tag) => (
            <span key={tag} className="text-xs text-gray-400 capitalize">
              {tag}
            </span>
          ))}
        </div>

        {/* Availability badge */}
        {searchDates && (
          <div className="mt-2">
            {campground.hasAvailability === true && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                ✓ Available
              </span>
            )}
            {campground.hasAvailability === false && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                Fully booked
              </span>
            )}
          </div>
        )}

        {/* CTA */}
        <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
          <Link
            href={`/campground/${campground.id}`}
            className="text-xs font-medium text-green-700 hover:text-green-800"
            onClick={(e) => e.stopPropagation()}
          >
            View details →
          </Link>
          <div className="flex items-center gap-1.5">
            {/* Watch button: show when booked or unchecked and dates are active */}
            {searchDates && campground.hasAvailability !== true && (
              <WatchButton
                campgroundId={campground.id}
                campgroundName={campground.name}
                startDate={searchDates.startDate}
                endDate={searchDates.endDate}
                siteType={siteType}
              />
            )}
            {campground.reservationsUrl && campground.hasAvailability === true && (
              <a
                href={campground.reservationsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                Book
              </a>
            )}
            {campground.reservationsUrl && !searchDates && (
              <a
                href={campground.reservationsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                Book
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
