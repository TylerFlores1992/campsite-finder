-- One date per cost line: when it started. No end date.
--
-- 029 added started_at + ended_at and left both blank, which meant every one of the
-- 18 existing rows reported its lifetime as unknown and the panel showed a permanent
-- "18 items have no start date" warning. The rule is now simpler and self-maintaining:
-- a cost starts on the day it is entered unless you say otherwise, and it accrues one
-- charge per month or per year from there. A one-time cost is counted once.
--
-- BACKFILL IS NOW CORRECT, where in 029 it was not. That migration deliberately
-- refused to default started_at to created_at, on the grounds that "when the row was
-- added" is not "when the money started". Under the new rule, the date of entry IS
-- the definition — so created_at is not a proxy for the answer, it is the answer, and
-- the 18 rows can be filled in rather than sitting unknown forever. Any that predate
-- their real start can be corrected by editing the one visible field.
UPDATE cost_items SET started_at = created_at::date WHERE started_at IS NULL;

ALTER TABLE cost_items ALTER COLUMN started_at SET DEFAULT CURRENT_DATE;

-- ended_at goes, at the owner's request. The trade-off is recorded here rather than
-- lost: nothing now stops a CANCELLED service accruing. Removing the row stops it but
-- also erases what it historically cost, so if "I cancelled Twilio in March" ever
-- needs to be true in the lifetime figure, this column is what has to come back.
ALTER TABLE cost_items DROP CONSTRAINT IF EXISTS cost_items_dates_ordered_check;
ALTER TABLE cost_items DROP COLUMN IF EXISTS ended_at;
