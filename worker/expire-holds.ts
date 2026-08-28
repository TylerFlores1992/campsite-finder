// Close out RC holds whose moment came and went without a cart — and TELL THE USER.
//
// WHY THIS EXISTS (2026-08-07, the first real run of the day-before flow). A hold was
// offered at 05:26, tapped at 06:00, and the site released at 08:00 exactly as predicted.
// The mini-PC runner never picked it up. Six hours later the row still read `requested`
// with `updated_at` unchanged since the tap: no cart, no `failed`, no error, and — the
// part that matters — **no word to the user**, who had been told "you'll get a text when
// it's in the cart". A promise made and silently dropped is worse than never offering.
//
// THE CLEANUP CANNOT LIVE IN THE FEED. `expireStaleHolds` runs inside
// `GET /api/auto-cart/rc-holds`, which only executes when the runner polls — so when the
// runner is down, the sweep that would notice the runner is down does not run either. It
// is a watchdog wired to the thing it watches. This runs on the Fly worker instead,
// which is always up and has nothing to do with the mini-PC.
//
// THE GRACE MUST BE WIDER THAN THE FEED'S. `dueHolds` stops offering a hold
// `graceMinutes` (20) after its release, so anything past that is unreachable by the
// runner no matter what — it can never be carted later. Sweeping EARLIER than the feed
// gives up would mark a hold failed while the runner could still legitimately take it,
// and the user would get "we couldn't" followed by "we did". Wider is safe; narrower is
// a lie.

import { query, mutate } from '../src/lib/db/client';
import { notifyHoldMissed } from '../src/lib/rc-holds-notify';
import { rcBotUsable } from '../src/lib/rc-holds';
import { HOLD_LAPSE_MIN } from '../src/lib/limits';

/**
 * EVERY MINUTE. This was hourly, under a comment reading "nothing here is urgent — the
 * moment is already lost — and the value is telling the user, which is worth doing
 * reliably rather than instantly."
 *
 * **THE PREMISE WAS WRONG AND THE OWNER SAID SO (2026-08-17): "if we can't cart it the user
 * needs to know immediately, not an hour later."** The moment is NOT already lost.
 * ReserveCalifornia's cancelled sites routinely sit unbooked for a while after release —
 * that is the entire reason `hold_missed` carries the provider link and says "it may still
 * be free". The alert exists so the user can go and take the site themselves, and its value
 * decays by the minute.
 *
 * Measured cost of the old cadence: the 2026-08-17 miss released at 08:00:53 and was
 * reported at 09:19:04 — **79 minutes**, of which ~34 were purely waiting for the next
 * hourly tick. Worst case was 105 minutes.
 *
 * The sweep is one indexed UPDATE that normally returns zero rows, so a 60x cadence
 * increase costs essentially nothing. "Reliably rather than instantly" was a false choice.
 */
export const EXPIRE_HOLDS_INTERVAL_MS = Number(process.env.EXPIRE_HOLDS_INTERVAL_MS ?? 60 * 1000);

/**
 * Minutes past the release after which a `requested` hold is unreachable **while the runner
 * is alive and could still take it**. Must exceed the feed's `dueHolds` grace (20) — see the
 * header: sweeping earlier than the feed gives up would mark a hold failed while the runner
 * could legitimately still cart it, and the user would get "we couldn't" followed by "we
 * did". Wider is safe; narrower is a lie.
 */
export const HOLD_MISS_GRACE_MIN = Number(process.env.HOLD_MISS_GRACE_MIN ?? 45);

/**
 * The same question when NOTHING IS RUNNING, which is a different question.
 *
 * The 45-minute grace above is bought entirely by "the runner might still cart it". That
 * justification is CONDITIONAL, and we already hold the evidence: `rc_runner_heartbeat`.
 * When the runner has gone silent there is no retry to protect, so waiting protects nothing
 * and costs the user the site — which is exactly what happened on 2026-08-17, where the
 * runner had not polled for 2h32m and we still sat on the news for 79 minutes.
 *
 * **This is NOT "narrower is a lie" being overruled.** The rule says never claim we could
 * not hold it while we still might. With a stale heartbeat we demonstrably might not: the
 * runner is not asking for work. The window is only shortened in the branch where the
 * conservative reasoning does not apply, and a live runner keeps the full 45 minutes
 * unchanged.
 *
 * Deliberately not zero. A runner that is mid-restart can be a couple of minutes silent and
 * then cart normally, and `supervise.ps1` backs off up to 5 minutes between restarts. Five
 * minutes is long enough that a routine restart does not produce a retracted alert, and
 * short enough that the user still has the morning.
 */
