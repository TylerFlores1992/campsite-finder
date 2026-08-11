import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, syncUser, hasAutocartEntitlement } from '@/lib/auth';
import { mutate, queryOne } from '@/lib/db/client';

// How recently the bot must have confirmed the rec.gov session for auto-cart to
// be usable. Mirrors AUTOCART_SESSION_STALE_MS in worker/poller.ts (45m ≈ one 30m
// keepalive plus a missed one). If the two ever diverge the UI would promise
// auto-cart the poller has already stopped using, so keep them in step.
const SESSION_STALE_MS = Number(process.env.AUTOCART_SESSION_STALE_MS ?? 45 * 60 * 1000);

export async function GET() {
  const userId = await requireAuth();
  const row = await queryOne<{
    autocart_enabled: boolean;
    autocart_connected: boolean;
    autocart_verified_at: string | null;
  }>(
    'SELECT autocart_enabled, autocart_connected, autocart_verified_at FROM users WHERE id = $1',
    [userId]
  );

  // The poller already refuses the auto-cart lane on a stale stamp and falls back
  // to a normal alert — correct, but silent. Surfacing it lets the UI say so
  // BEFORE the user misses a site, rather than after.
  const verifiedAt = row?.autocart_verified_at ?? null;
  const verifiedMs = verifiedAt ? Date.parse(verifiedAt) : NaN;
  const sessionFresh =
    Number.isFinite(verifiedMs) && Date.now() - verifiedMs < SESSION_STALE_MS;

  // connected = the one-time rec.gov sign-in finished on the bot machine.
  return NextResponse.json({
    enabled: !!row?.autocart_enabled,
    connected: !!row?.autocart_connected,
    // Additive fields — existing callers ignore them.
    verifiedAt,
    sessionFresh,
    // True only when the user asked for auto-cart but it can't currently run.
    sessionExpired: !!row?.autocart_enabled && !!row?.autocart_connected && !sessionFresh,
    // Plan gate (2026-08-01): auto-cart requires the Auto-Cart tier, a grandfathered
    // pre-tier subscription, or beta. The UI shows an upgrade path when false.
    entitled: await hasAutocartEntitlement(userId),
  });
}

export async function POST(req: NextRequest) {
  const userId = await requireAuth();
  await syncUser(userId);

  const { enabled } = await req.json();
  // Turning it ON needs the plan; turning it OFF never does — a lapsed premium
  // subscriber must always be able to switch the thing off.
  if (enabled && !(await hasAutocartEntitlement(userId))) {
    return NextResponse.json(
      { error: 'upgrade_required', message: 'Auto-cart needs the Auto-Cart plan.' },
      { status: 403 }
    );
  }
  await mutate(
    `UPDATE users SET
       autocart_enabled = $1,
       -- Stamped every time the toggle goes ON, not just the first time — re-enabling
       -- after turning it off should reset the "next morning" clock the nudge cron
       -- reads, same as flipping it on for the first time.
       autocart_enabled_at = CASE WHEN $1 THEN NOW() ELSE autocart_enabled_at END,
       updated_at = NOW()
     WHERE id = $2`,
    [!!enabled, userId]
  );
  return NextResponse.json({ ok: true, enabled: !!enabled });
}
