import type { Campground } from '@/lib/types';
import { describePlain } from '@/components/v2/richText';
import { normalizeStateCode } from '@/lib/coverage';
import { campgroundUrl, SITE_NAME, SITE_URL } from '@/lib/seo';

/**
 * Structured data (JSON-LD).
 *
 * WHAT THIS IS FOR: telling Google that a campground page is about a PLACE with
 * a location, a phone number and facilities — not just a bag of words. That's
 * what makes a page eligible to be treated as an entity rather than a document,
 * and it's the cheapest remaining SEO win now that the row is already loaded
 * server-side for rendering.
 *
 * EVERY FIELD IS OMITTED WHEN WE DON'T HAVE IT. No placeholder values, no
 * empty strings, and above all no aggregateRating or priceRange — we have
 * neither, and inventing them is exactly the kind of thing that earns a
 * structured-data manual action. Coverage in the catalog is uneven (geo 100%,
 * state 97%, city 75%, phone 73%, email 22%, amenities 53%), so most pages emit
 * a partial object, which is fine and valid.
 *
 * NO FAQPage, despite it being on the original plan. Google restricted FAQ rich
 * results to authoritative government and health sites in August 2023, so
 * FAQPage markup on camphawk.app produces no rich result at all — and the only
 * way to add it would be to invent questions nobody asked. Dropped rather than
 * shipped as decoration.
 */

/**
 * Serialise for a <script> tag.
 *
 * The `<` escape is not optional. Campground names and descriptions are
 * third-party strings; one containing "</script>" would close the tag and turn
 * the rest of the payload into live markup. < is still valid JSON and
 * parses back to "<".
 */
export function jsonLdScript(data: object): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Prefer the USPS code; fall back to the raw value so DC and territories keep
 *  an addressRegion. The catalog holds a mix — "Virginia" (190 rows), "OREGON",
 *  " IL" — and addressRegion should be consistent across pages. */
function regionCode(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return normalizeStateCode(raw) ?? raw.trim();
}

/**
 * schema.org/Campground — a subtype of LodgingBusiness and CivicStructure,
 * which is the type Google understands for a place people stay.
 */
export function campgroundJsonLd(c: Campground) {
  const url = campgroundUrl(c.id);
  const region = regionCode(c.address?.state);
  const description = describePlain(c.description);

  const address: Record<string, string> = { '@type': 'PostalAddress', addressCountry: 'US' };
  if (c.address?.street) address.streetAddress = c.address.street;
  if (c.address?.city) address.addressLocality = c.address.city;
  if (region) address.addressRegion = region;
  if (c.address?.zip) address.postalCode = c.address.zip;

  const amenities = (c.amenities ?? []).filter(Boolean);

  return {
    '@context': 'https://schema.org',
    '@type': 'Campground',
    '@id': `${url}#campground`,
    name: c.name,
    url,
    ...(description ? { description: description.slice(0, 1000) } : {}),
    address,
    // Present on all 8,013 rows — the one field we can always rely on.
    ...(typeof c.latitude === 'number' && typeof c.longitude === 'number'
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: c.latitude,
            longitude: c.longitude,
          },
        }
      : {}),
    ...(c.phone ? { telephone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.photos?.length ? { image: c.photos.map((p) => p.url) } : {}),
    // Only when TRUE. The column is false for everything we haven't confirmed,
    // so emitting `false` would publish "no pets allowed" about campgrounds
    // that simply have no data — a claim we can't stand behind.
    ...(c.petsAllowed ? { petsAllowed: true } : {}),
    ...(amenities.length
      ? {
          amenityFeature: amenities.map((a) => ({
            '@type': 'LocationFeatureSpecification',
            name: a,
            value: true,
          })),
        }
      : {}),
    // Where you actually book. Naming the provider's page is honest about what
    // we are: we find the opening, they take the reservation.
    ...(c.reservationsUrl
      ? {
          potentialAction: {
            '@type': 'ReserveAction',
            target: { '@type': 'EntryPoint', urlTemplate: c.reservationsUrl },
          },
        }
      : {}),
  };
}

/**
 * Breadcrumbs. Two levels today — Home › Campground.
 *
 * State landing pages would slot in as the middle item, but they don't exist
 * yet and a breadcrumb pointing at a 404 is worse than a short breadcrumb.
 */
export function campgroundBreadcrumbJsonLd(c: Campground) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: c.name, item: campgroundUrl(c.id) },
    ],
  };
}

/**
 * Site-level identity, rendered once in the root layout.
 *
 * Deliberately minimal: name, url, logo, what we do. No sameAs (we'd be listing
 * social profiles that may not exist), no contactPoint (there's no staffed
 * phone line), no SearchAction — Google retired the sitelinks search box in
 * 2024, so it would be markup nothing consumes.
 */
export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}#organization`,
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/logo-full.png`,
    description:
      'CampHawk watches booked campgrounds on Recreation.gov and state park systems and alerts you within seconds of a cancellation.',
  };
}
