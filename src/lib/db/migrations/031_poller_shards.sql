-- Shard leases for the alert poller.
--
-- Capacity against rec.gov is per egress IP (measured 2026-07-31: three Fly machines,
-- two sharing a /24, all clean at ~16 req/min each). One machine sustains roughly four
-- campground-months at a 15s cadence, so growth past that means more machines, each
-- polling a disjoint slice.
--
-- The slice is claimed here rather than configured per machine. Per-machine env vars
-- drift and have to be set by hand on every new machine; a lease makes machines
-- interchangeable — clone one and it picks up a free index by itself.
--
-- Deliberately the same shape as watch_site_alerts' claim: a single atomic
-- INSERT .. ON CONFLICT .. WHERE, so two machines racing for an index cannot both win.
CREATE TABLE IF NOT EXISTS poller_shards (
  shard_index  int PRIMARY KEY,
  machine_id   text        NOT NULL,
  -- The holder renews well inside this. Once it passes, any machine may take the index
  -- over, which is what makes a dead machine recoverable without human intervention.
  leased_until timestamptz NOT NULL,
  -- Written by the holder on every renew so /api/health/status can tell how many shards
  -- are SUPPOSED to exist. Without it, a shard whose machine never started looks
  -- identical to a shard that was never configured — and that gap is silent blindness:
  -- its campgrounds simply stop being watched while everything else reports green.
  shard_count  int         NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT NOW()
);

-- Health reads "is every index 0..count-1 currently leased", which is a small scan of
-- an inherently tiny table, but the index keeps it honest as the count grows.
CREATE INDEX IF NOT EXISTS poller_shards_leased_until_idx ON poller_shards (leased_until);

-- Service-role only, like the rest of the worker's tables. No anon policy: nothing
-- client-side has any business reading which machine owns which campgrounds.
ALTER TABLE poller_shards ENABLE ROW LEVEL SECURITY;
