// How often the UseDirect "locked until a scheduled release" check runs.
//
// Separate from poller.ts for the same reason claim.ts, shard.ts and lead-time.ts are:
// importing the poller STARTS it, which is what made the most consequential code in the
// repo untestable.
//
// THE RULE THIS ENCODES. Polling frequency only buys something when the event is
// unpredictable. `findRCOpenUnit` watches for a site becoming bookable — unpredictable,
// gone in minutes, and speed is the only defence, so it stays on the 15s cycle.
// `findRCHeldUnit` watches for a site LOCKED until a published release time; we record
// that time and the cart fires off it. Discovering the lock five minutes later changes
// nothing about when the site gets carted.
//
// The floor that makes a slow cadence safe is `holdIsNewsworthy`, which refuses any
// coming-soon alert with under an hour of lead. A discovery delay only costs us something
// if it eats into that hour, and these releases are typically ~18 hours out.

/** Default gap between held checks. Overridden by `RC_HELD_CHECK_MS`. */
export const RC_HELD_CHECK_DEFAULT_MS = 300_000;

/**
 * Is another held check due?
 *
 * `lastAt = 0` means "never run", which must be due — otherwise a freshly deployed worker
 * would wait a full interval before its first look, and a deploy at 07:55 would miss an
 * 8am release entirely.
 */
export function heldCheckDue(lastAt: number, now: number, intervalMs: number): boolean {
  if (!lastAt) return true;
  // A clock that jumped backwards must not wedge this off for hours. Fly machines resume
  // from snapshots and NTP steps them; treating a future `lastAt` as "due" fails toward
  // checking, which costs one grid fetch.
  if (lastAt > now) return true;
  return now - lastAt >= intervalMs;
}

/**
 * The interval must stay well inside the newsworthiness floor.
 *
 * Exported so the poller's own constant is checked rather than trusted: setting
 * `RC_HELD_CHECK_MS` to an hour would silently mean a lock discovered at T-59min is
 * announced at T-0, i.e. never, because `holdIsNewsworthy` would refuse it. Clamped
 * rather than thrown on — a bad env var must not stop the poller.
 */
export function clampHeldInterval(ms: number, leadFloorMs = 60 * 60_000): number {
  if (!Number.isFinite(ms) || ms <= 0) return RC_HELD_CHECK_DEFAULT_MS;
  // A quarter of the floor leaves three further chances to see a lock before it stops
  // being newsworthy.
  return Math.min(ms, leadFloorMs / 4);
}
