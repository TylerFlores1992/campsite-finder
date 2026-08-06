-- Mark the 14 pre-tracking beta testers as invited, on the owner's confirmation.
--
-- WHY THIS IS NOT EVIDENCE, and why that is written down. Migration 041 added
-- `invited_at` and deliberately left it NULL for every row added before invite
-- tracking existed, because NULL means "we do not know" and guessing either way
-- either spams a tester or silently drops one. Asked directly on 2026-08-06, the
-- owner confirmed he had sent those invites by hand from the admin panel and asked
-- for them to be recorded.
--
-- So the timestamp below is the moment we RECORDED the claim, not the moment the
-- mail went out — we do not know that, and no row should be read as if we do. The
-- real send dates are only in Resend's dashboard. Anyone auditing "when was this
-- person invited?" for a row dated 2026-08-06 should read it as "some time before
-- this, per the owner", not as a send receipt.
--
-- Every row from here on is stamped by the send itself (both paths in
-- /api/admin/beta), so this is the only batch that carries a recorded-not-observed
-- date, and it is the last one.
UPDATE beta_emails
   SET invited_at = NOW()
 WHERE invited_at IS NULL;

COMMENT ON COLUMN beta_emails.invited_at IS
  'When the beta invite email was sent. Stamped by the send itself since 2026-08-06. The 14 rows dated 2026-08-06 were marked on the owner''s confirmation that he had invited them by hand — that date is when we recorded the claim, not when the mail went out. NULL means never sent (nothing predates the tracking any more).';
