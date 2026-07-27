-- Annual costs, stored as what you're actually billed.
--
-- The Costs tab only understood a monthly figure, so anything billed yearly (a
-- domain, an annual plan) had to be divided by 12 by hand before typing it in.
-- That's a number you then can't check against an invoice, and the seed row for
-- the domain literally says "Annual ÷ 12" in its notes — the workaround was
-- baked into the data.
--
-- `monthly_cents` is RENAMED rather than kept alongside a new column. Keeping
-- both would mean two sources of truth for the same money, and the failure mode
-- is silent: a yearly item whose monthly_cents didn't get re-derived would
-- quietly overstate costs by 12x in the net-margin figure. One column, one
-- meaning — "the amount on the invoice" — and the monthly view is derived in
-- code (see monthlyCents() in src/lib/costs.ts).
ALTER TABLE cost_items RENAME COLUMN monthly_cents TO amount_cents;

ALTER TABLE cost_items
  ADD COLUMN IF NOT EXISTS billing_period TEXT NOT NULL DEFAULT 'monthly';

-- Existing rows were all monthly by definition, so the default is already right
-- for them and no backfill is needed.
ALTER TABLE cost_items
  DROP CONSTRAINT IF EXISTS cost_items_billing_period_check;
ALTER TABLE cost_items
  ADD CONSTRAINT cost_items_billing_period_check
  CHECK (billing_period IN ('monthly', 'yearly'));

-- The domain seed row's note documented the manual division. It can go now.
UPDATE cost_items
   SET notes = 'Renews annually'
 WHERE notes = 'Annual ÷ 12';
