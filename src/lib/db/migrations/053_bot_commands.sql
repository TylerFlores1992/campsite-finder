-- Ask the mini-PC a diagnostic question, and read the answer here.
--
-- WHY. On 2026-08-11 a broken on-demand update took six round-trips to diagnose, and every
-- one of them was "please type `type logs\something.log` and paste the result". The box is
-- behind a home router with no inbound path; the only channel is the hold runner's
-- authenticated 15-second poll, which already carries the update flag. This is one more
-- field in the same answer.
--
-- WHY IT IS NOT A SHELL. That machine holds the live ReserveCalifornia session, the DPAPI
-- credential store, and a residential IP that two providers have already blocked. Anyone
-- holding AUTOCART_TOKEN can talk to this table, so a free-form command string would make
-- that token a remote shell on the owner's home network. It carries a KIND from a fixed
-- list instead, and `scripts/auto-cart-bot/bot-commands.mjs` keeps its own copy of that
-- list: the box decides what a kind means, the server can only name one. A server that is
-- entirely compromised can still only trigger the handful of read-only things the box
-- already agreed to do.
--
-- OUTPUT IS SCRUBBED AND CAPPED ON THE BOX, before it is sent. Logs are a mixture - tokens,
-- emails, callback URLs - and the rule this repo keeps relearning is that a field you have
-- to filter is better not collected. Here the field is inherently mixed, so it is filtered
-- at the only place where "not sent" is still true.
CREATE TABLE IF NOT EXISTS bot_commands (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  -- Optional parameter (e.g. which log to tail). Validated against the kind on BOTH sides.
  arg           TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by  TEXT,
  -- Stamped when the box picks it up, so "nobody has looked at this" and "it ran and said
  -- nothing" are different states. That distinction is the entire lesson of 2026-08-11.
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  exit_code     INT,
  output        TEXT,
  error         TEXT
);

-- The feed asks for pending work on every poll; this is the index that makes that cheap.
CREATE INDEX IF NOT EXISTS bot_commands_pending
  ON bot_commands (requested_at) WHERE finished_at IS NULL;

ALTER TABLE bot_commands ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN bot_commands.kind IS
  'One of the allowlisted diagnostics. NEVER a command line - see scripts/auto-cart-bot/bot-commands.mjs, which holds the authoritative list.';
COMMENT ON COLUMN bot_commands.output IS
  'Scrubbed and truncated ON THE MINI-PC before transmission. Assume it may still contain fragments; do not widen what is collected.';
