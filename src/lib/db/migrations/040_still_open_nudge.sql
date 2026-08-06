-- One "still open" nudge, six hours after the alert.
--
-- WHY. Migration 039 stopped the hourly repeat by alerting on the transition rather
-- than the state — the right fix, but it removed something real along with the noise:
-- the repeat was incidentally a retry. If the first alert was missed (a filtered text,
-- a phone face-down overnight), nothing followed it.
--
-- So: exactly ONE follow-up, and only while the site is still open. Not a schedule —
-- a single second chance. `nudged_at` is what makes it once rather than every six
-- hours, which is the bug we just came from.
--
-- It RESETS to NULL whenever the pair genuinely re-opens, because that is a new
-- opening and deserves its own second chance. A nudge that could only ever fire once
-- per (watch, site) for the life of the watch would go quiet after the first stay.
ALTER TABLE watch_site_alerts
  ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;

COMMENT ON COLUMN watch_site_alerts.nudged_at IS
  'When the one-time "still open" follow-up was sent for the CURRENT opening. NULL = not yet nudged; reset to NULL on a genuine re-open so each opening gets its own single nudge.';
