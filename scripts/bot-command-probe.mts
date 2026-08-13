/**
 * Ask the mini-PC one question, and watch whether anything picks it up.
 *
 * WHY IT EXISTS. On 2026-08-13 `tail-log auto-update` was queued as command #36 and was
 * still unclaimed fifteen minutes later, while both pollers were heartbeating. That is
 * ambiguous by construction: `botControlFor` swallows both of its reads, so "the query
 * threw" and "nobody asked" leave the same trace. The mini-PC also updated three minutes
 * after #36 was queued, which restarts the pollers — so an orphaned command in flight is
 * an equally good explanation, and neither can be told from the other after the fact.
 *
 * The only way to separate them is to ask again and watch. This prints the whole life of
 * one command: queued -> claimed (by which process) -> answered.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-command-probe.mts [kind] [arg]
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-command-probe.mts --watch <id>
 *
 * Defaults to `git-status`, which takes no argument and is read-only.
 */
import { requestBotCommand, COMMAND_TTL_MS } from '../src/lib/bot-commands';
import { query } from '../src/lib/db/client';

interface Row {
  id: number; kind: string; arg: string | null;
  requested_at: string; started_at: string | null; finished_at: string | null;
  claimed_by: string | null; exit_code: number | null; output: string | null; error: string | null;
}

const ago = (iso: string | null) =>
  iso ? `${Math.round((Date.now() - new Date(iso).getTime()) / 1000)}s ago` : '—';

async function read(id: number): Promise<Row | null> {
  const [row] = await query<Row>(
    `SELECT id, kind, arg, requested_at::text, started_at::text, finished_at::text,
            claimed_by, exit_code, output, error
       FROM bot_commands WHERE id = $1`,
    [String(id)],
  );
  return row ?? null;
}

async function main() {
  const argv = process.argv.slice(2);

  let id: number;
  if (argv[0] === '--watch') {
    id = Number(argv[1]);
    if (!Number.isFinite(id)) { console.error('--watch needs a command id'); process.exit(1); }
  } else {
    const kind = argv[0] ?? 'git-status';
    const arg = argv[1] ?? null;
    const res = await requestBotCommand(kind, arg, 'bot-command-probe');
    if ('error' in res) { console.error(`refused: ${res.error}`); process.exit(1); }
    id = res.id;
    console.log(`queued #${id}: ${kind}${arg ? ` ${arg}` : ''}`);
  }

  // The two heartbeats, so an unclaimed command can be read against whether anything was
  // alive to claim it. A silent queue with both pollers dead is not the same finding.
  const [beat] = await query<{ beat_at: string | null }>(
    `SELECT beat_at::text FROM rc_runner_heartbeat WHERE id = 1`,
  ).catch(() => []);
  console.log(`rc runner heartbeat: ${ago(beat?.beat_at ?? null)}`);

  // The claim only ever looks back COMMAND_TTL_MS, so past that a command is not merely
  // late — it can never be picked up. Stop there rather than reporting a stall that is
  // really an expiry.
  const deadline = Date.now() + COMMAND_TTL_MS;
  let lastState = '';
  for (;;) {
    const row = await read(id);
    if (!row) { console.log('the row vanished'); break; }
    const state = `${row.started_at ? 'claimed' : 'queued'}/${row.finished_at ? 'done' : 'open'}`;
    if (state !== lastState) {
      lastState = state;
      console.log(
        `  ${state}  requested ${ago(row.requested_at)}` +
        (row.started_at ? `, claimed ${ago(row.started_at)} by ${row.claimed_by ?? '?'}` : ''),
      );
    }
    if (row.finished_at) {
      console.log(`\nanswered in ${((new Date(row.finished_at).getTime() - new Date(row.requested_at).getTime()) / 1000).toFixed(1)}s, exit ${row.exit_code}`);
      if (row.error) console.log(`error: ${row.error}`);
      if (row.output) console.log(`\n${row.output}`);
      return;
    }
    if (Date.now() > deadline) {
      console.log(
        `\nSTILL UNCLAIMED after the ${COMMAND_TTL_MS / 60000}-minute TTL — it can no longer be picked up.\n` +
        'Both reads in botControlFor are swallowed, so this is where to look next.',
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

void main();
