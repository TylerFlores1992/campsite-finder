/**
 * Backfill photos for RIDB campgrounds.
 *
 * WHY A SEPARATE SCRIPT. The sync fix (src/lib/sources/ridb/sync.ts) only reaches a
 * facility the next time that facility is synced, and syncs are scoped — by state, by
 * radius, by maxFacilities. Waiting for natural coverage would leave photos landing
 * unevenly across the catalog for weeks. This walks the rows that are actually empty
 * and fills them once.
 *
 * SAFE TO RE-RUN. It selects only rows with no photos, so a second run picks up
 * exactly what the first missed (rate-limited, timed out, genuinely has no media)
 * and re-tries it. It touches the `photos` column and nothing else — a campground's
 * name, location and campsites are never rewritten, so this cannot damage a row that
 * the sync owns.
 *
 * Usage:
 *   NODE_USE_ENV_PROXY=1 RIDB_API_KEY=... npx tsx scripts/backfill-ridb-photos.ts
 *   ...                                                              --limit=200   (try a slice first)
 *   ...                                                              --dry-run     (fetch, don't write)
 *
 * Needs RIDB_API_KEY. Run it where that key already lives.
 */
import { query, mutate } from '../src/lib/db/client';
import { getFacilityMedia } from '../src/lib/sources/ridb/client';
import { mediaToPhotos } from '../src/lib/sources/ridb/transform';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

// 8 at a time. The sync uses 15, but that's the whole job's budget; this is a bulk
// walk over thousands of facilities and there is no deadline on it, so it runs
// gentler. A 429 here would just mean re-running.
const CONCURRENCY = 8;

interface Row {
  id: string;
  name: string;
}

async function main() {
  const rows = await query<Row>(
    `SELECT id, name
       FROM campgrounds
      WHERE source = 'ridb'
        AND jsonb_array_length(COALESCE(photos, '[]'::jsonb)) = 0
      ORDER BY id`
  );

  const targets = rows.slice(0, limit === Infinity ? rows.length : limit);
  console.log(
    `${rows.length} RIDB campgrounds with no photos; processing ${targets.length}` +
      (dryRun ? ' (DRY RUN — no writes)' : '')
  );

  let withPhotos = 0;
  let noMedia = 0;
  let failed = 0;
  let done = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const row = targets[cursor++];
      try {
        const media = await getFacilityMedia(row.id);
        const photos = mediaToPhotos(media);

        if (photos.length === 0) {
          noMedia++;
        } else {
          if (!dryRun) {
            await mutate(`UPDATE campgrounds SET photos = $1, updated_at = NOW() WHERE id = $2`, [
              JSON.stringify(photos),
              row.id,
            ]);
          }
          withPhotos++;
        }
      } catch (err) {
        failed++;
        console.warn(`  ${row.id} ${row.name}: ${(err as Error).message}`);
      }
      if (++done % 250 === 0) {
        console.log(`  ${done}/${targets.length} — ${withPhotos} with photos, ${noMedia} none, ${failed} failed`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(
    `\nDone. ${withPhotos} campgrounds got photos, ${noMedia} have no media in RIDB, ${failed} failed.`
  );
  if (failed > 0) console.log('Re-run to retry the failures — the query only picks up empty rows.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

