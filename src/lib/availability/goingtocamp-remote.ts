// Ask the Fly worker for GoingToCamp availability.
//
// Camis' WAF 403s Vercel's IPs but not Fly's, so the search page (Vercel) cannot
// query Camis directly. The worker exposes POST /gtc/availability for exactly
// this. When GTC_AVAILABILITY_URL isn't set — local dev, or if the endpoint is
// down — callers fall back to the direct adapter, which works from residential
// and throws (→ unknown) from Vercel.

export interface RemoteAvailabilityItem {
  campgroundId: string;
  startDate: string;
  endDate: string;
  minNights?: number;
}

/**
 * Returns a map of campgroundId → availability. A missing key or a `null` value
 * means UNKNOWN — never render it as unavailable. Resolves to an empty map on
 * any failure so search degrades to "unknown" rather than erroring.
 */
export async function fetchGoingToCampAvailability(
  items: RemoteAvailabilityItem[]
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const url = process.env.GTC_AVAILABILITY_URL;
  const secret = process.env.GTC_AVAILABILITY_SECRET ?? process.env.SYNC_SECRET;
  if (!url || !secret || items.length === 0) return out;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify({ items }),
      // Search is user-facing: give up quickly rather than hanging the page.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return out;
    const json = (await res.json()) as {
      results?: { campgroundId: string; available: boolean | null }[];
    };
    for (const r of json.results ?? []) {
      if (typeof r?.campgroundId === 'string') out.set(r.campgroundId, r.available ?? null);
    }
  } catch {
    return out; // unknown, not unavailable
  }
  return out;
}
