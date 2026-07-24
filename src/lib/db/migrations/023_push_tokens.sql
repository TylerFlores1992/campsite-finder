-- Native push registration for the mobile app (Capacitor + FCM). One row per device
-- token; a user has many (phone + tablet, reinstalls, etc.). Push is a THIRD alert
-- channel alongside email/SMS — `notifications.channel` already allows 'push' (see
-- migration 002). Tokens are minted by the app shell and registered via
-- POST /api/user/push-token; dead tokens (FCM 404/UNREGISTERED) are pruned on send.
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);

-- RLS: deny-all like every app table; the service role (worker + API) bypasses it.
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