export const HOLD_MISS_GRACE_NO_RUNNER_MIN = Number(process.env.HOLD_MISS_GRACE_NO_RUNNER_MIN ?? 5);

interface MissedHold {
  id: string;
  watch_id: string;
  user_id: string;
  campground_id: string;
  unit_id: string;
  unit_name: string | null;
  arrival_date: string;
  release_at: string;
}

/**
 * Mark every hold the runner missed as `failed`, and return them so the caller can
 * notify. Returns the rows it closed — normally none, which is the point.
 *
 * `onlyIds` narrows the blast radius for tests, the same device as
 * `expireFinishedWatches(onlyIds)`: drive the REAL predicate without failing every live
 * user's holds as a side effect of `npm test`. Production passes nothing.
 */
export async function failMissedHolds(
  onlyIds?: string[],
  /**
   * INJECTABLE, BECAUSE THE GRACE NOW DEPENDS ON A LIVE PRODUCTION FACT.
   *
   * The branch below reads `rc_runner_heartbeat`, which is the REAL mini-PC. That quietly
   * made this function's behaviour — and therefore every test of it — depend on whether the
   * owner's box happened to be up. It passed for four consecutive `npm run verify` runs and
   * then failed the moment the box went dark, on a fixture inside the 45-minute grace that
   * the 5-minute branch swept.
   *
   * A real-DB test may hit real rows; it must never depend on real WEATHER. Production
   * passes nothing and reads the heartbeat, exactly as before.
   */
  deps?: { runnerAbsent?: boolean },
): Promise<MissedHold[]> {
  // WHICH GRACE APPLIES IS A QUESTION ABOUT THE RUNNER, NOT ABOUT THE HOLD.
  //
  // Read once per sweep and applied to every row: the runner is a single process, so its
  // liveness cannot differ between two holds in the same pass. Reading it per row would
  // also let a heartbeat landing mid-sweep give two holds different answers.
  //
  // FAILS TOWARD THE LONG GRACE. `rcBotUsable` returns ok:false when it cannot read the
  // heartbeat AT ALL, and that is "we could not tell", not "the runner is dead" — the same
  // rule as `unknown` never rounding to `signed-out`. A DB blip must not shorten the window
  // and start declaring live holds missed, so an unreadable heartbeat keeps the full 45.
  const beat = deps?.runnerAbsent == null
    ? await rcBotUsable().catch(() => ({ ok: true, beatAgeMs: null }))
    : { ok: !deps.runnerAbsent, beatAgeMs: deps.runnerAbsent ? Number.MAX_SAFE_INTEGER : 0 };
  const runnerAbsent = beat.beatAgeMs != null && !beat.ok;
  const graceMin = runnerAbsent ? HOLD_MISS_GRACE_NO_RUNNER_MIN : HOLD_MISS_GRACE_MIN;
  if (runnerAbsent) {
    console.log(
      `[expire-holds] the runner has not polled for ${Math.round((beat.beatAgeMs ?? 0) / 1000)}s — ` +
      `nothing is going to cart, so a missed hold is reported after ${graceMin} min instead of ${HOLD_MISS_GRACE_MIN}.`,
    );
  }
  // `release_at` is RC's zone-less Pacific wall-clock string, so it is compared against
  // Pacific wall-clock rather than parsed — the same rule as `dueHolds`. Parsing it into
  // a Date here would shift the cutoff by the worker's UTC offset, i.e. seven hours, and
  // silently fail holds that are still perfectly live.
  return mutate<MissedHold>(
    `UPDATE rc_hold_requests
        SET status = 'failed',
            error = 'no cart at release time — the hold runner did not pick it up',
            updated_at = NOW()
      WHERE status = 'requested'
        AND release_at < to_char((NOW() - ($1 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
        AND ($2 IS NULL OR id = ANY($2))
      RETURNING id, watch_id, user_id, campground_id, unit_id, unit_name,
                arrival_date::text AS arrival_date, release_at`,
    [String(graceMin), onlyIds ?? null],
  ).catch((err) => {
    console.error('[expire-holds] sweep failed:', (err as Error).message);
    return [];
  });
}

