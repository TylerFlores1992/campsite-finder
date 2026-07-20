// GoingToCamp (Camis) tenant registry.
//
// Washington, Michigan, Wisconsin and Mississippi all run the same Camis
// application — one integration serves them all, exactly like USEDIRECT_PROVIDERS
// does for Tyler's RDR. Campground ids are prefixed per state (`gtc-WA-…`) so the
// tenants' resource-id namespaces never collide.
//
// IMPORTANT: do NOT identify this platform by domain name. MI and MS are served
// from vanity hosts (midnrreservations.com, reserve.mdwfp.com) and an earlier
// survey misfiled them as a different vendor entirely. The reliable test is
// `GET /api/resourcelocation` returning a JSON array.

export interface GoingToCampProvider {
  /** Two-letter state; also the id segment (`gtc-WA-…`). */
  state: string;
  /** Tenant host. */
  host: string;
  /** Display name for alert copy. */
  name: string;
  /** Public booking entry point (reservations_url + alert CTA). */
  bookingUrl: string;
}

export const GOINGTOCAMP_PROVIDERS: GoingToCampProvider[] = [
  {
    state: 'WA',
    host: 'washington.goingtocamp.com',
    name: 'Washington State Parks',
    bookingUrl: 'https://washington.goingtocamp.com/',
  },
  {
    state: 'MI',
    host: 'midnrreservations.com',
    name: 'Michigan State Parks',
    bookingUrl: 'https://midnrreservations.com/',
  },
  {
    state: 'WI',
    host: 'wisconsin.goingtocamp.com',
    name: 'Wisconsin State Parks',
    bookingUrl: 'https://wisconsin.goingtocamp.com/',
  },
  {
    state: 'MS',
    host: 'reserve.mdwfp.com',
    name: 'Mississippi State Parks',
    bookingUrl: 'https://reserve.mdwfp.com/',
  },
];

/** Our single source value in the campgrounds table. */
export const GOINGTOCAMP_SOURCE = 'goingtocamp';

export function gtcProviderByState(state: string): GoingToCampProvider | undefined {
  return GOINGTOCAMP_PROVIDERS.find((p) => p.state === state.toUpperCase());
}

/** Parse `gtc-WA--2147483647` → provider + resourceLocationId (ids are negative). */
export function parseGoingToCampId(
  campgroundId: string
): { provider: GoingToCampProvider; resourceLocationId: number } | null {
  const m = campgroundId.match(/^gtc-([A-Z]{2})-(-?\d+)$/);
  if (!m) return null;
  const provider = gtcProviderByState(m[1]);
  return provider ? { provider, resourceLocationId: Number(m[2]) } : null;
}

export function goingToCampId(provider: GoingToCampProvider, resourceLocationId: number): string {
  return `gtc-${provider.state}-${resourceLocationId}`;
}

export function isGoingToCampSource(source: string): boolean {
  return source === GOINGTOCAMP_SOURCE;
}

/** Tenant hosts the Vercel proxy is allowed to forward to (WAF workaround). */
export const GOINGTOCAMP_ALLOWED_HOSTS = GOINGTOCAMP_PROVIDERS.map((p) => p.host);
