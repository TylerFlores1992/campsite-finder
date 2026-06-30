'use client';

import { useEffect, useRef, useState } from 'react';
import type { Campground } from '@/lib/types';

interface MapProps {
  campgrounds: Campground[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  center?: { lat: number; lng: number };
  radiusMiles?: number;
}

// Dynamically load mapbox-gl to avoid SSR issues
let mapboxgl: typeof import('mapbox-gl') | null = null;

export default function CampgroundMap({ campgrounds, selectedId, onSelect, center, radiusMiles }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('mapbox-gl').Map | null>(null);
  const markersRef = useRef(new globalThis.Map<string, import('mapbox-gl').Marker>());
  const [loaded, setLoaded] = useState(false);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    async function init() {
      mapboxgl = await import('mapbox-gl');
      await import('mapbox-gl/dist/mapbox-gl.css');

      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
      if (!token) {
        console.warn('NEXT_PUBLIC_MAPBOX_TOKEN is not set — map will not load');
        return;
      }

      mapboxgl!.default.accessToken = token;

      const map = new mapboxgl!.default.Map({
        container: containerRef.current!,
        style: 'mapbox://styles/mapbox/outdoors-v12',
        center: [center?.lng ?? -105, center?.lat ?? 39.5],
        zoom: center ? 9 : 5,
      });

      map.addControl(new mapboxgl!.default.NavigationControl(), 'top-right');
      mapRef.current = map;
      map.on('load', () => setLoaded(true));
    }

    init();

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly to new center when it changes
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center.lng, center.lat], zoom: 9, duration: 1200 });
  }, [center?.lat, center?.lng]);

  // Update markers when campgrounds change
  useEffect(() => {
    if (!loaded || !mapRef.current || !mapboxgl) return;

    const map = mapRef.current;
    const existing = markersRef.current;
    const currentIds = new Set(campgrounds.map((c) => c.id));

    // Remove stale markers
    for (const [id, marker] of existing) {
      if (!currentIds.has(id)) {
        marker.remove();
        existing.delete(id);
      }
    }

    // Add / update markers
    for (const cg of campgrounds) {
      if (existing.has(cg.id)) continue;

      const el = document.createElement('div');
      el.className = 'campsite-marker';
      el.innerHTML = `<div class="marker-pin ${selectedId === cg.id ? 'selected' : ''}" title="${cg.name}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
      </div>`;

      el.addEventListener('click', () => onSelect?.(cg.id));

      const marker = new mapboxgl!.default.Marker({ element: el })
        .setLngLat([cg.longitude, cg.latitude])
        .addTo(map);

      existing.set(cg.id, marker);
    }
  }, [campgrounds, loaded, selectedId, onSelect]);

  // Highlight selected marker
  useEffect(() => {
    document.querySelectorAll('.marker-pin').forEach((el) => {
      el.classList.remove('selected');
    });
    if (selectedId) {
      markersRef.current.get(selectedId)?.getElement().querySelector('.marker-pin')?.classList.add('selected');
    }
  }, [selectedId]);

  return (
    <>
      <style>{`
        .campsite-marker { cursor: pointer; }
        .marker-pin {
          background: #16a34a;
          color: white;
          border-radius: 50% 50% 50% 0;
          width: 32px; height: 32px;
          transform: rotate(-45deg);
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          transition: background 0.15s, transform 0.15s;
        }
        .marker-pin svg { transform: rotate(45deg); }
        .marker-pin:hover, .marker-pin.selected {
          background: #15803d;
          transform: rotate(-45deg) scale(1.2);
        }
      `}</style>
      <div ref={containerRef} className="w-full h-full rounded-lg overflow-hidden" />
    </>
  );
}
