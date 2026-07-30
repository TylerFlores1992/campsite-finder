-- When each cost started (and stopped), so lifetime spend can be computed.
--
-- "What has this product cost me in total" needs a start date per line, and the table
-- had none. `created_at` is when the ROW was added — 2026-07-26 for the seed batch —
-- not when the money started going out; camphawk.app was registered 2026-07-07 and
-- the Vercel project existed from 06-30. Using created_at as a proxy would understate
-- every early cost while looking like real data.
--
-- So `started_at` is NULLABLE WITH NO DEFAULT and no backfill. An item without one
-- reports its lifetime as UNKNOWN rather than as zero, and the UI says how many are
-- unset. A guessed date produces a total that is wrong in a direction nobody can see,
-- which is worse than a total that admits what it is missing — the same rule the
-- subscription gate uses for `unknown`.
--
-- `ended_at` matters as much for correctness: a service you cancelled must stop
-- accruing. Without it, every lifetime figure grows forever, and the first thing
-- anyone does with this tab is cancel something.
ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS started_at DATE;
ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS ended_at   DATE;

-- Cheap guard against a range that cannot be true. Accrual maths on an inverted range
-- would silently produce a negative contribution to the total.
ALTER TABLE cost_items DROP CONSTRAINT IF EXISTS cost_items_dates_ordered_check;
ALTER TABLE cost_items
  ADD CONSTRAINT cost_items_dates_ordered_check
  CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at);
