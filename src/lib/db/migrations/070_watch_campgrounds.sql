-- 070: one watch can cover several campgrounds (a park's divisions).
--
-- SIDE LANE CLAIMS 070+. The main lane holds 060-069; the highest applied migration is
-- 059. This gap is deliberate and `worker/migration-numbers.test.mts` does not assert
-- contiguity, precisely so a claimed block does not read as a defect.
--
-- WHY A JOIN TABLE AND NOT AN ARRAY COLUMN. Sharding is by CAMPGROUND — `ownsCampground`
-- decides which machine polls what, and all watches for a campground must land on the
-- same machine. A row per (watch, campground) is the shape the poller already wants to
-- iterate, and it lets Postgres index the campground side; an array would force an
-- unnest on every load and could not be indexed the same way.
--
-- IT IS EMPTY FOR EVERY EXISTING WATCH, and that is the safety property this whole
-- change rests on. `loadWatches` falls back to `watches.campground_id` when a watch has
-- no rows here, so the 19 live watches keep the byte-identical code path they have
-- today. Only a watch created through the new multi-division flow has rows, and only
-- those take the new path.
--
-- `watches.campground_id` STAYS, and stays NOT NULL. It is the representative division:
-- what the watch is named after, what manage links and alert deep-links point at, and
-- what every existing reader already uses. Dropping it would touch far more code than
-- this feature needs, for no gain.

-- watch_id is TEXT, not UUID: `watches.id` is TEXT in this database. Postgres refused
-- the foreign key outright rather than letting a mismatched type through, which is the
-- error working as intended.
CREATE TABLE IF NOT EXISTS watch_campgrounds (
  watch_id      TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_id, campground_id)
);

-- The poller asks "which campgrounds does this watch cover?" on every load, and the
-- capacity gauge asks the reverse. The primary key serves the first; this serves the
-- second, and the shard filter.
CREATE INDEX IF NOT EXISTS watch_campgrounds_campground_idx
  ON watch_campgrounds (campground_id);

-- ON DELETE CASCADE on the watch side means deleting a watch takes its divisions with
-- it — there is no state here worth keeping once the watch is gone, unlike `cart_key`
-- on a hold, which is evidence. On the campground side a cascade is right too: a
-- campground removed from the catalog cannot be polled, and leaving a dangling row
-- would make `loadWatches` join to nothing and silently shrink the watch.

ALTER TABLE watch_campgrounds ENABLE ROW LEVEL SECURITY;

-- Same posture as migration 027: the service role reaches this table and nothing else
-- does. The app never queries it with an anon key.
DROP POLICY IF EXISTS watch_campgrounds_service_only ON watch_campgrounds;
CREATE POLICY watch_campgrounds_service_only ON watch_campgrounds
  FOR ALL USING (false) WITH CHECK (false);
