// Lead-time tiering: how far out is the first night a watch wants within a given
// month? Separate from poller.ts for the same reason claim.ts and shard.ts are —
// importing the poller STARTS it, and this small function decides which
// campground-months get a guaranteed-fresh read every cycle versus riding a
// 60-second cache. Getting it wrong in the hot direction wastes the per-IP budget
// that keeps detection at 15s; wrong in the cold direction quietly slows the exact
// watches whose openings vanish in minutes.

/**
 * Days until the first night `startDate..` wants WITHIN `month` (YYYY-MM).
 * Per (watch, month), not per watch: a six-month watch's October pages are far-out
 * even on August 1st. Clamped at 0 for a stay already in progress.
 */
export function leadDaysUntil(startDate: string, month: string, now = Date.now()): number {
  const firstWanted = startDate > `${month}-01` ? startDate : `${month}-01`;
  const ms = Date.parse(`${firstWanted}T00:00:00Z`) - now;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
