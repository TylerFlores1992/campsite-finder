import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    _admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** Escape a value for safe embedding in a SQL string (server-side use only). */
export function sqlit(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (Array.isArray(val)) {
    if (val.length === 0) return "ARRAY[]::text[]";
    return `ARRAY[${val.map((v) => sqlit(v)).join(',')}]::text[]`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Transport failures that PROVABLY happened before the statement reached Postgres.
 *
 * These are the only errors a non-idempotent statement may be repeated after: if the name
 * never resolved, or the connection was refused, no server ever saw the SQL. Repeating is
 * then indistinguishable from the first attempt having been made a moment later.
 */
const NEVER_SENT = [
  /dns resolution failure/i,
  /getaddrinfo/i,
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
];

/**
 * Transport failures where the statement MAY have executed — the connection was made and
 * then died, or timed out with no answer. Safe to repeat only for a read.
 *
 * `fetch failed` belongs here and not above even though a DNS failure often produces it:
 * supabase-js surfaces only `error.message`, so undici's generic wrapper reaches us with
 * its `cause` already discarded and cannot be told apart from a socket that died
 * mid-statement. The ambiguous case has to be treated as the dangerous one.
 */
const MAYBE_SENT = [
  /fetch failed/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /socket hang up/i,
  /network error/i,
  // `timed out`, not `timeout` — the message can carry text from the row being written,
  // and an index called `sms_timeout_idx` in a constraint violation must not look transient.
  /\btimed out\b/i,
];

/**
 * May a failed statement be retried? `idempotent` is the caller's promise that running it
 * twice is the same as running it once — true for `query` (exec_select refuses anything
 * data-modifying), false for `mutate`.
 *
 * Everything not listed is NOT retried: a syntax error, a constraint violation or a
 * permission failure will fail identically three times and only slow the report down.
 */
export function isRetryableDbError(message: string, opts: { idempotent: boolean }): boolean {
  if (NEVER_SENT.some((re) => re.test(message))) return true;
  return opts.idempotent && MAYBE_SENT.some((re) => re.test(message));
}

const DB_RETRY_ATTEMPTS = 3;
const DB_RETRY_BASE_MS = 200;

async function withDbRetry<T>(
  idempotent: boolean,
  run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<T[]> {
  let last = '';
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
    const { data, error } = await run();
    if (!error) return (data as T[]) ?? [];
    last = error.message;
    if (attempt === DB_RETRY_ATTEMPTS || !isRetryableDbError(last, { idempotent })) break;
    await new Promise((r) => setTimeout(r, DB_RETRY_BASE_MS * 2 ** (attempt - 1)));
  }
  throw new Error(last);
}

/** Run a SELECT query via Supabase RPC. Params replace $1..$N placeholders. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const finalSql = params ? interpolate(sql, params) : sql;
  const supabase = getSupabaseAdmin();
  try {
    return await withDbRetry<T>(true, () =>
      supabase.rpc('exec_select', { query_text: finalSql })
    );
  } catch (e) {
    throw new Error(`DB query error: ${(e as Error).message}\nSQL: ${finalSql}`);
  }
}

/** Run a SELECT and return the first row (or null). */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE, optionally with RETURNING. */
export async function mutate<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const finalSql = params ? interpolate(sql, params) : sql;
  // Detect RETURNING on the raw template (params can contain the word
  // "returning" as data — e.g. campground descriptions), and IGNORE COMMENTS.
  //
  // A comment is not code, and this heuristic decides how `exec_dml` executes the
  // statement: with RETURNING it wraps the SQL in `WITH __dml__ AS (…)`, which is a syntax
  // error for anything that is not a data-modifying statement. So a migration whose
  // COMMENT happened to contain the word — "-- Search stops returning picnic shelters" —
  // failed with `syntax error at or near "CREATE"`, pointing at code that was perfectly
  // valid. Cost twenty minutes on 2026-08-08 and would have cost more to anyone who had
  // not just written the comment.
  const hasReturning = /\breturning\b/i.test(stripSqlComments(sql));
  const supabase = getSupabaseAdmin();
  try {
    // NOT idempotent: only errors that prove the statement never left this process are
    // retried. A repeated INSERT is a duplicate row, and a repeated `UPDATE .. SET x = x+1`
    // is a wrong number — neither announces itself.
    return await withDbRetry<T>(false, () =>
      supabase.rpc('exec_dml', { query_text: finalSql, with_result: hasReturning })
    );
  } catch (e) {
    throw new Error(`DB mutate error: ${(e as Error).message}\nSQL: ${finalSql}`);
  }
}

/**
 * Remove `-- line` and block comments so a comment cannot change how SQL is executed.
 *
 * Deliberately naive about string literals: it is only ever used to decide whether the
 * word RETURNING appears in CODE, and the cost of a wrong answer in either direction is
 * bounded (a real RETURNING inside a quoted string is not something this codebase writes).
 * It is NOT a sanitiser and must not be used as one.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Replace $1..$N params with safely quoted literals. */
function interpolate(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n) - 1;
    if (idx < 0 || idx >= params.length) throw new Error(`Missing param $${n}`);
    return sqlit(params[idx]);
  });
}

/** Backward-compat shim — most code calls query() for both reads and writes. */
export { mutate as queryMutate };

// --- Transaction helper (uses sequential mutate calls) ---
export async function withTransaction<T>(
  fn: (helpers: { query: typeof query; mutate: typeof mutate }) => Promise<T>
): Promise<T> {
  // Supabase JS client doesn't support multi-statement transactions over HTTP.
  // For v1, run the operations sequentially — most of our "transactions" are
  // just paired inserts that are safe to run without atomicity.
  return fn({ query, mutate });
}

// --- Migration runner (only used by scripts/setup-db.ts) ---
export async function runMigrations(): Promise<void> {
  const migrationsDir = resolve(process.cwd(), 'src/lib/db/migrations');
  const files = ['001_initial.sql', '002_campflare.sql'];
  const supabase = getSupabaseAdmin();

  for (const file of files) {
    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    // Split on semicolons and run each statement
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      const { error } = await supabase.rpc('exec_dml', { query_text: stmt });
      if (error && !error.message.includes('already exists')) {
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  }
  console.log('Migrations applied');
}
