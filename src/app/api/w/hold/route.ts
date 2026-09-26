import { NextRequest, NextResponse } from 'next/server';
import { performAction } from '@/lib/notifications/actions';

export const dynamic = 'force-dynamic';

/**
 * Confirm a "hold it for me" — the POST half of the two-step flow.
 *
 * WHY THIS IS NOT A GET. `hold` is the only alert action that cannot be undone: it
 * commits the bot to carting a real site at 08:00, taking it off the market for everyone
 * else. `/w/<token>` performs its actions on page load, which is right for the reversible
 * ones (stop, reopen, mute, keep) and wrong for this one — an email scanner or a link
 * preview fetching the URL would book a hold nobody asked for, and a tapped push
 * notification booked one before the owner had seen which site it was.
 *
 * Authorised by the token alone, exactly as before. The confirm step changes WHEN the
 * action happens, not who may perform it.
 *
 * Redirects back to `/w/<token>?r=<outcome>`. The outcome marker is what lets that page
 * tell "you just said yes" apart from "you came back": without it both rendered the repeat-
 * tap screen ("You're already down for this one … Tapping again changes nothing"), so the
 * person who had just confirmed was answered with what read as a refusal — and the hedged
 * outcomes (window full, bot offline) were never shown on the web at all. The marker only
 * picks COPY; the page still reads the row's real status (see `HOLD_OUTCOMES`). A refresh
 * cannot double-book (`requestHold` is idempotent anyway).
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = String(form?.get('token') ?? '');
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const result = await performAction(token);
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');

  // 303, not 302: the browser must follow with GET rather than re-POSTing, which is what
  // makes a refresh of the result page harmless.
  const url = new URL(`${base}/w/${encodeURIComponent(token)}`);
  url.searchParams.set('r', result.outcome ?? (result.ok ? 'held' : 'gone'));
  return NextResponse.redirect(url, 303);
}
