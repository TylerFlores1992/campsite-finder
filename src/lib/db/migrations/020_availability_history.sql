-- Cancellation-likelihood signal (feature E) — the RECORDER half.
--
-- The poller already computes, every cycle, whether each watched campground has a
-- qualifying opening for a given arrival window. Until now that observation was
-- thrown away. This append-only table captures it as a time series so we can later
-- surface "this site opens up often — ~X% of recent checks for stays this far out"
-- as a differentiator. (The aggregation + UI half ships separately, once enough
-- history has accrued for the number to be honest.)
--
-- One row = one observation of one (campground, arrival window) at a point in time:
-- had_opening = did a bookable whole-stay opening exist for [arrival_date, +nights)
-- at observed_at. The poller self-throttles to at most one row per window per
-- OBSERVATION_INTERVAL (see worker/poller.ts) — 15s detection granularity is far
-- finer than a cancellation-frequency signal needs, and unthrottled it would write
-- millions of near-duplicate rows a day.
CREATE TABLE IF NOT EXISTS availability_observations (
  id           BIGSERIAL PRIMARY KEY,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  arrival_date  DATE NOT NULL,          -- check-in of the observed window
  nights        INTEGER NOT NULL,       -- length of the observed stay
  lead_days     INTEGER NOT NULL,       -- arrival_date minus observed date. openings behave
                                        -- very differently 3 days out vs 45, so bucket on this
  had_opening   BOOLEAN NOT NULL,       -- was a whole-stay opening bookable at observed_at
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The aggregation reads a trailing window of one campground's history.
CREATE INDEX IF NOT EXISTS idx_avail_obs_campground_time
  ON availability_observations(campground_id, observed_at DESC);

-- Supports the retention prune (DELETE WHERE observed_at < now() - retention).
CREATE INDEX IF NOT EXISTS idx_avail_obs_observed_at
  ON availability_observations(observed_at);

-- RLS: deny-all like every other app table (the service role the worker/app use
-- bypasses RLS). See 009_rls_lockdown.sql.
ALTER TABLE availability_observations ENABLE ROW LEVEL SECURITY;
