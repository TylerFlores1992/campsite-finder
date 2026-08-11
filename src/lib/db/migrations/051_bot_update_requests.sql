-- "Update the mini-PC now" — an update the owner (or an agent) asks for, on demand.
--
-- WHY THIS BEATS A TIMER. auto-update.ps1 runs on a schedule and refuses outside a quiet
-- window, which is right for routine staleness and wrong for everything else: some days a
-- fix needs to land in a minute, other weeks nothing should change at all. A schedule can
-- only ever express an average.
--
-- WHY A FLAG THE BOX PULLS, RATHER THAN A PUSH TO THE BOX. The mini-PC is behind a home
-- router with no inbound path — that is why cloudflared exists for the broker — and
-- opening one for updates would be a new listening surface on the machine holding the RC
-- session. The hold runner ALREADY polls the feed every 15 seconds with a bearer token, so
-- the request rides a channel that is authenticated, outbound-only, and running anyway.
--
-- ONE ROW, id = 1, exactly like rc_runner_heartbeat. There is one mini-PC; a table of
-- requests would be modelling a fleet that does not exist.
CREATE TABLE IF NOT EXISTS bot_update_requests (
  id            INT PRIMARY KEY DEFAULT 1,
  requested_at  TIMESTAMPTZ,
  requested_by  TEXT,
  -- Stamped by the box when it finishes. `applied_at >= requested_at` is what makes the
  -- request "done" — a separate boolean would be a second source of truth, and the two
  -- would disagree the first time an update failed halfway.
  applied_at    TIMESTAMPTZ,
  applied_sha   TEXT,
  applied_note  TEXT,
  CONSTRAINT bot_update_requests_singleton CHECK (id = 1)
);

INSERT INTO bot_update_requests (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE bot_update_requests ENABLE ROW LEVEL SECURITY;
