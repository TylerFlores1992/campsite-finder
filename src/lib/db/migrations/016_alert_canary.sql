-- Alert-health canary: the poller stamps one row per probe every cadence, and
-- /api/health/status turns a stale or failing row into a 503 an external cron can
-- page on. This is what makes the "silent death" traps in docs/CONTEXT.md
-- (stale-worker-never-alerts, a source path breaking, a Resend/Twilio outage)
-- observable instead of caught by luck.
--
-- Keys are stable strings so the poller upserts in place:
--   detect:<source>   — a real, THROWING availability fetch for that source
--                       succeeded (ridb, reserveamerica, reservecalifornia,
--                       goingtocamp, tnsc). Proves the detection path is alive.
--   delivery:email    — Resend accepted a synthetic send to the canary address.
--   delivery:sms      — Twilio accepted a synthetic send to the canary number.
CREATE TABLE IF NOT EXISTS alert_canary (
  key                   text PRIMARY KEY,
  ok                    boolean     NOT NULL DEFAULT false,
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_latency_ms       integer,
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  detail                text
);
