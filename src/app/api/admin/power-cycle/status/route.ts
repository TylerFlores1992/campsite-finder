import { NextResponse } from 'next/server';
import { currentUserIsAdmin } from '@/lib/admin';
import { plugStatus } from '@/lib/power-cycle';

export const dynamic = 'force-dynamic';

/**
 * Is the smart plug reachable, and do OUR credentials authenticate?
 *
 * WHY THIS IS A SEPARATE ROUTE FROM THE PREVIEW. `GET /api/admin/power-cycle` answers "would
 * a cut be allowed right now" and is read on the admin page; it must stay fast and must not
 * depend on a third party being up. This one makes a real network call to SwitchBot, so a
 * slow or down API would otherwise make the refusal preview — the sentence somebody reads at
 * 07:50 while deciding whether to drive to the box — hang or fail. Different questions,
 * different failure modes, different routes.
 *
 * GET IS CORRECT HERE, and that is not a contradiction of the sibling route splitting
 * GET-preview from POST-act. That split exists because a link preview or a scanner can fire a
 * GET with nobody involved, which must never CUT POWER. This call cannot switch anything: it
 * is a GET to `/status` with no command body. Being fired by accident costs one API call.
 *
 * ADMIN ONLY, 404 rather than 403, matching the rest of /api/admin.
 */
export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const status = await plugStatus();
  // 200 EVEN WHEN THE PLUG IS UNHAPPY. The request succeeded and the answer is "the plug says
  // no" — a 5xx here would read as "this endpoint is broken", which is the one reading that
  // would stop somebody trusting the pre-flight at the moment it matters. The payload carries
  // the verdict, exactly as SwitchBot's own statusCode does inside an HTTP 200.
  return NextResponse.json(status);
}
