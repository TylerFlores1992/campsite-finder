// DELIBERATELY NOT `import 'server-only'`. It resolves to a throwing stub outside a server
// bundle, including under `node:test`, which would make the real-DB guard below impossible to
// write — the same reason `lib/stripe-client` and `lib/watch-mutes` leave it off.
import { mutate } from '@/lib/db/client';

/**
 * SAVING AND CLEARING A SUBSCRIBER'S PHONE — and the consent record that rides with it.
 *
 * THE DEFECT (measured 2026-09-09). Migration 034 added `users.sms_consent_at` so express
 * written consent could be evidenced per subscriber if a carrier ever asks — A2P 10DLC wants
 * it per number, and `phone IS NOT NULL` is weaker because a number could in principle arrive
 * by another path. That migration backfilled everyone who already had a number on 2026-08-01
 * and **nothing ever wrote the column again**. Counted against production: 17 accounts hold a
 * phone, **10 have no consent row, and every one of those ten was created after the backfill**.
 * All ten are being sent SMS. So the column proved consent for the accounts that predate it and
 * for nobody since — a fact captured once and never wired to its writer, which is the shape
 * this codebase keeps paying for.
 *
 * IT IS A MODULE, NOT TWO STATEMENTS IN THE ROUTE, for the reason `applyMutes` is. The whole
 * behaviour lives inside two SQL statements, so a test written against a COPY of them would
 * assert the copy. `worker/sms-consent.test.mts` drives these two functions against the real
 * database, and separately pins that the route still calls them — the helper being correct
 * while the caller stops using it is the fix-present-and-inert shape recorded here five times.
 */

/**
 * Store a number and record consent if this is the first one in an unbroken run of holding one.
 *
 * COALESCE, so the FIRST consent stands: changing your number is not a new consent event, and
 * restamping would lose the date the evidence is actually about. Same posture as `grandfathered`
 * (032), `signup_source` (072) and `onboarded_at` — a fact about an event that already happened
 * is written once. `clearUserPhone` is what resets it, so a re-add after a removal does stamp
 * fresh rather than inheriting a date from a period the subscriber had opted out of.
 */
export async function setUserPhone(userId: string, e164: string): Promise<void> {
  await mutate(
    `UPDATE users
        SET phone = $1,
            sms_consent_at = COALESCE(sms_consent_at, NOW()),
            updated_at = NOW()
      WHERE id = $2`,
    [e164, userId]
  );
}

/**
 * Remove the number, and with it the consent — because removing it IS the withdrawal.
 *
 * Keeping the old timestamp would let a later re-add inherit consent from a period the
 * subscriber had opted out of. A consent record that overstates itself is worse than none:
 * it is the document you would hand a carrier.
 */
export async function clearUserPhone(userId: string): Promise<void> {
  await mutate(
    `UPDATE users
        SET phone = NULL,
            sms_consent_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [userId]
  );
}
