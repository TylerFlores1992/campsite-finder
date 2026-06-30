import { auth, currentUser } from '@clerk/nextjs/server';
import { mutate, queryOne } from '@/lib/db/client';

/** Get the current Clerk user ID or throw a 401-ready error. */
export async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new AuthError('Unauthorized');
  return userId;
}

/** Upsert the Clerk user into our users table (id + email). */
export async function syncUser(userId: string): Promise<void> {
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? null;
  await mutate(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email), updated_at = NOW()`,
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

/** Return true if the user has an active or trialing subscription. */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const status = await getSubscriptionStatus(userId);
  return status === 'active' || status === 'trialing';
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
