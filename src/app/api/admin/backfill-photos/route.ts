import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { currentUserIsAdmin } from '@/lib/admin';
import { getFacilityMedia } from '@/lib/sources/ridb/client';

/**
 * Backfill RIDB photos, ONE BATCH PER REQUEST.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/backfill-ridb-photos.ts. The script needs a
 * checkout, Node and RIDB_API_KEY on the machine running it. The key lives on
 * Vercel — so the one environment that already HAS the credential is the web app,
 * and the one device the owner always has is a phone. This route closes that gap:
 * it runs where the key is, driven by a button in the admin page.
 *
 * BATCHED BECAUSE SERVERLESS FUNCTIONS TIME OUT. 4,469 facilities is far past any
 * request budget, so each call takes a slice and the client loops. That also makes
 * it interruptible: close the tab, come back, press the button again.
 *
 * ADVANCED BY A KEYSET CURSOR, NOT BY "rows that are still empty".
 * The obvious version — select empty rows, LIMIT 40, stop when none come back —
 * never terminates. A facility with no media in RIDB stays empty however many times
 * it's fetched, so `ORDER BY id LIMIT 40` hands back the SAME forty rows forever.
 * Passing the last id back as `?after=` walks the catalog exactly once regardless
 * of whether a row ended up with photos.
 */

// Comfortably inside a serverless budget: 40 facilities at 8 concurrent is five
// sequential round-trips to RIDB, plus the writes.
const BATCH = 40;
const CONCURRENCY = 8;

export async function POST(request: NextRequest) {
  if (!(await currentUserIsAdmin())) {
    // 404, not 403 — same posture as the rest of /api/admin.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!process.env.RIDB_API_KEY) {
    return NextResponse.json(
      { error: 'RIDB_API_KEY is not set in this environment.' },
      { status: 500 }
    );
  }

  const after = request.nextUrl.searchParams.get('after');

  const rows = await query<{ id: string }>(
    `SELECT id
       FROM campgrounds
      WHERE source = 'ridb'
        AND jsonb_array_length(COALESCE(photos, '[]'::jsonb)) = 0
        ${after ? 'AND id > $1' : ''}
      ORDER BY id
      LIMIT ${BATCH}`,
    after ? [after] : undefined
  );

  let updated = 0;
  let noMedia = 0;
  let failed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const { id } = rows[cursor++];
      try {
        const media = await getFacilityMedia(id);
        // Same filter and shape as transformFacility, so a backfilled row is
        // indistinguishable from a freshly synced one.
        const photos = media
          .filter((m) => m.MediaType === 'Photo' && m.URL)
          .map((m) => ({ url: m.URL, title: m.Title, isPrimary: m.IsPrimary }));
        if (photos.length === 0) {
          noMedia++;
          continue;
        }
        await mutate(`UPDATE campgrounds SET photos = $1, updated_at = NOW() WHERE id = $2`, [
          JSON.stringify(photos),
          id,
        ]);
        updated++;
      } catch {
        // Swallowed per facility: one bad id must not abort the batch. The row
        // stays empty, so a later full pass (starting with no cursor) retries it.
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return NextResponse.json({
    processed: rows.length,
    updated,
    noMedia,
    failed,
    // Where the next batch resumes. Null when the walk is finished.
    nextCursor: rows.length > 0 ? rows[rows.length - 1].id : null,
    done: rows.length === 0,
  });
}

/** How much is left to do, for the button's idle state. */
export async function GET() {
  if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const [counts] = await query<{ total: number; empty: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(photos, '[]'::jsonb)) = 0)::int AS empty
       FROM campgrounds
      WHERE source = 'ridb'`
  );
  return NextResponse.json(counts);
}
