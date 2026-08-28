-- One account always gets first dibs (2026-08-28) — an explicit thumb on the scale.
--
-- WHAT THIS IS, PLAINLY. Migration 068 built a fairness line: the rotation ticket first,
-- then earliest `watches.created_at`, so whoever watched a site first is offered it first
-- and the ticket stops anyone sitting at the top for ever. This column overrides that. A
-- user with a higher `line_priority` is ranked ahead of everybody, every time, whatever
-- their ticket and whenever they started watching.
--
-- WHY IT EXISTS. The owner asked for it on 2026-08-28 and reaffirmed it after being shown
-- who is on the other side of it. That is the whole justification and it is enough — but
-- the cost is written down here rather than left to be rediscovered, because a silent
-- ranking override is exactly the kind of thing a later reader finds and files as a bug.
--
-- WHO LOSES, AS MEASURED THAT DAY. In the live line for unit 43189 the accounts ranked
-- ahead of the owner were `melinda.flores0501` (a paying subscriber — active, base tier,
-- grandfathered) and `iamtylerflores12345` (the owner's own test account). Melinda is
-- family, which is what settled it. Two accounts that are NOT family also compete in
-- future lines: `suziegrieve03` (3 active watches, more than anyone) and `cam1234123`.
-- Both are beta users, both hold a NULL ticket — which reads as 0 and would otherwise
-- outrank everybody — and both now lose to this flag. That was raised and accepted.
--
-- A COLUMN, NOT A HAND-EDITED TICKET. The cheaper route was setting the owner's
-- `hold_offer_seq` to 0 and walking away, and it is strictly worse: it is invisible at the
-- ranking site, it drifts back the moment the rotation charges the ticket again, and the
-- next person to read the line sees a number where a decision belongs. This way the
-- override has a name, one enforcer (`orderLine`), and a test.
--
-- INTEGER, NOT BOOLEAN, so a second tier can be added without another migration. 0 is "no
-- override" and is the default, so every existing row keeps exactly today's behaviour:
-- this migration ON ITS OWN CHANGES NOTHING until some row is set to something else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_priority integer NOT NULL DEFAULT 0;

-- NO INDEX, DELIBERATELY. `rankHoldLine` reads the users it already JOINs for one
-- `(release_at, unit_id)` — a handful of rows — and never scans or filters on this column.
-- An index here would be read by nothing.

COMMENT ON COLUMN users.line_priority IS
  'Hold-line override: higher is ranked first, ahead of the rotation ticket and watch age. '
  -- NO SEMICOLON INSIDE THIS STRING. Migrations here are applied by hand, and the obvious
  -- way to do that is to split the file on ';' — which cuts a statement in half if one is
  -- hiding in a literal. Cost one failed apply on 2026-08-28.
  '0 = no override (the default, and the fair rule). Set deliberately — see migration 069.';
