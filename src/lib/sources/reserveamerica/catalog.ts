// ReserveAmerica park catalog — enumerate a contract's camping parks (id + name).
//
// The state site's campgroundDirectory.do links to a campgroundDirectoryList.do
// page (org-slug specific, discovered at runtime) that lists every camping park
// with its parkId. Coordinates aren't in the list, so the sync geocodes by name.

import type { RAContract } from './client';
import { isRealCoord, type PostalAddress } from '../geocode';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface RAPark {
  parkId: number;
  name: string;
  detailPath: string; // /camping/<slug>/r/campgroundDetails.do?...parkId=N (for coords)
}

async function session(host: string): Promise<string> {
  const res = await fetch(`https://${host}/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return (h.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}
async function html(url: string, cookie: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'follow' });
  if (!res.ok) throw new Error(`RA catalog ${res.status} ${url}`);
  return res.text();
}

/** Every camping park for a contract: parkId + display name (deduped). */
export async function fetchParkCatalog(contract: RAContract): Promise<RAPark[]> {
  const cookie = await session(contract.host);

  // 1. The directory landing → the actual directory-list URL (org slug varies).
  const dir = await html(`https://${contract.host}/campgroundDirectory.do?contractCode=${contract.contractCode}`, cookie);
  const listPath =
    (dir.match(/href='([^']*campgroundDirectoryList\.do[^']*)'/i) || [])[1] ||
    `/campgroundDirectoryList.do?contractCode=${contract.contractCode}`;
  const listUrl = listPath.startsWith('http') ? listPath : `https://${contract.host}${listPath}`;

  // 2. Parse parkId + name from the park anchors, across ALL result pages. The
  //    directory lists 25 parks per page and paginates via a `startIdx` query
  //    param; the total is in `id='resulttotal_top'>N<`. Each park is linked
  //    several times; the placeholder link reads "Enter Date" while the real name
  //    sits on another anchor. Layouts vary by contract: some states put the name
  //    on a second campgroundDetails.do link (NY), others on a facilityDetails.do
  //    link (TX). Read the name from either, keep the longest non-placeholder one,
  //    and synthesize a canonical campgroundDetails.do path (present for every
  //    park, and where the coord OG-meta lives) from the slug.
  const PAGE = 25;
  const byId = new Map<number, { name: string; slug: string }>();
  let total = Infinity;
  for (let startIdx = 0; startIdx < total; startIdx += PAGE) {
    const pageUrl = `${listUrl}${listUrl.includes('?') ? '&' : '?'}startIdx=${startIdx}`;
    const list = await html(pageUrl, cookie);
    if (startIdx === 0) {
      const t = list.match(/id='resulttotal_top'>(\d+)</);
      total = t ? Number(t[1]) : PAGE; // no total marker → assume a single page
    }
    let matchedOnPage = 0;
    for (const m of list.matchAll(/href='\/camping\/([a-z0-9-]+)\/r\/(?:campground|facility)Details\.do\?[^']*parkId=(\d+)[^']*'[^>]*>([^<]{2,80})</gi)) {
      const slug = m[1];
      const id = Number(m[2]);
      const name = m[3].trim();
      if (/^enter date$/i.test(name)) continue;
      matchedOnPage++;
      const prev = byId.get(id);
      if (!prev || name.length > prev.name.length) byId.set(id, { name, slug });
    }
    // Safety valve: if a page yields no parks, stop rather than loop to `total`.
    if (matchedOnPage === 0) break;
  }
  return [...byId.entries()].map(([parkId, v]) => ({
    parkId,
    name: v.name,
    detailPath: `/camping/${v.slug}/r/campgroundDetails.do?contractCode=${contract.contractCode}&parkId=${parkId}`,
  }));
}

/** Read a park's authoritative coordinates from its detail page's Open Graph meta. */
/**
 * Coordinates AND postal address from a park's detail page.
 *
 * Two coordinate sources, because the Open Graph meta this used to read exclusively is
 * absent on some parks while the schema.org `itemprop` block is present (and vice
 * versa). Whichever answers first wins.
 *
 * THE PORTAL PUBLISHES `0.0, -0.0` FOR PARKS IT HAS NO LOCATION FOR — confirmed on
 * Clough State Park, NH, 2026-08-04. That parses as a perfectly good number and would
 * put a campground in the Gulf of Guinea, so it is rejected by `isRealCoord`. The old
 * code survived this only by accident: those pages happen to omit the OG meta, so the
 * regex failed and returned null. Reading a second source removes that accident.
 *
 * The address is returned even when coordinates are found — it costs nothing (same
 * page) and lets the caller geocode when the coordinates turn out to be a placeholder.
 */
export async function fetchParkLocation(
  contract: RAContract,
  detailPath: string,
  cookie: string
): Promise<{ coords: [number, number] | null; address: PostalAddress }> {
  const empty = { coords: null, address: {} as PostalAddress };
  try {
    const body = await html(`https://${contract.host}${detailPath}`, cookie);

    const pick = (re: RegExp): string | null => body.match(re)?.[1]?.trim() || null;

    // 1. Open Graph meta (single-quoted content, as this portal writes it).
    let lat = pick(/place:location:latitude"\s*content='(-?\d+(?:\.\d+)?)'/);
    let lng = pick(/place:location:longitude"\s*content='(-?\d+(?:\.\d+)?)'/);
    // 2. schema.org GeoCoordinates itemprops.
    if (!lat || !lng) {
      lat = pick(/itemprop="latitude"\s*>\s*(-?\d+(?:\.\d+)?)/);
      lng = pick(/itemprop="longitude"\s*>\s*(-?\d+(?:\.\d+)?)/);
    }

    const address: PostalAddress = {
      street: pick(/itemprop="streetAddress"[^>]*>([^<]{3,120})/),
      city: pick(/itemprop="addressLocality"[^>]*>([^<]{2,60})/),
      state: pick(/itemprop="addressRegion"[^>]*>([^<]{2,30})/) ?? contract.state,
      zip: pick(/itemprop="postalCode"[^>]*>([^<]{3,12})/),
    };

    if (!lat || !lng) return { coords: null, address };
    const [nlng, nlat] = [Number(lng), Number(lat)];
    if (!isRealCoord(nlng, nlat)) return { coords: null, address };
    return { coords: [nlng, nlat], address };
  } catch {
    return empty;
  }
}

/** Back-compat wrapper — coordinates only. */
export async function fetchParkCoords(
  contract: RAContract,
  detailPath: string,
  cookie: string
): Promise<[number, number] | null> {
  return (await fetchParkLocation(contract, detailPath, cookie)).coords;
}

/** Session cookie for coord fetching (exported for the sync). */
export async function raSession(host: string): Promise<string> {
  return session(host);
}
