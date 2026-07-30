// UseDirect / US eDirect provider registry.
//
// ReserveCalifornia, Arizona State Parks, Minnesota, Missouri, etc. all run on
// Tyler Technologies' RDR API (same /fd/* + /search/grid endpoints, same grid
// slice shape incl. the cancelled-but-held `Lock` field). One integration serves
// them all — each state is just a registry entry here. Campground ids are
// prefixed per provider (`rc-…`, `az-…`) so their facility-id namespaces never
// collide.

export interface UseDirectProvider {
  /** campgrounds.source value in our DB. */
  source: string;
  /** campground id prefix, e.g. 'rc' → 'rc-123', unit 'rc-unit-45'. */
  idPrefix: string;
  /** Display name for alert copy. */
  name: string;
  /** Two-letter state, used as an address fallback. */
  state: string;
  /** Discover the current RDR base from this config.json's rdrApiUrl (host moves). */
  configUrl?: string;
  /** Static RDR base when there's no config.json to discover from. */
  rdrBase?: string;
  /** Last-known RDR base if discovery fails. */
  fallbackBase: string;
  /** Public booking deep link for a park (reservations_url + alert CTA). */
  parkUrl: (placeId: number) => string;
}

export const USEDIRECT_PROVIDERS: UseDirectProvider[] = [
  {
    source: 'reservecalifornia',
    idPrefix: 'rc',
    name: 'ReserveCalifornia',
    state: 'CA',
    configUrl: 'https://www.reservecalifornia.com/config.json',
    fallbackBase: 'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr',
    parkUrl: (placeId) => `https://www.reservecalifornia.com/park/${placeId}`,
  },
  {
    source: 'arizonastateparks',
    idPrefix: 'az',
    name: 'Arizona State Parks',
    state: 'AZ',
    rdrBase: 'https://azrdr.usedirect.com/azrdr/rdr',
    fallbackBase: 'https://azrdr.usedirect.com/azrdr/rdr',
    parkUrl: () => 'https://azstateparks.com/reserve/',
  },
  {
    source: 'minnesotastateparks',
    idPrefix: 'mn',
    name: 'Minnesota State Parks',
    state: 'MN',
    rdrBase: 'https://mnrdr.usedirect.com/minnesotardr/rdr',
    fallbackBase: 'https://mnrdr.usedirect.com/minnesotardr/rdr',
    parkUrl: () => 'https://reservemn.usedirect.com/',
  },
  {
    source: 'missouristateparks',
    idPrefix: 'mo',
    name: 'Missouri State Parks',
    state: 'MO',
    rdrBase: 'https://msprdr.usedirect.com/MSPRDR/rdr',
    fallbackBase: 'https://msprdr.usedirect.com/MSPRDR/rdr',
    parkUrl: () => 'https://icampmo1.usedirect.com/',
  },
  {
    source: 'floridastateparks',
    idPrefix: 'fl',
    name: 'Florida State Parks',
    state: 'FL',
    rdrBase: 'https://floridardr.usedirect.com/Floridardr/rdr',
    fallbackBase: 'https://floridardr.usedirect.com/Floridardr/rdr',
    parkUrl: () => 'https://reserve.floridastateparks.org/Web/',
  },
  {
    source: 'nevadastateparks',
    idPrefix: 'nv',
    name: 'Nevada State Parks',
    state: 'NV',
    rdrBase: 'https://nevadardr.usedirect.com/nevadardr/rdr',
    fallbackBase: 'https://nevadardr.usedirect.com/nevadardr/rdr',
    parkUrl: () => 'https://www.reservenevada.com/NevadaWeb/',
  },
  {
    source: 'ohiostateparks',
    idPrefix: 'oh',
    name: 'Ohio State Parks',
    state: 'OH',
    rdrBase: 'https://ohiordr.usedirect.com/Ohiordr/rdr',
    fallbackBase: 'https://ohiordr.usedirect.com/Ohiordr/rdr',
    parkUrl: () => 'https://reserveohio.com/OhioCampWeb/',
  },
  {
    source: 'wyomingstateparks',
    idPrefix: 'wy',
    name: 'Wyoming State Parks',
    state: 'WY',
    rdrBase: 'https://wyordr.usedirect.com/wyomingrdr/rdr',
    fallbackBase: 'https://wyordr.usedirect.com/wyomingrdr/rdr',
    parkUrl: () => 'https://reserve.wyoming.gov/Web/',
  },
  {
    // Newer Tyler-hosted RDR (like RC's current base). Host may rotate; no
    // config.json discovery endpoint found, so static + fallback for now.
    source: 'illinoisstateparks',
    idPrefix: 'il',
    name: 'Illinois State Parks',
    state: 'IL',
    rdrBase: 'https://il-rdr.recreation-management.tylerapp.com/IllinoisRDR/rdr',
    fallbackBase: 'https://il-rdr.recreation-management.tylerapp.com/IllinoisRDR/rdr',
    parkUrl: () => 'https://recreation.exploremoreil.com/IllinoisWeb/',
  },
  {
    source: 'virginiastateparks',
    idPrefix: 'va',
    name: 'Virginia State Parks',
    state: 'VA',
    rdrBase: 'https://prod-va-rdr.recreation-management.tylerapp.com/virginiardr/rdr',
    fallbackBase: 'https://prod-va-rdr.recreation-management.tylerapp.com/virginiardr/rdr',
    parkUrl: () => 'https://www.reservevaparks.com/Web/',
  },
];

