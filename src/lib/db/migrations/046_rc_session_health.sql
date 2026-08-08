-- Make "can the bot actually drive ReserveCalifornia?" a server-side fact.
--
-- WHAT 045 MISSED. The runner heartbeat is stamped by `GET /api/auto-cart/rc-holds` —
-- the feed poll. That proves the process is alive and can reach camphawk.app. It proves
-- NOTHING about whether it can touch RC, and those are different failures.
--
-- `runPass()` has three paths that do the whole job and change nothing:
--   • the Chromium profile lock is held (rc-keepwarm has it, or a crashed process left a
--     lock file behind) → "skipping this pass, work stays queued";
--   • the RC session is dead — no token in localStorage → "a human must run --login";
--   • launchPersistentContext throws.
-- In all three the hold stays `requested`, `updated_at` never moves, no `failed` row is
-- written, and the runner keeps polling the feed happily — so `autocart.rc_runner` stays
-- GREEN. That is precisely the signature of 2026-08-07: offered 05:26, tapped 06:00,
-- released 08:00, and six hours later the row was byte-identical to the tap.
--
-- So 045 built a beacon one level too shallow. It catches "the process is gone". It
-- cannot catch "the process is fine and useless", which is the failure we actually had.
--
-- TWO ADDITIONS, and the split matters.
--
-- 1. SESSION LIVENESS, on the heartbeat row. `rc-keepwarm.mjs` already asks RC a question
--    only an authenticated session can answer, every 20 minutes, and throws the answer
--    away into a console on a box nobody watches. It is the single most valuable signal
--    we have and it was never leaving the mini-PC. Reported here it becomes a warning the
--    EVENING BEFORE a release — while a human can still sign in — instead of a
--    post-mortem at 08:00:10. A dead RC session needs a person (RC serves a reCAPTCHA
--    now, so no unattended re-login exists), and a person needs lead time.
--
-- 2. LAST ATTEMPT, per hold. When the runner skips, the affected rows record WHY without
--    changing status — they must still retry, so `failed` would be a lie. On 08-07 the
--    row would have read `requested — RC session is dead (last try 14:59:58)` instead of
--    saying nothing at all. Status answers "what happened to my hold"; this answers "is
--    anyone even trying", and one cannot be derived from the other.
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_ok     BOOLEAN;
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_at     TIMESTAMPTZ;
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_detail TEXT;
-- Which process last answered. keep-warm owns the session and probes it on a schedule;
-- the runner only finds out when it opens the profile to do real work. A stale report
-- from the runner alone means keep-warm is down, which is its own problem.
ALTER TABLE rc_runner_heartbeat ADD COLUMN IF NOT EXISTS session_source TEXT;

COMMENT ON COLUMN rc_runner_heartbeat.session_ok IS
  'Whether RC accepted the profile session at the last check. NULL means never reported — treat as unknown, never as healthy.';

ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS last_attempt_at   TIMESTAMPTZ;
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS last_attempt_note TEXT;

COMMENT ON COLUMN rc_hold_requests.last_attempt_note IS
  'Why the last runner pass could not act on this hold, recorded WITHOUT moving status — a skipped pass must still retry, so marking it failed would be false. Empty on a hold nothing has tried yet.';
