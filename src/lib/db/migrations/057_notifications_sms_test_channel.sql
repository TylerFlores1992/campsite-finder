-- Allow `channel = 'sms_test'` on notifications.
--
-- WHY. `scripts/sms-link-test.mts` measures which SHAPE of a camphawk.app link survives
-- carrier filtering, and it deliberately logs its rows under `sms_test` rather than `sms`:
-- the admin "Did the texts arrive?" panel counts `channel = 'sms'`, and this experiment
-- sends messages some of which are EXPECTED to be filtered. Logging them as ordinary SMS
-- would turn the regression detector red by running the experiment — an instrument that
-- breaks when you use it.
--
-- That design was written down and was never possible: the CHECK constraint has only ever
-- allowed email/sms/push/webhook, so every insert the script attempted was rejected. It
-- went unnoticed because the script had never run with real credentials until 2026-08-12,
-- and when it did it hit `user_id` NOT NULL first — so the second, independent blocker was
-- still hiding behind the first. Both had to be fixed before a single row could be written.
--
-- The value is added rather than dropping the constraint. The constraint is what keeps a
-- typo'd channel from creating a silent category nothing counts, and every dashboard query
-- filters on an explicit channel, so a new value is inert until something asks for it.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_channel_check
  CHECK (channel = ANY (ARRAY['email', 'sms', 'push', 'webhook', 'sms_test']));
