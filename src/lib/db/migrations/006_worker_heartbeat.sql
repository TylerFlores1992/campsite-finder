-- Single-row heartbeat the Fly poller updates every cycle; the
-- /api/health/worker endpoint alerts when it goes stale.
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id              int PRIMARY KEY DEFAULT 1,
  beat_at         timestamptz NOT NULL DEFAULT NOW(),
  watches_checked int NOT NULL DEFAULT 0
);
INSERT INTO worker_heartbeat (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
