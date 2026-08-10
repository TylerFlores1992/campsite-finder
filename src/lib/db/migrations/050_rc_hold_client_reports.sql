-- What the USER'S OWN DEVICE did during the hand-off.
--
-- Everything recorded about a hold so far is what the SERVER and the BOT did: offered,
-- requested, carted, claiming, released. The last two seconds — the part that decides
-- whether the user actually gets the site — happen inside a webview on their phone, and
-- nothing about it reaches us. A hold that ends `released` looks identical whether the
-- injected precart carted the site, threw on line 1, or never ran.
--
-- That is the same gap `executeScript` had before the reporter existed, and the same
-- family as `notifications.status = 'sent'` meaning only "Twilio returned 2xx": a value
-- that records our side of a handoff and gets read as the outcome.
--
-- The reports themselves are already built (lib/rc-precart-script) and already proven on
-- both platforms. This is only the durable end: without it they are visible for as long
-- as the claim screen stays open and then gone, which is no use at 08:00 when nobody is
-- reading a diagnostic panel.
--
-- NOT A NEW TABLE. One jsonb array on the hold, because these are worthless detached from
-- the hold they describe and there is never a reason to query them across holds. Appended
-- and capped in `recordClientReports` — an unbounded array on a row that is also written
-- by the cart path is a way to make the 08:00 write slow.
--
-- CONTAINS NO CREDENTIAL. The reporter sends stage names, RC's own user-facing status
-- text, and booleans about the token (`captured`, `length`) — never the token, never the
-- cart key, and URLs as origin+pathname so Okta's `?code=` never travels. Guarded by
-- worker/rc-handoff.test.mts.

ALTER TABLE rc_hold_requests
  ADD COLUMN IF NOT EXISTS client_reports jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Denormalised so the readout and the health check can answer "did the phone cart it?"
  -- without parsing the array. NULL means the device never reported at all, which is a
  -- different fact from "reported and failed" — the distinction that made 2026-08-07
  -- undiagnosable when `requested` with a frozen `updated_at` meant both "nothing tried"
  -- and "something tried and could not".
  ADD COLUMN IF NOT EXISTS client_last_stage text,
  ADD COLUMN IF NOT EXISTS client_last_note text,
  ADD COLUMN IF NOT EXISTS client_reported_at timestamptz;
