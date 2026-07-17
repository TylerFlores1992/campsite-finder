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
