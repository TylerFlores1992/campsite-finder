import axios from 'axios';
import type { CampgroundAvailability, CampsiteAvailability, AvailabilityDay } from '@/lib/types';

// Recreation.gov's unofficial availability API — same one their own site uses.
// Returns availability by campsite for a given month.
// Treat as best-effort: structure can change without notice.
const BASE = 'https://www.recreation.gov/api/camps/availability/campground';

type RecGovStatus =
  | 'Available'
  | 'Reserved'
  | 'Not Available'
  | 'Open'
  | 'Closed'
  | string;

interface RecGovCampsite {
  availabilities: Record<string, RecGovStatus>; // ISO date string → status
  campsite_id: string;
  campsite_reserve_type: string;
  campsite_type: string;
  loop: string;
  max_num_people: number;
  min_num_people: number;
  site: string;
  type_of_use: string;
}

function normalizeStatus(raw: RecGovStatus): AvailabilityDay['status'] {
  switch (raw) {
    case 'Available':
    case 'Open':
      return 'available';
    case 'Reserved':
      return 'reserved';
    case 'Closed':
      return 'closed';
    default:
      return 'not_available';
  }
}

function isoToDate(iso: string): string {
  // RecGov returns "2024-07-01T00:00:00Z" — we want "2024-07-01"
  return iso.slice(0, 10);
}

export async function getAvailabilityFromRecGov(
  campgroundId: string,
  month: string // YYYY-MM
): Promise<CampgroundAvailability> {
  const startDate = `${month}-01T00:00:00.000Z`;

  let rawCampsites: Record<string, RecGovCampsite> = {};

  try {
    // recreation.gov rejects unencoded ':' in query params ("query not encoded"),
    // and axios's default serializer leaves ':' bare — encode the URL ourselves.
    const response = await axios.get(
      `${BASE}/${campgroundId}/month?start_date=${encodeURIComponent(startDate)}`,
      {
        timeout: 10000,
        headers: {
          // mimic the browser — this is an unofficial API
          'User-Agent': 'Mozilla/5.0 (compatible; CampsiteFinder/1.0)',
          Accept: 'application/json',
        },
      }
    );
    rawCampsites = response.data?.campsites ?? {};
  } catch (err) {
    console.warn(`[RecGov availability] Failed for ${campgroundId}/${month}:`, (err as Error).message);
    // Return empty availability rather than crashing
  }

  const campsites: CampsiteAvailability[] = Object.values(rawCampsites).map((cs) => {
    const days: AvailabilityDay[] = Object.entries(cs.availabilities).map(([iso, status]) => ({
      date: isoToDate(iso),
      status: normalizeStatus(status),
      minStay: null,
    }));

    days.sort((a, b) => a.date.localeCompare(b.date));

    return {
      campsiteId: cs.campsite_id,
      campsiteName: cs.site || null,
      campsiteType: cs.campsite_type || null,
      loop: cs.loop || null,
      availability: days,
    };
  });

  const availableCount = campsites.filter((cs) =>
    cs.availability.some((d) => d.status === 'available')
  ).length;

  return {
    campgroundId,
    month,
    campsites,
    availableCount,
  };
}

/** Check if a campground has any available nights in a date range across all its campsites. */
export async function hasAvailabilityInRange(
  campgroundId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,   // YYYY-MM-DD
  minNights = 1
): Promise<boolean> {
  // Determine which months to check
  const months = new Set<string>();
  const start = new Date(startDate);
  const end = new Date(endDate);
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    months.add(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }

  // Collect per-campsite availability across months so a stay spanning a month
  // boundary still counts as consecutive at the same site.
  const bySite = new Map<string, Map<string, boolean>>();
  for (const month of months) {
    const avail = await getAvailabilityFromRecGov(campgroundId, month);
    for (const cs of avail.campsites) {
      const days = bySite.get(cs.campsiteId) ?? new Map<string, boolean>();
      for (const day of cs.availability) {
        // Nights of the stay are [startDate, endDate) — checkout day isn't a night.
        if (day.date < startDate || day.date >= endDate) continue;
        days.set(day.date, day.status === 'available');
      }
      bySite.set(cs.campsiteId, days);
    }
  }

  for (const days of bySite.values()) {
    let consecutive = 0;
    for (const date of [...days.keys()].sort()) {
      if (days.get(date)) {
        consecutive++;
        if (consecutive >= minNights) return true;
      } else {
        consecutive = 0;
      }
    }
  }

  return false;
}
