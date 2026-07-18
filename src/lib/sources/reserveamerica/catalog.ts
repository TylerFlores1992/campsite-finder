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

  // 2. Parse parkId + name. Each park appears twice (an "Enter Date" placeholder
  //    link + the real UPPERCASE name link) — keep the longest non-placeholder name.
  const list = await html(listUrl, cookie);
  const byId = new Map<number, { name: string; detailPath: string }>();
  for (const m of list.matchAll(/href='(\/camping\/[a-z0-9-]+\/r\/campgroundDetails\.do\?[^']*parkId=(\d+)[^']*)'[^>]*>([^<]{2,80})</gi)) {
    const detailPath = m[1];
    const id = Number(m[2]);
    const name = m[3].trim();
    if (/^enter date$/i.test(name)) continue;
    const prev = byId.get(id);
    if (!prev || name.length > prev.name.length) byId.set(id, { name, detailPath });
  }
  return [...byId.entries()].map(([parkId, v]) => ({ parkId, name: v.name, detailPath: v.detailPath }));
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
