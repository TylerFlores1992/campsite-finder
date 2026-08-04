// Address geocoding + a state sanity box, shared by the catalog syncs.
//
// WHY: a park with no coordinates is DROPPED from the catalog — invisible in search,
// unwatchable. As of 2026-08-04 that was 35 parks across ReserveAmerica (16) and
// GoingToCamp (19). GoingToCamp already geocoded its addresses and bbox-checked the
// result; ReserveAmerica did not geocode at all, so any park whose portal page omitted
// coordinates was simply lost. This is that logic in one place, with a box for all 50
// states rather than the four GoingToCamp happened to need.
//
// ADDRESS ONLY — NEVER GEOCODE BY NAME. Measured on the SC portal (2026-07-22): only
// 5 of 43 park names resolved and ~20 stacked onto one wrong point, because Mapbox has
// no POI for these parks and collapses "<name> State Park, <state>" onto a "State Park"
// neighbourhood. Re-confirmed 2026-08-04: "Clough State Park, New Hampshire" returns
// the NEW HAMPSHIRE STATE CENTROID, which would place a campground ~40 miles from the
// park and look entirely plausible on a map. A wrong pin is worse than a missing one:
// absent is visibly absent, wrong sends someone to the wrong place.

/** Rough per-state bounding box: [minLat, maxLat, minLng, maxLng]. */
const BBOX: Record<string, [number, number, number, number]> = {
  AL: [30.1, 35.1, -88.5, -84.8], AK: [51.0, 71.5, -180.0, -129.0],
  AZ: [31.2, 37.1, -114.9, -108.9], AR: [32.9, 36.6, -94.7, -89.6],
  CA: [32.4, 42.1, -124.5, -114.1], CO: [36.9, 41.1, -109.1, -102.0],
  CT: [40.9, 42.1, -73.8, -71.7], DE: [38.4, 39.9, -75.8, -74.9],
  FL: [24.3, 31.1, -87.7, -79.9], GA: [30.3, 35.1, -85.7, -80.8],
  HI: [18.8, 22.3, -160.3, -154.7], ID: [41.9, 49.1, -117.3, -110.9],
  IL: [36.9, 42.6, -91.6, -87.4], IN: [37.7, 41.8, -88.2, -84.7],
  IA: [40.3, 43.6, -96.7, -90.1], KS: [36.9, 40.1, -102.1, -94.5],
  KY: [36.4, 39.2, -89.6, -81.9], LA: [28.8, 33.1, -94.1, -88.7],
  ME: [42.9, 47.6, -71.2, -66.8], MD: [37.8, 39.8, -79.5, -74.9],
  MA: [41.1, 42.9, -73.6, -69.8], MI: [41.6, 48.4, -90.5, -82.3],
  MN: [43.4, 49.5, -97.3, -89.4], MS: [30.1, 35.1, -91.7, -88.0],
  MO: [35.9, 40.7, -95.9, -89.0], MT: [44.3, 49.1, -116.1, -104.0],
  NE: [39.9, 43.1, -104.1, -95.2], NV: [34.9, 42.1, -120.1, -113.9],
  NH: [42.6, 45.4, -72.6, -70.6], NJ: [38.8, 41.4, -75.6, -73.8],
  NM: [31.2, 37.1, -109.1, -102.9], NY: [40.4, 45.1, -79.8, -71.8],
  NC: [33.7, 36.7, -84.4, -75.4], ND: [45.8, 49.1, -104.1, -96.5],
  OH: [38.3, 42.4, -84.9, -80.4], OK: [33.6, 37.1, -103.1, -94.4],
  OR: [41.9, 46.4, -124.6, -116.4], PA: [39.6, 42.4, -80.6, -74.6],
  RI: [41.1, 42.1, -71.9, -71.1], SC: [32.0, 35.3, -83.4, -78.4],
  SD: [42.4, 46.0, -104.1, -96.4], TN: [34.9, 36.7, -90.4, -81.6],
  TX: [25.8, 36.6, -106.7, -93.4], UT: [36.9, 42.1, -114.1, -108.9],
  VT: [42.7, 45.1, -73.5, -71.4], VA: [36.5, 39.5, -83.7, -75.1],
  WA: [45.5, 49.1, -124.9, -116.9], WV: [37.1, 40.7, -82.7, -77.7],
  WI: [42.4, 47.4, -92.9, -86.7], WY: [40.9, 45.1, -111.1, -104.0],
};

