-- The claim handshake: two more states, so a swap can be coordinated.
--
-- WHY IT NEEDS STATES AT ALL. Only the session that made a cart entry can remove it, so
-- the user's device cannot release the site itself — it has to ask, and then wait for
-- the bot to actually let go before it can take it. That is a two-party handshake across
-- a polling boundary, and a handshake with no recorded state is a race.
--
--   claiming  the user pressed the button. The bot must release THIS ONE NOW.
--   released  the bot has let go. The user's session may take it; the clock is running.
--
-- The window between `released` and the user's cart is the whole exposure — measured at
-- ~2.5s in the release probe, dominated by RC's two precart round trips. It is why the
-- bot polls fast while anything is claimable rather than on its lazy 20s cadence: a
-- 20-second exposure would hand the site to whoever else is watching.
--
-- `released` is deliberately NOT terminal. If the user's recapture fails they are no
-- worse off than an ordinary alert — the site is simply free and they can book it — but
-- we want to be able to tell that apart from a claim that completed, so `claimed` still
-- means "they got it".
ALTER TABLE rc_hold_requests DROP CONSTRAINT IF EXISTS rc_hold_requests_status_check;
ALTER TABLE rc_hold_requests ADD CONSTRAINT rc_hold_requests_status_check
  CHECK (status IN ('offered','requested','carted','claiming','released','claimed','expired','failed'));

-- When the user asked. Also the clock for "the bot never picked this up" — a claim
-- stuck in `claiming` means the runner is down, and the user is staring at a spinner.
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS claim_started_at TIMESTAMPTZ;
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

COMMENT ON COLUMN rc_hold_requests.claim_started_at IS
  'When the user pressed claim. If this is old and status is still claiming, the bot runner is not running — surface that rather than spinning forever.';
