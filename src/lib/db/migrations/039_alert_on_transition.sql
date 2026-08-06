-- Alert on the TRANSITION, not on the state.
--
-- WHY. The claim re-fires for any (watch, site) whose last alert is over an hour old,
-- and nothing recorded whether the site had been open that whole time. So a site that
-- simply STAYED open produced one text and one email every hour, indefinitely: Silver
-- Lake sent 16 identical alerts in a single day for one opening (2026-08-05, verified
-- in `notifications`). That is not a reminder, it is a drumbeat — and it costs a
-- message fee per hour per subscriber for information they already have.
--
-- A cancellation is an EVENT. The product promise is "we tell you within seconds when
-- a site opens", which is once per opening. Re-alerting is only meaningful when the
-- site actually went away and came back, because that is a new chance to book.
--
-- `last_seen_open_at` is stamped on EVERY cycle where we find the site open, whether
-- or not we alert. The claim can then tell "open continuously since the last alert"
-- (recent stamp) apart from "closed, then re-opened" (stale stamp) — the distinction
-- the old single timestamp could not express.
--
-- NULL means "never tracked": every row that predates this migration. Those keep the
-- old hourly behaviour until the poller stamps them, which it does the first time it
-- sees the site open. Backfilling a value would be a guess about history we do not
-- have, and guessing SUPPRESSED would silence a real re-opening.
ALTER TABLE watch_site_alerts
  ADD COLUMN IF NOT EXISTS last_seen_open_at TIMESTAMPTZ;

COMMENT ON COLUMN watch_site_alerts.last_seen_open_at IS
  'Last cycle we observed this site open, alerted or not. A recent value means the site never closed, so a re-alert would be noise rather than news. NULL = pre-migration-039 row, treated as "we do not know".';
