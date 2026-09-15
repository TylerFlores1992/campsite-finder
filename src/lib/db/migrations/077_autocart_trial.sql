-- A time-boxed auto-cart grant that expires by itself (2026-09-15). Main lane block 072-079.
--
-- WHY THE EXISTING MECHANISMS ALL FAIL AT THIS. Comping somebody the Auto-Cart tier for a
-- fixed period is a retention lever we have no way to pull, and each of the three obvious
-- routes is wrong in a different direction:
--
--   users.is_beta = true        grants auto-cart AND makes `hasActiveSubscription` return
--                               true before it ever reads the subscriptions table, so a beta
--                               account never meets a paywall again. And it never expires.
--   subscriptions.tier          derived from the Stripe price id on EVERY webhook event, so
--                               a hand-edited tier survives only until Stripe next says
--                               anything. It also never expires.
--   extend the Stripe trial     charges them the Auto-Cart price when it ends. They signed
--                               up for base; silently upgrading what they pay is not a gift.
--
-- SO: ONE NULLABLE TIMESTAMP, AND THE EXPIRY IS THE WHOLE DESIGN. `> NOW()` in the
-- entitlement predicate means the grant lapses on its own — no cron, no sweep, no cleanup
-- job to forget. "Once the week is up it kicks them back to alerts only" is not a process
-- somebody has to run; it is arithmetic. The row can stay set for ever and still be correct.
--
-- IT IS AN INSTANT, NOT A DURATION, DELIBERATELY. The obvious API is "give them 7 days", and
-- the first real use showed why that is a trap: a 7-day comp granted 2026-09-15 expires on
-- the 22nd, and the trip it was meant to help with was the 24th to the 27th. A duration
-- makes that mistake invisible; a date makes the caller look at a calendar.
--
-- IT DOES NOT TOUCH STRIPE, AND MUST NOT. Nothing here changes what anybody is billed, what
-- tier they hold, or when their trial ends. That is what makes it safe to grant and safe to
-- revoke: set it to NULL and the account is exactly as it was.
--
-- IT IS NOT A SUBSCRIPTION. `hasActiveSubscription` is untouched, so this grants the
-- auto-cart LANE and never the right to create watches. Somebody with no live subscription
-- and a trial grant can use auto-cart on the watches they already have and still cannot add
-- a seventh. That asymmetry is intentional: this is a demonstration, not a free plan.
ALTER TABLE users ADD COLUMN IF NOT EXISTS autocart_trial_until TIMESTAMPTZ;

COMMENT ON COLUMN users.autocart_trial_until IS
  'Comped auto-cart entitlement, expiring on its own at this instant. Read by the three copies of the entitlement predicate. Never written by a webhook; does not affect billing or hasActiveSubscription.';

-- NO INDEX. It is read one user at a time by an equality-keyed lookup that already has the
-- primary key, and the poller reads it in a subquery over a handful of rows.
