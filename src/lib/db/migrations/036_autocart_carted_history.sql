-- One auto-cart per (watch, site).
--
-- The poller asks "has this watch already had this exact site carted?" before it
-- queues a job (worker/poller.ts → alreadyCartedForWatch). Nothing else in the
-- schema answered that question quickly: the existing indexes are on detected_at
-- (pending jobs) and (user_id, detected_at).
--
-- Why the rule exists: the alerting claim (watch_site_alerts, migration 026) has a
-- 1-hour window, so an opening that STAYS open re-claims every hour and queued a
-- fresh cart job every hour; the bot's own guard is a 20-minute TTL sized for
-- rec.gov's cart hold, so it had long since forgotten. Silver Lake site 84611 was
-- carted five times in five hours on 2026-08-02 for one watch.
--
-- Partial: only the carted rows are ever looked up, and they are the minority.
CREATE INDEX IF NOT EXISTS idx_autocart_jobs_carted_site
  ON autocart_jobs (watch_id, campsite_id)
  WHERE resolution = 'carted' OR cart_outcome = 'carted';
