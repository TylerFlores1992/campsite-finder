-- Track Campflare subscription IDs on watches so we can cancel them
ALTER TABLE watches ADD COLUMN IF NOT EXISTS campflare_sub_id TEXT;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ;

-- Notification log
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id TEXT REFERENCES watches(id) ON DELETE SET NULL,
  campground_id TEXT REFERENCES campgrounds(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'webhook')),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'pending')),
  payload JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_watch ON notifications(watch_id);
