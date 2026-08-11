-- RENUMBERED 051 -> 052 on merge: 051 was already taken by bot_update_requests, which was
-- applied to production on 2026-08-10. Two files claiming one number is not a cosmetic
-- clash - a runner that tracks applied migrations by number would consider 052 already
-- done, skip it silently, and /api/user/autocart would 500 on every toggle against
-- columns that never got created.

-- Tracking for the "finish connecting auto-cart" nudge email.
--
-- Two accounts sat with autocart_enabled=true and autocart_connected=false for days
-- with nobody told: iamtylerflores12345@yahoo.com's session died 2026-07-29 and was
-- never reconnected, and dgmerlo25@gmail.com enabled auto-cart 2026-08-05 and never
-- finished /connect. Neither is visible anywhere but the settings page, which nobody
-- was looking at.
--
-- `autocart_enabled_at` is stamped when the toggle is switched ON, separate from
-- `updated_at` (bumped by syncUser on every authenticated page load, so it says
-- nothing about when the toggle was flipped — see the CLAUDE.md note on
-- users.updated_at). It is what lets the "never connected" nudge wait for the
-- *next* calendar day rather than firing the moment someone signs up.
--
-- `autocart_nudge_sent_at` is stamped by BOTH send paths (the enrollment route, the
-- moment the bot reports connected=false after having been true; and the daily cron,
-- for someone who never connected at all) so the cron never double-sends someone the
-- enrollment route already caught, and a resend button (if one is ever added) has
-- something to show.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS autocart_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS autocart_nudge_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN users.autocart_enabled_at IS
  'When autocart_enabled was last switched to true. NULL for rows enabled before this column existed — treated as "eligible now" by the nudge cron, not as "never enabled".';
COMMENT ON COLUMN users.autocart_nudge_sent_at IS
  'When the "finish connecting auto-cart" email was last sent. NULL = never sent.';
