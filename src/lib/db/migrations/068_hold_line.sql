-- Two people were promised one campsite (2026-08-24) — so holds get a LINE.
--
-- MEASURED, not hypothetical. Unit 43191 ("#96", Morro Bay, arrival 2026-09-04, releasing
-- 2026-08-25 08:00 PT) was offered to TWO different users: melinda.flores0501 through
-- "Morro Lottery sites" (rc-2185, watch created 16:53) and tylerflores1992 through
-- "Upper Section" (rc-583, watch created 19:45). RC lists one physical campsite under more
-- than one facility, so this is not a matching bug — it is one site and two promises.
--
-- Nothing decided who got it. `dueHolds` had no de-dupe, so if both had tapped the runner
-- would have been handed both rows and carted the same unit twice; RC refuses the second
-- in its own wording, and the loser's row would have sat `requested` with
-- `last_attempt_note` NULL — which this project's own readout reads as "NOTHING has tried
-- to act on this hold at all", i.e. the signature of the 2026-08-07 runner outage. So the
-- absence of a policy was also manufacturing a false alarm.
--
-- THE POLICY, as the owner specified it:
--   1. Earliest `watches.created_at` gets first dibs.
--   2. BOTH are still offered — nobody is silently excluded.
--   3. Rotate on OFFER, not on WIN, so a user who never claims cannot sit at the top for
--      ever.
--   4. (Cascade on expiry — GATED on first measuring RC's real cart lapse, not built here.)
--   5. Say which you are, on the offer screen, at the point of decision.

-- The rotation ticket. Lower = longer since this user was given first dibs; NULL = never.
-- ON THE USER, NOT THE WATCH, deliberately: the fairness unit is the person, and a
-- per-watch counter would hand somebody with four watches four top-of-queue positions,
-- which is the thing rotation exists to prevent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hold_offer_seq BIGINT;

-- A SEQUENCE rather than `MAX(hold_offer_seq) + 1`, so two poller shards ranking the same
-- line at the same moment cannot mint the same ticket. Gaps are free and meaningless here:
-- only the ORDER of these numbers is ever read.
CREATE SEQUENCE IF NOT EXISTS hold_offer_seq_counter AS BIGINT START 1;

-- 1-based position in the line for this hold's (release_at, unit_id). NULL means the line
-- has never been ranked — an uncontested hold, or a row predating this migration.
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS line_rank INTEGER;

-- The rotation ticket this hold was RANKED with, frozen the first time its line was seen
-- to be contested. 0 means "this user had never been given first dibs" — the sequence
-- starts at 1, so 0 can only mean never, and it sorts first without a NULL special case.
--
-- WITHOUT THIS THE LINE FEEDS BACK INTO ITSELF, which a test caught rather than a review.
-- Charging the winner raises their `users.hold_offer_seq`, so the very next re-rank of the
-- SAME line sorts them BELOW the person they had just beaten, charges that person too, and
-- the "you're first in line" on the offer screen flips under the reader. Freezing the
-- ticket per line keeps the charge where it belongs — on FUTURE contests.
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS line_seq BIGINT;

-- Set when this hold's user spent a rotation ticket for THIS line. It is what stops a
-- contest that spans many poller cycles from rotating the same user over and over: the
-- line is re-ranked every cycle, and the ticket is spent once.
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS line_rotated_at TIMESTAMPTZ;

-- Ranking reads every live hold for one (release_at, unit_id).
CREATE INDEX IF NOT EXISTS idx_rc_hold_requests_line
  ON rc_hold_requests (release_at, unit_id)
  WHERE status IN ('offered', 'requested');

-- NOTHING IS BACKFILLED, AND THAT IS THE SAFE DIRECTION. A NULL `line_rank` sorts LAST at
-- cart time, behind any ranked rival, and an uncontested hold is alone in its line so the
-- column never matters to it. Inventing ranks for live rows would be guessing at a line
-- nobody was ever told about.
