-- How LONG does a ReserveCalifornia session actually live?
--
-- 046 records the current verdict and when it was last checked. That is enough to know
-- the session is dead; it is NOT enough to know when it died, because `session_at` moves
-- on every 20-minute pass — so a session that died at 05:30 and was probed at 13:40 reads
-- as "dead, 0 minutes ago". The transition is overwritten by the next confirmation of it.
--
-- WHY THAT MATTERS NOW. Two deaths measured by hand, both ~8-9 hours after a fresh human
-- sign-in (2026-08-07 05:54Z → failed by 15:00Z; 2026-08-08 05:14Z → dead by ~13:40Z),
-- with keep-warm loading RC every 20 minutes throughout the second one and "Keep me signed
-- in" confirmed ticked. That combination falsifies the design premise: a page load can
-- extend an IDLE timeout, and cannot extend an ABSOLUTE session lifetime. If RC/Okta caps
-- sessions at ~8h regardless of activity, then "a human signs in once and the bot never
-- lets it lapse" cannot support an 08:00 hold, and the flow has to change shape.
--
-- That is a big conclusion to draw from two hand-timed observations bounded only to the
-- nearest several hours. `session_since` moves ONLY when the verdict changes, so each
-- death is bounded to one 20-minute keep-warm pass instead — and `--login` stamps it too,
-- which makes the measurement a subtraction rather than an inference.
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_since TIMESTAMPTZ;
-- TWO columns, because one cannot answer the question. `session_since` moves on EVERY
-- change, so the moment a session dies it holds the death — and the sign-in it is
-- measured against has just been overwritten. `session_live_since` is set only on a flip
-- to alive and is never cleared, so it survives the death that needs it:
--     lifetime = session_since (the death) − session_live_since (the sign-in)
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_live_since TIMESTAMPTZ;

COMMENT ON COLUMN rc_runner_heartbeat.session_since IS
  'When session_ok last CHANGED value — not when it was last checked (that is session_at). While dead, this is the time of death, bounded to one 20-minute keep-warm pass.';
COMMENT ON COLUMN rc_runner_heartbeat.session_live_since IS
  'When the session last came ALIVE, and never cleared — so it outlives the death it has to be subtracted from. session_since minus this is the measured session lifetime.';
