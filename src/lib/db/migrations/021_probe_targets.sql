-- Cancellation-likelihood signal (feature E) — the PROBE ROSTER.
--
-- The recorder (migration 020) only samples campgrounds someone is actively
-- watching, so history accrues for a handful of user-chosen windows. To build a
-- signal for popular campgrounds nobody happens to be watching, the poller also
-- probes a curated roster of high-demand campgrounds on a fixed hourly cadence and
-- records the same availability_observations rows.
--
-- A row = one campground worth monitoring for cancellations. "Worth monitoring"
-- means high demand: the seed script (scripts/seed-probe-targets.ts) scans a broad
-- sample for a peak weekend and keeps the ones that are booked solid — a site
-- that's always open has no cancellation signal worth surfacing. The poller derives
-- the arrival windows to probe itself (fixed lead-times off "today"), so this table
-- holds no dates; it just answers "which campgrounds, and on what source path."
CREATE TABLE IF NOT EXISTS probe_targets (
  campground_id TEXT PRIMARY KEY REFERENCES campgrounds(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,          -- selects the availability adapter in the poller
  reason        TEXT,                   -- provenance, e.g. 'demand-scan 2026-08-15 booked-solid'
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_probe_targets_active ON probe_targets(active) WHERE active;

-- RLS deny-all like every other app table (service role bypasses). See 009.
ALTER TABLE probe_targets ENABLE ROW LEVEL SECURITY;
