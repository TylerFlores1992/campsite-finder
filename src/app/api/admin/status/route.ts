import { NextResponse } from 'next/server';
import { currentUserIsAdmin } from '@/lib/admin';

/**
 * "Is the signed-in user an admin?" — a single boolean, resolved SERVER-side.
 *
 * This exists so the nav (a client component, and the only place the admin link
 * now lives) can draw the link without shipping the allowlist. `lib/admin` is
 * `server-only` on purpose; the alternative a client component reaches for is a
 * hardcoded email comparison, which is exactly the bug the old homepage had —
 * see the comment in `src/lib/admin.ts`.
 *
 * Deliberately NOT in `isPublicRoute`, so Clerk protects it and a signed-out
 * caller gets a 404. The nav only calls it once signed in.
 *
 * This is not a gate. /admin 404s for a non-admin on its own, and every
 * /api/admin/* route re-checks before touching data.
 */
export async function GET() {
  return NextResponse.json({ isAdmin: await currentUserIsAdmin() });
}
