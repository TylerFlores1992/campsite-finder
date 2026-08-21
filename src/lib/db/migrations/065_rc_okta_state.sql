-- WILL THE NEXT RC REPAIR BE THE CHEAP ONE OR THE 9-GIGABYTE ONE?
--
-- `autocart.rc_session` answers "does RC accept the current token". It says nothing about the
-- OKTA session sitting behind it, and that is the field which decides what the next sign-in
-- COSTS. Measured, both on the same box, five days apart:
--
--     okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB   (2026-08-21)
--     okta=GONE    full password form             12 minutes,  +9,434 MB   (2026-08-20)
--
-- The expensive one is what the RAM guard killed on 08-20, and whether a throwaway tab
-- reclaims a trip that size is still unmeasured. So "Okta is about to lapse" is a *cost*
-- prediction that is knowable in advance and was being thrown away.
--
-- ── IT WAS ALREADY REPORTED, AS PROSE ─────────────────────────────────────────────────────
-- `checkAndReport` has the structured reading from `oktaSessionAlive` — `{alive, status,
-- expiresAt}` — stringifies it into `okta=ALIVE (exp …)`, and posts only that sentence, which
-- lands in `session_detail`. The server would have to un-parse its own prose to get back a
-- value the bot already had. Same shape as `notePlatform` emitting a fact into a region that
-- then discarded it (migration 064): produced, and thrown away one layer down.
--
-- ── WHAT THIS BUYS, AND WHAT IT MUST NOT DO ───────────────────────────────────────────────
-- On 2026-08-21 at 14:42 the session read perfectly healthy while Okta had FIVE MINUTES left:
--
--     14:30:06  ✓ signed in — token now 60m          <- 4s, no form: answered from the cookie
--     14:42:33  okta=ALIVE (exp 2026-08-21T14:47:57) <- 5m ahead, NOT the rolling +12h
--     15:00:32  okta=GONE(404)
--
-- That is the absolute cap recorded on 2026-08-19 ("the rolling window is real and it is
-- bounded"), and it answers that entry's open question from the other side: a sign-in
-- answered from the `idx` cookie REUSES the existing Okta session and inherits its cap. It
-- does not restart the clock. "The bot signed in at T−30" therefore does NOT mean "Okta is
-- good for twelve hours" — that morning it meant eighteen minutes.
--
-- **NOTHING HERE MAY GO RED.** `okta=GONE` is the ordinary state between releases: the access
-- token IS the session for most of the day, and the repair at T−30 is scheduled and expected.
-- Turning it into a fault is the cry-wolf failure this file has fixed three times, most
-- expensively at 07:33 on 2026-08-16 where the printed remedy would have destroyed a working
-- session. This is a COST PREDICTION shown beside an existing verdict, not a new verdict.
--
-- NULL IS "NOT REPORTED", NEVER "GONE". A box on a build older than this reports no okta
-- fields at all and lands here as NULL, which must read as a gap and never as a measured
-- absence — the same rule as `max_type` in 062 and `client_platform` in 064, and the same
-- rule that keeps an unknown Okta probe from being written as dead.

ALTER TABLE rc_runner_heartbeat
  ADD COLUMN IF NOT EXISTS okta_alive      boolean,
  ADD COLUMN IF NOT EXISTS okta_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS okta_checked_at timestamptz;
