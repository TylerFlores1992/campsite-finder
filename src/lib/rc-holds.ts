// Opt-in holds for ReserveCalifornia's 8am releases — the state machine, in one place.
//
// Three callers touch these rows and they must not disagree about what a status means:
// the poller (offers), the /w/<token> action (requests), and the bot (carts, releases).
// See migration 043 for the lifecycle and why a row is created at ALERT time.
//
// The rule that matters most: **only `requested` authorises a cart.** An `offered` row is
// a question nobody answered, and carting one would be exactly the speculative
// inventory-grabbing this design exists to avoid.

import { query, mutate } from '@/lib/db/client';
import { RC_RUNNER_STALE_MS } from '@/lib/health-thresholds';
import { HOLD_LAPSE_MIN } from '@/lib/limits';

export type HoldStatus =
  | 'offered' | 'requested' | 'carted' | 'claiming' | 'released' | 'claimed' | 'expired' | 'failed';

export interface HoldRequest {
  id: string;
  watch_id: string;
  user_id: string;
  campground_id: string;
  unit_id: string;
  unit_name: string | null;
  arrival_date: string;
  nights: number;
  release_at: string;
  status: HoldStatus;
  claim_started_at: string | null;
  cart_key: string | null;
  cart_entry_key: string | null;
}

/**
 * Record that we told someone about an upcoming release.
 *
 * Idempotent per (watch, unit, arrival): a re-alert for the same opening updates the row
 * rather than stacking duplicates. It deliberately does NOT reset a status that has moved
 * on — if the user already tapped, a later alert must not walk them back to `offered` and
 * silently discard their answer.
 */
export async function offerHold(input: {
  watchId: string;
  userId: string;
  campgroundId: string;
  unitId: string;
  unitName: string | null;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
}): Promise<string | null> {
  try {
    const rows = await mutate<{ id: string }>(
      `INSERT INTO rc_hold_requests
         (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights, release_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (watch_id, unit_id, arrival_date) DO UPDATE
         SET release_at = EXCLUDED.release_at,
             unit_name  = COALESCE(EXCLUDED.unit_name, rc_hold_requests.unit_name),
             nights     = EXCLUDED.nights,
             updated_at = NOW()
         WHERE rc_hold_requests.status = 'offered'
       RETURNING id`,
      [
        input.watchId, input.userId, input.campgroundId, input.unitId,
        input.unitName, input.arrivalDate, String(input.nights), input.releaseAt,
      ],
    );
    // No row back means the conflict target existed with a status past `offered` — the
    // user has already answered. That is a success, not a failure.
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('[rc-holds] offerHold failed:', (err as Error).message);
    return null;
  }
}

/**
 * How many sites are already spoken for at this release — the capacity question.
 *
 * Counts every hold for the same release window that is still on its way to a cart or
 * already in one. `offered` COUNTS: the button is in an email we cannot retract, so it is
 * a promise whether or not anyone has tapped it yet. Terminal states (`released`,
 * `claimed`, `expired`, `failed`) do not — those seats are back.
 *
 * The triple is EXCLUDED rather than the count being taken raw, so this answers "is there
 * room for this one" and not "is the window busy". Without that, a re-alert for a hold
 * already offered would be judged against its own row and quietly lose its button.
 *
 * A `carted` ROW STUCK PAST `HOLD_LAPSE_MIN` DOES NOT COUNT EITHER, and it is the one
 * status excluded without being terminal. Since 2026-08-28 `reclaimLapsedHolds` no longer
 * marks these `expired` — it keeps retrying their release forever, because RC does not
 * appear to lapse a cart on its own (see that function's header). Counting them here
 * anyway would let a hold nobody can free up make a genuinely new offer for the SAME
 * release read as full, which is the one case this exclusion exists to prevent — the
 * capacity question is "is a seat REACHABLE", not "does a row still say carted".
 *
 * Not a lock. Two poller shards could both read `capacity - 1` and both offer; at a
 * handful of holds a day that is a fair trade against a transaction, and the failure is
 * one offer over, not a wrong cart.
 */
