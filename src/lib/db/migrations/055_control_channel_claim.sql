-- The control channel moves onto the roster feed, so TWO processes now poll it.
--
-- WHY (2026-08-11). The update flag and the diagnostics queue were both read by
-- `rc-hold-runner.mjs` — which is the process most likely to be DEAD at the moment you
-- need them. It stopped at 09:36 PT, and with it went every remote lever: no update, no
-- diagnostics, no way to ask the box a single question. "The box is unreachable" and "the
-- RC runner is down" were the same event, and they should never have been.
--
-- `bot.mjs` polls /api/auto-cart/roster every ~2 seconds and has survived every one of
-- these outages. Putting the same channel there means the box stays reachable as long as
-- ANY of its processes is alive.
--
-- That redundancy is the point, and it is also what makes these columns necessary: two
-- pollers racing one checkout is worse than a slow update.

-- WHICH PROCESS ANSWERED. Not bookkeeping — it is the diagnosis. "list-processes came back,
-- and it was the rec.gov bot that ran it" tells you the runner is dead in the same breath
-- as the answer. Without it, a diagnostic reply is silent about the one thing the reply
-- itself proves.
ALTER TABLE bot_commands ADD COLUMN IF NOT EXISTS claimed_by TEXT;

-- AN ATOMIC CLAIM ON THE UPDATE. Both pollers see `updateRequested` on the same tick, and
-- `auto-update.ps1` moves the git checkout out from under whatever is running. Two of them
-- at once is the failure this prevents; the winner is decided in one UPDATE, the same shape
-- as the alerting claim and the shard lease.
--
-- `claimed_at` is CLEARED by requestBotUpdate, so a new request is always claimable. It
-- also expires on its own: a process that claims and then dies before spawning the updater
-- must not wedge updates for ever, which is exactly what a claim with no TTL would do.
ALTER TABLE bot_update_requests ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE bot_update_requests ADD COLUMN IF NOT EXISTS claimed_by TEXT;

COMMENT ON COLUMN bot_update_requests.claimed_at IS
  'One poller wins the right to spawn auto-update.ps1. Expires, so a claimer that dies before spawning cannot block updates for ever.';
COMMENT ON COLUMN bot_commands.claimed_by IS
  'Which mini-PC process ran this. A diagnostic answered by the rec.gov bot proves the RC runner is not answering.';