/**
 * Note — never terminate — a `carted` hold that has sat too long without being released.
 *
 * WAS (until 2026-08-28): marked the row `expired`, on the premise that RC lapses an
 * unreleased cart on its own after roughly `HOLD_LAPSE_MIN` minutes — a number read off
 * RC's bundle as ~15, NEVER OBSERVED, multiplied up for safety.
 *
 * THAT PREMISE IS RETIRED. `--cart-lapse`'s sibling measurement (2026-08-25) found RC does
 * NOT drop an unclaimed cart on its own inside 45 minutes — a genuinely unclaimed hold sat
 * in the cart until OUR OWN `expireStaleHolds(45)` released it, HTTP 200. So a hold that
 * could not be released because the RC session was dead is not "probably gone by itself"
 * — it is most likely still locked, on a real campsite, with nobody able to book it.
 *
 * MARKING IT `expired` MADE THAT PERMANENT, AND SILENTLY. `expireStaleHolds`'s `toRelease`
 * query only ever selects `status = 'carted'`, so the moment this function flipped status
 * away from `carted`, the row left the runner's retry list FOR EVER. The old docstring
 * here said "cart_key is kept ... so a later healthy pass could still try" — nothing did.
 * The comment described an intention the code never implemented.
 *
 * SO THIS NO LONGER CHANGES STATUS. The row stays `carted`, which keeps it in
 * `expireStaleHolds`'s retry list on every poll: the runner will actually ask RC to let go
 * of it the next time the session is healthy, however long that takes. That costs nothing
 * extra — since 2026-08-13 every hold mints its OWN cart (`rc-hold-runner.mjs`), so a stuck
 * row occupies only its own cart, never a shared pool other holds are waiting on.
 *
 * `holdWindowLoad` (src/lib/rc-holds.ts) independently stops counting a hold this old
 * against `RC_HOLD_CAPACITY` for its own release, so a stuck row cannot make a genuinely
 * new offer for the SAME release read as full. That is a display/offer concern; this
 * function's only remaining job is the diagnostic note, so the readout can tell "still
 * trying, session's the problem" from "nothing has looked at this at all" — the same
 * distinction `noteAttempt` exists for.
 *
 * IDEMPOTENT, on purpose: a hold stuck for days would otherwise get the identical note
 * rewritten (and reported as newly "lapsed" in the sweep log) every 60 seconds forever.
 */
export async function reclaimLapsedHolds(): Promise<{ id: string; unit_name: string | null }[]> {
  return mutate<{ id: string; unit_name: string | null }>(
    `UPDATE rc_hold_requests
        SET last_attempt_at = NOW(),
            last_attempt_note =
              'carted over ' || $1 || ' min ago and still not released — the RC session is ' ||
              'probably the reason; the runner keeps retrying every pass, this is not a give-up'
      WHERE status = 'carted'
        AND carted_at < NOW() - ($1 || ' minutes')::interval
        AND (last_attempt_note IS NULL
             OR last_attempt_note NOT LIKE 'carted over % min ago and still not released%')
      RETURNING id, unit_name`,
    [String(HOLD_LAPSE_MIN)],
  ).catch((err) => {
    console.error('[expire-holds] lapse note failed:', (err as Error).message);
    return [];
  });
}

export async function sweepMissedHolds(): Promise<number> {
  const missed = await failMissedHolds();
  for (const h of missed) {
    console.error(
      `[expire-holds] MISSED: hold ${h.id} (${h.unit_name ?? h.unit_id}) released ${h.release_at} ` +
        `and was never carted — the mini-PC runner was not reachable.`,
    );
    await notifyHoldMissed(h).catch((e) => console.error('[expire-holds] notify failed:', e));
  }

  // DELIBERATELY SILENT to the user. A carted hold nobody came back for is the user's own
  // choice not to claim, and telling them hours later that the thing they ignored has gone
  // is noise. This is a note, not an outcome — the row stays `carted` and the runner keeps
  // trying to release it, so "freeing its seat" would overstate what just happened.
  const stuck = await reclaimLapsedHolds();
  for (const h of stuck) {
    console.log(
      `[expire-holds] STUCK: hold ${h.id} (${h.unit_name ?? 'a site'}) has been carted over ` +
        `${HOLD_LAPSE_MIN} min without being released — the runner will keep retrying.`,
    );
  }
  return missed.length;
}
