import { NextRequest, NextResponse } from 'next/server';
import { query, mutate } from '@/lib/db/client';
import { currentUserIsAdmin } from '@/lib/admin';
import { getFacilityMedia, getFacilityMediaRaw } from '@/lib/sources/ridb/client';
import { mediaToPhotos } from '@/lib/sources/ridb/transform';

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
        // The same helper the sync uses, so a backfilled row is indistinguishable
        // from a freshly synced one — and a fix to the filter reaches both.
        const photos = mediaToPhotos(media);
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

/**
 * How much is left to do — and, with `?probe=1`, what RIDB actually returns.
 *
 * THE PROBE EXISTS BECAUSE A CLEAN ZERO IS A PARSING BUG, NOT A DATA FACT. The first
 * run processed 1,880 facilities with 0 filled and 0 FAILED: every call succeeded and
 * every one filtered to nothing. That rules out auth, rate limits and the network, and
 * leaves the shape — a wrong envelope key, or a MediaType we don't match. Neither is
 * visible from this sandbox, because RIDB_API_KEY only exists in this environment.
 *
 * So the probe reports what came back verbatim: the response's top-level keys, the
 * record count, and the distinct MediaType values seen. That distinguishes all three
 * hypotheses in one tap.
 */
export async function GET(request: NextRequest) {
  if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (request.nextUrl.searchParams.get('probe') === '1') {
    const ids = await query<{ id: string; name: string }>(
      `SELECT id, name FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 5`
    );
    const results = [];
    for (const { id, name } of ids) {
      try {
        const raw = await getFacilityMediaRaw(id);
        const records: unknown[] = Array.isArray(raw?.RECDATA) ? raw.RECDATA : [];
        results.push({
          id,
          name,
          topLevelKeys: raw && typeof raw === 'object' ? Object.keys(raw) : null,
          recdataCount: records.length,
          mediaTypes: [
            ...new Set(
              records.map((r) => (r as { MediaType?: string })?.MediaType ?? '(missing)')
            ),
          ],
          firstRecord: records[0] ?? null,
        });
      } catch (err) {
        results.push({ id, name, error: (err as Error).message });
      }
    }
    return NextResponse.json({ probe: results }, { status: 200 });
  }
  const [counts] = await query<{ total: number; empty: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(photos, '[]'::jsonb)) = 0)::int AS empty
       FROM campgrounds
      WHERE source = 'ridb'`
  );
  return NextResponse.json(counts);
}
