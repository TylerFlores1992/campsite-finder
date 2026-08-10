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

/**
 * How many rec.gov campground-months one worker machine can poll at the 15-second
 * cadence. Derived from measurement, not hope: a clean IP sustains ~15-16 req/min
 * before 429s (the RECGOV_BUDGET_PER_MIN in worker/recgov-scheduler.ts), and one
 * campground-month at 15s costs 4 req/min — so 4 pairs saturate a machine and a
 * 5th degrades everyone's refresh below the promised 15s. `/api/health/status`
 * compares live demand against machines × this and says when to clone a machine
 * (raise SHARD_COUNT in worker/fly.toml + `flyctl machine clone`) BEFORE detection
 * falls behind, which is the whole "never trail demand" policy.
 */
export const RECGOV_MONTHS_PER_MACHINE = 4;

/**
 * Free campground-months below which the capacity gauge warns — an ABSOLUTE reserve,
 * deliberately not a percentage.
 *
 * The old rule warned only at `demand === capacity`, i.e. the first signal was "the next
 * watch degrades everyone" with zero lead time to clone a machine. The obvious fix is a
 * percentage, and it is the wrong shape: a percentage measures the wrong quantity. The
 * question this gauge answers is not "what fraction is used" but "are there enough free
 * slots left to notice and act before demand lands", and that is a COUNT.
 *
 * The two behave very differently as the fleet grows. At 75%:
 *   2 machines (capacity 8)  → warns with 2 free. Too late; a single 2-month watch on a
 *                              new campground eats the whole margin.
 *   10 machines (capacity 40) → warns with 10 free. Absurdly early — that is two and a
 *                              half machines of runway, and it would sit amber for weeks.
 * A fixed reserve warns at the same real headroom either way.
 *
 * 4 = one machine's worth. "Fewer than one machine of headroom left" is the moment to
 * clone, because cloning is what fixes it and a human has to do it.
 *
 * THIS DOES NOT PROTECT AGAINST A DEMAND SPIKE, and it must not be read as though it
 * does. Twenty users adding two 2-month watches each is ~80 campground-months arriving in
 * an afternoon against a capacity of 8 — no warning threshold survives that, because the
 * gap between warning and saturation is a human being awake. Only autoscaling does.
 */
export const RECGOV_CAPACITY_RESERVE = 4;

/* ------------------------------------------------------------ SMS delivery */

/** Carrier outcomes for SMS over a window — see migration 038 for each bucket. */
export type SmsDelivery = {
  delivered: number;
  dropped: number;
  pending: number;
  untracked: number;
};

/**
 * Below this many carrier-ANSWERED messages, a rate is noise: one undelivered text out
 * of three is 33% and means nothing. Same lesson as the canary thresholds above — a
 * dashboard that cries wolf trains its only reader to ignore it.
 */
export const SMS_MIN_SAMPLE = 10;
/** A few percent of drops is ordinary carrier behaviour on any A2P route. */
export const SMS_DROP_WARN = 0.03;
/** Past this it is us, not the carriers: a filtered campaign, a bad sender id, a
 *  number pool that lost its registration. */
export const SMS_DROP_FAIL = 0.1;

/**
 * "Are the texts arriving?" — which is NOT what the SMS canary answers. The canary
 * proves Twilio ACCEPTS a message from us; delivery is a different system failing in a
 * different way, and the gap between the two is where a real alert went missing on
 * 2026-08-05 (email and push arrived, the text did not, every row said `sent`).
 *
 * Two distinct failures. The obvious one is a high drop rate. The quiet one is receipts
 * never coming back AT ALL: if the StatusCallback URL is wrong, or the signature check
 * is rejecting Twilio, every message sits `pending` forever and a naive rate over
 * `delivered / answered` would divide by zero and report perfect health while measuring
 * nothing. Hence the first branch — a pile of pending with no answers among them is a
 * broken pipe, not patience.
 */
export function smsLevel(d: SmsDelivery): 'ok' | 'warn' | 'fail' {
  const answered = d.delivered + d.dropped;
  if (answered === 0) return d.pending >= SMS_MIN_SAMPLE ? 'warn' : 'ok';
  if (answered < SMS_MIN_SAMPLE) return 'ok';
  const rate = d.dropped / answered;
  if (rate >= SMS_DROP_FAIL) return 'fail';
  if (rate >= SMS_DROP_WARN) return 'warn';
  return 'ok';
}

export const DELIVERY_STALE_SECONDS = DELIVERY_STALE_MS / 1000;
export const DETECT_STALE_SECONDS = DETECT_STALE_MS / 1000;
export const DELIVERY_DEAD_SECONDS = DELIVERY_DEAD_MS / 1000;
export const DETECT_DEAD_SECONDS = DETECT_DEAD_MS / 1000;

/**
 * How long the RC session verdict may go unrefreshed before it stops meaning anything.
 *
 * `rc-keepwarm.mjs` reports every ~20 minutes, so 45 is two missed passes plus slack —
 * long enough that a slow pass or a reboot is not an alarm, short enough that a wedged
 * keep-warm is caught inside one hold's lead time.
 *
 * MOVED HERE 2026-08-10 from a private const in the health route, for the reason stated
 * at the top of this file: it now has three readers (the health check, the alarm gate and
 * the readout) and a threshold with three copies is a threshold that will disagree.
 */
export const RC_SESSION_STALE_MS = 45 * 60 * 1000;

/** Why the RC session cannot be relied on for an upcoming hold — or null if it can. */
export type RcSessionFault = 'dead' | 'stale' | 'never-reported';

/**
 * Can we count on the bot's RC session right now?
 *
 * THE DISTINCTION THIS EXISTS TO MAKE (2026-08-10). A verdict of `ok` recorded ten hours
 * ago is not an `ok` — the keep-warm that produced it had been wedged since, holding the
 * Chromium profile and reporting nothing, so the 08:00 cart failed with the health check
 * showing amber and the phone silent. `holdAtRisk` only ever fired on a session reported
 * DEAD, and a stale verdict is not a dead one.
 *
 * It is the same rule this codebase already applies to `hasAvailabilityInRange` returning
 * null and to `untracked` SMS rows: the absence of an answer is not a good answer. It had
 * simply been applied to the VERDICT and never to its AGE.
 *
 * `stale` is treated as WORSE than `dead` for alarm timing, not better — see the gate in
 * the hold feed. A dead session has a repair coming (`maybeAutoLogin` at T-15); a stale
 * one means the process that would run that repair is not running.
 */
export function rcSessionFault(ok: boolean | null, ageMs: number | null): RcSessionFault | null {
  if (ok == null || ageMs == null) return 'never-reported';
  if (ageMs > RC_SESSION_STALE_MS) return 'stale';
  return ok ? null : 'dead';
}
