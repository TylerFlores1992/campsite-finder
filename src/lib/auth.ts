import { auth, currentUser } from '@clerk/nextjs/server';
import { mutate, queryOne } from '@/lib/db/client';

/** Get the current Clerk user ID or throw a 401-ready error. */
export async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new AuthError('Unauthorized');
  return userId;
}

/** Upsert the Clerk user into our users table (id + email).
 *  Emails on the beta_emails pre-approval list get is_beta automatically. */
export async function syncUser(userId: string): Promise<void> {
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  await mutate(
    `INSERT INTO users (id, email, is_beta)
     VALUES ($1, $2, EXISTS(SELECT 1 FROM beta_emails b WHERE LOWER(b.email) = LOWER($2)))
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       is_beta = users.is_beta OR EXCLUDED.is_beta,
       updated_at = NOW()`,
    [userId, email]
  );
}

/** Return the subscription status for a user: 'active' | 'trialing' | null */
export async function getSubscriptionStatus(userId: string): Promise<string | null> {
  const row = await queryOne<{ status: string }>(
    `SELECT status FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return row?.status ?? null;
}

/** Return true if the user has an active/trialing subscription or is a beta tester. */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const beta = await queryOne<{ is_beta: boolean }>(
    'SELECT is_beta FROM users WHERE id = $1',
    [userId]
  );
  if (beta?.is_beta) return true;

  const status = await getSubscriptionStatus(userId);
  return status === 'active' || status === 'trialing';
}

/**
 * May this user use auto-cart? True for beta testers, the Auto-Cart tier, and
 * grandfathered pre-tier subscriptions (sold "auto-cart included" — migration 032).
 * The subscription must be live; a grandfathered sub that lapses loses the lane
 * exactly like everyone else.
 *
 * One EXISTS, not "latest row": a user can carry an old canceled row next to a
 * live one, and which is "latest" depends on ordering trivia that entitlement
 * must not.
 */
export async function hasAutocartEntitlement(userId: string): Promise<boolean> {
  const row = await queryOne<{ entitled: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.is_beta)
       OR EXISTS (
         SELECT 1 FROM subscriptions s
          WHERE s.user_id = $1
            AND s.status IN ('active', 'trialing')
            AND (s.tier = 'autocart' OR s.grandfathered)
       )
     ) AS entitled`,
    [userId]
  );
  return row?.entitled === true;
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
