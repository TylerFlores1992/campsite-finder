-- Whether the user has completed their one-time recreation.gov sign-in on the
-- bot machine. Reported by the broker/bot via POST /api/auto-cart/enrollment
-- the moment the session is verified; lets the app hide "set up auto-cart"
-- nudges once setup is genuinely done (toggle on + signed in).
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocart_connected BOOLEAN NOT NULL DEFAULT false;
