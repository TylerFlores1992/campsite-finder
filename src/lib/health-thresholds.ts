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

/**
 * How stale a login rehearsal may get before it stops being evidence.
 *
 * Two missed nights. ONE can be a legitimate skip — a hold was within six hours, or the
 * session happened to be live at 20:00, and both of those are the rehearsal correctly
 * declining to prove nothing. Two in a row means nothing has exercised the sign-in since
 * before the last hold, which is exactly the state this whole mechanism exists to surface.
 */
export const REHEARSAL_STALE_MS = 48 * 60 * 60 * 1000;

export type RehearsalFault = 'never' | 'failed' | 'stale';

/**
 * "Has the RC sign-in been proved to work recently?" — null when it has.
 *
 * WHY THERE IS A CHECK FOR THIS AT ALL. Three consecutive 08:00 holds failed and all three
 * failed AT LOGIN, each discovered at 07:30 with twenty minutes to act. The login was
 * testable at any hour the whole time; nothing was scheduled to test it. See migration 054
 * and scripts/auto-cart-bot/rehearsal.mjs.
 *
 * `ok: null` IS NOT HEALTHY. It means the night was skipped, or nothing has ever run —
 * the same rule as a null availability read and an `untracked` SMS row. A run of quiet
 * skips must not read as a run of green nights, which is precisely what a naive
 * "no failure recorded" check would report.
 */
export function rehearsalFault(
  row: { ran_at?: string | null; ok?: boolean | null } | null | undefined,
  ageMs: number | null,
): RehearsalFault | null {
  if (!row?.ran_at) return 'never';
  if (row.ok === false) return 'failed';
  if (row.ok !== true) return 'stale';
  if (ageMs == null || ageMs > REHEARSAL_STALE_MS) return 'stale';
  return null;
}

/**
 * How long the RC hold runner may go without polling before it counts as absent.
 *
 * It polls every ~20s (RC_HOLD_POLL_MS), so three minutes is nine missed polls —
 * comfortably past a transient network blip, and still well inside the ~21-minute window a
 * hold is reachable in, so a stale beat is actionable BEFORE the release is lost rather
 * than a post-mortem.
 *
 * Shared with `rcBotUsable`, which decides whether to OFFER a hold at all. The admin page
 * judging the runner absent while the poller cheerfully offers to hold a site is exactly
 * the disagreement this file exists to prevent.
 */
export const RC_RUNNER_STALE_MS = 3 * 60 * 1000;

/**
 * How close a release has to be before a DEAD RC session counts as a failure.
 *
 * The access token lives about an hour, so the session is legitimately dead for most of the
 * day and `maybeAutoLogin` signs in at T-30 without anyone's help. A dead session thirteen
 * hours before a release is therefore the system working, not a fault — and failing on it
 * meant every night between tapping a hold and its morning was spent red, notifying every
 * two hours, over nothing.
 *
 * Matched to `AUTOCART_ALARM_LEAD_MIN`: the point at which the phone alarm decides a human
 * is the fallback is exactly the point at which this stops being routine. The alarm gate
 * learned this on 2026-08-09 after ringing twice about a session that carted a site fifteen
 * minutes later; the health check kept the naive version for two more days.
 *
 * A STALE verdict is NOT covered by this and still fails on any hold ahead — see the check.
 * Dead means the repair is pending; stale means the thing that would repair it is absent.
 */
export const RC_SESSION_CRITICAL_MIN = Number(process.env.AUTOCART_ALARM_LEAD_MIN || 45);