export function providerBySource(source: string): UseDirectProvider | undefined {
  return USEDIRECT_PROVIDERS.find((p) => p.source === source);
}

export function providerByCampgroundId(campgroundId: string): UseDirectProvider | undefined {
  return USEDIRECT_PROVIDERS.find((p) => campgroundId.startsWith(`${p.idPrefix}-`));
}

export function isUseDirectSource(source: string): boolean {
  return USEDIRECT_PROVIDERS.some((p) => p.source === source);
}

/** RDR API hosts we allow the Vercel proxy to forward to (WAF workaround). */
export const USEDIRECT_ALLOWED_HOSTS = Array.from(
  new Set(
    USEDIRECT_PROVIDERS.flatMap((p) =>
      [p.rdrBase, p.fallbackBase].filter(Boolean).map((u) => new URL(u!).host)
    )
  )
);

/**
 * Headers for an RDR call, matching what the providers' own booking sites send.
 *
 * These are the same endpoints reservecalifornia.com (and each state's site) calls
 * from the browser, and they are fronted by WAFs that score requests on how ordinary
 * they look. We were sending `Mozilla/5.0 (compatible; CampsiteFinder/1.0)` with no
 * Origin, Referer or Accept-Language — a self-identifying non-browser and trivially
 * filterable. On 2026-07-30 the Virginia host started returning a flat nginx 403 to
 * our proxy and California a bare 500, while the identical request succeeded from a
 * different IP, so how the request presents itself is the cheapest thing to correct.
 *
 * Origin/Referer are derived from each provider's own public booking site (parkUrl),
 * so every state gets the pairing its WAF expects rather than a hardcoded Californian
 * one. Unknown hosts get the headers minus Origin/Referer — inventing a mismatched
 * pair is worse than sending none.
 *
 * This is not evasion of a rate limit: a single request and ten concurrent requests
 * both returned 200 from an unrelated datacenter IP at the time, so volume is not
 * what these hosts are refusing.
 */
export function rdrRequestHeaders(base?: string, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/139.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="139", "Not(A:Brand";v="24", "Google Chrome";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
  if (hasBody) headers['Content-Type'] = 'application/json';

  if (base) {
    try {
      const host = new URL(base).host;
      const provider = USEDIRECT_PROVIDERS.find((p) =>
        [p.rdrBase, p.fallbackBase].filter(Boolean).some((u) => new URL(u!).host === host)
      );
      if (provider) {
        const site = new URL(provider.parkUrl(1)).origin;
        headers.Origin = site;
        headers.Referer = `${site}/`;
      }
    } catch {
      // Unknown/unparseable base — send the browser headers without a fabricated pair.
    }
  }
  return headers;
}
