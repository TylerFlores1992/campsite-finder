/**
 * WHAT THE MINI-PC NOTICED — ramp scans and tab-close timings (migration 075).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts [--hours 72] [--all]
 *
 * TWO QUESTIONS, ONE TABLE:
 *
 *   ramp-scan   Where is the ~35 GB of commit that appears at every ramp onset and that
 *               chrome.exe private bytes do not account for? Read ALLPROC privateSumMB
 *               against OS commitUsedMB first: close together means the commit is
 *               process-attributable and TOP names the owner; far apart means shared
 *               sections or kernel pool (PERF poolNonpagedMB / poolPagedMB). Then CHROME
 *               handles= for a renderer holding shared-memory sections open.
 *
 *   tab-close   Is the throwaway tab's close hanging? `closeMs` beside `tripMs`, per trip.
 *               A healthy close is milliseconds. A close that took minutes — or `hung: true`
 *               — is the renderer refusing to answer, and it is why the throwaway-tab cure
 *               never handed anything back. Read the healthy baseline too: a bad number is
 *               only readable next to a good one.
 *
 * NO EVENTS IS THE ORDINARY STATE until the box has updated to code that sends them, and
 * for ramp scans until a ramp has happened since. The absence is an absence, not a reading.
 */
import { recentBotEvents, type BotEventRow } from '@/lib/bot-events';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const hours = Math.max(1, Number(arg('hours', '72')) || 72);
const showAll = process.argv.includes('--all');

const [scans, closes] = await Promise.all([
  recentBotEvents('ramp-scan', hours, showAll ? 50 : 3),
  recentBotEvents('tab-close', hours, showAll ? 500 : 40),
]);

const pt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
const d = (row: BotEventRow) => (row.detail ?? {}) as Record<string, unknown>;

console.log(`BOT EVENTS — last ${hours}h\n`);

console.log(`RAMP SCANS: ${scans.length}${showAll ? '' : ' (newest 3; --all for more)'}`);
if (scans.length === 0) {
  console.log('  none. Ordinary until a ramp has happened on a box running ramp-scan.mjs —');
  console.log('  check chromium_memory_samples for a ramp since the box updated before reading this as silence.');
}
for (const s of scans) {
  const x = d(s);
  console.log(`\n  ${pt(s.at)} PT  trigger rc ${x.rcMb} MB (threshold ${x.thresholdMb})  commit ${x.commitUsedMb}/${x.commitLimitMb} MB  free RAM ${x.ramFreeMb} MB  max pid ${x.maxPid} ${x.maxType ?? ''}${x.complete === false ? '  ⚠ scan INCOMPLETE (no END line)' : ''}`);
  const lines = (s.text ?? '').split('\n');
  // The discriminator first, then everything.
  const os = lines.find((l) => l.startsWith('OS '));
  const all = lines.find((l) => l.startsWith('ALLPROC '));
  const perf = lines.find((l) => l.startsWith('PERF '));
  if (os && all) {
    const commit = Number(/commitUsedMB=(\d+)/.exec(os)?.[1]);
    const priv = Number(/privateSumMB=(\d+)/.exec(all)?.[1]);
    if (Number.isFinite(commit) && Number.isFinite(priv)) {
      const gap = commit - priv;
      console.log(`  >>> commit ${commit} MB vs private bytes over EVERY process ${priv} MB — gap ${gap} MB: `
        + (gap < 4000
          ? 'the commit IS process-attributable; read TOP for the owner.'
          : 'the commit is NOT in any process\'s private bytes — shared sections or kernel pool. Read PERF pool figures and CHROME handles.'));
    }
  }
  if (perf) console.log(`  ${perf}`);
  for (const l of lines) console.log(`    ${l}`);
}

console.log(`\nTAB CLOSES: ${closes.length}${showAll ? '' : ' (newest 40; --all for more)'}`);
if (closes.length === 0) {
  console.log('  none. Ordinary until the box runs tab-close.mjs and a trip has happened since.');
} else {
  const hung = closes.filter((c) => d(c).hung === true).length;
  const slow = closes.filter((c) => Number(d(c).closeMs) > 5_000 && d(c).hung !== true).length;
  console.log(`  ${hung} given up on (hung), ${slow} slow (>5s but closed), ${closes.length - hung - slow} prompt.`);
  console.log('  time (PT)            trip        tripMs   closeMs  hung  ramMb');
  for (const c of closes) {
    const x = d(c);
    console.log(`  ${pt(c.at).padEnd(20)} ${String(x.label ?? '?').padEnd(11)} ${String(x.tripMs ?? '?').padStart(7)}  ${String(x.closeMs ?? '?').padStart(7)}  ${x.hung ? 'YES ' : ' no '}  ${x.ramMb ?? '-'}`);
  }
  if (hung) {
    console.log('\n  >>> A hung close is the renderer not answering. The keep-warm recycles the browser on');
    console.log('      the next loop pass; the memory series should show the ramp ending at that moment.');
  } else if (closes.some((c) => Number(d(c).tripMs) > 300_000)) {
    console.log('\n  >>> Closes are prompt but a trip took over five minutes: the time is in the renewal');
    console.log('      BODY (its bounded waits timing out in series), not in the close. Different fix.');
  }
}
