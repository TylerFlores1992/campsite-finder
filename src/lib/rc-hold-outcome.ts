/**
 * WHY DID THIS HOLD NOT CART — DID THE SITE NEVER OPEN, OR DID SOMEBODY ELSE GET IT?
 *
 * ## The question that could not be answered on 2026-09-03
 *
 * `#L005` at Leo Carrillo was tapped for the 08:00 PT release and refused ~100 times with
 * *"The unit is not available for the date(s) specified."* Two completely different stories
 * produce that identical record:
 *
 *   (a) the lock holder completed their booking, so the site never returned to the market;
 *   (b) the site returned at 08:00:0x and a human refreshing the page carted it first.
 *
 * **RC gives the same answer to both** — and worse, it gives the same answer to a cart fired
 * too EARLY (measured 2026-08-08, a cart 85 seconds ahead of the release). One message, three
 * meanings, and nothing in the readout could separate them. Every conclusion drawn about that
 * morning was therefore a guess wearing evidence's clothes.
 *
 * ## The evidence already existed — it was just never joined up
 *
 * No probe is needed and nothing on the 08:00 hot path changes. The poller stamps
 * `watch_site_alerts.last_seen_open_at` on EVERY 15-second cycle a site is open, and
 * `last_alert_at` when it announces the transition. That is a per-site, per-cycle record of
 * exactly the fact in question, and it is how `rc-542::42527` was found to have opened at
 * 08:00:13 that morning and be gone by the next cycle.
 *
 * So: if the poller saw the unit open and we did not cart it, **we were beaten**. That is a
 * finding, and it is one this project has never once been able to state.
 *
 * ## THE 15-SECOND FLOOR IS THE WHOLE CAVEAT, AND IT MUST BE SAID OUT LOUD
 *
 * The poller samples every 15 seconds. A site that opens and is taken inside one cycle is
 * INVISIBLE to it. So "the poller never saw it open" does NOT mean "it never opened" — it
 * means "not open at any sample we took", which is a weaker claim and the honest one.
 * Rounding it up to "it never opened" would be the absent-reading-as-a-negative failure this
 * codebase records more often than any other, committed by the very function built to stop
 * somebody committing it by hand.
 */

/** Both shapes a site key takes: bare for a single-campground watch, namespaced for a park. */
export function siteKeyMatchesUnit(siteKey: string, unitId: string): boolean {
  if (!siteKey || !unitId) return false;
  // The namespace is `<campgroundId>::<siteKey>` and is written ONLY for a multi-campground
  // watch, so both must match or a park watch's sightings are silently invisible here.
  const bare = siteKey.includes('::') ? siteKey.slice(siteKey.indexOf('::') + 2) : siteKey;
  return bare === unitId;
}

export interface HoldOutcomeInput {
  /**
   * Did the USER ever tap the offer? Nothing below is a loss if they did not — we never
   * asked RC for the site, so there was no race to lose.
   *
   * THE STATUS IS THE WRONG AXIS AND THE FIRST REAL RUN PROVED IT (2026-09-03). This gated
   * on `status === 'offered'`, and an untapped offer does not stay `offered` — it ends
   * `expired`. So the very first run against production announced *"THE SITE DID OPEN and
   * we did not get it — a race we lost"* about `#L034`, an offer nobody had touched. A
   * function built to stop the readout claiming more than it knows, claiming more than it
   * knew, on its first outing. `requested_at` is the fact; the status vocabulary is not.
   */
  tapped: boolean;
  /** Did the bot get a cart entry? Taken from `carted_at`, not inferred from the status. */
  carted: boolean;
  /**
   * Seconds from the release to the poller's transition alert, or null if it never saw one.
   *
   * A NUMBER, COMPUTED BY THE CALLER IN SQL, and deliberately not a pair of timestamps.
   * `release_at` is zone-less Pacific TEXT — a bare `NOW()` against it is seven hours out,
   * which is a class of bug this repo has paid for in both languages. Every existing caller
   * already converts it with `AT TIME ZONE 'America/Los_Angeles'`; taking the delta keeps
   * this function free of timezone arithmetic entirely rather than adding a second copy of
   * `pacificWallClockToUtcMs` on the other side of the worker boundary.
   */
  openedAfterS: number | null;
  /** How many fast attempts the runner made, if it reported any. */
  attempts?: number | null;
}

export type HoldOutcome = { level: 'info' | 'warn'; text: string };

/**
 * @returns a reading, or null when the hold has nothing to explain (it carted and was claimed,
 *   or it was never tapped). Null rather than a cheerful line: the readout already says what
 *   a healthy hold did, and a second sentence agreeing with it is noise.
 */
export function rcHoldOutcomeReading(input: HoldOutcomeInput): HoldOutcome | null {
  const { tapped, carted, openedAfterS, attempts } = input;
  if (carted) return null;
  // Nobody tapped it. Not a fault and not a loss — there was no attempt to explain, and
  // saying otherwise invents a defeat out of somebody simply not being interested.
  if (!tapped) return null;

  const tried = attempts && attempts > 1 ? ` We made ${attempts} attempts.` : '';

  // A SIGHTING IS A NUMBER, AND 0 IS A REAL ONE. `openedAfterS != null`, never a truthiness
  // test: a site seen open in the same second as the release is the sharpest case there is,
  // and `if (openedAfterS)` would silently file it as "never opened".
  if (openedAfterS != null) {
    const when = `T+${openedAfterS}s`;
    return {
      level: 'warn',
      text: `THE SITE DID OPEN (${when}, seen by the poller) and we did not get it — somebody`
        + ` else carted it first.${tried} This is a race we lost, not a lock that never lapsed.`,
    };
  }

  // NO SIGHTING. Stated as what it is — the absence of a sample — never as proof.
  return {
    level: 'info',
    text: 'the poller never saw this unit open at any 15-second sample, so most likely the lock'
      + ` holder completed their booking.${tried} NOT proof: a site taken inside one 15s cycle`
      + ' leaves no trace here.',
  };
}
