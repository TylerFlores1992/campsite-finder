-- WHAT CODE IS THE MINI-PC ACTUALLY RUNNING?
--
-- Nothing knew. `autocart.rc_runner` proves the box can reach camphawk.app;
-- `autocart.rc_session` proves RC accepts its session. Neither says a word about whether
-- the checkout is current — and "the halves deploy by different routes" is the most
-- expensive recurring failure in this project's log:
--
--   * 2026-08-11: AUTOCART_ALARM_AFTER_MIN shipped to Vercel instantly while
--     RC_AUTOLOGIN_LEAD_MIN needed a human-run update.bat. In the gap the alarm fires at
--     T-25 while the login still waits for T-15 — the 2026-08-09 cry-wolf bug exactly.
--   * 2026-08-11: update.bat never reported what it landed on, so the admin panel showed
--     "37e1527, REFUSED" while the box was happily running d1ab782. That is the field you
--     check to find out whether a fix arrived, and it misled twice in one evening.
--
-- `bot_commands`' `git-status` can answer this, but only when somebody ASKS. A health
-- check is passive and continuous, which is strictly better for a fact that goes wrong
-- while nobody is looking.
--
-- TWO COLUMNS, because the sha alone cannot answer the question that matters.
-- A sha tells you the box differs from the deploy; it cannot tell you WHAT is missing,
-- because a server with no git history cannot compute ancestry. The commit DATE can:
-- master is linear, so "the box's HEAD is older than the last commit touching
-- scripts/auto-cart-bot/" means the box is missing bot-side code, which is the only
-- version of this drift worth failing over.
--
-- Both are NULLABLE and both start NULL. A runner too old to send them leaves them NULL,
-- and the check reports "we do not know what code the box runs" — a warn, never an ok.
-- Unknown is not healthy; same rule as `hasAvailabilityInRange` returning null and
-- `untracked` SMS rows.
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS bot_commit TEXT;
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS bot_commit_at TIMESTAMPTZ;

COMMENT ON COLUMN rc_runner_heartbeat.bot_commit IS
  'git rev-parse HEAD on the mini-PC, reported on the feed poll. NULL = the box is running code that predates this column, which is itself a drift signal.';
COMMENT ON COLUMN rc_runner_heartbeat.bot_commit_at IS
  'Commit date of that HEAD. Lets the server decide whether the gap includes bot-side code without needing git ancestry.';
