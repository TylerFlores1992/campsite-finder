/**
 * "What is open on this watch right now?" — answered from the poller's own records.
 *
 * The value of these is mostly in what they FORBID. The obvious implementation of this
 * feature asks the provider on page load, which duplicates the poller, adds seconds to
 * the watches list, and spends the per-IP rec.gov budget that keeps detection at 15s.
 * `watch_site_alerts.last_seen_open_at` already carries the answer for free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPEN_WINDOW_MS } from '../src/lib/watch-openings';

const src = readFileSync('src/lib/watch-openings.ts', 'utf8');

test('nothing is fetched from a provider to answer this', () => {
  // THE RULE. A live grid fetch here would put provider latency and the rec.gov budget on
  // the critical path of the page a user opens most, to re-derive something the poller
  // wrote seconds ago.
  assert.ok(!/fetch\(|fetchGrid|getAvailability|findRC/.test(src),
    'this must read the poller\'s records, never call a reservation provider');
});

test('the window survives the slowest poll cadence a watch can be on', () => {
  // Since the cadence split, a far-out watch may only be checked every 5 minutes. A window
  // shorter than that would blink the badge off and on for a site that never closed —
  // reporting our polling schedule as if it were the campground's availability.
  const SLOWEST_POLL_MS = 5 * 60_000;
  assert.ok(OPEN_WINDOW_MS >= SLOWEST_POLL_MS * 2,
    'must cover at least two of the slowest cycles, or the badge flickers on a stable site');
  // And not so long that it outlives the truth: a site taken 20 minutes ago should not
  // still be advertised as open.
  assert.ok(OPEN_WINDOW_MS <= 30 * 60_000, 'a very old sighting is not "open now"');
});

test('the no-site-id sentinel is never counted as a site', () => {
  // ReserveAmerica, GoingToCamp and TN/SC have no per-site id and collapse onto '*'
  // (see worker/claim.ts). Counting that row would render "1 site open" from a record
  // that only ever meant "something on this campground" — a number we made up.
  assert.match(src, /site_key <> '\*'/, "the '*' sentinel must be excluded from the count");
});

test('a batch, not a query per watch', () => {
  // The watches list renders every watch at once. Per-watch round trips would be N
  // queries on the page a user opens most.
  assert.match(src, /watch_id = ANY\(\$1\)/, 'openings are looked up for all watches in one go');
});

test('only holds that are still ahead, and only before they are carted', () => {
  // A carted hold has its own screen and its own clock; a badge on the list would be a
  // second, staler place to learn about it — and the claim flow is where the ~15-minute
  // cart window is actually explained.
  assert.match(src, /status IN \('offered', 'requested'\)/, 'offered/requested only');
  assert.match(src, /release_at >= to_char\(NOW\(\) AT TIME ZONE 'America\/Los_Angeles'/,
    "release times are zone-less Pacific wall-clock and must be compared in Pacific");
});

test('the card prefers the measurement over the inference', () => {
  // `state === "hit"` was "alerted within the last hour", which decayed into a wrong
  // answer once alerting became transition-based (migration 039): a site that stays open
  // stops re-alerting, so the card reverted to "Watching" while the site sat there open.
  const card = readFileSync('src/components/v2/WatchCard.tsx', 'utf8');
  const state = card.slice(card.indexOf('export function watchState'), card.indexOf('export default function WatchCard'));
  // MATCH THE STATEMENTS, NOT THE WORDS. The first version compared indexOf on bare
  // identifiers and failed against correct code, because the comment ABOVE the check
  // mentions `notification_sent_at` while explaining why it is now second. A test that a
  // comment can flip is not testing the code.
  const measured = state.indexOf('if (w.open_sites?.length) return "hit";');
  const inferred = state.indexOf('const alerted = w.notification_sent_at');
  assert.ok(measured >= 0, 'the seen-open check must exist');
  assert.ok(inferred >= 0, 'the alerted-recently guess must still exist as the fallback');
  assert.ok(measured < inferred, 'seen-open must be checked BEFORE the alerted-recently guess');
});
