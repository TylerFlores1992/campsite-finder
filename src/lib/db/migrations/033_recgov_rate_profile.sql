-- 033: rec.gov full-day rate profile (2026-08-01).
--
-- The 15/min budget (worker/recgov-scheduler.ts) was calibrated almost entirely in
-- quiet hours. Before any sub-15s hot lane is promised, we need to know whether that
-- budget survives rec.gov's peak hours — so the worker records its own rec.gov fetch
-- outcomes in 5-minute buckets for a full day (and keeps doing so; retention is
-- pruned by the recorder). One row per (bucket, machine): counters accumulate via
-- ON CONFLICT so a double flush can never double-count a request that happened once.
--
-- ok / throttled_429 / timeout / error are NETWORK outcomes (what rec.gov did);
-- denied / breaker_skipped are LOCAL outcomes (what our own budget and breaker did).
-- The distinction matters: a clean hour with high denials means WE were the
-- bottleneck (headroom exists upstream); 429s mean rec.gov was.
--
-- Read out with: NODE_USE_ENV_PROXY=1 npx tsx scripts/recgov-429-profile.mts

CREATE TABLE IF NOT EXISTS recgov_rate_profile (
  bucket_start    timestamptz NOT NULL,
  machine_id      text        NOT NULL,
  ok              int         NOT NULL DEFAULT 0,
  throttled_429   int         NOT NULL DEFAULT 0,
  timeout         int         NOT NULL DEFAULT 0,
  error           int         NOT NULL DEFAULT 0,
  denied          int         NOT NULL DEFAULT 0,
  breaker_skipped int         NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bucket_start, machine_id)
);

-- Same posture as alert_canary/action_tokens: service-role access only.
ALTER TABLE recgov_rate_profile ENABLE ROW LEVEL SECURITY;