/**
 * WHEN HAS THE AUTO-LOGIN ACTUALLY HAD ITS TURN?
 *
 * `RC_SESSION_CRITICAL_MIN` (45) is when a dead session starts to MATTER. It is not when
 * the repair is spent, and using it for both is a bug that shipped and was caught live on
 * 2026-08-12: at T-34 the check read `fail` and said "the auto-login has had its turn —
 * run mini-pc\rc-login.bat", while `maybeAutoLogin` had not run at all. It then ran at
 * ~T-31 and signed in unattended. Had anyone followed that instruction they would have
 * gone to the box over a session that repaired itself four minutes later.
 *
 * That is the 2026-08-09 cry-wolf, arriving at the detail line a second time. The comment
 * directly above the message in the health route already explains why not to do this; the
 * severity beneath it did it anyway, because the two thresholds were the same constant.
 *
 * The repair runs at `RC_AUTOLOGIN_LEAD_MIN` (30), so it is spent only INSIDE that. This is
 * the same number and the same env var the phone alarm already gates on — the alarm learned
 * it on 08-09 and the health check kept the naive version. One definition now, read by
 * both, so they cannot drift apart again and disagree about whether a repair is pending.
 *
 * Five minutes of grace inside the lead, exactly as `ALARM_AFTER_MIN` reasons: enough for
 * the login to be attempted and reported before we call it failed. **It must move with
 * `RC_AUTOLOGIN_LEAD_MIN`** — `worker/autologin-lead.test.mts` holds that inequality.
 *
 * A REPORTED FAILURE OUTRANKS THE CLOCK. If the keep-warm says the sign-in was attempted
 * and refused, the turn is spent whatever the distance — same as the alarm's `loginFailed`
 * branch. Waiting out a window for a repair that has already failed is pure delay.
 */
export const RC_SESSION_REPAIR_SPENT_MIN = Number(process.env.AUTOCART_ALARM_AFTER_MIN || 25);

/**
 * How long before a release `maybeAutoLogin` signs in — the WEB SIDE's copy of a number
 * that lives on the mini-PC (`RC_AUTOLOGIN_LEAD_MIN` in `scripts/auto-cart-bot/
 * rc-keepwarm.mjs`).
 *
 * It is a copy because the two halves deploy by different routes and cannot import from
 * each other — which is exactly why it is dangerous, and exactly why
 * `worker/autologin-lead.test.mts` pins every copy together. It was a bare `30` written
 * into a message string here, i.e. the same fact with nothing keeping it honest; if the box
 * ever moves its lead, that sentence would confidently state the old number to whoever is
 * deciding whether to drive to the machine.
 */
export const RC_AUTOLOGIN_LEAD_MIN = Number(process.env.RC_AUTOLOGIN_LEAD_MIN || 30);

// ── Is the mini-PC running the code master has? (migration 056) ───────────────────────
/**
 * `autocart.rc_runner` proves the box can reach camphawk.app; `autocart.rc_session` proves
 * RC accepts its token. Neither says whether the CHECKOUT is current, and the halves of
 * this system deploy by different routes — Vercel auto-deploys on a push to master, the box
 * waits for a quiet window or a human. Drift is therefore the normal state for part of
 * every day, which is exactly why the severity has to be thought about rather than assumed.
 *
 * THE EXPENSIVE CASE IS NOT "DIFFERENT SHAS", IT IS "THE BOX IS MISSING BOT-SIDE CODE".
 * 2026-08-11: `AUTOCART_ALARM_AFTER_MIN` reached Vercel instantly while
 * `RC_AUTOLOGIN_LEAD_MIN` needed a human-run `update.bat`, and in the gap the alarm fires
 * at T-25 while the login still waits for T-15 — the 2026-08-09 cry-wolf bug exactly.
 *
 * Master is linear, so a box whose HEAD commit is OLDER than the last commit touching
 * `scripts/auto-cart-bot/` is missing bot-side code. That comparison needs no git ancestry
 * on the server, which is the only reason this is computable at all from Vercel.
 *
 * WHY FAIL IS GATED ON A QUEUED HOLD. A box a few commits behind with nothing due is the
 * ordinary state between an update and the next quiet window; failing on it would be red
 * most mornings, which is the cry-wolf failure this file has already had to fix twice
 * (`autocart.rc_session` on any hold ahead, and the alarm gate firing before the repair).
 * Missing bot-side code WITH a hold queued is different: that is the configuration where
 * the two halves can disagree at 08:00.
 */
export type BotVersionState = 'current' | 'unknown' | 'behind' | 'behind-bot-code';

export type BotVersionVerdict = {
  level: 'ok' | 'warn' | 'fail';
  state: BotVersionState;
  detail: string;
};

