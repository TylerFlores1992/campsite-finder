/**
 * "Is anyone asking, in public, the question CampHawk answers?" — the weekly digest.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/mentions-readout.mts
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/mentions-readout.mts --days=14 --dry-run
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/mentions-readout.mts --all      # ignore what is seen
 *
 * IT READS AND IT REPORTS. It posts nothing, anywhere, ever — see the header of
 * `src/lib/mentions/types.ts` for why that is a design constraint and not a limitation, and
 * `src/lib/mentions/monitor.test.mts` for the guard that keeps it true.
 *
 * WHAT IT COSTS TO RUN AND WHAT TO EXPECT. At CampHawk's size this surfaces perhaps two or
 * three genuinely relevant posts a week. That is the shape of the channel, not a
 * disappointment — its value is that you answer those three within the hour instead of
 * finding them a fortnight later. A digest of ten would mean the threshold is too low.
 *
 * FIRST LIVE RUN IS THE FIRST REAL EVIDENCE. Every fetcher here was written in a sandbox
 * where reddit.com and google.com answer 403 to CONNECT, so the parsing is tested against
 * captured fixtures and the HTTP has never executed. Expect to correct a field name. That
 * is the validated-somewhere-other-than-where-it-runs trap, stated up front rather than
 * discovered.
 */
import { query, mutate } from '../src/lib/db/client';
import { runSources, partition, type ScoredCandidate } from '../src/lib/mentions/run';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name: string) => process.argv.includes(`--${name}`);

const days = Number(arg('days') ?? 7);
if (!Number.isFinite(days) || days < 1) {
  console.error('--days must be a positive number');
  process.exit(1);
}
const dryRun = has('dry-run');
const showAll = has('all');

const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

console.log(`\nCampHawk mention monitor — last ${days} day(s)\n`);

const { scored, reports, degraded } = await runSources({
  fetch: globalThis.fetch,
  since,
  env: process.env,
  limit: 50,
});

// ── what each source managed ──────────────────────────────────────────────────────────────
// FIRST, ABOVE THE FINDINGS, and loudest when something failed. An empty digest is the
// ORDINARY weekly result, so "quiet week" and "Reddit rate-limited every query" have to be
// told apart before anything else is read — otherwise a monitor that has been broken for a
// month looks exactly like a monitor working correctly.
console.log('SOURCES');
for (const r of reports) {
  const kind = r.kind === 'manual' ? 'manual' : 'auto';
  if (r.error) console.log(`  ✗ ${r.label.padEnd(32)} [${kind}]  COULD NOT ANSWER — ${r.error}`);
  else console.log(`  ✓ ${r.label.padEnd(32)} [${kind}]  ${r.found} candidate(s)`);
}
if (degraded) {
  console.log(
    '\n  ⚠ At least one automatic source failed. The count below is NOT a reading of how\n' +
      '    quiet the week was — it is a reading of what we managed to ask.',
  );
}

// ── what is new ───────────────────────────────────────────────────────────────────────────
const seenRows = showAll
  ? []
  : await query<{ source: string; external_id: string }>(
      'SELECT source, external_id FROM mention_hits',
    );
const seen = new Set(seenRows.map((r) => `${r.source}:${r.external_id}`));
const { surface, record } = partition(scored, seen);

console.log(`\nWORTH A REPLY  (${surface.length} new)`);
if (surface.length === 0) {
  console.log(
    degraded
      ? '  Nothing — but a source failed above, so this is not evidence of a quiet week.'
      : '  Nothing new. Two or three a week is the expected rate; zero is an ordinary week.',
  );
}
for (const c of surface) {
  console.log(`\n  [${c.scoring.score}] ${c.title}`);
  console.log(`      ${c.community ?? c.source}${c.author ? ` · ${c.author}` : ''}${c.createdAt ? ` · ${ago(c.createdAt)}` : ''}`);
  console.log(`      ${c.url}`);
  for (const r of c.scoring.reasons) console.log(`      · ${r}`);
}

// Below the bar but recorded. Printed only on request: the whole reason the threshold is
// high is that a digest nobody finishes reading is worth nothing.
const near = record.filter((c) => !c.scoring.surfaced && c.scoring.score > 0);
if (near.length > 0) {
  console.log(`\n  (${near.length} more scored below the bar and were recorded — --all to see them)`);
  if (showAll) for (const c of near) console.log(`    [${c.scoring.score}] ${c.title}\n        ${c.url}`);
}

// ── the manual venues ─────────────────────────────────────────────────────────────────────
// A CHECKLIST IS NEVER COUNTED AS A FINDING. It is a list of places to look, printed apart
// so "12 items" can never be read as twelve hits.
for (const r of reports) {
  if (!r.checklist?.length) continue;
  console.log(`\n${r.label.toUpperCase()} — open these yourself`);
  for (const item of r.checklist) {
    console.log(`  • ${item.label}${item.note ? `  — ${item.note}` : ''}`);
    console.log(`    ${item.url}`);
  }
}

// ── remember what was shown ───────────────────────────────────────────────────────────────
// EVERYTHING SCORED, not only what was surfaced: a candidate that scored 11 today is the
// only evidence available for whether the threshold is right, and without the near-misses
// lowering it would dump a month of backlog into one digest as a burst of interest.
if (!dryRun && record.length > 0) {
  for (const c of record) await remember(c);
  console.log(`\nRecorded ${record.length} new candidate(s). They will not appear again.`);
} else if (dryRun) {
  console.log('\n--dry-run: nothing recorded, so the next run repeats this digest.');
}

console.log('');
process.exit(0);

async function remember(c: ScoredCandidate): Promise<void> {
  // ON CONFLICT DO NOTHING, never an upsert. `score` and `surfaced` are a record of what a
  // human was SHOWN at the time; recomputing them under a later scoring rule would rewrite
  // history and destroy the only data that could say whether a threshold change helped.
  await mutate(
    `INSERT INTO mention_hits
       (source, external_id, url, title, community, author, posted_at, score, surfaced, reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [
      c.source, c.externalId, c.url, c.title,
      c.community ?? null, c.author ?? null,
      c.createdAt ? c.createdAt.toISOString() : null,
      c.scoring.score, c.scoring.surfaced,
      c.scoring.reasons,
    ],
  );
}

function ago(d: Date): string {
  const h = Math.round((Date.now() - d.getTime()) / 3_600_000);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
