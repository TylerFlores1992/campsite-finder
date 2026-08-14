/**
 * WHICH CHROMIUM IS EATING THE MINI-PC'S COMMIT?
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts [--hours 24] [--all]
 *
 * The leak of 2026-08-12 — 9.4 GB private, ~395 MB/min, COMMIT to 99% of 50 GB, ending in a
 * hand power-cycle — has never been attributed to a profile family. It was guessed twice and
 * wrong both times. See migration 059 for why a series exists instead of a pair of readings.
 *
 * THIS REFUSES A VERDICT IT HAS NOT EARNED, and that is the point of it. It counts the pairs
 * that could actually be compared (same pid, two samples) rather than the rows it fetched,
 * because the rec.gov browsers open and close every thirty minutes and a family total across
 * a restart is two different browsers subtracted from each other. Same posture as
 * `recgov-429-profile.mts` refusing until all 24 UTC hours have data.
 */
import {
  recentMemorySamples, readMemoryVerdict, MIN_COMPARABLE_PAIRS, BIG_PROCESS_MB,
} from '../src/lib/chromium-memory';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const hours = Math.max(1, Number(arg('hours', '24')) || 24);
const showAll = process.argv.includes('--all');

const rows = await recentMemorySamples(hours);
const v = readMemoryVerdict(rows);

console.log(`\nChromium memory on the mini-PC — last ${hours}h, ${v.samples} sample(s)\n`);

if (v.samples === 0) {
  console.log(v.verdict);
  console.log(
    '\nThe sampler lives in bot.mjs and needs BOT-SIDE code on the box, so a fresh deploy of\n' +
    'the website alone will not start it. `autocart.bot_version` says which commit the box is\n' +
    'on; the quiet update window is 02:00-05:00 PT and is shut while a hold is `requested`.',
  );
  process.exit(0);
}

console.log(`VERDICT  ${v.verdict}\n`);
console.log(`  comparable pairs   ${v.comparablePairs} (needs ${MIN_COMPARABLE_PAIRS} for a verdict)`);
console.log(`  peak COMMIT        ${v.peakCommitPct === null ? 'not reported' : `${v.peakCommitPct.toFixed(0)}%`}`);

// FAMILIES NOT SEEN ARE NOT FAMILIES CLEARED. This is the single most important line here:
// on 2026-08-14 a clean two-reading test sampled zero rec.gov processes and was read as
// evidence about a leak, which it could not be. Say which families the window could speak to.
const seen = v.familiesSeen.length ? v.familiesSeen.join(', ') : 'none';
console.log(`  families observed  ${seen}`);
for (const f of ['rc', 'recgov']) {
  if (!v.familiesSeen.includes(f)) {
    console.log(`  ⚠ NO ${f} process was running at any point in this window — this readout says`);
    console.log(`    NOTHING about the ${f} family. It has not been cleared; it was not sampled.`);
  }
}

// A HOLE IN THE SERIES IS EVIDENCE, NOT AN ABSENCE. Taking a sample spawns PowerShell, and
// spawning anything is exactly what fails at 99% commit — the supervise.ps1 failure IS this
// failure. So the samples immediately before a crash are the ones most likely to be missing,
// and a gap that begins mid-climb is where it got to, never a reading of zero.
if (v.worstGapMin > 10) {
  console.log(`\n  ⚠ longest gap ${Math.round(v.worstGapMin)} min with no sample at all.`);
  console.log('    At high commit PowerShell cannot be spawned, so the series ENDS rather than');
  console.log('    peaking. Check what the box was doing either side of the gap.');
}

// AND THE GAP AT THE END, which for a while was the one shape this could not see. A series
// that stops has no INTERNAL gap, so a box that died mid-ramp printed the same line as a box
// sitting quietly idle — a failure and a success looking identical, in the instrument built to
// separate them. `lastCommitPct` is what distinguishes a crash from a bot that was stopped.
if (v.seriesEnded && v.lastSampleAgeMin !== null) {
  console.log(`\n  ⚠ THE SERIES HAS STOPPED — nothing sampled for ${Math.round(v.lastSampleAgeMin)} min.`);
  console.log(`    Last COMMIT reading: ${v.lastCommitPct === null ? 'not reported' : `${v.lastCommitPct.toFixed(0)}%`}`);
  console.log('    Sampling spawns PowerShell, and spawning is the first thing that fails at');
  console.log('    high commit — so the END of the series is where the box got to. Read it as a');
  console.log('    reading, never as zero. At a NORMAL commit figure the dull explanation (the');
  console.log('    bot stopped, an update, the box off) is the likely one.');
}

// THE LARGEST PROCESS EVER SEEN, printed whether or not a rate corroborated it. A climb that
// outran the two-minute cadence (08-12 did: 7.9 GB in 46 seconds) leaves no comparable pair at
// all, so a readout that only ever printed rates could stay silent about a 7.9 GB browser
// sitting in its own table.
if (v.peak) {
  console.log(`\nLargest single process seen:`);
  console.log(`  ${v.peak.family} pid ${v.peak.pid}: ${Math.round(v.peak.mb)} MB at ${v.peak.at.slice(0, 19)}`);
  if (v.peak.mb >= BIG_PROCESS_MB) {
    console.log(`  ⚠ over the ${BIG_PROCESS_MB} MB line — normal on these profiles is 40-114 MB.`);
    console.log('    This is the attribution: that family, that pid, measured.');
  }
}

if (v.worst) {
  const w = v.worst;
  console.log(`\nSteepest climb on one process:`);
  console.log(`  ${w.family} pid ${w.pid}: ${w.fromMb} MB → ${w.toMb} MB ` +
    `over ${w.minutes.toFixed(1)} min = ${w.mbPerMin.toFixed(0)} MB/min`);
  console.log(`  ${w.fromAt} → ${w.toAt}`);
  console.log('  (2026-08-12 measured ~395 MB/min, on a family that was never identified.)');
}

const fmt = (n: number | null) => (n === null ? '—' : String(Math.round(Number(n))));
const shown = showAll ? rows : rows.slice(-30);
console.log(`\n${showAll ? 'All' : 'Last'} ${shown.length} sample(s) — MB, and the largest single process:`);
console.log('  taken_at                  commit%   rc   recgov  other   largest');
for (const r of shown) {
  const pct = r.commit_used_mb !== null && r.commit_limit_mb
    ? `${((Number(r.commit_used_mb) / Number(r.commit_limit_mb)) * 100).toFixed(0)}%`
    : '—';
  const largest = r.max_pid === null
    ? '—'
    : `${r.max_family ?? '?'} pid ${r.max_pid} ${fmt(r.max_mb)} MB`;
  console.log(
    `  ${r.taken_at.slice(0, 19)}  ${pct.padStart(7)}  ` +
    `${fmt(r.rc_mb).padStart(5)} ${fmt(r.recgov_mb).padStart(7)} ${fmt(r.other_mb).padStart(6)}   ${largest}`,
  );
}
if (!showAll && rows.length > shown.length) {
  console.log(`  … ${rows.length - shown.length} earlier sample(s); pass --all to see them.`);
}
console.log('');