/** Whole days, floored, for a human-readable gap. */
function agoDays(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function botVersionVerdict(o: {
  boxSha: string | null;
  boxCommitAt: string | null;
  deploySha: string | null;
  deployCommitAt: string | null;
  botCodeAt: string | null;
  holdsAhead: number;
}): BotVersionVerdict {
  const short = (s: string | null) => (s ? s.slice(0, 7) : '?');

  // UNKNOWN IS A WARN, NEVER AN OK. A runner too old to send the header, a box with no git,
  // or a build that could not read its own sha all land here — and "we cannot tell" is
  // itself a drift signal, since the first thing that fixes it is an update. Same rule as
  // `untracked` SMS rows and a null availability reading.
  if (!o.boxSha) {
    return {
      level: 'warn', state: 'unknown',
      detail: 'the mini-PC has not reported a commit — it is running code from before this ' +
        'check existed, or git is unavailable there',
    };
  }
  if (!o.deploySha) {
    return {
      level: 'warn', state: 'unknown',
      detail: `mini-PC is on ${short(o.boxSha)}, but this deploy does not know its own ` +
        'commit, so they cannot be compared',
    };
  }
  if (o.boxSha === o.deploySha) {
    return { level: 'ok', state: 'current', detail: `mini-PC and web are both on ${short(o.boxSha)}` };
  }

  const gap = o.boxCommitAt && o.deployCommitAt ? agoDays(o.boxCommitAt, o.deployCommitAt) : null;
  const behindBy = gap == null ? '' : gap > 0 ? `, ${gap}d behind` : '';
  const base = `mini-PC is on ${short(o.boxSha)}${behindBy}; web is on ${short(o.deploySha)}`;

  // The one that matters. Strictly older than the last bot-side change means the box does
  // not have it — and `<` rather than `<=` because the box being ON that commit is current
  // for our purposes.
  const missesBotCode =
    !!o.botCodeAt && !!o.boxCommitAt && Date.parse(o.boxCommitAt) < Date.parse(o.botCodeAt);

  if (missesBotCode) {
    return {
      level: o.holdsAhead > 0 ? 'fail' : 'warn',
      state: 'behind-bot-code',
      // THIS SENTENCE USED TO ASSERT A CAUSE THE CHECK CANNOT KNOW (2026-08-15).
      //
      // It read "Nothing is queued, so this is the ordinary wait for a quiet window." — and
      // that is only one of the two ways a box reports an old commit. `boxSha` comes from
      // `git rev-parse HEAD` computed ONCE AT PROCESS START, so it describes the RUNNING
      // CODE, not the checkout. The two readings are:
      //
      //   the update has not been applied  -> the checkout is old too, and it self-heals on
      //                                       the next quiet window or update.bat;
      //   the update WAS applied and       -> the checkout is new, the process is old, and
      //   nothing restarted onto it           it NEVER self-heals: update-guard sees HEAD
      //                                       already at the target and has nothing to do.
      //
      // The second is what happened on 2026-08-15: update.bat moved the checkout to
      // `c1bd875`, `start-all` could not see the elevated generation still running (see
      // stop-all.ps1), and the box executed `e6a7ebf` for four hours while this line called
      // it an ordinary wait. So it describes both and names the discriminator — `git-status`
      // reads the checkout at the moment you ask, and disagreeing with the sha here IS the
      // second case. The LEVEL is deliberately unchanged; only the sentence a human reads
      // to decide whether to act.
      detail: `${base} — and it is MISSING bot-side changes` +
        (o.holdsAhead > 0
          ? `, with ${o.holdsAhead} hold(s) queued. The two halves can disagree at the release.`
          : '. Nothing is queued. This sha is the RUNNING code, read at process start: either ' +
            'the update has not been applied yet (it self-heals on the next quiet window), or ' +
            'it was applied and nothing restarted onto it (it never will). `git-status` on the ' +
            'box reads the checkout and tells you which.'),
    };
  }
  return {
    level: 'warn', state: 'behind',
    detail: `${base}. No bot-side code in the gap` +
      (o.botCodeAt ? '' : ' (though this build could not read when bot code last changed)') + '.',
  };
}
