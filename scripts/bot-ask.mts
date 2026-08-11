/**
 * Ask the mini-PC a diagnostic question from anywhere with database access.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts tail-log auto-update
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts tail-log rc-holds:40
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts list-processes
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts disk-free
 *
 * This is the tool that six round-trips of "please paste that file" on 2026-08-11 were
 * standing in for. It queues the question, waits for the runner's next 15-second poll, and
 * prints the answer.
 */
import { requestBotCommand, recentBotCommands, BOT_COMMAND_KINDS, COMMAND_TTL_MS } from '../src/lib/bot-commands';

const [kind, arg] = process.argv.slice(2);
if (!kind) {
  console.log('usage: bot-ask.mts <kind> [arg]\n');
  for (const [k, s] of Object.entries(BOT_COMMAND_KINDS)) {
    console.log(`  ${k.padEnd(15)} ${s.label}${s.argHint ? `\n  ${''.padEnd(15)} arg: ${s.argHint}` : ''}`);
  }
  process.exitCode = 1;
} else {
  const res = await requestBotCommand(kind, arg ?? null, 'bot-ask.mts');
  if ('error' in res) {
    console.error(`refused: ${res.error}`);
    process.exitCode = 1;
  } else {
    console.log(`queued #${res.id} (${kind}${arg ? ` ${arg}` : ''}) — waiting for the runner's next poll...`);
    const deadline = Date.now() + Math.min(COMMAND_TTL_MS, 120_000);
    let done = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const [row] = (await recentBotCommands(5)).filter((c) => c.id === res.id);
      if (row?.finished_at) { done = row; break; }
    }
    if (!done) {
      // NOT "no output". A question nobody answered and a question answered with nothing
      // are different facts, and conflating them is the whole reason this tool exists.
      console.error('\nno answer within the wait — the runner did not pick it up, or is not running.');
      process.exitCode = 1;
    } else {
      console.log(`\n--- #${done.id} ${done.kind}${done.arg ? ` ${done.arg}` : ''} (exit ${done.exit_code}) ---`);
      if (done.error) console.log(`ERROR: ${done.error}`);
      if (done.output) console.log(done.output);
      if (!done.error && !done.output) console.log('(empty output)');
    }
  }
}
