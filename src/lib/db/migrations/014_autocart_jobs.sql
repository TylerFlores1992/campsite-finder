-- Cart-outcome-gated alerts for auto-cart users.
--
-- Instead of texting the instant a rec.gov site opens (false hope when it's gone
-- before we can grab it), the poller creates a PENDING job here for auto-cart
-- users, the bot attempts the cart and reports the outcome back, and the alert is
-- decided on that outcome:
--   carted                    → "it's in your cart, check out"
--   not carted, still open    → normal "book it yourself" alert (re-verified live)
--   not carted, gone          → silence (no false hope)
-- This table is also the permanent record of every cart attempt (the bot's
-- console was previously the only place outcomes were visible).
CREATE TABLE IF NOT EXISTS autocart_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  watch_id TEXT REFERENCES watches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campground_id TEXT,
  campsite_id TEXT,               -- the specific rec.gov campsite to cart
  payload JSONB NOT NULL,         -- the NotificationPayload to send on resolve
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cart_outcome TEXT,              -- bot report: carted|already-booked|dates-not-found|calendar-not-loaded|cta-not-ready|error|skipped-not-logged-in
  cart_reported_at TIMESTAMPTZ,
  resolution TEXT,                -- carted|alerted|silent   (NULL = still deciding)
  resolved_at TIMESTAMPTZ
);

-- Fast lookup of the still-deciding jobs the reconciler scans each cycle.
CREATE INDEX IF NOT EXISTS idx_autocart_jobs_pending ON autocart_jobs (detected_at) WHERE resolution IS NULL;
CREATE INDEX IF NOT EXISTS idx_autocart_jobs_user ON autocart_jobs (user_id, detected_at DESC);

-- Match the security lockdown: RLS on, no policies (service role bypasses).
ALTER TABLE autocart_jobs ENABLE ROW LEVEL SECURITY;
