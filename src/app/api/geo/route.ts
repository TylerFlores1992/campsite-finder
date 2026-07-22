import { NextRequest, NextResponse } from 'next/server';

/**
 * Coarse (city-level) location from the request IP, for when the browser's precise
 * geolocation is unavailable — location services off, permission denied, or timed out.
 * Vercel injects these headers on every request at the edge (no API key, no dependency);
 * accuracy is city-level, which is plenty for a 50–100mi radius campground search.
 *
 * Returns { lat, lng, city } on success, or 204 (no body) when the headers aren't
 * present (local dev, or an IP Vercel can't place) so the caller can fall through to
 * its next fallback rather than treat it as an error.
 */
export async function GET(request: NextRequest) {
  const lat = parseFloat(request.headers.get('x-vercel-ip-latitude') ?? '');
  const lng = parseFloat(request.headers.get('x-vercel-ip-longitude') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new NextResponse(null, { status: 204 });
  }
  // Header values are URL-encoded (e.g. "San%20Francisco").
  const rawCity = request.headers.get('x-vercel-ip-city');
  let city: string | null = null;
  if (rawCity) {
    try { city = decodeURIComponent(rawCity); } catch { city = rawCity; }
  }
  return NextResponse.json({ lat, lng, city });
}
