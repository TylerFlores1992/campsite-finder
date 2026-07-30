// The canary staleness thresholds. This banner told the owner "3 things need
// attention — delivery:email is failing, delivery:push is failing and delivery:sms
// is failing" for roughly 17 hours out of every 24, about three canaries whose last
// recorded result was success. A dashboard that cries wolf daily trains its only
// reader to ignore it, which is worse than not having one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_INTERVAL_MS,
  DELIVERY_STALE_MS,
  DELIVERY_DEAD_MS,
  DETECT_INTERVAL_MS,
  DETECT_STALE_MS,
  DETECT_DEAD_MS,
} from '../src/lib/health-thresholds';

const HOUR = 3600_000;

test('a delivery canary on its normal daily cadence is never stale', () => {
  // The whole bug: the threshold was 7h against a 24h cadence.
  assert.ok(DELIVERY_STALE_MS > DELIVERY_INTERVAL_MS,
    'stale must be looser than the interval, or every run is late the moment it lands');
  assert.ok(24 * HOUR < DELIVERY_STALE_MS);
});

test('the 14.4h age observed on the live dashboard reads as OK', () => {
  // Exactly what production showed while the banner claimed all three were failing.
  assert.ok(14.4 * HOUR < DELIVERY_STALE_MS);
});

test('a canary that has genuinely stopped still escalates', () => {
  // Two tiers, so "late" and "dead" do not share one word.
  assert.ok(DELIVERY_DEAD_MS > DELIVERY_STALE_MS);
  assert.ok(3 * 24 * HOUR <= DELIVERY_DEAD_MS, 'three missed days is stopped, not slow');
});

test('detection canaries keep a much tighter window than delivery', () => {
  // They run every ~2 minutes and guard the path that finds openings at all.
  assert.ok(DETECT_STALE_MS < DELIVERY_STALE_MS);
  assert.equal(DETECT_STALE_MS, DETECT_INTERVAL_MS * 5);
  assert.ok(DETECT_STALE_MS <= 10 * 60_000, 'ten minutes of silence is already an outage');
});

test('detection has NO softer tier — stale is dead', () => {
  // A second tier here would make the banner less sensitive than /api/health/status,
  // which fails outright on a stale detect canary. The two-tier split is for delivery
  // only, where a daily cadence makes "late" routine and meaningless.
  assert.equal(DETECT_DEAD_MS, DETECT_STALE_MS);
});
