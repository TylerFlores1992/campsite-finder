-- Per-user opt-in for the personal auto-cart bot. When true, the user's openings
-- appear in the master roster feed (/api/auto-cart/roster) the Pi bot pulls.
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocart_enabled BOOLEAN NOT NULL DEFAULT false;
