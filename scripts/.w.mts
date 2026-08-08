import { query } from '../src/lib/db/client';
const [r] = await query<Record<string, string | boolean | null>>(
  `SELECT session_ok, session_at::text, session_since::text, session_live_since::text,
          session_detail FROM rc_runner_heartbeat WHERE id = 1`);
const mins = (t: unknown) => t ? Math.round((Date.now() - new Date(t as string).getTime())/60000) : null;
console.log(`${new Date().toISOString().slice(11,16)}Z  ok=${r.session_ok}  alive ${mins(r.session_live_since)}m  checked ${mins(r.session_at)}m ago`);
console.log(`        ${r.session_detail}`);
