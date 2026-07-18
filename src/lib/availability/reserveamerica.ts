// Availability adapter for ReserveAmerica campgrounds. Campground ids are
// `ra-<contractCode>-<parkId>` (e.g. ra-NY-404); we parse the contract + park and
// call the scrape client. All call sites stay source-agnostic.

import { contractByCode, raStayAvailability } from '@/lib/sources/reserveamerica/client';

export function isReserveAmericaCampgroundId(campgroundId: string): boolean {
  return /^ra-[A-Z]+-\d+$/.test(campgroundId);
}

/** Parse `ra-NY-404` → { contractCode: 'NY', parkId: 404 }. */
function parseId(campgroundId: string): { contractCode: string; parkId: number } | null {
  const m = campgroundId.match(/^ra-([A-Z]+)-(\d+)$/);
  return m ? { contractCode: m[1], parkId: Number(m[2]) } : null;
}

function nightsOf(startDate: string, endDate: string): number {
  return Math.max(1, Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000));
}

/** True if one site is bookable for the whole consecutive stay within the window. */
export async function hasReserveAmericaAvailabilityInRange(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<boolean> {
  const parsed = parseId(campgroundId);
  if (!parsed) return false;
  const contract = contractByCode(parsed.contractCode);
  if (!contract) return false;
  const nights = Math.max(minNights, nightsOf(startDate, endDate));
  const r = await raStayAvailability(contract, parsed.parkId, startDate, nights);
  return r.available;
}

/** Like the above, but returns the bookable siteIds (for alert deep-linking). */
export async function findReserveAmericaOpen(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<{ siteIds: number[] } | null> {
  const parsed = parseId(campgroundId);
  if (!parsed) return null;
  const contract = contractByCode(parsed.contractCode);
  if (!contract) return null;
  const nights = Math.max(minNights, nightsOf(startDate, endDate));
  const r = await raStayAvailability(contract, parsed.parkId, startDate, nights);
  return r.available ? { siteIds: r.siteIds } : null;
}
