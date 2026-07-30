-- Per-(watch, site) alert cooldown.
--
-- WHY. `watches.notification_sent_at` is a single timestamp per watch, and the
-- poller skipped any watch that had alerted in the last hour. So the FIRST site to
-- open muted the whole watch: if site 008 opened at 23:17 and site 015 opened at
-- 23:20, the user did not hear about 015 until 00:19 — and auto-cart never tried
-- for it either, because the watch was dropped from the candidate query entirely,
-- not just the notification.
--
-- For a product that promises alerts "within seconds of a cancellation", losing a
-- different site for up to an hour is the difference between getting a booking and
-- not. This table moves the cooldown to the pair, so a genuinely new site alerts
-- immediately while the same site re-opening still respects the hour.
--
-- `site_key` is the provider's campsite id where one exists (rec.gov/RIDB and
-- ReserveCalifornia units). ReserveAmerica, GoingToCamp and TN/SC report
-- campground-level availability with no site id, so they use the '*' sentinel and
-- therefore keep exactly the old per-watch behaviour — which is correct for them,
-- since "a site opened" is all those sources can tell us.
-- watch_id is TEXT because `watches.id` is TEXT (not UUID, despite holding
-- UUID-shaped values) — `autocart_jobs.watch_id` already follows the same rule.
-- A UUID column here fails outright: "foreign key constraint cannot be implemented".
CREATE TABLE IF NOT EXISTS watch_site_alerts (
  watch_id      TEXT        NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  site_key      TEXT        NOT NULL,
  last_alert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watch_id, site_key)
);

-- The claim is a single INSERT .. ON CONFLICT .. WHERE, so this index is the
-- primary key above; no secondary index is needed for the hot path. This one is
-- for the sweeper that trims rows for stays that are long gone.
CREATE INDEX IF NOT EXISTS watch_site_alerts_last_alert_idx
  ON watch_site_alerts (last_alert_at);

ALTER TABLE watch_site_alerts ENABLE ROW LEVEL SECURITY;
