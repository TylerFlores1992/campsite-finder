-- Did the mini-PC's WINDOWS SCHEDULED TASKS actually fire?
--
-- WHY THIS EXISTS (2026-08-17). An 08:00 hold was never carted. The hold runner had
-- hard-crashed at 05:36:31 PT with exit code -1073740791 (0xC0000409, the Windows fast-fail
-- `abort()` produces) and `supervise.ps1` logged `restarting in 5s (attempt 1)` — then both
-- the supervisor and the payload were gone, and the watchdog that fires every five minutes
-- for exactly this said NOTHING for two and a half hours.
--
-- It said nothing because IT WAS NEVER INVOKED. `auto-update.log` — a separate Scheduled
-- Task on the same five-minute cadence — stops dead at 05:31:03 PT after a flawless run of
-- entries, five minutes before the crash. Two independent tasks going silent together is
-- not a bug in either task; it is the scheduler or the session underneath them, and it
-- rules out the per-task hung-instance explanation that fits only one.
--
-- WHY THE BOX LOOKED PERFECTLY HEALTHY THROUGHOUT. Everything driven by a RUNNING PROCESS
-- carried on: the supervisors restarted rc-keepwarm four times, `bot.mjs` beat every two
-- seconds, the control channel answered `list-processes`, `tail-log` and `git-status`. Only
-- the things driven by Task Scheduler stopped, and nothing anywhere measured those.
--
-- THE HOUSE FAILURE, ONE LEVEL UP AGAIN. `expire-holds.ts` was moved to Fly because the
-- sweep that notices a dead runner cannot live in the feed the dead runner polls. This is
-- the same shape: the watchdog is the supervisor of last resort, and the ONE fact nobody
-- collected was whether it had run. A silent watchdog and a healthy box produce identical
-- evidence — which is `notifications.status = 'sent'` meaning only "Twilio returned 2xx",
-- and `claimBotCommands` returning `[]` for both "nobody asked" and "the query threw".
--
-- SO THE PROCESS THAT KNOWS IS THE PROCESS THAT REPORTS, exactly as `rc-keepwarm` posts its
-- own session verdict rather than having a watcher infer it. Each task stamps a row as its
-- FIRST act, before any check that could throw — a firing that reached the script is worth
-- recording even when the work after it fails, because the question this answers is "did
-- Windows run you at all?" and nothing else.
--
-- NOT A COLUMN ON `rc_runner_heartbeat`. That row is the singleton "last authorized poll
-- from the RC hold runner"; there are two tasks here and there may be more, and folding a
-- second meaning into a row already carrying four (`beat_at`, `session_ok`, `session_at`,
-- `bot_commit`) is how `.camphawk-ready` came to mean two things that then came apart.
--
-- CHECKED, NOT ASSUMED: `bot_update_requests.applied_at` is NOT already this signal. It read
-- 2026-08-15 11:56Z while the auto-update task demonstrably ran every five minutes until
-- 05:31 PT on 08-17, so that reporting path is itself unreliable and cannot answer the
-- question. Do not "simplify" this table away into that column.
CREATE TABLE IF NOT EXISTS bot_task_heartbeat (
  -- The task's own name, e.g. 'watchdog' or 'auto-update'. Keyed by name rather than a
  -- singleton id because these fail INDEPENDENTLY — which is the entire lesson of
  -- `autocart.bot` staying green through three RC outages.
  task    TEXT PRIMARY KEY,
  beat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What that firing decided, in the task's own words ('healthy', 'restarted rc-hold-runner',
  -- 'stood down for an update'). Diagnostic only; nothing gates on it. A task that fires and
  -- refuses is a different fact from a task that does not fire, and this is what keeps them
  -- apart the next time somebody reads a quiet log.
  note    TEXT
);

ALTER TABLE bot_task_heartbeat ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE bot_task_heartbeat IS
  'Last firing of each mini-PC Windows Scheduled Task. Both tasks went silent at ~05:31 PT on 2026-08-17 and nothing noticed for 2.5 hours, because no instrument measured whether the watchdog had run.';
