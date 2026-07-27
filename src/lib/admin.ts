import 'server-only';
import { currentUser } from '@clerk/nextjs/server';

/**
 * Who counts as an admin — one definition.
 *
 * This list was copy-pasted into four places (the /admin page, /api/admin/beta,
 * /api/admin/costs, and a hardcoded email in the old homepage's client code).
 * Four copies of an access rule is three chances for them to disagree, and the
 * homepage's copy already had: it ignored ADMIN_EMAILS entirely and compared
 * against a literal string, so adding a second admin to the env var would have
 * given them the page but not the link to it.
 *
 * `server-only` is imported deliberately. This module reads an env var that is
 * NOT NEXT_PUBLIC_, and importing it from a client component would be a build
 * error rather than a silent leak of the admin roster into the JS bundle.
 * Client components must be handed a boolean, never the list.
 *
 * NONE OF THIS IS THE SECURITY BOUNDARY BY ITSELF. Every admin surface does its
 * own check server-side — /admin calls notFound() (404, not 403, so the page's
 * existence isn't revealed) and the API routes reject before touching data. A
 * link rendered conditionally is a convenience, not a gate.
 */

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'tylerflores1992@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** Is this email address on the allowlist? Case-insensitive; null is never. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/** The signed-in user's primary email, lowercased, or null. */
export async function currentUserEmail(): Promise<string | null> {
  const user = await currentUser();
  return user?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? null;
}

/** Is the signed-in user an admin? False when signed out. */
export async function currentUserIsAdmin(): Promise<boolean> {
  return isAdminEmail(await currentUserEmail());
}
