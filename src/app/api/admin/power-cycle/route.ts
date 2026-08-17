import { NextResponse } from 'next/server';
import { currentUserIsAdmin, currentUserEmail } from '@/lib/admin';
import {
  powerCycle, powerCycleRefusal, boxSilentMs, powerPlugConfigured,
  POWER_CYCLE_MIN_SILENT_MS,
} from '@/lib/power-cycle';

export const dynamic = 'force-dynamic';
/** The cut holds the power off for POWER_OFF_SECONDS, so the handler outlives the default. */
export const maxDuration = 60;

/**
 * Hard power-cycle the mini-PC through the cloud smart plug.
 *
 * WHY THIS ROUTE EXISTS AT ALL: on 2026-08-17 the box ran zero processes for over an hour
 * and every remote lever we had rode a process on it. This one does not touch the box — it
 * talks to the plug — which is the only reason it works in the case it was built for.
 *
 * ADMIN ONLY, and 404 rather than 403 to match the rest of /api/admin. This is the single
 * most destructive control in the product: it can interrupt a cart and corrupt the Chromium
 * profile holding RC's `DT` device cookie.
 *
 * GET IS THE PREVIEW AND POST IS THE ACT, deliberately split. A GET can be fired by a link
 * preview or a scanner with nobody involved — the same reasoning that makes the "hold it for
 * me" confirmation a form POST rather than a link. The preview is what lets the panel show
 * the refusal BEFORE somebody presses anything, so the button is never a coin toss.
 */
export async function GET() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const silentMs = await boxSilentMs();
  return NextResponse.json({
    configured: powerPlugConfigured(),
    silentSeconds: silentMs == null ? null : Math.round(silentMs / 1000),
    minSilentSeconds: Math.round(POWER_CYCLE_MIN_SILENT_MS / 1000),
    // Null means "it would be allowed right now". The panel shows this verbatim rather than
    // re-deriving the rule, so the sentence a human reads and the gate that runs cannot
    // disagree — which is the failure the 07:33 alarm made twice.
    refusal: await powerCycleRefusal(silentMs),
  });
}

export async function POST() {
  if (!(await currentUserIsAdmin())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const who = (await currentUserEmail()) ?? 'admin';
  const result = await powerCycle(who);
  // 409 on a refusal, not 500: the gates declining is the system working, and a 500 would
  // read as "the plug is broken" on the one screen where that distinction decides whether
  // somebody gets in a car.
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
