import type { Campground, Campsite } from '@/lib/types';
import type { RIDBFacility, RIDBCampsite } from './client';

// RIDB activity IDs we care about for tagging
const ACTIVITY_TAGS: Record<string, string> = {
  'camping': 'camping',
  'hiking': 'hiking',
  'fishing': 'fishing',
  'swimming': 'swimming',
  'boating': 'boating',
  'paddling': 'paddling',
  'kayaking': 'paddling',
  'canoeing': 'paddling',
  'rock climbing': 'rock climbing',
  'mountain biking': 'mountain biking',
  'horseback riding': 'horseback riding',
  'hunting': 'hunting',
  'wildlife viewing': 'wildlife viewing',
  'birding': 'birding',
  'off-highway vehicle': 'OHV',
  'atv': 'OHV',
  'snowshoeing': 'snowshoeing',
  'cross-country skiing': 'skiing',
  'skiing': 'skiing',
  'snowmobiling': 'snowmobiling',
};

// Derive environment tags from name + description
function deriveEnvironmentTags(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const tags: string[] = [];

  if (/\blake\b|\bpond\b|\breservoir\b/.test(text)) tags.push('lake');
  if (/\briver\b|\bcreek\b|\bstream\b|\bbrook\b/.test(text)) tags.push('river');
  if (/\bocean\b|\bbeach\b|\bcoast\b|\bbay\b|\bsea\b/.test(text)) tags.push('ocean');
  if (/\bmountain\b|\balpine\b|\bpeak\b|\bridge\b/.test(text)) tags.push('mountain');
  if (/\bforest\b|\bwoods\b|\btimber\b/.test(text)) tags.push('forest');
  if (/\bdesert\b|\bsand\b|\bdune\b/.test(text)) tags.push('desert');
  if (/\bmeadow\b|\bprairie\b|\bgrassland\b/.test(text)) tags.push('meadow');
  if (/\bcanyon\b|\bgorge\b/.test(text)) tags.push('canyon');
  if (/\bwaterfall\b|\bfalls\b/.test(text)) tags.push('waterfall');
  if (/\bwilderness\b|\bbackcountry\b/.test(text)) tags.push('wilderness');

  return [...new Set(tags)];
}

// Normalize campsite type from RIDB's freeform strings.
// Careful: "STANDARD NONELECTRIC" contains the substring "electric" — match
// specific tokens, and check tent-only before RV.
function normalizeSiteType(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('cabin') || t.includes('lodge') || t.includes('shelter')) return 'cabin';
  if (t.includes('yurt')) return 'yurt';
  if (t.includes('group')) return 'group';
  if (t.includes('tent only') || t.includes('walk to') || t.includes('hike to') || t.includes('boat in')) return 'tent';
  if (t.includes('rv')) return 'rv';
  // STANDARD sites are drive-in: usable by tents and (usually) RVs
  if (t.includes('standard')) return 'standard';
  return 'tent';
}

/** Does the campsite accommodate an RV/trailer (per permitted equipment or type)? */
function isRvCapable(cs: RIDBCampsite): boolean {
  const equip = cs.PERMITTEDEQUIPMENT ?? [];
  if (equip.some((e) => /rv|trailer|fifth wheel|camper|motorhome/i.test(e.EquipmentName))) return true;
  return /(^|\s)rv(\s|$)/i.test(cs.CampsiteType);
}

/** Largest permitted vehicle/trailer length for a campsite, or null. */
function maxEquipmentLength(cs: RIDBCampsite): number | null {
  const equip = (cs.PERMITTEDEQUIPMENT ?? []).filter((e) =>
    /rv|trailer|fifth wheel|camper|motorhome/i.test(e.EquipmentName)
  );
  const lengths = equip.map((e) => e.MaxLength).filter((n) => Number.isFinite(n) && n > 0);
  return lengths.length > 0 ? Math.max(...lengths) : null;
}

/** True when the RIDB type string indicates electric hookups. */
function isElectricSite(cs: RIDBCampsite): boolean {
  return /(?<!non)electric/i.test(cs.CampsiteType.replace(/\s+/g, ''));
}

// Extract amenities from facility description + attributes
function deriveAmenities(facility: RIDBFacility): string[] {
  const text = (facility.FacilityDescription || '').toLowerCase();
  const amenities: string[] = [];

  if (/\btoilet\b|\brestroom\b|\bpit toilet\b|\bvault toilet\b/.test(text)) amenities.push('toilets');
  if (/\bflush toilet\b|\bflush restroom\b/.test(text)) amenities.push('flush toilets');
  if (/\bshower\b/.test(text)) amenities.push('showers');
  if (/\bdrinking water\b|\bpotable water\b|\bwater spigot\b/.test(text)) amenities.push('drinking water');
  if (/\belectric(al)? hookup\b|\belectric(al)? site\b/.test(text)) amenities.push('electric hookup');
  if (/\bsewer\b/.test(text)) amenities.push('sewer hookup');
  if (/\bdump station\b/.test(text)) amenities.push('dump station');
  if (/\bfire ring\b|\bfire pit\b/.test(text)) amenities.push('fire rings');
  if (/\bpicnic table\b/.test(text)) amenities.push('picnic tables');
  if (/\bboat ramp\b|\bboat launch\b/.test(text)) amenities.push('boat ramp');
  if (/\bcell service\b|\bwifi\b/.test(text)) amenities.push('wifi');
  if (/\blaundry\b/.test(text)) amenities.push('laundry');
  if (/\bstore\b|\bcamp store\b/.test(text)) amenities.push('camp store');

  if (facility.FacilityAdaAccess === 'Y') amenities.push('ADA accessible');

  return [...new Set(amenities)];
}

