/**
 * Catch a rec.gov keepalive browser in the act.
 *
 * THE QUESTION. 175 consecutive samples recorded recgov=0 while the bot log shows ~26
 * keepalive browsers opening in the same window. Two explanations, and they are NOT the
 * same finding:
 *   (a) the browsers are short-lived and a 2-minute cadence genuinely misses them, or
 *   (b) the sampler's PowerShell filter does not match rec.gov profiles at all, in which
 *       case the family that has never been ruled out is INVISIBLE to the instrument built
 *       to rule it out — and `kill-chrome recgov`, which shares the filter idiom, would not
 *       reach it either.
 *
 * `memory` prints CHROME (every chrome.exe on the box) and OURS (those matching our filter),
 * plus the full --user-data-dir per matched process. Fired while a keepalive browser is
 * open, that separates them: a rec.gov path under OURS means the filter works and the
 * sampler is merely unlucky; CHROME > OURS with no rec.gov path means it is blind.
 *
 * keepSessionsWarm runs on a fixed 30-minute setInterval from bot.mjs start (observed
 * 03:01:23 -> 03:31:23), so the window is predictable. Three commands are queued a beat
 * early and run back to back to cover the stagger between the two enrolled users.
 */
import { requestBotCommand, recentBotCommands } from '../src/lib/bot-commands';

const TARGET_MS = Date.parse(process.argv[2] ?? '');
if (!Number.isFinite(TARGET_MS)) throw new Error('pass a target ISO timestamp');

const wait = (ms: number) => new Promise((s) => setTimeout(s, Math.max(0, ms)));

console.log(`now      ${new Date().toISOString()}`);
console.log(`target   ${new Date(TARGET_MS).toISOString()} (keepalive fires)`);
await wait(TARGET_MS - 3000 - Date.now());
console.log(`arming   ${new Date().toISOString()}`);

const ids: number[] = [];
for (let i = 0; i < 3; i++) {
  const r = await requestBotCommand('memory', null, `keepalive-probe-${i}`);
  if ('error' in r) console.log(`  request ${i} refused: ${r.error}`);
  else { ids.push(r.id); console.log(`  queued #${r.id} at ${new Date().toISOString()}`); }
}

for (let i = 0; i < 60 && ids.length; i++) {
  await wait(5000);
  const rows = await recentBotCommands(10);
  for (const id of [...ids]) {
    const c = rows.find((x) => x.id === id);
    if (!c?.finished_at) continue;
    ids.splice(ids.indexOf(id), 1);
    console.log(`\n=== #${id} started ${c.started_at} finished ${c.finished_at} ===`);
    // Only the lines that answer the question: the counts and any rec.gov path.
    for (const line of (c.output ?? '').split('\n')) {
      if (/CHROME|OURS|FAMILY|profiles|rc-bot-profile|COMMIT/i.test(line)) console.log('  ' + line.trim());
    }
  }
}
console.log('\ndone');
