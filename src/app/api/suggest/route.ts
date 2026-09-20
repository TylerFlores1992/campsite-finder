import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';

/**
 * Campground name suggestions, GROUPED BY PARK.
 *
 * Searching "Leo Carrillo" used to return three near-identical lines — the park has
 * three divisions and each row repeats the park name in full. With `LIMIT 8` on raw
 * rows, one park could take most of the list; Carpinteria has four divisions and
 * Ohio's Grand Lake St. Marys has seventy. The limit now applies to PARKS, so eight
 * suggestions mean eight places.
 *
 * THE RESPONSE SHAPE IS BACKWARD COMPATIBLE ON PURPOSE. `campgrounds[]` still carries
 * id/name/city/state/latitude/longitude, so `components/v2/geo.ts` — which feeds
 * Explore's location search — needed no change and gets the de-duplication for free.
 * What is new is `divisions[]` and `divisionCount`, which the New watch picker uses to
 * offer the park's parts as checkboxes.
 *
 * `id` and the coordinates are the park's FIRST division. For Explore that is a map
 * centre, and divisions of one park are adjacent, so a representative is honest there.
 * The New watch flow never uses it — it works from `divisions[]`.
 *
 * **`NOT hidden` was missing entirely**, which is a pre-existing bug rather than part
 * of the grouping work: 425 rows are hidden (183 shelters, 127 day-use areas, visitor
 * centres, a golf course), and the picker was offering them as campgrounds to watch.
 * `/api/search` already excludes them.
 *
 * ── EACH DIVISION CARRIES `reservable`, AND NOTHING IS FILTERED HERE (2026-09-20) ────
 * A first-come campground cannot be watched — there is no booking, so there is no
 * cancellation — and the New watch picker was offering 678 of them. It filters them out
 * itself, using `watchable()` from `@/lib/booking-policy`, which is the one definition
 * the three watch surfaces share.
 *
 * **THE FILTER IS DELIBERATELY NOT IN THIS QUERY**, because this route has two consumers
 * and they want opposite things: `components/v2/geo.ts` feeds EXPLORE's location box,
 * where a first-come campground must still be findable — it is a real place with a real
 * page, and Explore's whole job this week is to badge it rather than hide it. A route
 * that answered only one caller's question would have made the other one wrong silently.
 *
 * **PER DIVISION AND NOT PER PARK: 33 parks are MIXED** — a reservable division beside
 * first-come ones (Williams Lake, Black Bear, McFarland …). A park-level flag would hide
 * all 33 from the picker, taking a bookable campground with it.
 */

/**
 * The park segment of a name — everything before the first em/en dash.
 *
 * Kept deliberately in step with `parkOf` in `components/v2/campground-name.ts`, which
 * does the same split for display. Grouping happens on the RAW text, before any
 * title-casing, so two genuinely different source names can never be merged by a
 * cosmetic transform.
 */
const PARK_EXPR = `CASE WHEN c.name ~ '[—–]'
                        THEN btrim(split_part(regexp_replace(c.name, '–', '—', 'g'), '—', 1))
                        ELSE c.name END`;

interface Division {
  id: string;
  name: string;
  /** Does this division take reservations? Added 2026-09-20 — see the header. */
  reservable: boolean;
}

interface ParkRow {
  park: string;
  source: string;
  id: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  divisions: Division[];
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json({ campgrounds: [] });

  // Two steps, and the second one is the point: find the parks that MATCH, then return
  // ALL of each park's divisions. Someone typing "Canyon" matches two of Leo Carrillo's
  // three divisions, and offering only those two would silently hide the third from a
  // picker whose whole job is to let them choose among the lot.
  const rows = await query<ParkRow>(
    `WITH hits AS (
       SELECT ${PARK_EXPR} AS park,
              c.source,
              bool_or(c.name ILIKE $1 || '%') AS name_prefix,
              bool_or(c.address->>'city' ILIKE $1 || '%') AS city_prefix,
              min(length(c.name)) AS len
         FROM campgrounds c
        WHERE NOT c.hidden
          AND (c.name ILIKE '%' || $1 || '%' OR c.address->>'city' ILIKE '%' || $1 || '%')
        GROUP BY 1, 2
        ORDER BY 3 DESC, 4 DESC, 5
        LIMIT 8
     )
     SELECT h.park,
            h.source,
            d.id,
            d.city,
            d.state,
            d.latitude,
            d.longitude,
            d.divisions
       FROM hits h
       JOIN LATERAL (
         SELECT (array_agg(c2.id ORDER BY c2.name))[1] AS id,
                (array_agg(c2.address->>'city' ORDER BY c2.name))[1] AS city,
                (array_agg(c2.address->>'state' ORDER BY c2.name))[1] AS state,
                (array_agg(ST_Y(c2.location::geometry) ORDER BY c2.name))[1] AS latitude,
                (array_agg(ST_X(c2.location::geometry) ORDER BY c2.name))[1] AS longitude,
                json_agg(json_build_object('id', c2.id, 'name', c2.name, 'reservable', c2.reservable)
                          ORDER BY c2.name) AS divisions
           FROM campgrounds c2
          WHERE NOT c2.hidden
            AND c2.source = h.source
            AND ${PARK_EXPR.replace(/\bc\./g, 'c2.')} = h.park
       ) d ON true
      ORDER BY h.name_prefix DESC, h.city_prefix DESC, h.len`,
    [q],
  );

  const campgrounds = rows.map((r) => {
    const divisions = r.divisions ?? [];
    return {
      id: r.id,
      // A single-division park shows its own full name; a multi-division park shows the
      // park, because the divisions are listed underneath it.
      name: divisions.length > 1 ? r.park : (divisions[0]?.name ?? r.park),
      city: r.city,
      state: r.state,
      latitude: r.latitude,
      longitude: r.longitude,
      source: r.source,
      divisionCount: divisions.length,
      divisions,
    };
  });

  return NextResponse.json({ campgrounds });
}
