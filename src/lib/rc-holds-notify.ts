import { query } from '@/lib/db/client';
import { dispatchNotifications } from '@/lib/notifications';
import type { HoldRequest } from '@/lib/rc-holds';

/**
 * "We couldn't hold it after all."
 *
 * SHARED BY THE TWO WAYS A HOLD DIES, and it used to be reachable from only one of them —
 * backwards, as it turned out. There are exactly two paths:
 *
 *   1. **Nothing ever touched it.** The runner was down or could not open Chromium, so the
 *      hold sat at `requested` past its release and `worker/expire-holds.ts` swept it.
 *      This path notified.
 *   2. **The runner tried and RC said no.** It reports the failure, the row goes to
 *      `failed` with the reason attached — and the sweep's `WHERE status = 'requested'`
 *      can never match it again. **This path said nothing at all.**
 *
 * So the case where we KNOW it failed and know exactly why was the silent one, and the
 * case where we are inferring from silence was the loud one. Observed 2026-08-08: a hold
 * failed at 07:58:35 PT and the only thing the user received was an ordinary "#41 is
 * available" alert at 08:00:16 — which does not distinguish "we're holding it for you"
 * from "we tried and couldn't, go and grab it". They had asked us to hold it the night
 * before; the ambiguity is the whole problem.
 *
 * Sent as an ordinary `available`-shaped alert on purpose rather than a new kind: the
 * useful fact is that the site released and they can still go and look. A bespoke apology
 * that does not say what to do next would be worse than the alert they'd have got anyway.
 */
export async function notifyHoldMissed(
  h: Pick<HoldRequest, 'watch_id' | 'user_id' | 'campground_id' | 'unit_id' | 'unit_name' | 'arrival_date'>,
): Promise<void> {
  const [w] = await query<{ start_date: string; end_date: string; name: string; reservations_url: string | null }>(
    `SELECT wt.start_date::text, wt.end_date::text, c.name, c.reservations_url
       FROM watches wt JOIN campgrounds c ON c.id = wt.campground_id WHERE wt.id = $1`,
    [h.watch_id],
  );
  if (!w) return;
  await dispatchNotifications({
    userId: h.user_id,
    watchId: h.watch_id,
    campgroundId: h.campground_id,
    campgroundName: w.name,
    availableDates: [h.arrival_date],
    bookingUrl: w.reservations_url ?? 'https://www.reservecalifornia.com/',
    campsiteName: h.unit_name,
    campsiteId: h.unit_id,
    startDate: w.start_date,
    endDate: w.end_date,
    kind: 'hold_missed',
  });
}
