-- Liveness beacon for the mini-PC auto-cart bot.
--
-- The bot polls /api/auto-cart/roster every couple of seconds; that endpoint
-- stamps beat_at here on each authorized poll. The Fly poller reads it to decide
-- whether the bot is genuinely online BEFORE routing a rec.gov opening into the
-- silent cart-outcome lane (014_autocart_jobs).
--
-- Why this exists: an auto-cart watch only enters that lane while the user is
-- flagged connected, and the lane deliberately stays SILENT when a site is gone
-- by the ~35s reconcile. If the bot is actually down (box off, process crashed,
-- network cut) nothing carts the opening, so the silent branch swallows a real
-- cancellation with no alert — exactly the miss this guards against. A stale beat
-- makes those watches fall back to normal immediate alerts. The failure mode is
-- deliberately fail-OPEN: no beat / a read error => treat the bot as offline =>
-- alert, never swallow.
CREATE TABLE IF NOT EXISTS autocart_bot_heartbeat (
  id      int PRIMARY KEY DEFAULT 1,
  beat_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO autocart_bot_heartbeat (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Match the security lockdown: RLS on, no policies (service role bypasses).
ALTER TABLE autocart_bot_heartbeat ENABLE ROW LEVEL SECURITY;
