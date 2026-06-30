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

/** Run a SELECT query via Supabase RPC. Params replace $1..$N placeholders. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const finalSql = params ? interpolate(sql, params) : sql;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('exec_select', { query_text: finalSql });
  if (error) throw new Error(`DB query error: ${error.message}\nSQL: ${finalSql}`);
  return (data as T[]) ?? [];
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
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('exec_dml', { query_text: finalSql });
  if (error) throw new Error(`DB mutate error: ${error.message}\nSQL: ${finalSql}`);
  return (data as T[]) ?? [];
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
