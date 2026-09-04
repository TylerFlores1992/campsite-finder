import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db/client';
import { wholeStayOpen } from '@/lib/availability/whole-stay';
import { watchOutlook, OUTLOOK_HEADING, outlookBody } from '@/lib/watch-outlook';

/**
 * "Is there anything to be had for this watch right now, and is the trip far enough
 * off that a long silence needs explaining?" — read once by the app after a watch is
 * created. See `lib/watch-outlook` for why it says what it says.
 *
 * IT IS A SEPARATE READ RATHER THAN PART OF `POST /api/watches`, deliberately. This
 * asks the reservation portal, which can take seconds and can fail; putting it on the
 * create path would make the one action that matters slower and give it a new way to
 * go wrong, to decorate the screen after it.
 *
 * SCOPED TO THE CALLER'S OWN WATCH. The id comes off a URL, so the WHERE clause
 * carries `user_id` — without it this reports on any watch whose id is guessed.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireAuth();
  const { id } = await params;

  const rows = await query<{
    campground_id: string;
    source: string;
    start_date: string;
    end_date: string;
    flex_nights: number | null;
  }>(
    `SELECT c.id AS campground_id, c.source,
            w.start_date::text, w.end_date::text, w.flex_nights
       FROM watches w
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           (SELECT array_agg(wc.campground_id ORDER BY wc.campground_id)
              FROM watch_campgrounds wc WHERE wc.watch_id = w.id),
           ARRAY[w.campground_id]
         ) AS ids
       ) e
       CROSS JOIN LATERAL unnest(e.ids) AS pair(campground_id)
       JOIN campgrounds c ON c.id = pair.campground_id
      WHERE w.id = $1 AND w.user_id = $2`,
    [id, userId]
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { start_date, end_date, flex_nights } = rows[0];
  const DAY = 86_400_000;
  const span = Math.round((Date.parse(`${end_date}T00:00:00Z`) - Date.parse(`${start_date}T00:00:00Z`)) / DAY);
  const nights = flex_nights ?? Math.max(1, span);
  const leadDays = Math.round((Date.parse(`${start_date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / DAY);

  // A park watch covers several divisions. ONE bookable division means the answer is
  // "yes, go and book" — so a true anywhere wins. Otherwise a single division we could
  // not read makes the WHOLE answer unknown, because the free site could have been in
  // exactly the one that failed. Rounding that to false is how a user gets told to be
  // patient about a stay they could book right now.
  let available: boolean | null = false;
  for (const r of rows) {
    let open: boolean | null;
    try {
      open = await wholeStayOpen(r.source, r.campground_id, start_date, end_date, nights);
    } catch (err) {
      console.error('[watch-outlook] probe failed:', (err as Error).message);
      open = null; // a throw is "we never found out", never "nothing is free"
    }
    if (open === true) { available = true; break; }
    if (open == null) available = null;
  }

  const outlook = watchOutlook({ leadDays, available });
  return NextResponse.json({
    ...outlook,
    leadDays,
    available,
    ...(outlook.show ? { heading: OUTLOOK_HEADING, body: outlookBody(leadDays) } : {}),
  });
}
