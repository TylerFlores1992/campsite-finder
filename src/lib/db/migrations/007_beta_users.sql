-- Beta testers get full access without a Stripe subscription.
-- Flag someone: UPDATE users SET is_beta = true WHERE email = 'tester@example.com';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta boolean NOT NULL DEFAULT false;
