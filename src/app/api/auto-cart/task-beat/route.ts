import { NextRequest, NextResponse } from 'next/server';
import { recordTaskBeat, isBotTask } from '@/lib/bot-tasks';

/**
 * "A Windows Scheduled Task on the mini-PC just fired."
 *
 * WHY IT IS ITS OWN ROUTE and not a field on the hold feed. The hold feed is polled by the
 * RC hold runner, and the whole point of this signal is to survive the runner being dead —
 * which is the state it exists to report. Hanging it off the feed would wire the watchdog's
 * heartbeat to the thing the watchdog is watching, for the fourth time in this codebase
 * (`expireStaleHolds` in the feed, the keep-warm's own wedge watchdog, and the release loop
 * inside `withRC` were the first three).
 *
 * WHY IT IS NOT THE ROSTER FEED EITHER, which `bot.mjs` polls every two seconds and which
 * IS reliably up: same reason. `bot.mjs` is a process; Task Scheduler is not. A task must
 * report for itself or the report proves nothing about the task.
 *
 * Authorised by `AUTOCART_TOKEN`, the same bearer the box already holds — it is
 * outbound-only from a machine behind a home router with no inbound path, which is why the
 * whole control channel is built on polling rather than on anything listening here.
 */
function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const bad = unauthorized(req);
  if (bad) return bad;

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const task = String((body as { task?: unknown }).task ?? '');
  const noteRaw = (body as { note?: unknown }).note;
  const note = typeof noteRaw === 'string' ? noteRaw : null;

  // A NAME WE DO NOT KNOW IS A 400, NOT A NEW ROW. See `BOT_TASKS`: silently accepting an
  // unknown name is how a renamed task ends up reporting into a row nothing reads while its
  // real health check stays green on the old one.
  if (!isBotTask(task)) {
    return NextResponse.json({ error: `unknown task '${task}'` }, { status: 400 });
  }

  try {
    await recordTaskBeat(task, note);
  } catch (err) {
    // The CALLER must not care. This is a diagnostic riding a task whose actual job is to
    // restart the bots; a failed beat that took the watchdog down with it would be strictly
    // worse than no beat at all.
    console.error('[task-beat] write failed:', (err as Error).message);
    return NextResponse.json({ ok: false, error: 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
