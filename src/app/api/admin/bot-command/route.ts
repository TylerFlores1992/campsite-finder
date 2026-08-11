import { NextRequest, NextResponse } from 'next/server';
import { currentUserIsAdmin, currentUserEmail } from '@/lib/admin';
import { requestBotCommand, recentBotCommands, BOT_COMMAND_KINDS, RESTART_RC_BLACKOUT_MIN } from '@/lib/bot-commands';

export const dynamic = 'force-dynamic';

/**
 * Ask the mini-PC a diagnostic question, and read the answers.
 *
 * ADMIN ONLY. The box refuses anything outside its own allowlist, so this cannot become a
 * shell whatever happens here — but a diagnostic still returns log excerpts from a machine
 * holding live sessions, and those are not public. `currentUserIsAdmin` is server-only and
 * Clerk-authed, and the response is 404 rather than 403, matching the rest of /api/admin.
 */
export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    // SERVED, not imported by the panel. `bot-commands.ts` reaches the database, so a
    // client component importing a VALUE from it pulls `fs` into the browser bundle and
    // fails the build — `import type` is erased and hides this until the moment you need a
    // real constant. Caught by `next build` after typecheck and 396 tests were all green.
    restartBlackoutMin: RESTART_RC_BLACKOUT_MIN,
    kinds: Object.entries(BOT_COMMAND_KINDS).map(([kind, s]) => ({
      kind, label: s.label, argHint: s.argHint, argOptions: s.argOptions ?? null,
    })),
    recent: await recentBotCommands(10),
  });
}

export async function POST(req: NextRequest) {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const kind = typeof body?.kind === 'string' ? body.kind : '';
  const arg = typeof body?.arg === 'string' && body.arg ? body.arg : null;
  const who = (await currentUserEmail()) ?? 'admin';
  const result = await requestBotCommand(kind, arg, who);
  // 400, not 404: an admin asking for something outside the allowlist should be told what
  // is wrong with the request, not that the endpoint does not exist.
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, id: result.id });
}
