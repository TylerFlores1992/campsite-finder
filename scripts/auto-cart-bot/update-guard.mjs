/**
 * "Is it safe to update the bot right now?"
 *
 * ── WHY THIS IS A SEPARATE, TESTED MODULE ───────────────────────────────────────────
 * The orchestration lives in PowerShell, which nothing here can test. The DECISION does
 * not have to: it is the part that can lose a campsite, so it lives in JavaScript where
 * `worker/update-guard.test.mts` can drive it. Same split as `worker/claim.ts` — the
 * consequential logic is extracted from the thing that cannot be exercised.
 *
 * ── WHAT IT IS PROTECTING AGAINST ───────────────────────────────────────────────────
 * `update.bat` force-kills every node process, which closes the Chromium the RC access
 * token lives in — measured 2026-08-10, a sign-in at 16:15 was gone by 16:23. An
 * unattended update is therefore a way to destroy the session, and a scheduled one is a
 * way to destroy it AT THE SAME TIME EVERY DAY. Two independent guards:
 *
 *   1. A QUIET WINDOW. Updates only in the small hours, so even a botched one has hours
 *      of daylight before an 08:00 release. **An explicit request lifts this one** — a
 *      person asking for an update now has decided the staleness matters more than the
 *      timing, and a schedule can only ever express an average.
 *   2. A LEAD CHECK against the real next release. The window alone is not enough: RC
 *      releases at 08:00 Pacific and a hold requested at 02:30 is inside the window and
 *      six hours from being carted.
 *
 * The RELEASE CHECK IS NOT LIFTABLE, by anything short of `--force` at a keyboard. An
 * update requested by hand is still an update that ends the RC session, and doing it
 * twenty minutes before a cart would lose the site the whole system exists to catch.
 *
 * ── AND WHY IT REFUSES WHEN IT CANNOT TELL ──────────────────────────────────────────
 * A feed that will not answer means we do not know whether a hold is due. The rule this
 * codebase keeps arriving at — unknown is not healthy — applies with particular force to
 * an action whose failure mode is "the session is gone and nobody finds out until 08:00".
 * Skipping an update costs a day of staleness; taking one blind can cost a campsite.
 */

/** Local hour in Pacific, whatever the box's own clock is set to. */
export function pacificHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number(h) % 24;
}

/**
 * Hours until a zone-less Pacific wall-clock release string, or null if there is none.
 *
 * Both sides are put into Pacific wall-clock and compared as UTC, so the offset cancels —
 * the same discipline as the hold runner's `msUntilRelease`. NEVER `new Date(releaseAt)`:
 * a string with no zone is read as the machine's local time, and this decision would then
 * be wrong by the offset on any box not set to Pacific.
 */
export function hoursUntilRelease(releaseAt, now = new Date()) {
  if (!releaseAt) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const hh = parts.hour === '24' ? '00' : parts.hour;
  const nowPacific = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}Z`);
  const rel = Date.parse(`${releaseAt.slice(0, 19)}Z`);
  if (!Number.isFinite(rel) || !Number.isFinite(nowPacific)) return null;
  return (rel - nowPacific) / 3_600_000;
}

export const DEFAULTS = {
  /** Update only between these Pacific hours. 02:00–05:00: after the late crowd, well
   *  before any 08:00 release, and inside the window a human is least likely to be
   *  mid-anything on the box. */
  windowStart: 2,
  windowEnd: 5,
  /** Never update within this many hours of a real release. Six covers a 02:00 update
   *  against an 08:00 release with the whole quiet window to spare. */
  minHoursToRelease: 6,
};

/**
 * @param {{ now?: Date, nextRelease?: string|null, feedReachable?: boolean,
 *           windowStart?: number, windowEnd?: number, minHoursToRelease?: number,
 *           requested?: boolean, force?: boolean }} opts
 * @returns {{ ok: boolean, reason: string }}
 */
export function safeToUpdate(opts = {}) {
  const {
    now = new Date(),
    nextRelease = null,
    feedReachable = true,
    windowStart = DEFAULTS.windowStart,
    windowEnd = DEFAULTS.windowEnd,
    minHoursToRelease = DEFAULTS.minHoursToRelease,
    requested = false,
    force = false,
  } = opts;

  // A human at the keyboard has context this cannot have. `update.bat` stays the manual
  // path and is unaffected; this only gates the UNATTENDED one.
  if (force) return { ok: true, reason: 'forced by hand' };

  if (!feedReachable) {
    return { ok: false, reason: 'cannot reach CampHawk — refusing to update blind, a hold may be due' };
  }

  // An explicit "update now" replaces the schedule, not the safety check below it.
  const hour = pacificHour(now);
  if (!requested && (hour < windowStart || hour >= windowEnd)) {
    return { ok: false, reason: `outside the quiet window (${hour}:00 PT, allowed ${windowStart}:00-${windowEnd}:00)` };
  }

  const hrs = hoursUntilRelease(nextRelease, now);
  if (hrs != null && hrs >= 0 && hrs < minHoursToRelease) {
    return { ok: false, reason: `a hold releases in ${hrs.toFixed(1)}h — too close to take the session down` };
  }

  const why = requested ? 'requested' : 'quiet window';
  return { ok: true, reason: hrs == null ? `${why}, no hold queued` : `${why}, next release ${hrs.toFixed(1)}h away` };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────
// `node update-guard.mjs` → exit 0 to proceed, 1 to skip. Called by auto-update.ps1,
// which has no way to reason about any of the above.
if (process.argv[1] && process.argv[1].endsWith('update-guard.mjs')) {
  // THE .env, OR THIS CAN ONLY EVER REFUSE. The token lives in
  // scripts/auto-cart-bot/.env, not in the machine environment. The scheduled task runs
  // this script with no parent to inherit from, so without loadEnv the feed answers 401,
  // `feedReachable` stays false, and the guard skips EVERY run with "refusing to update
  // blind" - correct behaviour for an unknown, reached for the wrong reason, and
  // indistinguishable in the log from a genuine outage.
  //
  // load-env.mjs's own header records this exact bug hitting rc-hold-runner.mjs on
  // 2026-08-07: "answered `feed 401`, which reads exactly like a wrong token". This was
  // the only bot script still missing the call.
  const { loadEnv } = await import('./load-env.mjs');
  loadEnv(import.meta.url);
  const force = process.argv.includes('--force');
  const url = process.env.CAMPHAWK_URL || 'https://camphawk.app';
  const token = process.env.AUTOCART_TOKEN || '';
  let nextRelease = null;
  let requested = false;
  let feedReachable = false;
  try {
    const r = await fetch(`${url}/api/auto-cart/rc-holds?leadSeconds=0`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const j = await r.json();
      nextRelease = j?.nextRelease ?? null;
      requested = j?.updateRequested === true;
      feedReachable = true;
    }
  } catch { /* feedReachable stays false — see safeToUpdate */ }

  const verdict = safeToUpdate({ nextRelease, feedReachable, requested, force });
  console.log(`[update-guard] ${verdict.ok ? 'PROCEED' : 'SKIP'} — ${verdict.reason}`);
  process.exit(verdict.ok ? 0 : 1);
}
