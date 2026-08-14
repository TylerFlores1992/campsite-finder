-- WHICH CHROMIUM EATS THE COMMIT, AND HOW FAST?
--
-- On 2026-08-12 one chrome.exe on one of our profiles reached 9.4 GB private, growing about
-- 395 MB/min, and drove Windows COMMIT to 99% of 50 GB. At that point supervise.ps1 could not
-- start a shell ("the paging file is too small", then an OutOfMemoryException), so the process
-- whose entire job is recovery failed at the one moment it exists for — and every remote lever
-- with it, because the watchdog, kill-chrome and bot_commands all ride pollers on that box. It
-- ended with somebody power-cycling the machine by hand. It is the only failure left that has
-- ever needed that.
--
-- WHICH PROFILE FAMILY LEAKED HAS NEVER BEEN ESTABLISHED. It was guessed twice and wrong both
-- times, from regexes that cannot settle it — the RC profile is
--     ...\scripts\auto-cart-bot\.rc-bot-profile
-- and the rec.gov profiles are
--     ...\scripts\auto-cart-bot\profiles\<userId>
-- so both contain the substring `auto-cart-bot`. `memory` prints the full directory now, which
-- fixes the reading. It does not fix the SAMPLING, and that is what this table is for.
--
-- ── WHY A TABLE AND NOT "TAKE TWO READINGS" ────────────────────────────────────────────────
-- The prescribed method is two `memory` readings five minutes apart, because the growth RATE
-- is the signature. Run on 2026-08-14 it produced a clean, useless answer: the same 8 pids in
-- both readings, 312 MB -> 264 MB, a NEGATIVE rate. Useless not because the box was healthy,
-- but because of what was not running:
--
--   * every process sampled was on the RC profile, and
--   * `keepSessionsWarm` opens a rec.gov Chromium per enrolled user every THIRTY MINUTES and
--     closes it again.
--
-- So the family that has never been ruled out is EPISODIC, and a five-minute window has
-- roughly one chance in ten of overlapping one at all. Two manual readings do not merely risk
-- missing it — they are structurally unlikely to sample it. No human and no agent is going to
-- be watching at the moment it happens; that is why the leak has survived three sightings with
-- its cause unattributed.
--
-- This is the same remedy as `recgov_rate_profile` (033) for the 429 question and
-- `rc_app_session_probes` (058) for the RC session, and the same lesson as 047: reasoning from
-- "when we noticed" is how a bounded observation becomes a confident wrong number. A series is
-- what replaces it.
--
-- ── ONE ROW PER SAMPLE, WITH THE BIGGEST PROCESS NAMED ─────────────────────────────────────
-- Per-family totals alone cannot say whether 9 GB is one runaway process or thirty ordinary
-- ones, and the 08-12 event was ONE process. The largest is therefore carried explicitly,
-- with its pid — a pid is what lets two samples be paired, and pairing is what turns two
-- numbers into a rate.
--
-- CONTAINS NO COMMAND LINE. Chromium argv carries flags and sometimes URLs; the profile
-- DIRECTORY is the one field needed to attribute a leak, so it is the only one taken. Same
-- rule the `memory` command follows, and the one the precart diagnostic broke when it reported
-- location.href and shipped an OAuth authorization code.

CREATE TABLE IF NOT EXISTS chromium_memory_samples (
  id            bigserial PRIMARY KEY,
  taken_at      timestamptz NOT NULL DEFAULT NOW(),
  -- Which process took the sample. The RC pair have died twice while bot.mjs stayed healthy
  -- (2026-08-11, and the 08-14 REPL launch), so knowing the reporter separates "nothing was
  -- leaking" from "nothing was sampling".
  source        text,

  -- Windows COMMIT — RAM plus page file. This is the resource that ran out; RAM alone read
  -- fine throughout, and `disk-free` answering 404 GB the same night is what sent the first
  -- diagnosis the wrong way.
  commit_used_mb  numeric,
  commit_limit_mb numeric,
  ram_free_mb     numeric,

  -- Per family. NULL means "not reported"; 0 means "reported, and there were none" — a
  -- distinction this codebase keeps having to relearn, most recently when a broken rollup
  -- printed `rc 0 MB` and that read as the RC profile being innocent.
  rc_procs      integer,
  rc_mb         numeric,
  recgov_procs  integer,
  recgov_mb     numeric,
  other_procs   integer,
  other_mb      numeric,

  -- The single largest Chromium of ours, which is the shape the 08-12 event actually had.
  max_pid       integer,
  max_mb        numeric,
  max_family    text,

  created_at    timestamptz NOT NULL DEFAULT NOW()
);

-- Every read is "newest first", and the rate calculation walks a window backwards.
CREATE INDEX IF NOT EXISTS chromium_memory_samples_taken_idx
  ON chromium_memory_samples (taken_at DESC);

-- Admin-only surface, written by the service role. RLS on, no policy: nothing reaches it
-- through the anon key. Same posture as the rest of migration 027's tables.
ALTER TABLE chromium_memory_samples ENABLE ROW LEVEL SECURITY;
