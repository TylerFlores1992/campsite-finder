/**
 * A site being free now must not hide a site releasing tomorrow.
 *
 * THE BUG (reported 2026-08-10). The held/"coming soon" pass ran only for watches with no
 * open unit, and the alert loop skipped any watch that had already alerted as available.
 * So a watch on a campground with one free site never heard that a DIFFERENT site was
 * locked and releasing at 08:00 — and could never be offered a hold on it.
 *
 * They are not substitutes. "Something is bookable now" is whichever site happened to
 * free up; "we can hold #38 for you at 08:00" is a specific site, and only one of the two
 * expires. Suppressing the second because of the first quietly narrowed the product to
 * whatever came free first.
 *
 * Found live: South Carlsbad had #85 and #92 free for 8/18 while #68 and #84 were locked
 * for an 08:00 release, and the watch was told only about #85.
 *
 * SOURCE-LEVEL because this is control flow inside the poll cycle, and importing
 * poller.ts STARTS the poller — the reason claim.ts, shard.ts and lead-time.ts are all
 * separate modules. The assertions name the exact suppressions rather than the behaviour,
 * which is the honest description of what they can check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('worker/poller.ts', 'utf8');

test('the held pass covers every UseDirect watch, not only the ones with nothing open', () => {
  assert.ok(
    !/heldTargets = rcWatches\.filter\(\(w\) => !rcResults\.has\(w\.id\)\)/.test(src),
    'filtering held targets by "has no open unit" is the bug — a free site hid a locked one',
  );
  assert.match(src, /const heldTargets = rcWatches;/, 'every watch gets the held check');
});

test('the coming-soon alert is not skipped because an availability alert went out', () => {
  assert.ok(
    !/if \(rcResults\.has\(w\.id\)\) continue; \/\/ already alerted as available above/.test(src),
    'the two alerts answer different questions and must not suppress each other',
  );
});

test('the release-time dedup is still what stops repeats', () => {
  // Removing the suppression is only safe because something else bounds the noise:
  // claimHoldNotification is keyed on the RELEASE TIME, so however many ordinary
  // availability alerts a watch sends, the coming-soon heads-up still goes out at most
  // once per release. Without this the change would trade a missed alert for a repeated
  // one — the 16-alerts-in-a-day shape from migration 039.
  //
  // The call gained a THIRD argument with migration 070 (the campground scope), so this
  // matches the first two rather than the whole call — the property being guarded is
  // "keyed on the release time", not "takes exactly two arguments". Loosening it to
  // /claimHoldNotification\(/ would have kept it passing while letting the release key
  // disappear entirely, which is the thing it exists to catch.
  assert.match(src, /claimHoldNotification\(\s*w\.id,\s*held\.availableAt\b/,
    'the per-release claim is what makes the un-suppressed loop safe');

  // And the scope must actually be passed, or two divisions of one park sharing the
  // single rc_hold_notified_for column would silence each other's coming-soon alert.
  assert.match(src, /claimHoldNotification\([\s\S]{0,120}multi:\s*w\.multi_campground/,
    'the hold claim is scoped per campground for a multi-campground watch');
});
