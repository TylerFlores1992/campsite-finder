/**
 * Location helpers for the redesign's search surfaces.
 *
 * Extracted so Explore and any future search share one implementation —
 * the current UI has this logic inline in SearchBar, which is exactly the kind
 * of thing that drifts once a second caller appears.
 */

import { parseCampgroundName, placeLabel } from "./campground-name";

export interface PlaceHit {
  kind: "place";
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface CampgroundHit {
  kind: "campground";
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
}

export type LocationHit = PlaceHit | CampgroundHit;

/**
 * Current position.
 *
 * Goes through @capacitor/geolocation rather than navigator.geolocation:
 * the browser API never resolves inside the iOS WKWebView — no result and no
 * error either — which is why "use my location" used to spin forever in the app.
 * The plugin uses the native API on device and the browser one on web.
 *
 * Returns null on denial or error so callers can fall back rather than hang.
 */
export async function deviceCoords(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { Geolocation } = await import("@capacitor/geolocation");
    // Native shows the OS prompt; on web requestPermissions may be unimplemented,
    // so ignore its failure and still attempt the read.
    await Geolocation.requestPermissions().catch(() => {});
    const pos = await Geolocation.getCurrentPosition({
      timeout: 10_000,
      enableHighAccuracy: false,
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

/** Coarse fallback when the device won't give a position. */
export async function ipCoords(): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch("/api/geo");
    if (!r.ok) return null;
    const j = (await r.json()) as { lat?: number; lng?: number };
    return typeof j.lat === "number" && typeof j.lng === "number" ? { lat: j.lat, lng: j.lng } : null;
  } catch {
    return null;
  }
}

/**
 * Search PLACES and CAMPGROUNDS together.
 *
 * /api/suggest only knows campgrounds, so on its own a user typing "Big Sur" or
 * a ZIP gets nothing — you could only search for somewhere we already had a
 * campground row named. Mapbox geocoding supplies towns, regions and parks;
 * campground hits stay first because a named match is almost always what the
 * user meant.
 *
 * Both legs are allSettled: geocoding failing shouldn't take campgrounds with
 * it, and vice versa.
 */
export async function searchLocations(q: string, signal?: AbortSignal): Promise<LocationHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const placesUrl = token
    ? `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?country=US&types=place,locality,region,postcode,poi&limit=5&access_token=${token}`
    : null;

  const [placeRes, cgRes] = await Promise.allSettled([
    placesUrl
      ? fetch(placesUrl, { signal }).then((r) => (r.ok ? r.json() : null))
      : Promise.resolve(null),
    fetch(`/api/suggest?q=${encodeURIComponent(query)}`, { signal }).then((r) =>
      r.ok ? r.json() : null,
    ),
  ]);

  const places: PlaceHit[] =
    placeRes.status === "fulfilled" && placeRes.value
      ? ((placeRes.value.features ?? []) as Array<{
          id: string;
          place_name: string;
          center: [number, number];
        }>).map((f) => ({
          kind: "place" as const,
          id: f.id,
          name: f.place_name.replace(", United States", ""),
          lng: f.center[0],
          lat: f.center[1],
        }))
      : [];

  const campgrounds: CampgroundHit[] =
    cgRes.status === "fulfilled" && cgRes.value
      ? ((cgRes.value.campgrounds ?? []) as Array<{
          id: string;
          name: string;
          city: string | null;
          state: string | null;
          latitude: number;
          longitude: number;
        }>).map((c) => ({
          kind: "campground" as const,
          id: c.id,
          // Tidied at the point of DISPLAY, not in the API: /api/suggest stays faithful
          // to what is in the database, and 2,719 rec.gov rows are stored in all caps.
          name: parseCampgroundName(c.name).full,
          city: c.city,
          state: c.state,
          lat: c.latitude,
          lng: c.longitude,
        }))
      : [];

  // Campgrounds first: typing a campground name means you want that campground,
  // not the town it sits in.
  return [...campgrounds.slice(0, 5), ...places.slice(0, 5)];
}

/**
 * Display label for a hit, avoiding "Big Sur, Big Sur" when name === city.
 *
 * Shares `placeLabel` with the suggestion rows. It did NOT before, and the two
 * disagreed in the way that matters: this one joined whatever of city/state existed —
 * correct — while the rows gated the whole thing on `city` and rendered nothing for the
 * 1,957 campgrounds that have a state and no city. Two expressions for one idea, in the
 * same feature, and the broken one was what the user read first.
 */
export function hitLabel(hit: LocationHit): string {
  if (hit.kind === "place") return hit.name;
  const where = placeLabel(hit.city, hit.state);
  if (!where || hit.city === hit.name) return hit.name;
  return `${hit.name}, ${where}`;
}
