// Does skipping the RIDB media call preserve the photos it skipped it for?
//
// Run: npm test
//
// This guards a DATA-DESTRUCTIVE edge. From 2026-08-04 the sync skips the media
// endpoint for facilities that already have photos — it was doubling the request count
// and getting us 429'd — but with no MEDIA the transform yields `photos: []`, and the
// upsert's `photos = EXCLUDED.photos` would then have erased 3,775 rows on the first
// run. Silently, because an empty array is not an error. The fix is to pass NULL and
// pass a keep-existing FLAG so the UPDATE branch holds the stored value.
//
// The first attempt used a NULL photos param with COALESCE, and this suite caught that
// `campgrounds.photos` is NOT NULL — the proposed INSERT tuple is rejected before the
// ON CONFLICT branch runs, so it would have failed every facility that HAS photos.
// Worse than the bug. Hence a flag.
//
// Hits the REAL database on purpose: the whole question is what Postgres does with
// `COALESCE(EXCLUDED.photos, campgrounds.photos)` when the parameter is null. A mock
// would be asserting my belief about SQL rather than the SQL.
//
// SAFETY: operates on its own fixture row (`ridb-test-photos-*`), never a live
// campground, and deletes it on the way out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mutate, query } from '../src/lib/db/client';

const ID = 'ridb-test-photos-fixture';
const PHOTOS = [{ url: 'https://example.test/a.jpg', title: 'A' }];

/** The upsert's photo clause, isolated — same shape as upsertCampground's. */
async function upsertPhotos(photos: string, keepExisting: boolean) {
  await mutate(
    `INSERT INTO campgrounds (id, source, name, location, photos, last_synced_at, updated_at)
     VALUES ($1, 'ridb', 'Test Photos Fixture',
             ST_SetSRID(ST_MakePoint(-98.35, 39.5), 4326)::geography, $2, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       photos = CASE WHEN $3 THEN campgrounds.photos ELSE EXCLUDED.photos END,
       updated_at = NOW()`,
    [ID, photos, keepExisting]
  );
}

const readPhotos = async (): Promise<unknown[] | null> => {
  const [row] = await query<{ photos: unknown[] | null }>(
    `SELECT photos FROM campgrounds WHERE id = $1`, [ID]);
  return row?.photos ?? null;
};

const cleanup = () => mutate(`DELETE FROM campgrounds WHERE id LIKE 'ridb-test-photos-%'`);
before(cleanup);
after(cleanup);

test('a row with photos KEEPS them when the media call was skipped', async () => {
  await upsertPhotos(JSON.stringify(PHOTOS), false);
  assert.equal((await readPhotos())?.length, 1, 'setup: photos stored');

  // The skip case: transform yielded [] because we never called the media endpoint.
  await upsertPhotos(JSON.stringify([]), true);
  const after1 = await readPhotos();
  assert.equal(after1?.length, 1, 'photos must survive a sync that skipped the media call');
});

test('an EMPTY array still overwrites — a real "no media" answer is not the same as no answer', async () => {
  // The distinction that matters: null means "we did not ask", [] means "we asked and
  // RIDB has none". Only the first should preserve. Collapsing them would freeze a
  // stale photo set forever once a facility's media was withdrawn.
  await upsertPhotos(JSON.stringify(PHOTOS), false);
  await upsertPhotos(JSON.stringify([]), false);
  assert.equal((await readPhotos())?.length, 0, 'an explicit empty result must clear');
});

test('a NEW row inserts its photos normally', async () => {
  await cleanup();
  await upsertPhotos(JSON.stringify(PHOTOS), false);
  assert.equal((await readPhotos())?.length, 1);
});