/**
 * Is this point plausibly inside the state? A geocode that lands elsewhere is a bad
 * answer dressed as a good one — a state centroid, a same-named town in another state,
 * or a street that exists in fifty places. Unknown state → true, because a box we do
 * not have should not delete a coordinate the portal gave us.
 */
export function inState(state: string, lng: number, lat: number): boolean {
  const b = BBOX[state?.toUpperCase()];
  if (!b) return true;
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

/**
 * Reject the null-island coordinate. ReserveAmerica publishes `0.0, -0.0` on park
 * pages it has no location for (confirmed on Clough State Park, NH, 2026-08-04) — a
 * value that parses perfectly and puts a campground in the Gulf of Guinea. Anything
 * this close to the origin is a placeholder, never a US campground.
 */
export function isRealCoord(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return Math.abs(lng) > 0.5 || Math.abs(lat) > 0.5;
}

/**
 * How far an address may sit from the centre of the town it lists. Generous, because
 * rural park addresses legitimately sit well outside the town they are addressed to,
 * and the job here is to catch a wrong-town or wrong-state answer, not to second-guess
 * a real rural address.
 */
const MAX_CITY_DISTANCE_KM = 60;

const norm = (v: string) => v.toLowerCase().replace(/[^a-z]/g, '');

/** Great-circle distance in km between two [lng, lat] points. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Centre of a town, for the distance sanity check above. Null if it cannot be found. */
async function geocodePlace(city: string, state: string, token: string): Promise<[number, number] | null> {
  try {
    const q = [city, state].filter(Boolean).join(', ');
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
        `?access_token=${token}&country=us&types=place,locality&limit=1`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { features?: { center?: [number, number] }[] };
    const c = j.features?.[0]?.center;
    return c && c.length === 2 ? [c[0], c[1]] : null;
  } catch {
    return null;
  }
}

export interface PostalAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

/**
 * Geocode a STREET ADDRESS. Returns null unless there is both a street and a city —
 * "Kingston, NH" alone resolves to the town centre, which is a guess, not a location.
 *
 * The caller must still `inState`-check the result: Mapbox answers something for
 * almost any input, and the failure mode is a confident wrong point rather than an
 * error. Returns null on any failure so the caller skips and logs rather than storing
 * a fabricated position.
 */
export async function geocodeAddress(addr: PostalAddress): Promise<[number, number] | null> {
  const street = (addr.street ?? '').trim();
  const city = (addr.city ?? '').trim();
  if (!street || !city) return null;

  // A PO BOX IS A MAILBOX, NOT A PLACE. Measured 2026-08-04: Glen Island's listed
  // address is "PO Box 993, Bolton Landing" (Lake George, ~-73.65) and Mapbox returned
  // -78.58 — WESTERN New York, roughly 300 miles off, and well inside the state box so
  // the bbox check waved it through. A park pinned 300 miles away is worse than one
  // that is missing, so a box number is treated as no address at all.
  if (/\b(p\.?\s?o\.?\s*box|post\s+office\s+box)\b/i.test(street)) return null;

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;

  const q = [street, city, addr.state ?? '', addr.zip ?? ''].filter(Boolean).join(', ');
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?access_token=${token}&country=us&limit=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: {
        center?: [number, number];
        place_type?: string[];
        text?: string;
        context?: { text?: string }[];
      }[];
    };
    const f = json.features?.[0];
    const center = f?.center;
    if (!center || center.length !== 2) return null;
    // A result typed `region`/`country` is the state or national centroid — the exact
    // shape of the SC name-geocoding failure. Only accept a real address-level answer.
    const type = f?.place_type?.[0];
    if (type === 'region' || type === 'country' || type === 'district') return null;

    if (!isRealCoord(center[0], center[1])) return null;

    // DOES IT LAND NEAR THE TOWN IT CLAIMS TO BE IN? The state box is far too coarse
    // inside a big state — it waved through a New York park that resolved 300 miles
    // away. Comparing the returned city NAME does not work either: Mapbox labels
    // "5800 W. Sprague Road, Martell NE" as Crete (the postal city), which is correct
    // but not a string match, and rejecting it loses a real park.
    //
    // So compare POSITION, not names: geocode the town itself and require the address
    // to be within MAX_CITY_DISTANCE_KM of it. Martell lands ~0 km away and passes;
    // "Bolton Landing NY" against a result in Moorestown NJ is ~400 km and fails.
    const ctx = (f?.context ?? []).map((c) => norm(c.text ?? ''));
    if (!ctx.includes(norm(city)) && norm(f?.text ?? '') !== norm(city)) {
      const town = await geocodePlace(city, addr.state ?? '', token);
      // No town to compare against → fall back to the caller's state-box check alone
      // rather than discarding a result we have no evidence against.
      if (town && haversineKm(center, town) > MAX_CITY_DISTANCE_KM) return null;
    }

    return [center[0], center[1]];
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------------
// Last resort: locate a park BY NAME, via OpenStreetMap.
// ---------------------------------------------------------------------------------
//
// "Never geocode by name" is the rule above, and it stands FOR MAPBOX — measured twice
// (SC parks 2026-07-22, "Clough State Park" 2026-08-04), it has no POI for these places
// and answers with a state centroid. Re-measured 2026-08-04 against the 16 GoingToCamp
// locations this exists for: Mapbox returned ZERO results with types=poi. Not bad
// results — none.
//
// OpenStreetMap is a different proposition because it carries the actual park and
// protected-area GEOMETRIES. It is where the curated SC_PARK_COORDS table was sourced
// from by hand; this automates the same lookup. Measured on those 16: 14 resolved, and
// the good ones landed on the real feature (Wolfe Property → "Cascadia Marine Trail
// Campsite - Wolfe Property State Park", Silver Lake State Park → 43.668,-86.523).
//
// It is still name matching, so it is wrapped in TWO independent checks, and both were
// written against a real wrong answer from this exact call:
//   - the caller's state box. "Big Eddy, Washington" returned a covered bridge in
//     Washington COUNTY, VERMONT; "Riverside HQ, Washington" returned Riverside,
//     Washington County, IOWA. Both are confidently wrong and both are far outside the
//     Washington box.
//   - a distinctive-token check, below, so a result that shares no meaningful word with
//     the park name is rejected even if it lands in the right state.
//
// USAGE POLICY. Nominatim asks for at most one request per second and a User-Agent that
// identifies the caller. This runs only for locations that have neither coordinates nor
// a street address — about 19 a night — and requests are serialised with a delay.

/** Words that identify nothing on their own: every third park contains them. */
const GENERIC_NAME_WORDS = new Set([
  'state', 'park', 'parks', 'forest', 'recreation', 'area', 'unit', 'campground',
  'camping', 'national', 'scenic', 'waters', 'north', 'south', 'east', 'west',
  'northern', 'southern', 'eastern', 'western', 'lake', 'river', 'the', 'and',
  'center', 'centre', 'front', 'desk', 'site', 'sites', 'reserve', 'trail',
]);

/** Tokens distinctive enough to confirm a match. Empty means the name says nothing. */
function distinctiveTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
}

