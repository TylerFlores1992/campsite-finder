import { NextResponse, after } from 'next/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { alarmCall } from '@/lib/notifications/voice';
import { query } from '@/lib/db/client';
import { auth } from '@clerk/nextjs/server';

export const dynamic = 'force-dynamic';
// Same reasoning as the hold feed: the repeat call is scheduled with `after`, which runs
// inside this invocation's budget.
export const maxDuration = 90;

/**
 * Ring my phone, right now, so I know the alarm works.
 *
 * The alarm's whole value is that it fires on a morning when something is already broken,
 * which is the worst possible time to discover that the Twilio number is SMS-only, or that
 * the phone on file is wrong, or that the call goes to voicemail. None of that is knowable
 * from the code — Twilio rejects a non-voice-capable `From` at call time with a 21210, and
 * we have never placed a voice call from this account.
 *
 * So: a button, and a real call. It is deliberately the same `alarmCall` on the same path
 * as the real thing — a test that exercises a different code path would confirm the wrong
 * thing. The only difference is the words.
 *
 * ADMIN ONLY, and it re-checks rather than trusting the nav: /api/admin/status draws a
 * link, it is not a gate.
 */
export async function POST() {
  if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // `users.id` IS the Clerk user id — see ensureUser in lib/auth, which upserts the Clerk
  // id straight into the primary key. There is no separate clerk_id column to join on.
  const { userId } = await auth();
  const [me] = await query<{ phone: string | null }>(
    'SELECT phone FROM users WHERE id = $1',
    [userId],
  ).catch(() => []);

  const to = process.env.AUTOCART_ALARM_PHONE || me?.phone;
  if (!to) {
    return NextResponse.json({
      ok: false,
      detail: 'No phone on file and AUTOCART_ALARM_PHONE is not set — there is nothing to ring.',
    });
  }

  const spoken =
    'This is a CampHawk test. Your alarm is working. ' +
    'A real one means the Reserve California session is dead and a campsite is about to release.';

  // A fresh key every time. The rate limit exists to stop a stuck reporter dialling all
  // night; a person pressing a test button twice on purpose is not that, and making them
  // wait fifteen minutes to re-test would be its own small trap.
  const key = `test-alarm:${Date.now()}`;
  const r = await alarmCall(to, spoken, key, (task) => after(task));

  // Say WHICH number, masked. "It worked" against the wrong phone is the failure this
  // test is supposed to rule out, and the caller cannot see who we dialled otherwise.
  const masked = to.replace(/.(?=.{4})/g, '•');
  return NextResponse.json({
    ok: r.placed > 0,
    to: masked,
    // The second call is what pierces Do Not Disturb, so the reply has to set the
    // expectation — otherwise one call arriving looks like the feature working.
    detail: r.placed
      ? `Calling ${masked} now, and again in about 45 seconds. Both should ring — the repeat is what gets through Do Not Disturb.`
      : `Could not place the call: ${r.error}`,
  });
}
