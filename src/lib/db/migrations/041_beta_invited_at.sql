-- When each beta tester was actually told they were in.
--
-- WHY. `sendBetaInvite` posts straight to Resend and records nothing, so "did this
-- person ever get an invite?" was unanswerable from our own data — the only record was
-- Resend's dashboard. Asked directly on 2026-08-06 whether any testers had been missed,
-- the honest answer was "I cannot tell you", which is a poor thing to say about mail we
-- sent ourselves.
--
-- It also makes the resend button safe. Right now it will cheerfully mail someone a
-- second copy, because nothing knows a first one went out; the insert-gated path exists
-- precisely to avoid that on the add flow, and the resend path bypasses it by design.
--
-- NULL means "we do not know", exactly as it does on watch_site_alerts.last_seen_open_at
-- — not "never invited". Only rows added on or after 2026-07-28, when the auto-invite
-- shipped, can be backfilled with any confidence: those were mailed by the add itself.
-- Everything before that date is genuinely unknown and stays NULL rather than being
-- guessed either way, because a wrong guess here either spams a tester or silently
-- leaves them out.
ALTER TABLE beta_emails
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

COMMENT ON COLUMN beta_emails.invited_at IS
  'When the beta invite email was last sent. NULL = unknown (pre-2026-08-06 rows, or added before the auto-invite shipped on 2026-07-28) — NOT proof that none was sent.';

-- The auto-invite shipped 2026-07-28: every row added on or after it was mailed by the
-- add flow itself, unless Resend errored (which is logged, not silent).
UPDATE beta_emails
   SET invited_at = added_at
 WHERE added_at >= '2026-07-28'
   AND invited_at IS NULL;
