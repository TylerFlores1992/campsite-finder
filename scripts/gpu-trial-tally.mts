/**
 * Is the GPU-off change doing anything? — the tally, with the bar stated before the trial.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/gpu-trial-tally.mts 2026-09-10T05:21:50Z
 *
 * ## THE TRIAL RAN AND IS OVER (2026-09-10) — this is now a general ramp tally
 *
 * The first trial RAMPED, two minutes after `restart-rc` replaced the browser, with the full
 * 32 GiB / 16,385-region walk and the same native spin. **The command-buffer candidate is
 * refuted and the flags are off again**; the ~20 bar below was for crediting a CURE and was
 * never reached because silence is not what arrived. Do not re-run the trial to confirm a
 * refutation — the confirming evidence is the walk. The script is kept because "how many
 * browser replacements ramped since <instant>?" is the question every future candidate needs.
 *
 * ## What a trial IS
 *
 * A trial is a BROWSER REPLACEMENT, not a restart command. `restart-rc` is one way to cause
 * one; the post-Okta recycle, the size guard, a profile yield and a `bail:ramp` are others,
 * and a NATURAL replacement counts exactly like a forced one — the browser does not know
 * which lever started it. Counting only the ones we fired would throw away most of the
 * evidence and make the bar take days instead of hours.
 *
 * ## Why `since` is an ARGUMENT and not inferred
 *
 * The flags reached the box at a knowable instant, and a replacement before it is a CONTROL
 * rather than a trial. Inferring the boundary from the data would fold the two populations
 * together, which is how a repair gets credited to the wrong mechanism — three times in this
 * repo's history. It is passed in so it can be wrong out loud rather than quietly.
 *
 * The instant is not the update's `applied_at`: what matters is when a browser first LAUNCHED
 * under the flags. On 2026-09-10 that was 05:21:50Z, identified from the per-type breakdown —
 * `gpu-process` fell to 20-22 MB from a steady 80-126 MB and stayed there.
 *
 * ## THE BAR, AND WHY IT IS THIS BIG
 *
 * A browser replacement ramps about **10%** of the time — 11 of 110 measured over ten days to
 * 2026-09-09. So three quiet trials is what a change doing NOTHING produces roughly three
 * quarters of the time, and even ten is a coin-flip. **Roughly twenty clean trials** is the
 * point at which silence starts to mean something (0.9^20 ~ 12%).
 *
 * The number is written down here rather than argued about afterwards, because the mistake
 * this file has recorded three separate times — the age recycle, the throttling flags and the
 * containment arm — is crediting a repair to the wrong mechanism on a handful of quiet hours.
 *
 * ## The most valuable outcome is the one that arrives soonest
 *
 * A ramp that still appears with the flags on **refutes the command-buffer candidate
 * outright**, and does so on the first occurrence rather than the twentieth. That is worth as
 * much as a cure. Read its VMSTACK and region-walk rows when it happens.
 */
import { query } from '../src/lib/db/client';

const RAMP_MB = 1500;         // well above the ~220-320 MB idle family, well below any ramp peak
const EVENT_GAP_MS = 20 * 60_000; // samples this far apart are separate events, not one long one
const BASE_RATE = 0.1;        // measured: 11 of 110 replacements ramped
const BAR = 20;

const since = process.argv[2];
if (!since) {
  console.error('usage: gpu-trial-tally.mts <ISO instant a browser first launched under the flags>');
  process.exit(1);
}

const rows = await query<{ taken_at: string; rc_mb: number; max_pid: number }>(
  `SELECT taken_at, rc_mb, max_pid FROM chromium_memory_samples
    WHERE taken_at > $1::timestamptz AND source = 'bot'
    ORDER BY taken_at`,
  [since],
);

// NOT an empty tally. "No samples" and "no ramps" are different facts, and reporting the
// first as the second is the absent-reading-as-a-negative shape this file keeps paying for.
if (!rows.length) {
  console.log(`No samples at all since ${since}.`);
  console.log('That is an ABSENCE, not a clean run — the box may not have updated, or the');
  console.log('sampler may not be reporting. Check `bot-ask git-status` before reading anything into it.');
  process.exit(0);
}

let replacements = 0;
let prevPid: number | null = null;
const ramps: { at: string; peak: number }[] = [];
let lastRampT = 0;

for (const r of rows) {
  if (r.max_pid && prevPid && r.max_pid !== prevPid) replacements++;
  if (r.max_pid) prevPid = r.max_pid;

  const mb = Number(r.rc_mb ?? 0);
  if (mb > RAMP_MB) {
    const t = new Date(r.taken_at).getTime();
    if (t - lastRampT > EVENT_GAP_MS) ramps.push({ at: r.taken_at, peak: mb });
    else ramps[ramps.length - 1].peak = Math.max(ramps[ramps.length - 1].peak, mb);
    lastRampT = t;
  }
}

const clean = Math.max(replacements - ramps.length, 0);
console.log(`window       : ${since} -> ${rows[rows.length - 1].taken_at}`);
console.log(`samples      : ${rows.length}`);
console.log(`replacements : ${replacements}`);
console.log(`RAMPS        : ${ramps.length}`);
for (const r of ramps) console.log(`               ${r.at}  peak ${Math.round(r.peak)} MB`);
console.log(`clean trials : ${clean}   (bar is ~${BAR})`);
console.log('');

if (ramps.length > 0) {
  console.log('A RAMP ARRIVED WITH THE FLAGS ON, WHICH REFUTES THE COMMAND-BUFFER CANDIDATE.');
  console.log('That is a finding, not a setback, and it arrived sooner than a cure would have.');
  console.log('Read its VMSTACK and region-walk rows: `bot-events-readout.mts`.');
} else if (clean >= BAR) {
  console.log(`${clean} clean trials with no ramp. At the measured ${BASE_RATE * 100}% base rate that is`);
  console.log(`about ${(BASE_RATE ** 0 * (1 - BASE_RATE) ** clean * 100).toFixed(1)}% likely from a change that does nothing —`);
  console.log('the first real evidence the flags did something. It is still not a mechanism.');
} else {
  const p = ((1 - BASE_RATE) ** clean * 100).toFixed(0);
  console.log(`NOT YET EVIDENCE. ${clean} clean trials is what a change doing NOTHING produces about`);
  console.log(`${p}% of the time at the measured ${BASE_RATE * 100}% base rate. Keep going to ~${BAR}.`);
}
