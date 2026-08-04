import { NextRequest, NextResponse } from 'next/server';
import { syncAllTnsc } from '@/lib/sources/tnsc/sync';

// Scheduled catalog sync for the TN/SC ColdFusion portal, driven by Vercel Cron
// (see `crons` in vercel.json). It lives on Vercel for one reason: **Vercel is the
// only scheduled egress that this portal's WAF allows.** All five are measured —
// residential OK, agent proxy OK, Vercel OK, Fly BLOCKED, GitHub Actions runners
// BLOCKED. The Fly block is why /api/tnsc-availability exists; the runner block is
// why there is no step in nightly-sync.yml (tested 2026-08-04, run 30878585899:
// 0 parks in under a second for both states). See docs/CONTEXT.md.
//
// Until this existed TN/SC was the only source with NO scheduled sync at all, so
// the catalog only refreshed when someone remembered — it had gone twelve days,
// and `catalog.syncs` in /api/health/status sat at "2 stale" the whole time.

export const dynamic = 'force-dynamic';

// Measured at ~16s for both states from an allowed egress (TN 39 parks + SC 34).
// 120s is ~7x that, so a slow portal day or a retry still fits, and it is well
// under the Pro plan's 300s ceiling. The default would NOT do: it is below the
// measured runtime, so this would time out mid-sync on a normal night.
export const maxDuration = 120;

/**
 * Two accepted credentials, because there are two callers:
 *  - `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron sends. It is the
 *    ONLY header Vercel lets a cron carry, which is why this isn't just the
 *    `x-sync-secret` the other sync routes use.
 *  - `x-sync-secret: <SYNC_SECRET>` — for running it by hand, matching
 *    /api/sync, /api/rc-proxy and /api/tnsc-availability.
 *
 * Fails CLOSED: an unset env var never matches, so a missing secret makes this
 * unreachable rather than open. This route writes to the catalog — an open
 * version would let anyone on the internet drive traffic at the portal from our
 * IP, which is the one thing most likely to get that IP blocked like the others.
 */
function authorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const bearer = req.headers.get('authorization');
  if (cronSecret && bearer === `Bearer ${cronSecret}`) return true;
  if (syncSecret && req.headers.get('x-sync-secret') === syncSecret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await syncAllTnsc();

    // Zero parks is a FAILURE, not an empty success — the same rule as
    // scripts/run-sync-tnsc.ts. This portal does not reliably answer 403 when it
    // refuses us: a blocked landing can come back 200-but-empty, which parses to
    // "0 parks, 0 errors". Returning 200 there would show a green cron in the
    // Vercel dashboard every night while the catalog silently rotted — the exact
    // shape of failure this repo keeps paying for (the unsigned APK on a green
    // build, the RIDB photo filter, the deploy that left the poller stopped).
    // Neither state has ever legitimately returned zero: TN has 39 camping parks
    // and SC has 34.
    if (result.facilitiesSynced === 0) {
      console.error(
        `[cron sync-tnsc] ZERO parks synced (${result.errors.length} error(s)). ` +
          'Most likely the portal WAF started refusing Vercel too — check a landing ' +
          'response before assuming a code fault.',
        result.errors.slice(0, 5)
      );
      return NextResponse.json(
        { ok: false, ...result, errors: result.errors.slice(0, 10) },
        { status: 500 }
      );
    }

    console.log(
      `[cron sync-tnsc] ${result.facilitiesSynced} parks in ${(result.durationMs / 1000).toFixed(1)}s, ` +
        `${result.errors.length} error(s)`
    );
    return NextResponse.json({
      ok: true,
      facilitiesSynced: result.facilitiesSynced,
      durationMs: result.durationMs,
      errors: result.errors.slice(0, 10),
      errorCount: result.errors.length,
    });
  } catch (err) {
    console.error('[cron sync-tnsc] failed:', err);
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