export async function holdWindowLoad(
  releaseAt: string,
  exclude?: { watchId: string; unitId: string; arrivalDate: string },
): Promise<number> {
  try {
    const [row] = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM rc_hold_requests
        WHERE release_at = $1
          AND status IN ('offered', 'requested', 'carted', 'claiming')
          AND NOT (status = 'carted' AND carted_at < NOW() - ($5 || ' minutes')::interval)
          AND NOT ($2 IS NOT NULL AND watch_id = $2 AND unit_id = $3 AND arrival_date = $4::date)`,
      // `watch_id`/`unit_id`/`release_at` are all TEXT (release_at is RC's zone-less
      // Pacific wall-clock, which is why it is never a timestamp). Only `arrival_date` is a
      // real date, and it is cast so a malformed one fails loudly here rather than matching
      // nothing and silently reporting an empty window as room to spare.
      [releaseAt, exclude?.watchId ?? null, exclude?.unitId ?? '', exclude?.arrivalDate ?? '1970-01-01', String(HOLD_LAPSE_MIN)],
    );
    return Number(row?.n ?? 0);
  } catch (err) {
    console.error('[rc-holds] holdWindowLoad failed:', (err as Error).message);
    // FAIL CLOSED, like `rcBotUsable`. If we cannot tell how full the window is, do not
    // offer — a hold nobody honours costs a campsite, a missing button costs a convenience.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * The user tapped "hold it for me".
 *
 * Matches the newest un-answered offer for this (watch, unit) whose release is still in
 * the future — a tap on last week's email must not queue a cart for an opening that has
 * been and gone. Returns the row so the confirmation page can name the site and time.
 */
export async function requestHold(watchId: string, unitId: string): Promise<HoldRequest | null> {
  try {
    const rows = await mutate<HoldRequest>(
      `UPDATE rc_hold_requests
          SET status = 'requested', requested_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM rc_hold_requests
           WHERE watch_id = $1 AND unit_id = $2
             AND status IN ('offered', 'requested')
             AND release_at > to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
           ORDER BY release_at ASC LIMIT 1
        )
        RETURNING *`,
      [watchId, unitId],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('[rc-holds] requestHold failed:', (err as Error).message);
    return null;
  }
}

/**
 * What the bot should cart right now.
 *
 * `release_at` is RC's own wall-clock string with no zone, so it is compared against
 * Pacific wall-clock rather than parsed into a Date — the same reasoning as
 * `formatStayDates`: turning "2026-08-08T08:00:00" into a Date and back shifts the hour
 * for anyone not on Pacific, and the bot runs wherever it runs.
 *
 * The window opens slightly BEFORE the release so the bot is already asking when the site
 * frees, rather than starting to think about it a second late.
 */
export async function dueHolds(leadSeconds = 60, graceMinutes = 20): Promise<HoldRequest[]> {
  try {
    return await query<HoldRequest>(
      // ONE LIVE HOLD PER (release_at, unit_id) — see `worker/hold-line.ts`. Two people can
      // each hold a correct offer for one campsite, simply by watching the same facility
      // (measured 2026-08-24, unit 43191). Serving both asks RC for the same unit twice.
      //
      // ── `DISTINCT ON` ALONE WAS NOT THE RULE IT LOOKED LIKE (fixed 2026-08-26) ──
      //
      // It de-dupes within ONE query, and the runner polls every 15 seconds. So on 08-26
      // the first contest to have two tapped holds served BOTH of them, fourteen seconds
      // apart, from the box's own log:
      //
      //     15:00:02  held #123 - entry ae877ae5-...
      //     15:00:13  0 to hand over, 1 to cart, 0 to release     <- the NEXT poll
      //     15:00:17  held #123 - entry 6f0863e0-...
      //
      // The instant rank 1 succeeded and left `requested`, rank 2 became the top
      // `requested` row for that unit and was served on the very next pass. **RC accepted
      // both** — two distinct cart entries for one physical campsite — so the failure this
      // comment used to anticipate ("RC refuses the other in its own wording") was replaced
      // by a worse one that looks like success: two cart slots spent, two users each told
      // their site is held, and the loser finding out at CHECKOUT.
      //
      // The `NOT EXISTS` makes the rule TEMPORAL rather than per-call: once any hold for
      // this (release_at, unit_id) has reached RC's cart, nobody else is served.
      //
      // WHY THOSE FOUR STATUSES. `carted` and `claiming` are the site sitting in a cart.
      // `released` and `claimed` are the hand-off — the winner is checking out right now,
      // and carting under them is the same double-book one step later. Deliberately NOT
      // `failed` or `expired`: a cart RC refused never took the site, and blocking on it
      // would deny a retry to somebody who could still get it. `requested` is excluded for
      // the same reason it always was — a hold whose attempt failed inside its window stays
      // `requested` (see `reportCartFailure`), and that retry must keep working.
      //
      // THIS IS NOT THE EXPIRY CASCADE. Nothing here re-serves rank 2 when rank 1 lapses;
      // by the time our own 45-minute sweep fires, `graceMinutes` has long closed the
      // window anyway. The cascade remains a deliberate non-feature.
      //
      // `line_rank` NULLS LAST, then `id`, so an unranked row (uncontested, or predating
      // migration 068) still resolves deterministically instead of alternating between
      // shards. A hold nobody tapped is not in this query at all, so the line only decides
      // anything when two people BOTH asked.
      `SELECT * FROM (
         SELECT DISTINCT ON (release_at, unit_id) *
           FROM rc_hold_requests r
          WHERE status = 'requested'
            AND release_at <= to_char((NOW() + ($1 || ' seconds')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
            AND release_at >= to_char((NOW() - ($2 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
            AND NOT EXISTS (
              SELECT 1 FROM rc_hold_requests spoken
               WHERE spoken.release_at = r.release_at
                 AND spoken.unit_id    = r.unit_id
                 AND spoken.status IN ('carted', 'claiming', 'released', 'claimed')
            )
          ORDER BY release_at, unit_id, line_rank ASC NULLS LAST, id
       ) q
        ORDER BY release_at ASC
        LIMIT 25`,
      [String(leadSeconds), String(graceMinutes)],
    );
  } catch (err) {
    console.error('[rc-holds] dueHolds failed:', (err as Error).message);
    return [];
  }
}

/**
 * "Something tried to act on this hold and could not" — recorded WITHOUT moving status.
 *
 * WHY NOT `failed`. A skipped pass must retry: the profile lock frees, keep-warm renews
 * the session, the next pass works. Marking these failed would close a hold that is still
 * perfectly live, and would fire the missed-hold alert for a hold nothing has given up on.
 *
 * WHY RECORD IT AT ALL. Because the absence of this is what made 2026-08-07 undiagnosable.
 * The row sat at `requested` with `updated_at` frozen at the tap, which is *identical* to
 * "no process ever looked at it" — and the runner heartbeat was green, because the runner
 * was polling the feed fine and failing only when it tried to open Chromium. Status
 * answers "what happened to my hold"; this answers "is anything even trying", and neither
 * can be derived from the other.
 *
 * Deliberately does NOT touch `updated_at`: that column means "the hold changed", and a
 * failed attempt is not a change to the hold. Conflating them would make the readout's
 * "unchanged since the tap" tell — the one signal that exposed the outage — useless.
 */
export async function noteAttempt(ids: string[], note: string): Promise<void> {
  if (!ids.length) return;
  await mutate(
    `UPDATE rc_hold_requests SET last_attempt_at = NOW(), last_attempt_note = $2
      WHERE id = ANY($1::text[])`,
    [ids, note.slice(0, 300)],
  ).catch((e) => console.error('[rc-holds] noteAttempt failed:', e.message));
}

/**
 * ── A REAL RC UNIT ID IS NUMERIC, AND THAT IS HOW A TEST FIXTURE IS TOLD FROM A BOOKING ──
 *
 * MEASURED 2026-08-18, by causing it. `npm test` hits the production DB on purpose, and the
 * hold suites insert `requested`/`carted`/`claiming` rows with releases a minute or two out.
 * They are deleted on the way out and they cannot cart anything — since 2026-08-15 every
 * fixture carries a NON-NUMERIC sentinel unit id, enforced by `hold-fixture-safety.test.mts`,
 * exactly so the production runner cannot lock a stranger's campsite with one.
 *
 * **The sentinel protected the CART and nothing protected the LOGIN.** While a test run was
 * in flight the mini-PC's keep-warm read a real `nextRelease` one minute away and did what it
 * is built to do:
 *
 *     20:00:44  ⏰ hold releases in 1m and the session will not cover it — signing in
 *     20:00:49      → signed in, but the token will not cover the hold — dropping it to sign in fresh
 *     20:02:21  ✗ RC Chromium at 4037 MB (limit 1500) — RECYCLING the browser
 *
 * That is an unattended sign-in from the household address — the act that cost twelve hours
 * of IP block on 2026-08-06 and is rationed to two attempts per release for that reason — plus
 * a four-gigabyte Okta ramp that killed the browser mid-login. **Fired by CI, on every pull
 * request.** It also explains the profile churn in the same window (four `→ hold runner wants
 * the profile` in twenty minutes), which is the 2026-08-15 starvation signature recurring.
 *
 * `holdAtRisk` is the sharper half: it is the ALARM's trigger, so a fixture releasing in one
 * minute against a dead RC session **rings the owner's phone twice.**
 *
 * SO BOTH QUERIES NOW REQUIRE A NUMERIC UNIT ID. It reuses the safety property that already
 * exists rather than inventing a second marker to keep in step, and it is server-side, so it
 * reaches the box on a push with no bot update.
 *
 * NOT APPLIED TO `dueHolds`, DELIBERATELY. The hold suites exist to test `dueHolds`, so
 * filtering fixtures out of it would gut the tests that make this table safe at all. What
 * `dueHolds` costs is profile churn against a sentinel that cannot cart — bounded, understood,
 * and a separate decision from an unattended login and a phone call.
 */
const REAL_UNIT = `unit_id ~ '^[0-9]+$'`;

/**
 * The same rule as `REAL_UNIT`, in JavaScript, for the callers that filter a RESULT rather
 * than a query.
 *
 * ── WHY A SECOND FORM OF ONE RULE, AND WHY THAT IS SAFE HERE (2026-08-19) ──────────────────
 * The note above says `dueHolds` is deliberately unfiltered, because the hold suites exist to
 * test it, and that the cost is "profile churn against a sentinel that cannot cart — bounded,
 * understood". **The cost is bigger than that, and it was measured today.**
 *
 * The hold runner asks the keep-warm for the Chromium profile whenever the feed gives it work.
 * The keep-warm yields, closes its browser and reopens — and the live access token lives in
 * page memory (`window.__camphawkRcToken`), not in localStorage, so the reopen comes back
 * `token source: none`. On 2026-08-19 that destroyed a session which had sustained itself for
 * SEVEN HOURS since a hand sign-in:
 *
 *     13:33:52 ♻ token exp in 45m; renewed=no; src=live; okta=ALIVE
 *     13:49:07 → hold runner wants the profile — closing and standing down
 *     13:49:50 RC loaded and STAYING OPEN — token source: none
 *     13:50:38 ⚠ RC SESSION IS DEAD
 *
 * **And the work it wanted the profile for was a test fixture** — the runner's log names
 * `#L__t9003`, `#L__t9102` and `#L__t9007`, the non-numeric sentinels. The 13:49 pass falls
 * inside a CI run for a pull request that changed only Markdown. So `npm test` kills the
 * production RC session, and a run landing near 08:00 takes the session a cart depends on.
 *
 * ── THE FILTER GOES WHERE THE RUNNER IS SERVED, NOT IN THE QUERY ───────────────────────────
 * Adding `REAL_UNIT` to `dueHolds` would gut the suites that make this table safe, which is
 * exactly why the earlier fix stopped short of it. Filtering the FEED costs those suites
 * nothing — `dueHolds` keeps its full surface and they keep testing it — while the runner
 * simply never sees a fixture, so it never asks for the profile for one.
 *
 * It is also server-side, so it reaches the mini-PC on a push with no bot update. Same
 * reasoning that put `REAL_UNIT` in the two queries rather than in the runner.
 */
export function isRealUnitId(unitId: string | null | undefined): boolean {
  return typeof unitId === 'string' && /^[0-9]+$/.test(unitId);
}

/**
 * When the next hold releases, as RC's zone-less Pacific wall-clock — or null.
 *
 * The keep-warm needs this and nothing else. There is no session to keep warm (RC issues
 * no Okta session cookie; see rc-autologin.mjs), so the only way to hold a site at 08:00
 * unattended is to sign in shortly beforehand — and signing in is exactly the act that
 * got the household IP blocked when it was done repeatedly. Knowing the ONE moment it is
 * worth doing is what keeps this to a few times a month instead of hourly.
 *
 * `carted` and `claiming` count as well as `requested`: a hold we already hold still needs
 * a live session to be RELEASED to its owner, and losing the session between carting and
 * claiming would strand the site in the bot's cart.
 */
/**
 * HOW MANY HOLDS ARE AHEAD OF US — the ONE definition, carrying `REAL_UNIT`.
 *
 * ── WHY THIS EXISTS (2026-08-27) ──
 *
 * The 2026-08-18 fixture fix put `REAL_UNIT` into `nextHoldRelease` and `holdAtRisk`, so a
 * test fixture could no longer make the bot sign in or ring the owner's phone. It did not
 * reach `/api/health/status`, which carries **five** hand-rolled copies of the same
 * question and none of them filtered.
 *
 * The cost is not an untidy dashboard. `npm test` runs against the production database, so
 * CI on any pull request briefly inserts non-terminal holds — and on 2026-08-23 that turned
 * `autocart.rc_session` from warn to **fail** with the detail *"run mini-pc\rc-login.bat …
 * 4 hold(s) ahead"*. Ninety seconds later there were zero. **`rc-login.bat` force-kills the
 * Chromium the RC token lives in**, so the check printed a destructive remedy over a
 * session with nothing wrong with it — the 2026-08-16 cry-wolf reached by a new route, and
 * the check a 07:30 pre-flight Routine reads.
 *
 * A rule applied to one consumer and not to its siblings is how that happened, so this is
 * one function rather than a sixth predicate. `worker/health-hold-counts.test.mts` fails if
 * the route grows another inline count.
 *
 * FAILURE DIRECTION IS DELIBERATELY UNCHANGED — 0 on a read error, exactly as the inline
 * `queryOne` copies produced. These feed a DASHBOARD, and a health check that goes red on a
 * database blip is the cry-wolf failure this fix is about. `rcBotUsable` and
 * `holdWindowLoad` fail CLOSED because they gate an ACTION; this reports one.
 */
const HOLD_LIVE = `status IN ('requested','carted','claiming')`;
const NOW_PACIFIC = `to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;

/**
 * Live holds whose release is still ahead. `withinMinutes` bounds how far ahead — omit it
 * for "any hold at all still coming".
 *
 * A hold thirteen hours out is not evidence that anything is wrong: the token lives ~60
 * minutes, so the session is legitimately dead for most of the day and `maybeAutoLogin`
 * signs in at T−30. That is why the callers ask for a bounded count as well as a total.
 */
export async function holdsAhead(withinMinutes?: number): Promise<number> {
  const bound = withinMinutes == null ? '' :
    `AND release_at <= to_char((NOW() + ($1 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM rc_hold_requests
      WHERE ${HOLD_LIVE} AND ${REAL_UNIT}
        AND release_at >= ${NOW_PACIFIC} ${bound}`,
    withinMinutes == null ? [] : [String(withinMinutes)],
  ).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

/**
 * `requested` holds whose release is at most `minutes` away — INCLUDING ones already past,
 * which is the point: a hold the runner should have carted and has not is what this counts.
 */
export async function holdsDueWithin(minutes: number): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM rc_hold_requests
      WHERE status = 'requested' AND ${REAL_UNIT}
        AND release_at <= to_char((NOW() + ($1 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`,
    [String(minutes)],
  ).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

export async function nextHoldRelease(): Promise<string | null> {
  const [row] = await query<{ release_at: string }>(
    `SELECT release_at FROM rc_hold_requests
      WHERE status IN ('requested', 'carted', 'claiming')
        AND ${REAL_UNIT}
        AND release_at >= to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
      ORDER BY release_at ASC LIMIT 1`,
  ).catch(() => []);
  return row?.release_at ?? null;
}

/**
 * A hold that is about to release, with the phone of whoever loses it — or null.
 *
 * THIS IS THE ALARM'S TRIGGER, and the window is the whole design. A dead RC session at
 * two in the afternoon is a thing to fix today; a dead RC session forty minutes before a
 * site releases is a thing to fix NOW, and it is the only case that justifies ringing
 * somebody's phone. Same rule that makes `autocart.rc_session` fail only when a hold is
 * due — the check is not "is something broken", it is "is something about to be lost".
 *
 * The window is wider than the auto-login's 15-minute lead on purpose: the auto-login
 * reports its failure at T-15, and a person needs longer than that to wake up, find a
 * laptop and sign in by hand.
 */
export async function holdAtRisk(withinMinutes: number): Promise<
  { hold: HoldRequest; phone: string | null; campground: string | null; minutesAway: number } | null
> {
  const [row] = await query<HoldRequest & { phone: string | null; campground: string | null; minutes_away: number }>(
    // Pacific wall-clock on both sides, so the offset cancels and no zone-less string is
    // ever handed to a Date. Same discipline as the runner's msUntilRelease.
    // `minutes_away` is computed HERE, in Pacific, because `release_at` is a zone-less
    // wall-clock string and parsing one in JS reads it as the server's local time — the
    // trap that made an alert say "Sep 3" for a Sep 4 stay.
    `SELECT h.*, u.phone, c.name AS campground,
            EXTRACT(EPOCH FROM (h.release_at::timestamp
              - (NOW() AT TIME ZONE 'America/Los_Angeles'))) / 60 AS minutes_away
       FROM rc_hold_requests h
       JOIN users u ON u.id = h.user_id
       LEFT JOIN campgrounds c ON c.id = h.campground_id
      WHERE h.status IN ('requested', 'carted', 'claiming')
        AND h.${REAL_UNIT}
        AND h.release_at >= to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
        AND h.release_at <= to_char((NOW() + ($1 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
      ORDER BY h.release_at ASC LIMIT 1`,
    [String(withinMinutes)],
  ).catch(() => []);
  if (!row) return null;
  const { phone, campground, minutes_away, ...hold } = row;
  return { hold, phone, campground, minutesAway: Number(minutes_away) };
}

/**
 * The user pressed claim. Ask the bot to let go of THIS entry.
 *
 * Only a `carted` hold can be claimed — there is nothing to hand over otherwise — and
 * re-pressing while already `claiming` or `released` is a no-op rather than an error,
 * because a double-tap on a phone is normal and must not look like a failure.
 */
export async function startClaim(id: string): Promise<HoldRequest | null> {
  try {
    const rows = await mutate<HoldRequest>(
      `UPDATE rc_hold_requests
          SET status = 'claiming', claim_started_at = COALESCE(claim_started_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status IN ('carted', 'claiming')
        RETURNING *`,
      [id],
    );
    if (rows[0]) return rows[0];
    // Already released, or never carted. Hand the row back so the caller can tell the
    // user WHICH — "already let go, go book it" and "nothing is held" are different.
    const [existing] = await query<HoldRequest>(`SELECT * FROM rc_hold_requests WHERE id = $1`, [id]);
    return existing ?? null;
  } catch (err) {
    console.error('[rc-holds] startClaim failed:', (err as Error).message);
    return null;
  }
}

/** The bot has let go. The exposure window starts HERE. */
export async function markReleased(id: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'released', released_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('claiming','carted')`,
    [id],
  ).catch((e) => console.error('[rc-holds] markReleased failed:', e.message));
}

/** Claims waiting on the bot. Separate from the stale-release sweep because these are
 *  URGENT — somebody is watching a spinner — while a stale release is merely overdue. */
export async function pendingClaims(): Promise<HoldRequest[]> {
  return query<HoldRequest>(
    `SELECT * FROM rc_hold_requests WHERE status = 'claiming' ORDER BY claim_started_at ASC LIMIT 25`,
  ).catch(() => []);
}

/** One row, for the claim page to poll. */
export async function getHold(id: string): Promise<HoldRequest | null> {
  const [row] = await query<HoldRequest>(`SELECT * FROM rc_hold_requests WHERE id = $1`, [id]).catch(() => []);
  return row ?? null;
}

/** The bot got it. Record HOW TO LET GO as well as that we hold it — without the entry
 *  key we could only empty the whole cart, taking every other user's hold with it.
 *
 *  Returns whether this call is the one that flipped it, so the caller can send the
 *  "it's held, come and get it" alert EXACTLY once. Re-running the runner over a hold it
 *  already carted must not text the user again. */
export async function markCarted(id: string, cartKey: string, cartEntryKey: string | null): Promise<boolean> {
  const rows = await mutate<{ id: string }>(
    `UPDATE rc_hold_requests SET status = 'carted', carted_at = NOW(), cart_key = $2,
            cart_entry_key = $3, updated_at = NOW()
      WHERE id = $1 AND status <> 'carted' RETURNING id`,
    [id, cartKey, cartEntryKey],
  ).catch((e) => { console.error('[rc-holds] markCarted failed:', e.message); return []; });
  return rows.length > 0;
}

export interface RcSessionHealth {
  ok: boolean | null;
  at: string | null;
  detail: string | null;
  source: string | null;
}

/**
 * Record whether ReserveCalifornia still accepts the bot's session.
 *
 * `rc-keepwarm.mjs` has always known this — it asks RC a question only an authenticated
 * session can answer, every 20 minutes — and has always thrown the answer away into a
 * console on a box nobody watches. It is the earliest possible warning we have, and it
 * was not leaving the mini-PC.
 *
 * The value of getting it here is LEAD TIME. RC serves a reCAPTCHA on sign-in now, so
 * there is no unattended re-login: a dead session needs a human. Learning at 21:00 that
 * tomorrow's 08:00 hold has no session behind it is a fixable evening. Learning at
 * 08:00:10 is a post-mortem.
 *
 * @param okta The Okta session as the bot observed it, or `undefined` when this caller did
 *   not probe. See migration 065 — that distinction is the whole design: it decides whether
 *   the next repair is an 11-second cookie exchange or a 12-minute, 9.4 GB password sign-in.
 *
 *   **UNDEFINED LEAVES THE STORED READING ALONE; NULL OVERWRITES IT.** Most `reportSession`
 *   callers (the auto-login arms, the rehearsal) never ask Okta anything, and having them
 *   write NULL would erase a real reading `checkAndReport` took moments earlier — a fact
 *   destroyed by a caller that never had one. `{alive: null}` is different and does write:
 *   it means we asked and could not tell, which is a reading in its own right.
 *
 *   DELIBERATELY NOT COALESCE. Okta state is time-sensitive — it went ALIVE-with-5-minutes
 *   to GONE inside twenty on 2026-08-21 — so a preserved old value is actively misleading in
 *   a way a stale `bot_commit` merely looks current. The freshness is carried by
 *   `okta_checked_at`, so a reader can see the reading's age rather than infer it.
 */
/**
 * An ISO instant Postgres will accept, or NULL. Re-serialised from the parsed value rather
 * than passed through, so nothing reaches the `::timestamptz` cast that has not already been
 * proved to be a date on this side.
 */
export function oktaExpiresAt(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function recordSessionHealth(
  ok: boolean, detail: string | null, source: string,
  okta?: { alive: boolean | null; expiresAt: string | null },
): Promise<void> {
  await mutate(
    // `session_since` moves ONLY on a change of verdict. `session_at` is "when we last
    // looked", which on a 20-minute loop overwrites the death with every reconfirmation
    // of it — a session that died at 05:30 and was probed at 13:40 would read "dead, 0
    // minutes ago". The difference between an ok-since and the dead-since that follows it
    // IS the session lifetime, which is the number that decides whether "sign in once and
    // never let it lapse" is a viable design at all. See migration 047.
    `UPDATE rc_runner_heartbeat
        SET session_ok = $1, session_at = NOW(), session_detail = $2, session_source = $3,
            session_since = CASE WHEN session_ok IS DISTINCT FROM $1 THEN NOW() ELSE session_since END,
            -- Only on a flip to ALIVE, and never cleared: it has to outlive the death it
            -- will be subtracted from, or the lifetime is unmeasurable at the one moment
            -- we want to know it.
            session_live_since = CASE WHEN $1 AND session_ok IS DISTINCT FROM $1
                                      THEN NOW() ELSE session_live_since END,
            -- $4 is the flag for "this caller probed at all". When it is false every okta
            -- column keeps its current value, so a caller with no reading cannot blank one.
            okta_alive      = CASE WHEN $4 THEN $5 ELSE okta_alive END,
            okta_expires_at = CASE WHEN $4 THEN $6::timestamptz ELSE okta_expires_at END,
            okta_checked_at = CASE WHEN $4 THEN NOW() ELSE okta_checked_at END
      WHERE id = 1`,
    [
      ok, detail ? detail.slice(0, 300) : null, source.slice(0, 40),
      okta !== undefined,
      // Anything that is not a real boolean is stored as NULL rather than coerced. This
      // arrives over the network from the box, and `[object Object]` reaching a column is
      // the shape that switched off the memory series for ten minutes.
      typeof okta?.alive === 'boolean' ? okta.alive : null,
      // AND IT MUST PARSE, because `::timestamptz` on rubbish THROWS — and this statement
      // also carries the session verdict, so a malformed diagnostic field would take the
      // reading it rides along with. A diagnostic that can break the thing it observes is
      // not worth having; an unparseable expiry becomes NULL, i.e. "not reported".
      oktaExpiresAt(okta?.expiresAt),
    ],
  ).catch((e) => console.error('[rc-holds] recordSessionHealth failed:', e.message));
}

/**
 * Is there a bot alive to honour a hold at all?
 *
 * WHY THIS EXISTS (2026-08-11). The RC hold runner and keep-warm stopped at 09:36 PT and
 * nothing noticed for over two hours — while the poller went on offering "Hold it for me"
 * buttons, one of them eight minutes before this was written. Tapping one would have
 * answered *"We'll grab site #P177 the moment it opens"*, which nothing on the mini-PC was
 * running to do. That is the failure this codebase keeps finding in new clothes: a
 * confident answer from a component that never asked whether the work could be done.
 *
 * OFFERING A HOLD WE CANNOT KEEP IS WORSE THAN OFFERING NOTHING, because the user stops
 * watching. The same argument is already written on the claim screen, about promising an
 * automatic cart before the cart POSTs were proven. They get the coming-soon alert either
 * way and can book it themselves at 08:00 — which is the outcome a silent failure denies
 * them.
 *
 * IT READS THE RUNNER'S HEARTBEAT AND NOT THE SESSION, deliberately. A dead session at
 * 20:00 is a pending repair — `maybeAutoLogin` signs in at T-30 and the nightly rehearsal
 * proves it can — and refusing on that would be the 2026-08-09 cry-wolf, which told the
 * owner to sign in by hand over the session that carted a site fifteen minutes later. A
 * missing runner is different: nothing is coming to fix it, and nothing will cart.
 */
/**
 * May this caller stamp the hold runner's heartbeat?
 *
 * `beat_at` is the entire evidence base for `rcBotUsable()` above and for the
 * `autocart.rc_runner` health check, and what it claims to mean is "the process that carts
 * sites is alive". It was stamped on EVERY authorized GET of the hold feed, and three
 * different processes on the mini-PC make one:
 *
 *   rc-hold-runner.mjs   every 15s   <- the only one this field is about
 *   rc-keepwarm.mjs      every 20m   (?rehearsal=1)
 *   update-guard.mjs     every 5m    (the Windows scheduled task)
 *
 * So the heartbeat could not go stale while the box had a working scheduled task, which is
 * always. MEASURED on 2026-08-14: the hold runner was dead for hours - relaunched as a bare
 * `node` REPL by a quoting bug in restart-rc.ps1 - and `beat_at` advanced every 301 seconds,
 * exactly the updater's tick. `autocart.rc_runner` read OK throughout, and the poller went
 * on offering "Hold it for me" buttons that nothing would honour. That is the precise
 * failure rcBotUsable was written to prevent, defeated through its own instrument.
 *
 * THE TEST IS "SAYS IT IS SOMETHING ELSE", NOT "SAYS IT IS THE RUNNER, and the asymmetry is
 * the whole design. A runner too old to send the header must keep stamping: the server half
 * of this lands on Vercel the moment it is pushed, while the bot half waits for update.bat
 * or a quiet window, and a rule of "only an identified runner counts" would turn a healthy
 * box red for that entire gap. That is the two-halves-deploy trap that opened the T-30/T-25
 * alarm hole on 08-11. Unknown callers therefore behave exactly as they always did; only a
 * caller that positively identifies as NOT the runner is skipped, so the failure direction
 * is the status quo and never a new false alarm.
 */
export const HEARTBEAT_ROLE = 'rc-hold-runner';
export function beatIsFromRunner(role: string | null | undefined): boolean {
  return !role || role === HEARTBEAT_ROLE;
}

export async function rcBotUsable(): Promise<{ ok: boolean; beatAgeMs: number | null }> {
  const [row] = await query<{ beat_at: string | null }>(
    `SELECT beat_at::text FROM rc_runner_heartbeat WHERE id = 1`,
  ).catch(() => []);
  if (!row?.beat_at) return { ok: false, beatAgeMs: null };
  const beatAgeMs = Date.now() - new Date(row.beat_at).getTime();
  return { ok: beatAgeMs <= RC_RUNNER_STALE_MS, beatAgeMs };
}

export interface RehearsalRow {
  ran_at: string | null;
  ok: boolean | null;
  ok_at: string | null;
  detail: string | null;
  skipped_why: string | null;
}

/**
 * The nightly proof that the bot can still sign in — see migration 054.
 *
 * A SKIP AND A PASS ARE WRITTEN DIFFERENTLY, on purpose. `ok = NULL` with a reason is "we
 * declined to test tonight"; `ok = true` is "we signed in". Recording a skip as a pass is
 * how a fortnight of quiet evenings would read as a fortnight of proven mornings, and the
 * whole point of this table is that the three failures it exists to catch all LOOKED fine
 * until 07:30.
 *
 * `ok_at` is never cleared by a later failure — the health check needs to say "broken
 * since", not merely "broken".
 *
 * TWO WRITES, AND THE ORDER IS THE POINT (migration 063, 2026-08-18). The singleton is
 * only ever the LATEST verdict, so every failure was erased by the next stand-down — and
 * stand-downs are the common case, which made the erasure a nightly certainty rather than
 * a risk. The append-only log is what lets anyone ask whether the sign-in is getting
 * worse. The singleton is written FIRST and its failure is what gets reported: it is what
 * `/api/health/status` reads and what pages, and a history table must never come between
 * the alarm and the fact. The append is best-effort for the same reason.
 */
export async function recordRehearsal(
  ok: boolean | null, detail: string | null, skippedWhy: string | null,
): Promise<void> {
  const d = detail ? detail.slice(0, 300) : null;
  const why = skippedWhy ? skippedWhy.slice(0, 200) : null;
  await mutate(
    `UPDATE rc_login_rehearsal
        SET ran_at = NOW(), ok = $1, detail = $2, skipped_why = $3,
            ok_at = CASE WHEN $1 IS TRUE THEN NOW() ELSE ok_at END
      WHERE id = 1`,
    [ok, d, why],
  ).catch((e) => console.error('[rc-holds] recordRehearsal failed:', e.message));
  await mutate(
    `INSERT INTO rc_login_rehearsal_log (ok, detail, skipped_why) VALUES ($1, $2, $3)`,
    [ok, d, why],
  ).catch((e) => console.error('[rc-holds] recordRehearsal history failed:', e.message));
}

export interface RehearsalLogRow {
  ran_at: string;
  ok: boolean | null;
  detail: string | null;
  skipped_why: string | null;
}

/**
 * The rehearsal's history, newest first — the trend the singleton cannot show.
 *
 * Read by `scripts/rc-holds-readout.mts`, which is where a human looks before an 08:00.
 * A run of NULLs is a run of nights nobody tested, and that is a finding rather than an
 * absence of one: it is what "no rehearsal has PASSED in 12h" looked like from inside.
 */
export async function rehearsalHistory(limit = 14): Promise<RehearsalLogRow[]> {
  return await query<RehearsalLogRow>(
    `SELECT ran_at::text, ok, detail, skipped_why FROM rc_login_rehearsal_log
      ORDER BY ran_at DESC LIMIT $1`,
    [String(Math.max(1, Math.min(100, limit)))],
  ).catch(() => []);
}

export async function lastRehearsal(): Promise<RehearsalRow | null> {
  const [row] = await query<RehearsalRow>(
    `SELECT ran_at::text, ok, ok_at::text, detail, skipped_why FROM rc_login_rehearsal WHERE id = 1`,
  ).catch(() => []);
  return row ?? null;
}

/**
 * "No thanks" — the user turned down an offer we made.
 *
 * WHY THIS HAD TO EXIST BEFORE THE BUTTON DID. `HoldsPanel` deliberately gave `offered`
 * rows no remove control, and its header says why: with no server-side decline, an X could
 * only ever hide the row while the bot went on regardless, and a control that appears to
 * cancel and does not is worse than no control. So the owner's ask for an X on the "Hold
 * it for me" card is answered by building the decline, not by hiding the card.
 *
 * IT IS NOT MERELY COSMETIC, AND THAT IS THE POINT. An `offered` row occupies a capacity
 * seat (`holdWindowLoad` counts it, because the button is in an email we cannot retract),
 * and since the fairness line it also occupies a POSITION — declining moves everybody
 * behind you up, which is the one thing hiding a card could never do.
 *
 * `offered` ONLY, and the narrowness is the safety:
 *   - `requested` is a commitment the bot is about to honour. Retracting it is a cancel,
 *     which is a different act with a different confirmation, and getting it wrong at
 *     07:59 loses a campsite.
 *   - `carted`/`claiming` hold a real site in a real RC cart. Marking one of those
 *     terminal does not release it — it takes the site off the market for everyone and
 *     removes the last thing on screen still pointing at it. That is the 2026-08-13 leak
 *     with a button on it.
 *
 * `expired` rather than a new status: it is already terminal, already excluded from
 * `holdWindowLoad` and from `/api/rc-holds/mine`, and adding a seventh value to the
 * lifecycle means a CHECK migration and every consumer that enumerates statuses. The
 * NOTE is what keeps a decline distinguishable from a lapse in the readout.
 *
 * Returns false when nothing was declined, which the caller must not report as success —
 * a row that has moved past `offered` has been acted on, and saying "removed" over a hold
 * the bot is about to cart is the same lie the missing control was avoiding.
 */
export async function declineHold(id: string): Promise<boolean> {
  try {
    const rows = await mutate<{ id: string }>(
      `UPDATE rc_hold_requests
          SET status = 'expired', updated_at = NOW(),
              last_attempt_note = 'declined by the user - they removed the offer from their watches page'
        WHERE id = $1 AND status = 'offered'
        RETURNING id`,
      [id],
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[rc-holds] declineHold failed:', (err as Error).message);
    return false;
  }
}

export async function markClaimed(id: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'claimed', claimed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  ).catch((e) => console.error('[rc-holds] markClaimed failed:', e.message));
}

/**
 * The bot tried to cart and RC said no. Is that final, or is it just too early?
 *
 * THE BUG THIS EXISTS TO FIX (2026-08-08). The feed hands the bot a hold **90 seconds
 * before** its release, deliberately — "the bot should be mid-request when the site frees,
 * not starting to think about it a second late". The runner carted immediately, RC
 * correctly answered *"The unit is not available for the date(s) specified"* because the
 * site had not been released yet, and `markFailed` wrote that down as final. `failed` is
 * terminal — `dueHolds` only ever returns `requested` — so **the one and only attempt was
 * guaranteed to happen before the release, and there was never a second one.**
 *
 * Measured on the first hold that got this far: attempt at 07:58:35 PT for an 08:00:00
 * release. The lead time did not help the bot arrive first; it guaranteed the shot was
 * fired before the gun. This flow could not have succeeded no matter how healthy the
 * runner and the session were — and yesterday's dead runner hid it.
 *
 * So a failure while the release window is still open is an ATTEMPT, not an outcome: the
 * status stays `requested`, the hold stays in the feed, and the runner retries on its next
 * ~20s pass. Only once the window has closed does it become `failed`.
 *
 * The window matches `dueHolds`'s grace on purpose. Past it the hold stops being served to
 * the bot anyway, so anything else would leave rows `requested` forever with nothing
 * looking at them — and `worker/expire-holds.ts` (45-minute grace) is the backstop that
 * notifies the user either way.
 */
export async function reportCartFailure(
  id: string, error: string, graceMinutes = 20, cartKey?: string | null,
): Promise<{ state: 'retry' | 'failed' | 'already-failed'; hold: HoldRequest | null }> {
  const stillOpen = `release_at >= to_char((NOW() - ($3 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const rows = await mutate<HoldRequest & { status: HoldStatus }>(
    `UPDATE rc_hold_requests
        SET last_attempt_at = NOW(), last_attempt_note = $2,
            -- REMEMBER WHICH CART WE TRIED, EVEN THOUGH THIS FAILED.
            --
            -- Since holds mint their own carts, a submit that succeeded and whose read-back
            -- did not would leave the site locked in a cart NOTHING remembers: the retry
            -- would mint a fresh one, look there, find nothing, and the entry would sit
            -- orphaned until RC dropped it ~15 minutes later. With the old shared cart the
            -- retry happened to look in the right place by accident.
            --
            -- COALESCE keeps the FIRST key: once a hold has a cart, later attempts must not
            -- repoint it at one that holds nothing. And $4 is only ever supplied when the
            -- submit actually produced a key, so a plain failure stores nothing.
            cart_key   = COALESCE(cart_key, $4),
            status     = CASE WHEN ${stillOpen} THEN status     ELSE 'failed' END,
            error      = CASE WHEN ${stillOpen} THEN error      ELSE $2 END,
            -- updated_at means "the hold changed". A retryable attempt is not a change,
            -- and moving it would destroy the unchanged-since-the-tap tell (migration 046).
            updated_at = CASE WHEN ${stillOpen} THEN updated_at ELSE NOW() END
      -- The status guard makes this report the TRANSITION, so the caller can tell the
      -- user exactly once. Without it, any repeat report would send a second "we couldn't
      -- hold it" — the same lesson as markCarted and migration 039.
      WHERE id = $1 AND status <> 'failed'
      RETURNING *`,
    [id, error.slice(0, 500), String(graceMinutes), cartKey ?? null],
  ).catch((e) => { console.error('[rc-holds] reportCartFailure failed:', e.message); return []; });
  if (!rows[0]) return { state: 'already-failed', hold: null };
  return { state: rows[0].status === 'failed' ? 'failed' : 'retry', hold: rows[0] };
}

/** One line the user's device reported during the hand-off. Mirrors `RcReport`. */
export interface ClientReport {
  n: number;
  stage: string;
  detail: Record<string, unknown> | null;
}

/** Keep the tail, not the head. The interesting part of a hand-off is always the end —
 *  "✓ Added to cart" or "RC declined" — and the token rebroadcasts at the start are the
 *  bulkiest and least informative. */
/**
 * How many client reports a hold keeps, and WHY IT IS NO LONGER A PLAIN TAIL.
 *
 * A whole hand-off does not fit in 40. The 2026-08-24 iOS run — the one that worked, and the
 * baseline every later run is compared against — used **all forty** to cover: arriving signed
 * out, the Okta round trip, the cart, and the cart page. The 08-29 Android run therefore lost
 * its cart sequence off the FRONT, and a line-by-line comparison against the baseline was
 * simply not possible: the decisive middle had been deleted.
 *
 * This is the THIRD time the tail-trim has eaten the evidence. `✓ Added to cart` was trimmed
 * off the front of both 2026-08-13 hand-offs, and the platform tag was trimmed from every
 * summary until migration 064 gave it columns. Each time the fix was to rescue one field.
 *
 * SO KEEP BOTH ENDS. A hand-off's decisive moments are at the START (platform, the arriving
 * session, whether a sign-in was needed) and at the END (the submit, the navigation, the cart
 * read-back). The middle is `token` rebroadcasts, which `rc-inject.js` emits on every RC call
 * and which are already collapsed into `repeated` entries.
 *
 * THE ARRAY IS THEREFORE NOT NECESSARILY CONTIGUOUS. A reader who assumes it is will misread
 * a sequence — which is why the readout says so when the cap is reached.
 */
const CLIENT_REPORT_HEAD = 20;
const CLIENT_REPORT_TAIL = 60;
const CLIENT_REPORT_CAP = CLIENT_REPORT_HEAD + CLIENT_REPORT_TAIL;

/**
 * Record what the USER'S DEVICE did during the hand-off.
 *
 * WHY THIS EXISTS. Everything else about a hold is our side of it. A hold that ends
 * `released` is byte-identical whether the injected precart carted the site, threw on
 * line 1, or never ran — and the reports that answer it currently live only in the claim
 * screen's memory, which nobody is reading at 08:00. Same family as `status = 'sent'`
 * meaning "Twilio returned 2xx".
 *
 * NEVER MOVES `status`, and never `updated_at`. This is an observation about the client,
 * not a state change to the hold — conflating them would destroy the "unchanged since the
 * tap" tell that exposed the 2026-08-07 outage, exactly as `noteAttempt` must not.
 *
 * Best-effort by construction: a failed write here must never surface to a user who is
 * mid-claim with a clock running.
 */
export async function recordClientReports(id: string, reports: ClientReport[]): Promise<void> {
  if (!reports.length) return;
  // The last report that says something about the OUTCOME, for the denormalised columns.
  // `token`/`reinjected` are progress, not verdicts; a readout that surfaced "token
  // captured" as the final word would report a cart we never saw succeed.
  const verdict = [...reports].reverse().find((r) => r.stage === 'status' || r.stage === 'banner' || r.stage === 'error');
  const note = verdict
    ? String((verdict.detail?.status ?? verdict.detail?.message ?? '') || verdict.stage).slice(0, 300)
    : null;

  // THE PLATFORM IS LIFTED OUT OF THE LIST, because it cannot survive in it.
  //
  // It is reported ONCE, first, and the trim above keeps the TAIL — so it sits at the head of
  // exactly the region that gets discarded. Measured on hold 4734 (2026-08-20): 40 reports
  // stored, earliest survivor `session {n:2}`, the platform long gone. Every hand-off summary
  // this project has ever produced said "platform not reported" for that reason, and it was
  // read as the feature being unbuilt rather than as its output being deleted.
  //
  // COALESCE, so a later batch that carries no platform cannot erase one an earlier batch
  // established. A hand-off flushes several times and only the first carries it.
  const platform = reports.find((r) => r.stage === 'platform')?.detail as
    | { platform?: unknown; appBuild?: unknown } | undefined;
  const plat = typeof platform?.platform === 'string' ? platform.platform.slice(0, 40) : null;
  const build = typeof platform?.appBuild === 'string' ? platform.appBuild.slice(0, 60) : null;

  await mutate(
    `UPDATE rc_hold_requests
        SET client_reports = (
              -- HEAD AND TAIL, in order, dropping only the middle. row_number() over the
              -- concatenated array keeps the original sequence; the window count(*) is what
              -- makes "the last N" expressible without a second scan.
              -- (No backticks in here: this is a template literal and one would end it.)
              SELECT COALESCE(jsonb_agg(x ORDER BY rn), '[]'::jsonb)
                FROM (
                  SELECT x,
                         row_number() OVER () AS rn,
                         count(*)     OVER () AS n
                    FROM jsonb_array_elements(client_reports || $2::jsonb) AS t(x)
                ) s
               WHERE rn <= $8 OR rn > n - $3
            ),
            client_last_stage  = $4,
            client_last_note   = COALESCE($5, client_last_note),
            client_platform    = COALESCE($6, client_platform),
            client_app_build   = COALESCE($7, client_app_build),
            client_reported_at = NOW()
      WHERE id = $1`,
    // $3 is the TAIL length, not the cap — the head is $8. Passing the cap here would keep
    // the last 80 as well as the first 20 and quietly double the column.
    [id, JSON.stringify(reports), CLIENT_REPORT_TAIL, reports[reports.length - 1].stage, note,
     plat, build, CLIENT_REPORT_HEAD],
  ).catch((e) => console.error('[rc-holds] recordClientReports failed:', e.message));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
    [id, error.slice(0, 500)],
  ).catch((e) => console.error('[rc-holds] markFailed failed:', e.message));
}

/**
 * Close out rows whose moment has passed.
 *
 * An `offered` row nobody answered is simply expired. A `carted` one that was never
 * claimed is the case that matters: **the bot must let go.** Sitting on a hold the user
 * never came for is the inventory-grabbing this design exists to prevent, and the release
 * itself is the bot's job — this only marks which ones it owes.
 */
export async function expireStaleHolds(holdMinutes = 45): Promise<{ expired: number; toRelease: HoldRequest[] }> {
  const nowPacific = `to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const expired = await mutate<{ id: string }>(
    `UPDATE rc_hold_requests SET status = 'expired', updated_at = NOW()
      WHERE status = 'offered' AND release_at < ${nowPacific} RETURNING id`,
  ).catch(() => []);
  const toRelease = await query<HoldRequest>(
    `SELECT * FROM rc_hold_requests
      WHERE status = 'carted' AND carted_at < NOW() - ($1 || ' minutes')::interval`,
    [String(holdMinutes)],
  ).catch(() => []);
  return { expired: expired.length, toRelease };
}
