-- Hide non-campgrounds from search WITHOUT deleting them.
--
-- Reservation portals list everything they take bookings for: picnic shelters, day-use
-- parking spaces, golf courses, visitor centres, park headquarters. All real, all
-- bookable, none of them somewhere you can sleep. 425 of 8,025 rows (5.3%).
--
-- WHY A COLUMN AND NOT A DELETE. On 2026-08-04 this project deleted 35 parks because they
-- had no coordinates, and the reason it went unnoticed is that a filter yields `[]` rather
-- than an error — a classification mistake is silent by construction. A `hidden` flag is
-- reversible, inspectable ("which rows did we hide, and why?"), and correctable with a
-- deploy instead of a re-sync of eight thousand rows.
--
-- WHY NOT AT SYNC TIME. Same reason: a sync-time filter bakes the judgement into data and
-- the only record of a mistake is an absence. Classification lives in
-- `src/lib/campground-visibility.ts`, is applied at READ time, and this column is a cached
-- answer the search query can index on.
--
-- **THE POLLER MUST NOT CONSULT THIS.** Hiding affects DISCOVERY only. If somebody already
-- watches one of these, their alerts keep working — silently switching off a paying
-- subscriber's watch because we reclassified their campground is worse than listing a
-- picnic shelter. There is deliberately no `hidden` check anywhere in worker/.
ALTER TABLE campgrounds ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
-- The matched term, so "why is this hidden?" is answerable without re-running the rule
-- against a name that may since have changed.
ALTER TABLE campgrounds ADD COLUMN IF NOT EXISTS hidden_reason TEXT;

-- Search filters on it on every query, and 5% selectivity is worth an index only on the
-- visible side — partial, so it stays small.
CREATE INDEX IF NOT EXISTS campgrounds_visible ON campgrounds (id) WHERE hidden = false;

COMMENT ON COLUMN campgrounds.hidden IS
  'Not a campground (picnic shelter, day-use area, HQ, visitor centre) — excluded from search, sitemap and SEO pages, but NEVER from the poller: existing watches must keep alerting. Set by scripts/classify-campgrounds.mts from src/lib/campground-visibility.ts.';
