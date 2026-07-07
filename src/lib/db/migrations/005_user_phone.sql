-- Phone number for SMS alerts (E.164, e.g. +18055551234)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
