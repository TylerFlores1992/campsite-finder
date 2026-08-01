-- 034: per-channel alert preferences, collected at sign-up (2026-08-01).
--
-- Until now "do we email you" was implicit: we had an address, so we sent. The
-- welcome step asks explicitly, so the answer needs somewhere to live.
--
-- email_alerts_opt_in DEFAULTS TRUE and is backfilled true for everyone who already
-- exists — they signed up for alerts under a flow that never offered the choice, and
-- flipping them to false would silently stop the alerts they are paying for. New
-- accounts get the box pre-ticked in the UI for the same reason (email is the channel
-- the product is built on), but it is a real choice and unticking it is honoured.
--
-- sms_consent_at records WHEN express written consent was captured. A2P 10DLC asks
-- you to be able to evidence consent per subscriber; `phone IS NOT NULL` implied it
-- before, which is weaker — a number could in principle arrive by another path.
-- Nothing reads it yet; it exists so the evidence is there if a carrier ever asks.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_alerts_opt_in boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz,
  -- Stamped when the welcome step is completed or skipped, so it is shown once
  -- rather than on every sign-in.
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

-- Existing users with a number on file consented via /settings; date unknown, so
-- record the row's own creation time rather than inventing a precise one.
UPDATE users SET sms_consent_at = created_at
 WHERE phone IS NOT NULL AND sms_consent_at IS NULL;
