import { NextResponse } from 'next/server';
import { buildPrecartScript } from '@/lib/rc-precart-script';

export const dynamic = 'force-dynamic';

/**
 * Serves the ReserveCalifornia precart script, for injection into a mobile in-app webview.
 *
 * The script itself — and the long explanation of why it is served rather than copied, and
 * what the reporter adds on top — lives in `lib/rc-precart-script`. It is a plain module so
 * `worker/rc-handoff.test.mts` can call the real builder and syntax-check the real bytes.
 * The test used to reassemble an approximation by hand, which is worth nothing here: a
 * syntax error in the injected bundle runs NOTHING, and an injection that runs nothing is
 * indistinguishable from a webview that refused us.
 */

/** Cache for the process's life. The files cannot change without a redeploy. */
let cached: string | null = null;

export async function GET() {
  try {
    cached ??= buildPrecartScript();
  } catch (err) {
    // A missing file means the deployment did not include extension/ — see
    // outputFileTracingIncludes in next.config.ts. Fail LOUDLY rather than serving an
    // empty script: an injection that runs nothing looks exactly like a cart that failed
    // silently, and the claim screen would tell the user we were carting for them.
    return NextResponse.json(
      { error: `rc precart unavailable: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  return new NextResponse(cached, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Short, not immutable: this is the thing we would hot-fix if RC changed its payload
      // mid-morning, and a long cache would keep serving the broken one.
      'cache-control': 'public, max-age=300',
    },
  });
}
