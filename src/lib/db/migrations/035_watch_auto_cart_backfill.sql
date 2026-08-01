-- 035: make watches.auto_cart mean something (2026-08-01).
--
-- The column has existed since 001 and had NEVER been written: every row in
-- production was the `false` default. Meanwhile the New watch screen showed an
-- auto-cart toggle (defaulting to ON) whose value was never sent to the API, and the
-- poller decided the auto-cart lane purely from users.autocart_enabled. So turning
-- the toggle OFF carted anyway — reported from a real device 2026-08-01 — and two
-- other features silently never rendered, because both read this column: the
-- "Auto-cart" tag on a watch card, and the authexpired "Reconnect Recreation.gov"
-- recovery state.
--
-- THE BACKFILL IS THE WHOLE RISK. The poller now requires auto_cart = true for the
-- lane; with every row false that would switch auto-cart off for everyone who has it
-- today. So set it true for exactly the watches that ARE carting right now — active,
-- unexpired, owned by an account with autocart_enabled — which makes the new
-- behaviour identical to the old for existing data and different only for watches
-- created from here on, where the toggle finally decides.
--
-- Deliberately not scoped to source = 'ridb': isAutocartLane already requires that,
-- and a user who later watches a rec.gov campground shouldn't find the flag missing
-- because their old watch happened to be a state park.

UPDATE watches w
   SET auto_cart = true
  FROM users u
 WHERE u.id = w.user_id
   AND u.autocart_enabled = true
   AND w.active = true
   AND w.end_date > CURRENT_DATE
   AND w.auto_cart = false;
