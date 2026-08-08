/**
 * Apply `src/lib/campground-visibility.ts` to the catalog.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/classify-campgrounds.mts           # DRY RUN
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/classify-campgrounds.mts --apply
 *
 * Dry by default, because this decides what 8,000 campgrounds are and a mistake in the
 * hiding direction is invisible — the row is simply not in search, and nobody reports a
 * result they never saw.
 *
 * Re-runnable and self-correcting: it computes the answer for EVERY row, so a rule change
 * that un-hides something is applied by running this again. That is the property that
 * makes the read-time design worth having over a sync-time filter.
 */
import { query, mutate } from '../src/lib/db/client';
import { nonCampgroundReason } from '../src/lib/campground-visibility';

const APPLY = process.argv.includes('--apply');

const rows = await query<{ id: string; source: string; name: string; hidden: boolean; watches: number }>(
  `SELECT c.id, c.source, c.name, c.hidden,
          (SELECT count(*) FROM watches w WHERE w.campground_id = c.id)::int AS watches
     FROM campgrounds c ORDER BY c.source, c.name`,
);

const want = rows.map((r) => ({ ...r, why: nonCampgroundReason(r.name) }));
const toHide = want.filter((r) => r.why && !r.hidden);
const toShow = want.filter((r) => !r.why && r.hidden);

console.log(`${rows.length} campgrounds — ${want.filter((r) => r.why).length} classified as non-campgrounds\n`);
console.log(`  to hide: ${toHide.length}`);
console.log(`  to un-hide (rule relaxed since last run): ${toShow.length}`);

// Watches are the thing that must never be broken by this. Hiding is discovery-only and
// the poller ignores the flag, but a hidden campground someone is actively watching is
// still a sign the rule is wrong — surface it rather than let it pass silently.
const watched = toHide.filter((r) => r.watches > 0);
if (watched.length) {
  console.log(`\n⚠ ${watched.length} of these have LIVE WATCHES — alerts are unaffected, but check the rule:`);
  for (const w of watched) console.log(`    ${w.name} (${w.watches})`);
}

const by = new Map<string, number>();
for (const r of want) if (r.why) by.set(r.why, (by.get(r.why) ?? 0) + 1);
console.log('\nby matched term:');
for (const [w, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${w}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  console.log('Sample of what would be hidden:');
  for (const r of toHide.slice(0, 20)) console.log(`  ${r.source.padEnd(19)} ${r.name}  [${r.why}]`);
  process.exit(0);
}

for (const r of toHide) {
  await mutate(`UPDATE campgrounds SET hidden = true, hidden_reason = $2 WHERE id = $1`, [r.id, r.why]);
}
for (const r of toShow) {
  await mutate(`UPDATE campgrounds SET hidden = false, hidden_reason = NULL WHERE id = $1`, [r.id]);
}
console.log(`\napplied: ${toHide.length} hidden, ${toShow.length} un-hidden.`);
process.exit(0);
