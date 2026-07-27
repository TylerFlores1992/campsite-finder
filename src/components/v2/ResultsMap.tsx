"use client";

import { useEffect, useRef, useState } from "react";
import type { Campground } from "@/lib/types";

/**
 * Map of search results.
 *
 * A SEPARATE COMPONENT FROM src/components/Map.tsx rather than a restyle of it.
 * That one is rendered by the live UI, and repainting its markers in the ch-*
 * palette would change what current users see — the whole point of the dark
 * launch. It dies with the old UI at the route swap; until then the duplication
 * is deliberate.
 *
 * PINS ENCODE AVAILABILITY, which is the only question the map is being asked.
 * Green = sites open, neutral = booked. Unknown stays neutral too, because we
 * genuinely don't know. Red is NOT an availability colour here — it marks the
 * one pin you just clicked, and exactly one pin can hold it at a time, so a
 * selection can never be mistaken for a field of errors.
 */
export interface ResultsMapProps {
  campgrounds: Campground[];
  center: { lat: number; lng: number };
  radiusMiles?: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** False when no dates were searched — pins then make no availability claim. */
  datesChosen?: boolean;
  className?: string;
}

const GREEN = "#1E7A4C";
const NEUTRAL = "#8CA091";
/** Selection only — see the note above. */
const SELECTED = "#B4462F"; // --color-ch-alert

export default function ResultsMap({
  campgrounds,
  center,
  radiusMiles,
  selectedId,
  onSelect,
  datesChosen = false,
  className,
}: ResultsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("mapbox-gl").Map | null>(null);
  const markersRef = useRef(new globalThis.Map<string, import("mapbox-gl").Marker>());
  const glRef = useRef<typeof import("mapbox-gl") | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Init once. mapbox-gl is imported dynamically — it's large and touches
  // `window`, so it must not be pulled into the server bundle.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
      if (!token) {
        setFailed("Map unavailable");
        return;
      }
      const gl = await import("mapbox-gl");
      await import("mapbox-gl/dist/mapbox-gl.css");
      if (cancelled || !containerRef.current) return;

      glRef.current = gl;
      gl.default.accessToken = token;
      const map = new gl.default.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/outdoors-v12",
        center: [center.lng, center.lat],
        zoom: 8,
        attributionControl: true,
      });
      map.addControl(new gl.default.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;
      map.on("load", () => !cancelled && setReady(true));
    })().catch(() => setFailed("Map failed to load"));

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-centre when a new search moves the origin.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    mapRef.current.easeTo({ center: [center.lng, center.lat], duration: 400 });
  }, [ready, center.lat, center.lng]);

  // Markers.
  useEffect(() => {
    const gl = glRef.current;
    const map = mapRef.current;
    if (!ready || !gl || !map) return;

    const existing = markersRef.current;
    const wanted = new Set(campgrounds.map((c) => c.id));
    for (const [id, marker] of existing) {
      if (!wanted.has(id)) {
        marker.remove();
        existing.delete(id);
      }
    }

    for (const cg of campgrounds) {
      if (typeof cg.latitude !== "number" || typeof cg.longitude !== "number") continue;
      const open = datesChosen && cg.hasAvailability === true;
      const selected = selectedId === cg.id;

      let marker = existing.get(cg.id);
      if (!marker) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "ch-pin";
        el.setAttribute("aria-label", cg.name);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelect?.(cg.id);
        });
        marker = new gl.default.Marker({ element: el })
          .setLngLat([cg.longitude, cg.latitude])
          .addTo(map);
        existing.set(cg.id, marker);
      }
      const el = marker.getElement();
      // Selection wins over the availability colour: the user asked "which one
      // is this?", and answering that is worth one pin's worth of green.
      el.style.background = selected ? SELECTED : open ? GREEN : NEUTRAL;
      el.style.transform = selected ? "rotate(-45deg) scale(1.25)" : "rotate(-45deg)";
      el.style.zIndex = selected ? "2" : "1";
    }

    // Frame the results, but never zoom past a sensible level for one pin.
    const pts = campgrounds.filter(
      (c) => typeof c.latitude === "number" && typeof c.longitude === "number",
    );
    if (pts.length > 0) {
      const bounds = new gl.default.LngLatBounds();
      for (const c of pts) bounds.extend([c.longitude, c.latitude]);
      bounds.extend([center.lng, center.lat]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 11, duration: 400 });
    }
  }, [ready, campgrounds, selectedId, onSelect, datesChosen, center.lat, center.lng]);

  if (failed) {
    return (
      <div
        className={`grid place-items-center rounded-ch-card border border-ch-line bg-ch-card ${className ?? ""}`}
      >
        <p className="p-6 text-center text-ch-body text-ch-muted">
          {failed}. The list below has everything the map would show.
        </p>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-ch-card border border-ch-line ${className ?? ""}`}>
      <div ref={containerRef} className="size-full" />

      {(datesChosen || selectedId) && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex gap-3 rounded-[9px] bg-white/92 px-2.5 py-1.5 text-ch-fine font-bold text-ch-muted backdrop-blur">
          {datesChosen && (
          <><span>
            <i className="mr-1.5 inline-block size-2.5 rounded-full align-[-1px]" style={{ background: GREEN }} />
            Sites open
          </span>
          <span>
            <i className="mr-1.5 inline-block size-2.5 rounded-full align-[-1px]" style={{ background: NEUTRAL }} />
            Booked
          </span></>
          )}
          {selectedId && (
            <span>
              <i className="mr-1.5 inline-block size-2.5 rounded-full align-[-1px]" style={{ background: SELECTED }} />
              Showing first
            </span>
          )}
        </div>
      )}

      {/* Marker shape lives here rather than in globals.css so it can't leak
          into the old map, which uses the same kind of element. */}
      <style>{`
        .ch-pin {
          width: 22px; height: 22px; border: 2px solid #fff; cursor: pointer;
          border-radius: 50% 50% 50% 2px; transform: rotate(-45deg);
          box-shadow: 0 2px 6px rgba(22,41,31,.35); padding: 0;
          transition: transform .15s ease;
        }
        .ch-pin:hover { transform: rotate(-45deg) scale(1.18); }
        .ch-pin:focus-visible { outline: 2px solid ${GREEN}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .ch-pin { transition: none; } }
      `}</style>
    </div>
  );
}