export function transformFacility(facility: RIDBFacility): Campground {
  const activities = (facility.ACTIVITY ?? []).map((a) => a.ActivityName);
  const activityTags = activities
    .map((a) => ACTIVITY_TAGS[a.toLowerCase()])
    .filter(Boolean) as string[];

  const environmentTags = deriveEnvironmentTags(
    facility.FacilityName,
    facility.FacilityDescription ?? ''
  );

  const photos = (facility.MEDIA ?? [])
    .filter((m) => m.MediaType === 'Photo' && m.URL)
    .map((m) => ({ url: m.URL, title: m.Title, isPrimary: m.IsPrimary }));

  const primaryAddress = (facility.FACILITYADDRESS ?? []).find(
    (a) => a.AddressType === 'Default'
  ) ?? facility.FACILITYADDRESS?.[0];

  // Initial guesses from the (shallow) embedded campsite list — the sync
  // overwrites these via deriveCampgroundRollups once full campsites load.
  const rollups = deriveCampgroundRollups(facility.CAMPSITE ?? []);
  const siteTypes = rollups.siteTypes;
  const petsAllowed = rollups.petsAllowed;

  return {
    id: facility.FacilityID,
    source: 'ridb',
    name: facility.FacilityName,
    description: facility.FacilityDescription || null,
    latitude: facility.FacilityLatitude,
    longitude: facility.FacilityLongitude,
    address: {
      street: primaryAddress?.FacilityStreetAddress1,
      city: primaryAddress?.City,
      state: primaryAddress?.AddressStateCode,
      zip: primaryAddress?.PostalCode,
    },
    amenities: deriveAmenities(facility),
    activities: activityTags,
    environmentTags,
    siteTypes: siteTypes.length > 0 ? siteTypes : ['tent'],
    reservable: facility.Reservable,
    reservationsUrl:
      facility.FacilityReservationURL ||
      `https://www.recreation.gov/camping/campgrounds/${facility.FacilityID}`,
    phone: facility.FacilityPhone || null,
    email: facility.FacilityEmail || null,
    adaAccessible: facility.FacilityAdaAccess === 'Y',
    petsAllowed,
    photos,
    lastSyncedAt: new Date().toISOString(),
  };
}

export function transformCampsite(cs: RIDBCampsite): Campsite {
  const attrs: Record<string, string> = {};
  for (const a of cs.ATTRIBUTES ?? []) {
    attrs[a.AttributeName] = a.AttributeValue;
  }

  const maxOccupants = attrs['Max Num of People']
    ? parseInt(attrs['Max Num of People'], 10)
    : null;

  // Prefer permitted-equipment lengths (per-equipment, reliable); fall back to
  // the "Max Vehicle Length" attribute, which is often 0/absent.
  const attrVehicleLength = attrs['Max Vehicle Length']
    ? parseInt(attrs['Max Vehicle Length'], 10)
    : NaN;
  const maxVehicleLength =
    maxEquipmentLength(cs) ??
    (Number.isFinite(attrVehicleLength) && attrVehicleLength > 0 ? attrVehicleLength : null);

  const petsAllowed =
    attrs['Pets Allowed']?.toLowerCase() === 'yes' ||
    attrs['Dog Friendly']?.toLowerCase() === 'yes';

  return {
    id: cs.CampsiteID,
    campgroundId: cs.FacilityID,
    name: cs.CampsiteName || null,
    type: normalizeSiteType(cs.CampsiteType),
    loop: cs.Loop || null,
    maxOccupants: isNaN(maxOccupants!) ? null : maxOccupants,
    maxVehicleLength,
    adaAccessible: cs.CampsiteAccessible,
    petsAllowed,
    reservable: cs.CampsiteReservable,
    attributes: attrs,
  };
}

/**
 * Campground-level rollups derived from full campsite records (the embedded
 * CAMPSITE array on facility search responses lacks ATTRIBUTES/equipment, so
 * these must come from the per-facility campsites endpoint).
 */
export function deriveCampgroundRollups(campsites: RIDBCampsite[]): {
  siteTypes: string[];
  petsAllowed: boolean;
  hasElectric: boolean;
} {
  const siteTypes = new Set<string>();
  let petsAllowed = false;
  let hasElectric = false;

  for (const cs of campsites) {
    const t = normalizeSiteType(cs.CampsiteType);
    if (t === 'standard') {
      siteTypes.add('tent');
      if (isRvCapable(cs)) siteTypes.add('rv');
    } else {
      siteTypes.add(t);
      if (t !== 'rv' && isRvCapable(cs)) siteTypes.add('rv');
    }
    if (isElectricSite(cs)) hasElectric = true;
    if ((cs.ATTRIBUTES ?? []).some(
      (a) => a.AttributeName.toLowerCase().includes('pet') && a.AttributeValue.toLowerCase() === 'yes'
    )) petsAllowed = true;
  }

  return { siteTypes: [...siteTypes], petsAllowed, hasElectric };
}
