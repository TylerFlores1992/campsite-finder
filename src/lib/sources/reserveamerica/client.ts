// ReserveAmerica (Aspira) HTML-scrape client.
//
// Availability is server-rendered — no official API, no JSON, no browser needed.
// The "site list" view of campsiteCalendar.do (sitepage=true) renders one block
// per site; bookable sites contain `sitescompareselectorbtn<siteId>'>available`.
// We fetch a session cookie from the state subdomain first, then read the site
// list per night and intersect across the stay for consecutive-night matching.
//
// One integration serves every ReserveAmerica state — they differ only by
// contractCode + subdomain host (see RA_CONTRACTS).

export interface RAContract {
  contractCode: string; // e.g. 'NY'
  host: string;         // e.g. 'newyorkstateparks.reserveamerica.com'
  name: string;         // 'New York State Parks'
  state: string;        // 'NY'
}

// Genuine-ReserveAmerica states (others migrated to UseDirect). Add as we build
// each state's park catalog.
export const RA_CONTRACTS: RAContract[] = [
  { contractCode: 'NY', host: 'newyorkstateparks.reserveamerica.com', name: 'New York State Parks', state: 'NY' },
  { contractCode: 'TX', host: 'texasstateparks.reserveamerica.com', name: 'Texas State Parks', state: 'TX' },
  { contractCode: 'OR', host: 'oregonstateparks.reserveamerica.com', name: 'Oregon State Parks', state: 'OR' },
  { contractCode: 'UT', host: 'utahstateparks.reserveamerica.com', name: 'Utah State Parks', state: 'UT' },
  { contractCode: 'NC', host: 'northcarolinastateparks.reserveamerica.com', name: 'North Carolina State Parks', state: 'NC' },
  { contractCode: 'KY', host: 'kentuckystateparks.reserveamerica.com', name: 'Kentucky State Parks', state: 'KY' },
  { contractCode: 'IA', host: 'iowastateparks.reserveamerica.com', name: 'Iowa State Parks', state: 'IA' },
  { contractCode: 'IN', host: 'indianastateparks.reserveamerica.com', name: 'Indiana State Parks', state: 'IN' },
  { contractCode: 'GA', host: 'gastateparks.reserveamerica.com', name: 'Georgia State Parks', state: 'GA' },
  { contractCode: 'NE', host: 'nebraskastateparks.reserveamerica.com', name: 'Nebraska State Parks', state: 'NE' },
  { contractCode: 'PA', host: 'pennsylvaniastateparks.reserveamerica.com', name: 'Pennsylvania State Parks', state: 'PA' },
  { contractCode: 'NH', host: 'newhampshirestateparks.reserveamerica.com', name: 'New Hampshire State Parks', state: 'NH' },
  { contractCode: 'MT', host: 'montanastateparks.reserveamerica.com', name: 'Montana State Parks', state: 'MT' },
  { contractCode: 'RI', host: 'rhodeislandstateparks.reserveamerica.com', name: 'Rhode Island State Parks', state: 'RI' },
  { contractCode: 'NM', host: 'newmexicostateparks.reserveamerica.com', name: 'New Mexico State Parks', state: 'NM' },
  { contractCode: 'AK', host: 'alaskastateparks.reserveamerica.com', name: 'Alaska State Parks', state: 'AK' },
  { contractCode: 'CT', host: 'connecticutstateparks.reserveamerica.com', name: 'Connecticut State Parks', state: 'CT' },
  { contractCode: 'DE', host: 'delawarestateparks.reserveamerica.com', name: 'Delaware State Parks', state: 'DE' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function contractByCode(code: string): RAContract | undefined {
  return RA_CONTRACTS.find((c) => c.contractCode === code);
}

/** MM/DD/YYYY in UTC (RA expects US-format arrival dates; parse as literal). */
function usDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Grab a session cookie from the state subdomain (needed for the matrix pages). */
async function getSession(host: string): Promise<string> {
  const res = await fetch(`https://${host}/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function fetchHtml(url: string, cookie: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`RA ${res.status} ${url}`);
  return res.text();
}

/** SiteIds bookable for a single arrival night at a park (paginates all results). */
async function availableSiteIdsForNight(
  contract: RAContract,
  parkId: number,
  arrivalIso: string,
  cookie: string
): Promise<Set<number>> {
  const cal = encodeURIComponent(usDate(arrivalIso));
  const ids = new Set<number>();
  let startIdx = 0;
  let total = Infinity;
  const PAGE = 25;

  while (startIdx < total && startIdx < 1000) {
    const url =
      `https://${contract.host}/campsiteCalendar.do?page=matrix&contractCode=${contract.contractCode}` +
      `&parkId=${parkId}&calarvdate=${cal}&sitepage=true&startIdx=${startIdx}`;
    const body = await fetchHtml(url, cookie);

    const t = body.match(/id='resulttotal_top'>(\d+)</);
    if (t) total = Number(t[1]);

    // A site's status block: `sitescompareselectorbtn<siteId>'>available…` when bookable.
    for (const m of body.matchAll(/sitescompareselectorbtn(\d+)'>\s*available/gi)) {
      ids.add(Number(m[1]));
    }
    if (!t && body.indexOf('sitescompareselectorbtn') === -1) break; // no site list → stop
    startIdx += PAGE;
  }
  return ids;
}

/**
 * Whether a SINGLE site is bookable for the whole consecutive stay
 * [startDate, +nights). Intersects the per-night available-site sets. Best-effort:
 * errors resolve to no availability.
 */
export async function raStayAvailability(
  contract: RAContract,
  parkId: number,
  startDate: string,
  nights: number
): Promise<{ available: boolean; siteIds: number[] }> {
  try {
    const cookie = await getSession(contract.host);
    let common: Set<number> | null = null;
    for (let i = 0; i < Math.max(1, nights); i++) {
      const ids = await availableSiteIdsForNight(contract, parkId, addDaysIso(startDate, i), cookie);
      if (common === null) {
        common = ids;
      } else {
        const next = new Set<number>();
        for (const x of common) if (ids.has(x)) next.add(x);
        common = next;
      }
      if (common.size === 0) return { available: false, siteIds: [] };
    }
    return { available: (common?.size ?? 0) > 0, siteIds: common ? [...common] : [] };
  } catch (err) {
    console.warn(`[RA] availability failed for ${contract.contractCode}/${parkId}:`, (err as Error).message);
    return { available: false, siteIds: [] };
  }
}

/** Quick park-level count from the matchSummary header (single arrival night). */
export async function raParkAvailabilityCount(
  contract: RAContract,
  parkId: number,
  arrivalIso: string
): Promise<{ available: number; total: number } | null> {
  try {
    const cookie = await getSession(contract.host);
    const cal = encodeURIComponent(usDate(arrivalIso));
    const body = await fetchHtml(
      `https://${contract.host}/campsiteCalendar.do?page=matrix&contractCode=${contract.contractCode}&parkId=${parkId}&calarvdate=${cal}&sitepage=true`,
      cookie
    );
    const m = body.match(/(\d+)\s*site\(s\)\s*available\s*out of\s*(\d+)/i);
    return m ? { available: Number(m[1]), total: Number(m[2]) } : null;
  } catch {
    return null;
  }
}
