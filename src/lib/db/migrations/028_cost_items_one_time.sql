-- Allow a one-time cost line.
--
-- The Costs tab could only express a recurring charge, so anything paid once — the
-- $99/yr Apple Developer enrolment's first year, the mini PC, a domain transfer —
-- had nowhere to live. Recording it as 'monthly' would overstate monthly burn by the
-- whole amount forever; leaving it out understates what the product has cost. Both
-- distort net margin, which is the one figure on that tab you'd act on.
--
-- These rows are DELIBERATELY excluded from the monthly and yearly totals rather than
-- amortised. Amortising needs a purchase date and a chosen lifetime, neither of which
-- this table stores, and a guessed lifetime silently changes margin. They get their
-- own total instead — "spent once, to date" — which is a number that needs no
-- assumptions to be true. See monthlyCents()/yearlyCents()/oneTimeTotalCents() in
-- src/lib/costs.ts, which are the only sanctioned way to sum this column.
ALTER TABLE cost_items
  DROP CONSTRAINT IF EXISTS cost_items_billing_period_check;
ALTER TABLE cost_items
  ADD CONSTRAINT cost_items_billing_period_check
  CHECK (billing_period IN ('monthly', 'yearly', 'one_time'));
