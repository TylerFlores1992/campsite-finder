-- ReserveCalifornia "coming soon" alerts. When a watched RC site is cancelled it
-- enters a held state (locked until a release time, usually 8am next day). We send
-- a heads-up once per release event; this column dedupes it (stores the release
-- timestamp we last alerted for) independently of notification_sent_at, so the
-- real "now available" alert still fires when the site actually opens.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS rc_hold_notified_for TEXT;
