/**
 * Migration numbers are claimed exactly once.
 *
 * WHY THIS EXISTS. Two sessions each writing `060_*.sql` is a collision **git merges
 * cleanly** — different filenames, no conflict, both land — and Postgres does not: whichever
 * runner applies them decides what "060" meant, and the loser is silently skipped or applied
 * out of order. There is no failure at merge time, which is precisely what makes it worth a
 * mechanical check. `docs/LANES.md` carries the block-claiming convention that keeps this
 * green; this is the part that notices when it was not followed.
 *
 * WHY NOT CONTIGUITY. A gap is not a defect — a claimed block that goes unused, or a
 * migration withdrawn before it ever ran, both leave one. A test that fails on a non-defect
 * gets deleted by the next person it inconveniences, and it would take the duplicate check
 * with it. So: uniqueness and shape, never a dense sequence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const DIR = 'src/lib/db/migrations';
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

test('the migrations directory is not empty', () => {
  // A wrong path makes every other assertion here pass vacuously — the shape of a guard that
  // reports green over the thing it was meant to watch.
  assert.ok(files.length > 20, `expected many migrations in ${DIR}, found ${files.length}`);
});

test('every .sql file is named NNN_name.sql', () => {
  for (const f of files) {
    assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/,
      `${f} does not match NNN_name.sql — the number is how ordering is decided`);
  }
});

test('every migration number is claimed exactly once', () => {
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const n = f.slice(0, 3);
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }

  const duplicates = [...byNumber.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(duplicates, [],
    `two migrations claim the same number: ${duplicates.map(([n, names]) => `${n} → ${names.join(', ')}`).join('; ')}`);
});
