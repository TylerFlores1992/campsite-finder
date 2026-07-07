-- Pre-approval list: add an email BEFORE the tester signs up, and syncUser
-- flags them is_beta automatically on their first action.
--   INSERT INTO beta_emails (email) VALUES ('tester@example.com');
CREATE TABLE IF NOT EXISTS beta_emails (
  email    text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT NOW()
);
