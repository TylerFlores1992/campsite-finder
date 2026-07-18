// ReserveAmerica park catalog — enumerate a contract's camping parks (id + name).
//
// The state site's campgroundDirectory.do links to a campgroundDirectoryList.do
// page (org-slug specific, discovered at runtime) that lists every camping park
// with its parkId. Coordinates aren't in the list, so the sync geocodes by name.

import type { RAContract } from './client';

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
export async function fetchParkCoords(
  contract: RAContract,
  detailPath: string,
  cookie: string
): Promise<[number, number] | null> {
  try {
    const body = await html(`https://${contract.host}${detailPath}`, cookie);
    const lat = body.match(/place:location:latitude"\s*content='(-?\d+\.\d+)'/);
    const lng = body.match(/place:location:longitude"\s*content='(-?\d+\.\d+)'/);
    if (!lat || !lng) return null;
    return [Number(lng[1]), Number(lat[1])]; // [lng, lat]
  } catch {
    return null;
  }
}

/** Session cookie for coord fetching (exported for the sync). */
export async function raSession(host: string): Promise<string> {
  return session(host);
}
