-- One machine runs each nightly catalog sync, not every machine.
--
-- WHY: `SHARD_COUNT = 2` (2026-08-02) shards the POLLING by campground, but
-- `rcSyncIfDue` / `gtcSyncIfDue` in worker/poller.ts were never shard-aware — so both
-- machines ran the WHOLE catalog sync. The only guard was `rcSyncRunning`, an
-- in-process boolean, which cannot see the other machine. Both evaluate "is a sync
-- due?" against sync_log before either has finished, both see yes, both start.
--
-- Measured damage, 2026-08-03: two identical UseDirect chains ran 45 seconds apart
-- through the same states, and every error was `RC proxy /search/grid → 502 upstream
-- 403`. Ohio 311 errors, Minnesota 80 and 140, Illinois 139 and 42, Virginia 80 and 10.
-- Minnesota had logged ZERO errors every night from 07-17 through 08-02. The reason it
-- hurts is that UseDirect syncs route through /api/rc-proxy on VERCEL, so both workers
-- exit from the same Vercel IPs — and these WAFs meter per IP. It is the same mistake
-- `coalesce: false` on the nightly sync already exists to avoid.
--
-- Same shape as poller_shards (031) and watch_site_alerts (026): one atomic
-- INSERT .. ON CONFLICT .. WHERE decides the winner, so two machines racing cannot
-- both win. A holder renews while it works; an expired claim is takeable, so a machine
-- that dies mid-sync does not block the catalog forever.
CREATE TABLE IF NOT EXISTS sync_claims (
  job          TEXT PRIMARY KEY,        -- 'usedirect' | 'goingtocamp'
  machine_id   TEXT        NOT NULL,
  claimed_until TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match the security lockdown: RLS on, no policies (service role bypasses).
ALTER TABLE sync_claims ENABLE ROW LEVEL SECURITY;
