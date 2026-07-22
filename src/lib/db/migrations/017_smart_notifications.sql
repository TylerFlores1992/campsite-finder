-- Smarter notifications (feature D): one-tap actions from alerts, site-specific
-- mute, and the dead-man's switch for stale watches.

-- Site-specific mute: site ids the poller must NOT alert on for this watch
-- (rec.gov campsiteId / ReserveCalifornia unitId). The poller fires only when a
-- NON-muted site is open — so "Silver Lake site 002" can keep opening in silence
-- while you still get pinged the moment any other site frees up. Count-only sources
-- (GoingToCamp, TN/SC) have no site ids, so nothing to mute there.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS muted_site_ids TEXT[] NOT NULL DEFAULT '{}';

-- Dead-man's switch: when we last asked "still want this?" (NULL = never asked).
ALTER TABLE watches ADD COLUMN IF NOT EXISTS deadman_prompted_at TIMESTAMPTZ;

-- One-tap action links. A short opaque token maps to an action so SMS links stay
-- tiny (camphawk.app/w/<token>). One row per (watch, action, site) — reused across
-- alerts so links are stable and the table stays bounded; pruned past expiry.
CREATE TABLE IF NOT EXISTS action_tokens (
  token       TEXT PRIMARY KEY,
  watch_id    TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,   -- 'stop' | 'reopen' | 'mute_site' | 'keep' | 'cancel'
  site_id     TEXT,            -- the site to mute, for action='mute_site'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days'
);
-- One stable token per (watch, action, site). COALESCE so the NULL site_id rows
-- (stop/reopen/keep/cancel) still dedupe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_tokens_unique
  ON action_tokens (watch_id, action, COALESCE(site_id, ''));
CREATE INDEX IF NOT EXISTS idx_action_tokens_watch ON action_tokens (watch_id);
