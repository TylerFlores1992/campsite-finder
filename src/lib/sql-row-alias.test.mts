import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { query } from './db/client';

/**
 * A COLUMN ALIASED `t` SILENTLY RETURNS THAT COLUMN'S VALUES INSTEAD OF ROWS.
 *
 * `exec_select` — the Postgres function EVERY `query()` call goes through — is
 *
 *     EXECUTE format('SELECT coalesce(json_agg(t), ''[]''::json) FROM (%s) t', query_text)
 *
 * and `exec_dml`'s RETURNING path is the same shape (`FROM __dml__ t`). When the caller's
 * own SELECT list contains a column aliased `t`, Postgres resolves `json_agg(t)` to that
 * COLUMN rather than to the whole row — so the caller gets `["09-17 00:56", …]` where it
 * expected `[{ t: …, rc: … }]`, and every other field reads `undefined`.
 *
 * MEASURED 2026-09-17, on `chromium_memory_samples`:
 *
 *     SELECT rc_mb AS t,  max_pid AS pid  →  [302, 298]                     <- collapsed
 *     SELECT rc_mb AS rc, max_pid AS pid  →  [{rc:302,pid:3152}, …]         <- fine
 *     SELECT taken_at AT TIME ZONE 'UTC' AS tt, rc_mb AS rc  →  fine
 *     SELECT rc_mb AS "T", max_pid AS pid →  fine                           <- quoted, different identifier
 *
 * THE TYPE IS IRRELEVANT AND SO IS THE POSITION. It is the alias, and only the alias.
 * CLAUDE.md carried this as "`exec_select` SILENTLY RETURNS A SCALAR FOR A BARE COLUMN
 * ALIAS — always `AS` in a `query()` call", which names the wrong cause: the recorded
 * example happened to alias its first column `t`, and `AS` changes nothing. Following
 * that note is what produced seven rows of `undefined` while reading the memory series.
 *
 * WHY THIS IS A SCAN AND NOT A FIX. The real repair is one word in `exec_select` and
 * `exec_dml` — rename the subquery alias to something no caller would choose — and it is
 * a `SECURITY DEFINER` DDL replacement on the path every read in the product takes. That
 * is a deliberate change with a verification plan, not a drive-by. Until it is made, this
 * keeps the trap out of the tree.
 */

const ROOTS = ['src', 'worker', 'scripts'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.git']);

/**
 * `AS t` / `AS "t"` as a COLUMN alias.
 *
 * `(?![\w(])` is load-bearing twice over: it keeps `AS tt` out, and it keeps
 * `jsonb_array_elements(…) AS t(x)` out — a set-returning function's table alias with a
 * column list, which produces no output column called `t` and cannot collide. That form
 * is live in `src/lib/rc-holds.ts` today, so a naive `\bAS\s+t\b` would cry wolf on
 * correct code, and a guard that cries wolf is deleted by the next person it inconveniences.
 */
const ROW_ALIAS = /\bAS\s+"?t"?(?![\w(])/g;

function sqlFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sqlFiles(p, out);
    else if (/\.m?ts$/.test(name)) out.push(p);
  }
  return out;
}

export function rowAliasHits(source: string): string[] {
  return [...source.matchAll(ROW_ALIAS)].map((m) => m[0]);
}

test('no column is aliased `t` — it would collapse the row to that column', () => {
  const files = ROOTS.flatMap((r) => sqlFiles(r));
  // A scan that inspected nothing is indistinguishable from a scan that approved.
  assert.ok(files.length > 200, `expected to scan the tree, saw ${files.length} files`);

  const offenders: string[] = [];
  for (const f of files) {
    if (f.endsWith('sql-row-alias.test.mts')) continue; // this file quotes the shape it forbids
    const hits = rowAliasHits(readFileSync(f, 'utf8'));
    if (hits.length) offenders.push(`${f} (${hits.length})`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a column aliased `t` is swallowed by exec_select\'s own `FROM (%s) t` wrapper — '
    + 'rename it (tt, ts, at_utc — anything but `t`)',
  );
});

test('the detector admits what it is: `AS t(x)` is a table alias, not a column alias', () => {
  assert.deepEqual(rowAliasHits("FROM jsonb_array_elements(x) AS t(x)"), []);
  assert.deepEqual(rowAliasHits('SELECT a AS tt, b AS ts'), []);
  assert.equal(rowAliasHits('SELECT rc_mb AS t, max_pid AS pid').length, 1);
  assert.equal(rowAliasHits('SELECT rc_mb AS "t", max_pid AS pid').length, 1);
  assert.equal(rowAliasHits('SELECT x AS t\n  FROM y').length, 1);
});

test('THE TRAP IS STILL REAL — delete this whole file the day it is not', async () => {
  const rows = await query<unknown>('SELECT 1 AS t, 2 AS other');
  // `[1]` means exec_select still aggregates the COLUMN. `[{t:1,other:2}]` means somebody
  // has renamed the wrapper's subquery alias and this guard now forbids a legal alias —
  // which is a rule about nothing, and rules about nothing are how a scan rots.
  assert.deepEqual(
    rows,
    [1],
    'exec_select no longer collapses `AS t` — the wrapper has been fixed, so DELETE '
    + 'src/lib/sql-row-alias.test.mts and the CLAUDE.md entry that points at it',
  );
});
