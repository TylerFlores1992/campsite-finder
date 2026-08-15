import { NextRequest, NextResponse } from 'next/server';
import { ridbSource } from '@/lib/sources/ridb';
import { query } from '@/lib/db/client';

/**
 * The other divisions of the same park — "Leo Carrillo SP — Canyon Group Camp" for a
 * request that arrived on one of the two Canyon Campground rows.
 *
 * ADDITIVE, and non-fatal. A caller that does not know about `divisions` is unaffected,
 * and a failure here returns the campground without them rather than 500ing a page that
 * only wanted the detail. The grouping expression is kept in step with /api/suggest and
 * with `parkOf` in components/v2/campground-name.ts.
 */
async function divisionsOf(id: string): Promise<Array<{ id: string; name: string }>> {
  const PARK = `CASE WHEN %s.name ~ '[—–]'
                     THEN btrim(split_part(regexp_replace(%s.name, '–', '—', 'g'), '—', 1))
                     ELSE %s.name END`;
  const expr = (alias: string) => PARK.replace(/%s/g, alias);
  try {
    return await query<{ id: string; name: string }>(
      `SELECT c.id, c.name
         FROM campgrounds c
         JOIN campgrounds self ON self.id = $1
        WHERE NOT c.hidden
          AND c.source = self.source
          AND ${expr('c')} = ${expr('self')}
        ORDER BY c.name`,
      [id],
    );
  } catch {
    return [];
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const campground = await ridbSource.getDetail(id);
    if (!campground) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const [campsites, divisions] = await Promise.all([
      ridbSource.getCampsites(id),
      divisionsOf(id),
    ]);
    return NextResponse.json({ campground, campsites, divisions });
  } catch (err) {
    console.error('[campground detail] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch campground' }, { status: 500 });
  }
}
