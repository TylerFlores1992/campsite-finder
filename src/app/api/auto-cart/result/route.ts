import { NextRequest, NextResponse } from 'next/server';
import { mutate } from '@/lib/db/client';
import { dispatchNotifications, type NotificationPayload } from '@/lib/notifications';
import { recordBotEvent } from '@/lib/bot-events';

export const dynamic = 'force-dynamic';

// The bot reports the outcome of every cart attempt here (master AUTOCART_TOKEN).
// Two jobs: (1) it's the permanent record of what happened to each opening — the
// bot's console used to be the only place outcomes were visible; (2) a 'carted'
// outcome is what triggers the "it's in your cart, check out" alert. We only text
// on a confirmed cart, never on false hope — the poller's reconciler handles the
// not-carted jobs (normal alert if still open, silence if gone).
export async function POST(req: NextRequest) {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { jobId?: string; outcome?: string; detail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const jobId = String(body.jobId ?? '').trim();
  const outcome = String(body.outcome ?? '').trim();
  if (!jobId || !outcome) {
    return NextResponse.json({ error: 'jobId and outcome required' }, { status: 400 });
  }

  // Record the outcome (diagnostic fields; last write wins).
  await mutate(
    `UPDATE autocart_jobs SET cart_outcome = $2, cart_reported_at = NOW() WHERE id = $1`,
    [jobId, outcome]
  );

  if (outcome === 'carted') {
    // Atomically claim the resolution so the reconciler can't double-fire, then
    // send the "it's in your cart" alert.
    const rows = await mutate<{ payload: NotificationPayload }>(
      `UPDATE autocart_jobs SET resolution = 'carted', resolved_at = NOW()
       WHERE id = $1 AND resolution IS NULL RETURNING payload`,
      [jobId]
    );
    if (rows.length > 0 && rows[0].payload) {
      await dispatchNotifications({ ...rows[0].payload, kind: 'carted' }).catch((e) =>
        console.error('[auto-cart/result] carted dispatch failed:', e)
      );
    }
  }

  // THE LADDER'S TRAIL, LAST. Not in `cart_outcome`: three SQL predicates in two lanes read
  // that column (`= 'carted'` in carted-history and watch-openings, `!= 'carted'` in the
  // reconciler), so it stays one short string. `bot_events` is where a reading that nothing
  // overwrites belongs — the same argument PR #384 made for the RC cart burst, and the same
  // failure it fixed: the only copy lived in a box console that rolls in ~89 minutes, so
  // "why did the add not take?" was unanswerable ten hours after a real user lost a campsite.
  //
  // AFTER the dispatch above, deliberately. This is a diagnostic and the line above is a text
  // message about a campsite someone is racing for; a diagnostic that can delay the thing it
  // observes is not worth having. `recordBotEvent` swallows its own errors, and an unknown
  // kind or an oversized detail is stored as NULL rather than refused — so nothing here can
  // fail the outcome write that has already happened.
  if (body.detail && typeof body.detail === 'object') {
    await recordBotEvent({ kind: 'recgov-cart', detail: body.detail }, 'recgov-bot');
  }

  return NextResponse.json({ ok: true });
}
