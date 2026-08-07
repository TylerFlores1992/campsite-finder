-- Liveness beacon for the ReserveCalifornia hold runner on the mini-PC.
--
-- WHY THIS EXISTS (2026-08-07, the day it was needed). The first real day-before hold was
-- offered 05:26, tapped 06:00, and the site released at 08:00 exactly as predicted. The
-- runner never picked it up. Six hours later the row still read `requested`, unchanged
-- since the tap.
--
-- Nothing anywhere could have told us sooner. `autocart.bot` was green the whole time —
-- but that is the REC.GOV bot's heartbeat, a different process that happened to be
-- healthy, so the dashboard actively reassured while the RC runner was dead. The runner
-- had no beacon of its own, so its death was undetectable until a user's hold silently
-- failed, which is the worst possible detector.
--
-- Stamped by `GET /api/auto-cart/rc-holds`, the endpoint the runner polls every ~20s —
-- the same pattern as 015, where the roster poll doubles as the beat. A separate row
-- rather than a shared one because the two processes fail INDEPENDENTLY: the rec.gov bot
-- kept carting sites all afternoon on the very day the RC runner was down.
--
-- Read it together with pending work, not alone. A stale beat with nothing queued costs
-- nobody anything; a stale beat with a `requested` hold whose release has arrived is a
-- user losing a site they were promised. See /api/health/status.
CREATE TABLE IF NOT EXISTS rc_runner_heartbeat (
  id      int PRIMARY KEY DEFAULT 1,
  beat_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO rc_runner_heartbeat (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Match the security lockdown: RLS on, no policies (service role bypasses).
ALTER TABLE rc_runner_heartbeat ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rc_runner_heartbeat IS
  'Last authorized poll from the mini-PC RC hold runner. Separate from autocart_bot_heartbeat because the two processes fail independently — on 2026-08-07 the rec.gov bot was healthy all day while this one was down.';
