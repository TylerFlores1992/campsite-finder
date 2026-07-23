-- When the bot last CONFIRMED the user's rec.gov session is live — stamped on every
-- successful sign-in and every keepalive "kept warm" (POST /api/auto-cart/enrollment
-- with connected=true). `autocart_connected` is a sticky boolean that only flips off
-- when the bot actively detects death (at a keepalive, ~every 30m); between keepalives
-- a silently-expired session still reads connected, so an opening can be routed into
-- the silent auto-cart lane and swallowed. This timestamp lets the poller treat the
-- session as usable only if the confirmation is RECENT (fail-open: stale/never-verified
-- → normal alert lane), closing that window.
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocart_verified_at TIMESTAMPTZ;
