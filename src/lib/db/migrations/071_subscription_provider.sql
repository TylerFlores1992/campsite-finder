-- Store subscriptions need an identity that is not Stripe's (2026-08-28).
--
-- `subscriptions` is Stripe-shaped: `stripe_customer_id` and `stripe_subscription_id` are
-- both NOT NULL, and the latter is UNIQUE. A Play or App Store purchase has neither, so a
-- store subscription cannot be written at all until those two facts change.
--
-- THE ENTITLEMENT QUERY NEEDS NO CHANGE, AND THAT IS WHAT MAKES THIS CHEAP.
-- `hasAutocartEntitlement` reads only `status`, `tier` and `grandfathered`:
--
--     EXISTS (SELECT 1 FROM subscriptions s
--              WHERE s.user_id = $1 AND s.status IN ('active','trialing')
--                AND (s.tier = 'autocart' OR s.grandfathered))
--
-- It is already provider-agnostic, so the one definition with six enforcers -- the toggle
-- API, the bot roster feed, `isAutocartLane`, the RC hold offer and the hold action -- picks
-- up store subscribers untouched, as long as a purchase writes a row with the right
-- `status` and `tier`.
--
-- DELIBERATE DEVIATION FROM `docs/STOREKIT-PLAN.md` 2, WHICH IS APPLE-SHAPED.
-- That section proposes `apple_original_transaction_id` and a provider of 'stripe' | 'apple'.
-- It was written on 2026-08-24, BEFORE RevenueCat was chosen -- it assumed direct StoreKit,
-- one store at a time. RevenueCat normalises both stores behind ONE webhook, and **Play is
-- the store being wired first**, so an Apple-named column would be wrong on the day it
-- shipped and would need a second migration to hold a Play purchase. Generalised to
-- `provider` + `store_transaction_id`, which covers both and leaves Apple needing no schema
-- change at all.
--
-- CONFIRMED AGAINST PRODUCTION, not read off the plan: 2 said "ALTER COLUMN ... DROP NOT NULL
-- (if currently NOT NULL)". Both columns ARE NOT NULL, and there are 3 live rows.

-- 'stripe' | 'apple' | 'google'. The DEFAULT is what backfills the three live rows correctly
-- and is why this is additive: every existing row is a Stripe row and stays one.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe';

-- The store's own stable identifier for the subscription, surviving renewals -- RevenueCat's
-- `original_transaction_id`. NOT named for either store: the whole point of RevenueCat is
-- that one column serves both.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS store_transaction_id TEXT;

-- A store row has no Stripe ids to put here. `stripe_subscription_id` keeps its UNIQUE
-- constraint, which is safe because Postgres permits many NULLs in a unique index -- so
-- dropping NOT NULL does not weaken the guard against a Stripe subscription being recorded
-- twice.
ALTER TABLE subscriptions ALTER COLUMN stripe_customer_id DROP NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN stripe_subscription_id DROP NOT NULL;

-- ONE STORE SUBSCRIPTION CANNOT BE CLAIMED BY TWO ACCOUNTS. This is the guard that matters:
-- without it, a user who reinstalls and signs in with a different account could have the same
-- purchase written against both, and both would be entitled. PARTIAL, so the three Stripe
-- rows (and every future one) are unaffected by a column they never populate.
--
-- Keyed on (provider, store_transaction_id) rather than the id alone: the two stores mint
-- these independently and nothing promises they cannot collide.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_store_txn
  ON subscriptions (provider, store_transaction_id)
  WHERE store_transaction_id IS NOT NULL;

-- NO CHECK CONSTRAINT ON `provider`, AND NO IDENTITY CHECK, DELIBERATELY.
-- Both were considered and both fail in the dangerous direction. A CHECK restricting
-- `provider` to three values turns an unexpected store into an INSERT failure, i.e. a
-- webhook that 500s and a paying customer with no row -- while the entitlement query ignores
-- `provider` entirely, so an unrecognised value is HARMLESS to entitlement and merely
-- visible in the data. Likewise a CHECK demanding "Stripe ids or a store id" would reject a
-- write over a payload field this session could not verify, blocking the customer to catch a
-- bug the unique index and the webhook's own code already cover.
--
-- Same rule as the tier mapping: fail as "paying but treated as base", never as "the
-- subscription was lost".

-- DO NOT DROP THE STRIPE COLUMNS. Web keeps selling through Stripe; this is purely additive.
