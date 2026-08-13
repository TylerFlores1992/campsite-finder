import { NextResponse } from 'next/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { query } from '@/lib/db/client';
import { manageTokenFor } from '@/lib/notifications/actions';

export const dynamic = 'force-dynamic';

/**
 * "Open the claim screen for whatever hold is currently carted."
 *
 * WHY THIS EXISTS. The claim flow — step one's sign-in, the `token captured` gate, the
 * release — could only ever be reached by a real 8am hold, which happens a few times a
 * month and is the single worst moment to discover a problem. The admin RC webview test
 * covers the MECHANISM (webview opens, script injects, token captured) and never renders
 * the screen, so the parts that decide whether a user can hand over were untestable.
 *
 * AND IT HAS TO BE AN IN-APP LINK. The injectable webview only exists inside the native
 * shell, and its session is what the precart reads; a claim URL tapped from Mail or
 * Messages opens the SYSTEM browser instead — different cookie jar, `canInject` false, and
 * the whole thing degrades to the checkbox path, which tests nothing that changed. Push
 * carries a url and would work, but only from a runtime with FCM configured. A link
 * originating inside the app keeps the navigation in the webview, which is all this needs.
 *
 * Returns a PATH, not an absolute URL, so the navigation stays same-origin and cannot
 * bounce the user out to a browser.
 *
 * Read-only and admin-gated, 404 like the rest of the admin surface. It reveals a manage
 * token, which authorises acting on that watch — so it is never public.
 */
export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // `carted` and `claiming` only. A `requested` hold has nothing to claim yet and an
  // `offered` one has not been taken up — linking to either would render a screen that is
  // honestly empty and read as a broken button.
  const [h] = await query<{ id: string; watch_id: string; unit_name: string | null; status: string }>(
    `SELECT id, watch_id, unit_name, status FROM rc_hold_requests
      WHERE status IN ('carted', 'claiming')
      ORDER BY carted_at DESC NULLS LAST LIMIT 1`,
  ).catch(() => []);

  if (!h) return NextResponse.json({ url: null, detail: 'No hold is carted right now — nothing to claim.' });

  const token = await manageTokenFor(h.watch_id);
  if (!token) return NextResponse.json({ url: null, detail: 'Could not mint a manage token for that watch.' });

  return NextResponse.json({
    url: `/claim/${h.id}?t=${token}`,
    detail: `${h.unit_name ?? 'a site'} — status ${h.status}`,
  });
}
