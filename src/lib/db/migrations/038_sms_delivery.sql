-- SMS delivery tracking.
--
-- `notifications.status = 'sent'` has never meant the text arrived. It means Twilio's
-- API returned 2xx — i.e. we handed the message over. Everything after that (carrier
-- rejection, an unreachable handset, an A2P filtering block, a landline) happens
-- seconds to minutes later and was invisible to us: the row said `sent` and the user's
-- phone stayed quiet. That is the worst failure this product has, because the whole
-- promise is "we text you within seconds", and we could not tell the difference
-- between a delivered alert and a silently dropped one.
--
-- Twilio reports the real outcome asynchronously to a StatusCallback URL. These columns
-- are where that answer lands.
--
--   provider_id      the Twilio Message SID (SM…) — the key the callback arrives with.
--   delivery_status  Twilio's own vocabulary, stored verbatim: queued, sending, sent,
--                    delivered, undelivered, failed. NOT remapped into our `status`
--                    column: `status` records what WE did (handed it over / didn't),
--                    `delivery_status` records what the carrier did. Collapsing them
--                    would destroy the distinction that makes this useful.
--   delivery_error   Twilio error code + message on undelivered/failed (e.g. 30003
--                    "unreachable destination handset", 30007 "carrier violation").
--   delivered_at     when the terminal status landed.
--
-- Nullable throughout, with no backfill: every pre-existing row genuinely has no
-- delivery information, and inventing 'delivered' for them would poison the first
-- metric anyone computes off this table.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_id      TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_status  TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_error   TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ;

-- The callback looks a row up by SID and nothing else, several times per message
-- (queued → sent → delivered). Partial, because only SMS rows ever have one.
CREATE INDEX IF NOT EXISTS idx_notifications_provider
  ON notifications(provider_id)
  WHERE provider_id IS NOT NULL;

-- Feeds the admin "did the texts actually arrive?" panel: recent SMS rows by outcome.
CREATE INDEX IF NOT EXISTS idx_notifications_sms_recent
  ON notifications(created_at DESC)
  WHERE channel = 'sms';
