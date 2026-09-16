-- A pending cancellation is now VISIBLE (2026-09-16). Main lane block 077-079.
--
-- WHY. The owner found out a subscriber had cancelled by opening Stripe, days late. Our
-- table could not have told them: `cancel_at_period_end` appears NOWHERE in the codebase,
-- and the webhook writes only `sub.status`. A subscription cancelled on the 8th with
-- access through the 8th of next month stays `status = 'active'` that whole month, so the
-- admin page reads a healthy subscriber and MRR still counts them. Both are CORRECT — the
-- money really is still coming — and between them they hide the one fact that matters,
-- which is that it stops.
--
-- THE FAILURE IS THE SAME FAMILY AS `status = 'sent'` MEANING "Twilio returned 2xx". The
-- reading is true and it is not the question anyone is asking. A churn you learn about a
-- month late is a churn you had no chance to answer, and the whole point of noticing is
-- that there is a window in which an email can still change the outcome.
--
-- TWO COLUMNS, AND THE BOOLEAN IS THE LOAD-BEARING ONE.
--   cancel_at_period_end   Stripe's own flag. Unambiguous and ALWAYS present on the
--                          subscription object, so this is what the badge fires on.
--   cancel_at              "A date in the future at which the subscription will
--                          automatically get canceled" (Stripe's wording, read out of
--                          stripe@22.3.0's own types, not recalled). Nullable.
--
-- WHY NOT DERIVE ONE FROM THE OTHER. It is tempting to keep only the date and treat
-- non-null as "cancelling". Stripe's types decline to promise that `cancel_at` is
-- populated whenever `cancel_at_period_end` is true, and it could not be checked from
-- here — `api.stripe.com` is 403 at the agent proxy. So an admin page keyed on the date
-- alone would silently report a cancelling subscriber as healthy on exactly the API
-- version where that assumption does not hold. Keyed on the boolean it says "cancelling"
-- and omits the date, which is knowing less rather than being wrong.
--
-- AND NOT `current_period_end`. It is NOT on the Subscription object in this SDK version
-- — it moved onto `items.data[]` — so reaching for it would be reading a field that does
-- not exist and writing NULL for ever, which reads exactly like "nobody is cancelling".
--
-- THE DEFAULT IS false, NOT NULL, ON PURPOSE. Every existing row predates this and no
-- backfill can know what Stripe held at the time, so the honest reading of an untouched
-- row is "no cancellation on record" — which is what the product assumed yesterday and is
-- the same failure direction as today. NULL would invite a three-valued badge whose third
-- state ("we have never asked") nobody would render, and an unrendered state is an absent
-- reading standing in for a negative.
--
-- THE WEBHOOK IS FORWARD-ONLY, SO THE RECONCILE CARRIES THIS TOO. Nobody who has ALREADY
-- cancelled generates another event, so the webhook alone leaves precisely the rows that
-- prompted this change blank. Admin -> "Does our table match Stripe?" is what fills them.
-- That is the lesson of the 2026-09-02 trial-status fix arriving a second time: a fix to
-- what gets WRITTEN repairs nothing already written.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.cancel_at_period_end IS
  'Stripe cancel_at_period_end. A subscription with this set is still active and still paying until cancel_at, and it is what makes a pending churn visible before the status changes.';

COMMENT ON COLUMN subscriptions.cancel_at IS
  'Stripe cancel_at: the future instant the subscription is scheduled to end. NULL means Stripe reported no date, never that no cancellation is scheduled -- read cancel_at_period_end for that.';

-- NO INDEX. There are a handful of subscriptions and every read of this is already
-- filtered to one user or aggregated over the whole table in one pass.
