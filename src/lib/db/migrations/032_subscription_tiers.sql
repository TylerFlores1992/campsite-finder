-- 032: subscription tiers — the Auto-Cart plan ($10/mo, $50/yr), 2026-08-01.
--
-- tier is derived from the Stripe price on every webhook event ('autocart' for the
-- Auto-Cart prices, 'base' otherwise), so it tracks upgrades and downgrades on its
-- own. grandfathered is set ONCE, here, and never touched by the webhook: everyone
-- subscribed before the tier existed was sold "auto-cart included" under the
-- "keep the rate you signed up at" promise, and they keep exactly that for as long
-- as their subscription runs. A grandfathered subscriber who cancels and later
-- resubscribes gets a NEW subscription row (new Stripe subscription id), which is
-- born grandfathered = false — the promise is scoped to the subscription, not the
-- person, which is precisely how the pricing copy words it.
--
-- Entitlement to auto-cart = active/trialing AND (tier = 'autocart' OR grandfathered),
-- OR users.is_beta. One definition, three consumers: lib/auth.hasAutocartEntitlement,
-- the bot roster feed, and the poller's auto-cart lane.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS grandfathered boolean NOT NULL DEFAULT false;

-- Every subscription that exists at apply time predates the tier. (The exec_dml
-- guard refuses an UPDATE without a WHERE, hence the tautological-looking clause.)
UPDATE subscriptions SET grandfathered = true WHERE grandfathered = false;
