-- THE REHEARSAL KEPT NO HISTORY, SO IT COULD NOT SHOW A TREND (2026-08-18).
--
-- `rc_login_rehearsal` is ONE ROW, id = 1, updated in place. That was the right shape for
-- the question the health check asks ("what happened last night?") and the wrong shape for
-- the question this instrument exists to answer ("has the sign-in been getting worse?").
--
-- WHAT IT COST. The 2026-08-18 03:01 failure detail was overwritten by the next stand-down
-- and is simply gone — `ok = NULL`, `skipped_why = 'rehearsed 1h ago'`, and the only
-- surviving trace of a real failure is `ok_at` still pointing at 08-16. So a failure
-- survives exactly until the next skip, and skips are the COMMON case: `maybeRehearse`
-- writes one on every night the four gates stand it down. The check built to catch a login
-- regression was erasing its own evidence, on a cadence that guaranteed it.
--
-- That is the house shape one level up. `status = 'sent'` meant only "Twilio returned 2xx";
-- `claimBotCommands` returned `[]` for both "nobody asked" and "the query threw". Here,
-- "it failed last night and was skipped tonight" and "it has been skipped for a week" read
-- identically, because only the newest write survives.
--
-- APPEND-ONLY, AND THE SINGLETON STAYS. The singleton is what `/api/health/status` and
-- `lastRehearsal` read, and it is what pages; re-pointing those at an aggregate would put a
-- schema change in front of the alarm path for no gain. `recordRehearsal` writes BOTH, and
-- the append is best-effort — a history insert must never stop the row the health check
-- reads from being updated.
--
-- NO PRUNING. `maybeRehearse` writes at most a few rows a night (one verdict per Pacific
-- rehearsal slot), so this accrues on the order of 500 rows a year. A retention job would
-- be more moving parts than the data it removes — and a deleted rehearsal is exactly the
-- evidence this table exists to stop losing.
CREATE TABLE IF NOT EXISTS rc_login_rehearsal_log (
  id          BIGSERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Same three-valued meaning as the singleton, deliberately: TRUE = a credential was
  -- submitted and a session came back, FALSE = we tried and RC refused, NULL = we declined
  -- to test (see skipped_why) or could not tell. NEVER read NULL as healthy.
  ok          BOOLEAN,
  detail      TEXT,
  skipped_why TEXT
);

-- The only query this table has: "the last N, newest first".
CREATE INDEX IF NOT EXISTS rc_login_rehearsal_log_ran_at_idx
  ON rc_login_rehearsal_log (ran_at DESC);

ALTER TABLE rc_login_rehearsal_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rc_login_rehearsal_log IS
  'Append-only history behind rc_login_rehearsal. The singleton holds the latest verdict; '
  'this holds every one, so a failure survives the next skip.';
