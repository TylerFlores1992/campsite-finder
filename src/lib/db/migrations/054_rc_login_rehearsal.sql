-- Prove the RC sign-in works LONG before the morning it is load-bearing.
--
-- WHY. Three consecutive 08:00 holds failed, and all three failed AT LOGIN — 2026-08-07
-- (runner dead), 08-08 (carted 85s early), and 08-11 (the auto-login demanded an email
-- field Okta had stopped showing). Every one was discovered at 07:30 with twenty minutes
-- to act, because the 08:00 release was treated as the test. It is not the test; it is the
-- exam. The login is testable at any hour, and a failure found at 20:00 the night before
-- costs nothing.
--
-- The capability already existed — `node rc-keepwarm.mjs --test-login` runs the real
-- `attemptLogin` — and was never scheduled, so it only ever ran when somebody already
-- suspected a problem. That is the gap this closes: not a new ability, a cadence.
--
-- ONE ROW, id = 1, alongside rc_runner_heartbeat: there is one mini-PC.
CREATE TABLE IF NOT EXISTS rc_login_rehearsal (
  id          INT PRIMARY KEY DEFAULT 1,
  -- When the rehearsal last RAN. Distinct from `ok_at` on purpose: "we tried and it
  -- failed" and "nothing has tried for three days" are different faults with different
  -- fixes, and the whole point of this table is telling them apart before 08:00.
  ran_at      TIMESTAMPTZ,
  ok          BOOLEAN,
  -- Last time it actually SUCCEEDED. Survives a later failure, so the health check can say
  -- "broken since" rather than only "broken".
  ok_at       TIMESTAMPTZ,
  detail      TEXT,
  -- Why a night was skipped: a hold too close to risk the profile lock, or a session that
  -- was still live so `attemptLogin` would have short-circuited and proved nothing.
  -- SKIPPED IS NOT PASSED. Recording it separately is what stops a run of quiet skips
  -- reading as a run of green nights.
  skipped_why TEXT,
  CONSTRAINT rc_login_rehearsal_singleton CHECK (id = 1)
);

INSERT INTO rc_login_rehearsal (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE rc_login_rehearsal ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN rc_login_rehearsal.ok IS
  'NULL = the last attempt was skipped or has never run. Never read NULL as healthy.';
