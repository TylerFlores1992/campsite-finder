-- RC RELEASE-WINDOW READINGS: one row per (run, facility), so day 1 can sit beside day 7.
--
-- `scripts/rc-release-window.mts` measures WHEN ReserveCalifornia actually lets go of a
-- locked campsite, at 2-second resolution, by polling a facility's whole grid across a
-- release. Its first run (2026-09-04) answered a question the poller structurally could not:
-- rc-583's flip bracket was (-2.2s, -0.2s], ENTIRELY before the predicted release.
--
-- It then became a daily Routine for a week (09-05 through 09-11) — and the readings had
-- nowhere to go. Seven runs print to stdout in seven ephemeral sessions, and putting day 1
-- beside day 7 meant opening seven transcripts by hand. That is exactly how the 08-23
-- allocation attributions were lost to a 16,000-character `tail-log` window before PR #169
-- moved readings into Postgres. This is the same fix.
--
-- WHAT A ROW HOLDS. The facility's flip as a BRACKET — the last poll it was seen locked and
-- the first poll it was seen free, both relative to T in seconds — never a midpoint, because
-- a midpoint invents precision a 2-second cadence does not have. `bracket_lo_s` is the
-- LATEST "still locked" observation across the facility's nights and `bracket_hi_s` the
-- EARLIEST "free" — the tightest interval the run supports. When a facility does not flip
-- atomically (every night in one bracket, which is the pattern so far) the per-night detail
-- says so, and `split_brackets` counts how many distinct first-free instants there were.
--
-- NULLs ARE ABSENCES. A facility whose nights never freed has NULL `bracket_hi_s`; a night
-- never seen locked inside the window has no `bracket_lo_s` to contribute. A run that never
-- reached the question (nothing locked, or every poll unreadable) records NO row — an
-- empty day is "not measured", never "RC released nothing".

CREATE TABLE IF NOT EXISTS rc_release_readings (
  id                 bigserial PRIMARY KEY,
  run_at             timestamptz NOT NULL DEFAULT NOW(),
  -- RC's own zone-less PACIFIC wall clock for the release, exactly as the Lock field says it,
  -- e.g. '2026-09-05T08:00:00'. TEXT for the same reason `rc_hold_requests.release_at` is.
  release_at         text NOT NULL,
  -- 'rc-539', the campground id the poller uses for the facility.
  facility           text NOT NULL,
  nights_tracked     integer NOT NULL,
  nights_freed       integer NOT NULL,
  nights_retaken     integer NOT NULL,
  -- Seconds relative to T. Negative is before the predicted release.
  bracket_lo_s       numeric,
  bracket_hi_s       numeric,
  earliest_free_s    numeric,
  latest_free_s      numeric,
  quickest_retake_s  numeric,
  split_brackets     integer NOT NULL DEFAULT 1,
  polls              integer NOT NULL,
  unreadable         integer NOT NULL,
  -- Per-night: [{name, date, lockedS, freeS, retakenS}], so a split can be read.
  detail             jsonb,
  created_at         timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rc_release_readings_release_idx
  ON rc_release_readings (release_at, facility);

ALTER TABLE rc_release_readings ENABLE ROW LEVEL SECURITY;
