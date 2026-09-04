import { hasAvailabilityInRange } from '@/lib/availability/recgov';
import { findRCOpenUnit } from '@/lib/availability/reservecalifornia';
import { findReserveAmericaOpen } from '@/lib/availability/reserveamerica';
import { findGoingToCampOpen } from '@/lib/availability/goingtocamp';
import { findTnscOpen } from '@/lib/availability/tnsc';
import { isUseDirectSource } from '@/lib/sources/reservecalifornia/providers';
import { isGoingToCampSource } from '@/lib/sources/goingtocamp/providers';
import { isTnscSource } from '@/lib/sources/tnsc/providers';

/**
 * "Is a bookable whole stay available RIGHT NOW?", for any source.
 *
 * EXTRACTED FROM `worker/poller.ts` (2026-09-04), where it was `probeWholeStayOpen`
 * and reachable from nothing else — importing that file STARTS the poller, which is
 * the same reason `claim.ts`, `hold-claim.ts`, `hold-line.ts` and `held-cadence.ts`
 * were pulled out before it. The poller now imports this; the dispatch is unchanged,
 * and every adapter it calls already lived under `src/lib/availability/`, so nothing
 * about the dependency direction moved.
 *
 * `null` = WE NEVER FOUND OUT (throttled, breaker open, portal down, an unsupported
 * source). It must NOT be read as "fully booked" — that is the exact lie the search
 * page was telling on 2026-07-31, when a throttled rec.gov read rendered fifteen live
 * Moab campgrounds as booked solid. Every caller has to branch on three states.
 */
export async function wholeStayOpen(
  source: string,
  campgroundId: string,
  start: string,
  end: string,
  nights: number
): Promise<boolean | null> {
  if (isUseDirectSource(source)) return !!(await findRCOpenUnit(campgroundId, start, end, nights));
  if (isGoingToCampSource(source)) return !!(await findGoingToCampOpen(campgroundId, start, end, nights));
  if (isTnscSource(source)) return !!(await findTnscOpen(campgroundId, start, end, nights));
  if (source === 'reserveamerica') return !!(await findReserveAmericaOpen(campgroundId, start, end, nights));
  return hasAvailabilityInRange(campgroundId, start, end, nights); // rec.gov
}
