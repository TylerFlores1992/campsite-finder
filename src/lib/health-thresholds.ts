// How stale a canary may get before it means something, in ONE place.
//
// This existed in three, and they disagreed. `worker/fly.toml` runs the delivery
// canary every 24h; `/api/health/status` hardcoded a 7h staleness threshold; and
// `AdminTabs.canaryLevel` hardcoded its own 7h with a comment saying "delivery
// canaries run hourly". So for roughly seventeen hours out of every twenty-four the
// admin banner announced "3 things need attention — delivery:email is failing,
// delivery:push is failing and delivery:sms is failing" about three canaries whose
// last recorded result was success.
//
// That is the expensive kind of wrong. A dashboard that cries wolf daily trains its
// only reader to ignore it, and this is the same page that would report a genuine
// alerting outage.
//
// These are plain constants rather than env reads on purpose. The worker's config is
// not visible to Vercel, and a value that resolves differently on the server and in
// the client bundle is how the drift started. If the cadence in `worker/fly.toml`
// changes, change it HERE — one edit, both consumers.

/** `CANARY_DELIVERY_INTERVAL_MS` in worker/fly.toml. */
export const DELIVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** `CANARY_DETECT_INTERVAL_MS` default in worker/poller.ts. */
export const DETECT_INTERVAL_MS = 120 * 1000;

/**
 * Slack on top of the interval before "overdue" means anything.
 *
 * Generous deliberately: a canary is late whenever the worker restarted inside the
 * window, because the boot call is throttled and the interval timer restarts with the
 * process. Being late is normal; never running is the thing worth saying.
 */
export const DELIVERY_STALE_MS = DELIVERY_INTERVAL_MS * 1.15;
export const DETECT_STALE_MS = DETECT_INTERVAL_MS * 5;

/**
 * Past this, it has not merely slipped — it has stopped, and that IS worth a red
 * banner. Two tiers exist so "late" and "dead" don't share one word: with a single
 * threshold you must pick between crying wolf every day and never reporting a canary
 * that quietly died, and the first choice is what made this banner ignorable.
 */
export const DELIVERY_DEAD_MS = DELIVERY_INTERVAL_MS * 3;
/**
 * DETECTION HAS NO SECOND TIER — stale IS dead. The two-tier idea exists because
 * delivery runs daily, so "late" is routine and says nothing. Detection runs every
 * two minutes and guards whether openings are noticed at all; ten minutes of silence
 * there is already an outage, which is why /api/health/status fails on it outright.
 * Giving detect a softer tier would have made this banner LESS sensitive than the API
 * about the canaries that matter most.
 */
export const DETECT_DEAD_MS = DETECT_STALE_MS;

export const DELIVERY_STALE_SECONDS = DELIVERY_STALE_MS / 1000;
export const DETECT_STALE_SECONDS = DETECT_STALE_MS / 1000;
export const DELIVERY_DEAD_SECONDS = DELIVERY_DEAD_MS / 1000;
export const DETECT_DEAD_SECONDS = DETECT_DEAD_MS / 1000;
