-- The coming-soon dedup needs a SET, not a single value (2026-08-24).
--
-- THE BUG, measured on production. `rc_hold_notified_for` is ONE TEXT column, and
-- migration 070's park watches made `claimHoldNotification` write a CAMPGROUND-NAMESPACED
-- value into it so two divisions of one park would not silence each other. One column
-- still holds one value, so N divisions each claiming a different key for the same release
-- hour overwrite each other in turn and `IS DISTINCT FROM` is true on EVERY call. The
-- dedup was not weakened, it was completely defeated.
--
-- Melinda Flores, watch 336d742c, Morro Bay SP: 26 texts and 26 emails between 11:40 and
-- 12:42 PT, alternating rc-2185 / rc-583, all for the SAME physical campsite (unit 43191,
-- "#96") and the same 08:00 release — 13 poll cycles x 2 divisions, dead even. Two other
-- watches were on the same path. The fix that caused it was trying to prevent exactly one
-- missed alert; it produced an unbounded storm instead.
--
-- WHY A SET AND NOT SIMPLY REVERTING THE NAMESPACE. Reverting to an hour-only key kills
-- the storm in one line and reinstates the bug 070 fixed: two divisions with DIFFERENT
-- units releasing in the same hour, only the first announced. Keying on the unit instead
-- collapses the duplicate correctly but ping-pongs again the moment two units share an
-- hour. Only a set satisfies both, so the column becomes a set.
--
-- THE KEY IS `<releaseHour>|<unitId>`, which is what makes the duplicate collapse. RC lists
-- the same physical campsite under more than one facility — "Morro Lottery sites" and
-- "Upper Section (sites 86-140)" are both park 680 and both carry unit 43191 — so keying on
-- the campground guaranteed two alerts for one campsite. Keying on the unit gives one.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS rc_hold_notified_keys TEXT[];

-- NOTHING RE-ANNOUNCES ON DEPLOY. A watch mid-claim holds either `<hour>` (ordinary) or
-- `<campgroundId>|<hour>` (park watch). Neither matches the new `<hour>|<unitId>` shape, so
-- without this backfill every affected watch would send one more coming-soon alert the
-- moment this ships — on the very watches that just received twenty-six. The legacy value
-- is carried across as a WILDCARD entry for that hour, which `claimHoldNotification` also
-- checks; those entries decay on their own once the release passes and are never written
-- again.
UPDATE watches
   SET rc_hold_notified_keys = ARRAY[
         CASE WHEN rc_hold_notified_for LIKE '%|%'
              THEN split_part(rc_hold_notified_for, '|', 2)
              ELSE rc_hold_notified_for
         END || '|*'
       ]
 WHERE rc_hold_notified_for IS NOT NULL
   AND rc_hold_notified_keys IS NULL;

-- `rc_hold_notified_for` is deliberately LEFT IN PLACE and simply stops being written.
-- Dropping it in the same change would make a rollback of the poller silently lose every
-- live claim, and this is the alerting path.
