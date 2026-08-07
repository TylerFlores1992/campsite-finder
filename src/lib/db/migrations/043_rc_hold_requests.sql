-- Day-before opt-in holds for ReserveCalifornia's 8am releases.
--
-- THE IDEA (owner's, 2026-08-07). RC holds a cancelled site until a release time, and
-- that time is 08:00 in 289 of 292 real locks measured across 70 facilities — 99%. So we
-- know the night BEFORE exactly which sites open and when. Rather than polling all day
-- and racing to cart whatever appears, the coming-soon alert asks: *do you want this
-- one?* If they say yes, the bot carts that specific unit at that specific second.
--
-- Why this is better than carting on detection, beyond the saved polling:
--   • We only ever hold inventory somebody explicitly asked for. A bot that grabs sites
--     speculatively takes them off the market from other campers; this one cannot.
--   • Consent removes the race. The 2.5s release-and-recapture window exists to hand a
--     surprise hold to someone who didn't ask for it. Here they asked, so the site can
--     sit in the bot's cart until they claim it.
--   • It fails safe. No opt-in means no cart, which is exactly today's behaviour.
--
-- LIFECYCLE. offered → requested → carted → claimed, with dead ends at expired/failed.
--   offered   the alert went out with a "hold it for me" link; nobody has tapped yet
--   requested the user tapped. THIS is the only state that authorises a cart.
--   carted    the bot holds it; cart_key/cart_entry_key are how it releases
--   claimed   the user's own session took it — the bot is out of the picture
--   expired   release_at passed without a tap, or the hold lapsed
--   failed    the bot tried and could not; `error` says why
--
-- A row is created at ALERT time, not at tap time, so the tap carries no booking data.
-- The alternative — encoding unit/dates/release into a token — puts details in a URL
-- that outlives them and cannot be corrected if the grid changes before 8am.
CREATE TABLE IF NOT EXISTS rc_hold_requests (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  watch_id      TEXT        NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campground_id TEXT        NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  -- The RC unit, and the label a human recognises ("#L006"). We learned the hard way
  -- that UnitId alone is unmatchable against RC's own pages.
  unit_id       TEXT        NOT NULL,
  unit_name     TEXT,
  arrival_date  DATE        NOT NULL,
  nights        INT         NOT NULL DEFAULT 1,
  -- RC's own release timestamp, verbatim (ISO local, no zone — RC times are Pacific).
  -- Stored as text for the same reason dates are parsed as strings in the alert copy:
  -- `new Date('...')` on a zone-less string reinterprets it and shifts the hour.
  release_at    TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'offered'
                CHECK (status IN ('offered','requested','carted','claimed','expired','failed')),
  offered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_at  TIMESTAMPTZ,
  carted_at     TIMESTAMPTZ,
  claimed_at    TIMESTAMPTZ,
  -- How the bot releases this exact entry without disturbing anything else it holds.
  cart_key       TEXT,
  cart_entry_key TEXT,
  error         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One offer per (watch, unit, arrival). A re-alert for the same opening must update the
-- existing row rather than stack duplicates — otherwise a user who taps once could be
-- carted twice, and the bot would hold two entries it only knows how to release one of.
CREATE UNIQUE INDEX IF NOT EXISTS rc_hold_requests_unique
  ON rc_hold_requests (watch_id, unit_id, arrival_date);

-- The bot's hot query: "what has been requested and is due about now?"
CREATE INDEX IF NOT EXISTS rc_hold_requests_due
  ON rc_hold_requests (status, release_at);

ALTER TABLE rc_hold_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE rc_hold_requests IS
  'Opt-in holds for RC 8am releases. A row is created when the coming-soon alert goes out (status offered) and only a user tap moves it to requested, which is the sole state that authorises the bot to cart.';
