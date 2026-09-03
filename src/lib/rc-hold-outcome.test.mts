/**
 * "IT NEVER OPENED" AND "SOMEBODY BEAT US" MUST NOT BE THE SAME SENTENCE.
 *
 * RC refuses a cart with one message whether the lock never lapsed, a human got there first,
 * or we fired early (measured 2026-08-08). On 2026-09-03 that cost a morning of analysis and
 * still ended in a guess. The poller has been recording the answer on a 15-second cycle the
 * whole time; this reads it.
 *
 * The failure mode of this function is that it claims MORE than the data supports — and it
 * did exactly that on its first run against production, which is why the first test here is
 * the one that catches it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rcHoldOutcomeReading, siteKeyMatchesUnit } from './rc-hold-outcome';

function code(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const tapped = { tapped: true, carted: false, openedAfterS: null as number | null };

test('an offer nobody tapped is NOT a race we lost', () => {
  // THE BUG THIS CAUGHT ON ITS FIRST REAL RUN. The gate was `status === 'offered'`, and an
  // untapped offer does not stay `offered` — it ends `expired`. So the readout announced
  // "THE SITE DID OPEN and we did not get it — a race we lost" about #L034, an offer nobody
  // had touched. A function built to stop the readout overclaiming, overclaiming.
  for (const openedAfterS of [null, 13]) {
    assert.equal(rcHoldOutcomeReading({ tapped: false, carted: false, openedAfterS }), null,
      `untapped, opened=${openedAfterS}`);
  }
});

test('a hold that carted has nothing to explain', () => {
  assert.equal(rcHoldOutcomeReading({ ...tapped, carted: true, openedAfterS: 13 }), null);
});

test('tapped, not carted, and the poller SAW it open — we were beaten, and it says so', () => {
  const r = rcHoldOutcomeReading({ ...tapped, openedAfterS: 13 })!;
  assert.equal(r.level, 'warn', 'this is the one case worth a human reading twice');
  assert.match(r.text, /DID OPEN/);
  assert.match(r.text, /T\+13s/, 'the flip time is the finding, not just the fact');
  assert.match(r.text, /race we lost/);
});

test('T+0 is a real sighting, not a missing one', () => {
  // `if (openedAfterS)` would file the sharpest case there is — seen open in the same second
  // as the release — as "never opened". The absent-reading-as-a-negative shape.
  const r = rcHoldOutcomeReading({ ...tapped, openedAfterS: 0 });
  assert.ok(r, 'zero seconds is a sighting');
  assert.equal(r!.level, 'warn');
  assert.match(r!.text, /T\+0s/);
});

test('a negative delta is still a sighting — it must not be silently dropped', () => {
  // No held site has ever opened before its predicted release (0 of 14). If one ever does,
  // that is a finding about RC worth surfacing, not a row to discard.
  const r = rcHoldOutcomeReading({ ...tapped, openedAfterS: -5 });
  assert.ok(r);
  assert.match(r!.text, /T\+-5s|-5s/);
});

test('no sighting is reported as the ABSENCE of a sample, never as proof', () => {
  // The poller samples every 15 seconds, so a site taken inside one cycle leaves no trace.
  // Rounding "we did not see it" up to "it never opened" is the failure this file exists to
  // stop, and it is the reading somebody will quote next time a morning goes wrong.
  const r = rcHoldOutcomeReading(tapped)!;
  assert.equal(r.level, 'info', 'not a warning: nothing of ours went wrong');
  assert.match(r.text, /never saw/);
  assert.match(r.text, /15-second/, 'the resolution floor must be stated');
  assert.match(r.text, /NOT proof/i, 'the caveat is the point');
  assert.doesNotMatch(r.text, /never opened\b/,
    'it must not assert the thing it cannot know');
});

test('the attempt count rides along when there was a burst', () => {
  const r = rcHoldOutcomeReading({ ...tapped, attempts: 18 })!;
  assert.match(r.text, /18 attempts/);
  // One attempt is the ordinary case and adding "We made 1 attempts" is noise.
  assert.doesNotMatch(rcHoldOutcomeReading({ ...tapped, attempts: 1 })!.text, /1 attempts/);
});

test('BOTH site-key shapes match, or every park watch is invisible', () => {
  // Bare for a single-campground watch; `<campgroundId>::<unit>` since migration 070. The
  // namespaced form is the one a park watch writes, and a matcher that missed it would
  // report "never opened" for every park watch — confidently, and always wrongly.
  assert.equal(siteKeyMatchesUnit('42527', '42527'), true);
  assert.equal(siteKeyMatchesUnit('rc-542::42527', '42527'), true);
  assert.equal(siteKeyMatchesUnit('rc-542::42528', '42527'), false);
  // A sentinel, and a suffix that merely ends the right way, must not match.
  assert.equal(siteKeyMatchesUnit('rc-542::*', '42527'), false);
  assert.equal(siteKeyMatchesUnit('142527', '42527'), false);
  assert.equal(siteKeyMatchesUnit('', '42527'), false);
  assert.equal(siteKeyMatchesUnit('42527', ''), false);
});

test('the readout ROUTES through the shared reading and gates on the TAP', () => {
  // THE FIX-PRESENT-BUT-INERT SHAPE, plus the specific regression: keying on `status` here
  // is what produced the false "race we lost" line.
  const src = code('../../scripts/rc-holds-readout.mts');
  assert.match(src, /import \{[^}]*\brcHoldOutcomeReading\b[^}]*\} from '\.\.\/src\/lib\/rc-hold-outcome'/);
  assert.match(src, /tapped: !!h\.requested_at/, 'the tap is the axis, never the status');
  assert.match(src, /openedAfterS: h\.opened_after_s/);
  assert.match(src, /level === 'warn'/, 'severity must come from the reading');
});

test('the query matches BOTH site-key shapes and converts the zone correctly', () => {
  // The delta is computed in SQL on purpose: `release_at` is zone-less Pacific TEXT, and a
  // bare NOW() against it is seven hours out — a bug this repo has paid for in both
  // languages. A JS subtraction here would be a second copy of pacificWallClockToUtcMs.
  const src = code('../../scripts/rc-holds-readout.mts');
  const at = src.indexOf('AS opened_after_s');
  assert.ok(at > -1, 'the sighting must be selected');
  const q = src.slice(Math.max(0, at - 900), at);
  assert.match(q, /a\.site_key = r\.unit_id/, 'the bare shape');
  assert.match(q, /a\.site_key LIKE '%::' \|\| r\.unit_id/, 'the park-watch shape');
  assert.match(q, /AT TIME ZONE 'America\/Los_Angeles'/, 'or the delta is seven hours out');
  assert.match(q, /ORDER BY a\.last_alert_at ASC/,
    'the FIRST alert is the transition; the last is a re-alert after we released a cart');
});