let nominatimGate: Promise<void> = Promise.resolve();
/** Serialise calls at ~1/sec, as Nominatim's usage policy requires. */
function nominatimSlot(): Promise<void> {
  const wait = nominatimGate;
  nominatimGate = wait.then(() => new Promise((r) => setTimeout(r, 1100)));
  return wait;
}

/**
 * Find a named park in a state. Returns null unless the answer is BOTH inside the
 * state box and shares a distinctive word with the name asked for.
 *
 * Deliberately returns null for a name with no distinctive tokens — "Information
 * Center/Front Desk" is not a place, and anything a geocoder says about it is noise.
 */
export async function geocodePlaceName(name: string, state: string): Promise<[number, number] | null> {
  const tokens = distinctiveTokens(name);
  if (tokens.length === 0) return null;

  await nominatimSlot();
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us` +
      `&q=${encodeURIComponent(`${name}, ${state}, USA`)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': 'CampHawk/1.0 (+https://camphawk.app; alerts@camphawk.app)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const hit = json?.[0];
    if (!hit?.lat || !hit?.lon) return null;

    const lng = Number(hit.lon);
    const lat = Number(hit.lat);
    if (!isRealCoord(lng, lat)) return null;
    if (!inState(state, lng, lat)) return null;

    const display = (hit.display_name ?? '').toLowerCase();
    if (!tokens.some((t) => display.includes(t))) return null;

    return [lng, lat];
  } catch {
    return null;
  }
}
