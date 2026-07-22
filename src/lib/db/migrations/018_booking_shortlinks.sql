-- Booking short-links (feature D, SMS compaction). A `book` action token whose
-- redirect_url is the full booking URL, so a text can carry `camphawk.app/b/<token>`
-- (~22 chars) instead of a 50–300 char rec.gov / GoingToCamp URL — the difference
-- between a one-segment and a multi-segment SMS. Resolved by /b/<token> (302).
ALTER TABLE action_tokens ADD COLUMN IF NOT EXISTS redirect_url TEXT;
