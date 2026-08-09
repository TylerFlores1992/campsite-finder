import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * Serves the ReserveCalifornia precart script, for injection into a mobile in-app webview.
 *
 * ## Why a route and not a copy of the logic
 *
 * `extension/content-rc.js` is 332 lines of behaviour that cost real time to get right:
 * RC's two-step load-then-submit precart, the `extraValues` contract it answers HTTP 200
 * with `IsSuccess: false` if you omit, and unit-specific defaults captured from a live
 * add-to-cart. Writing a second version for the phone would create two implementations of
 * one wire contract, which this codebase has a standing rule against — `rc-cart.mjs` is
 * shared between the probe and the runner for exactly this reason, and RC has already
 * changed the payload once (2026-08-06).
 *
 * So the extension file IS the source, and this hands the same bytes to the phone. The
 * extension keeps using its own copy directly, because MV3 forbids remote code — one file,
 * two consumers, no drift possible.
 *
 * ## The property that makes this worth a route rather than bundling into the app
 *
 * The script updates with a WEB deploy. If it were bundled into the binary, every RC
 * schema change would need an app release and a review — and RC changes things without
 * telling anyone. This way a broken precart is a push to master, exactly like the rest of
 * the alerting stack.
 *
 * ## What is added on top, and why each piece is needed
 *
 * The extension script assumes two things a bare injection does not provide:
 *
 *   1. `chrome.storage.local` — it reads the user's opt-in before carting. There is no
 *      `chrome` in a webview, and the consent question is already answered: the user tapped
 *      "claim" thirty seconds ago, which is a stronger opt-in than a checkbox set once.
 *      Shimmed to yes rather than removed, so the extension file needs no edit.
 *   2. `rc-inject.js` — the MAIN-world script that captures the live `accesstoken` off RC's
 *      own requests, because the localStorage copy is AES-encrypted and unusable (see
 *      rc-token.mjs, and the day lost to reading it anyway). `content-rc.js` waits for its
 *      postMessage. Injected code runs in the page world already, so shipping both in
 *      order gives the same arrangement the extension has.
 *
 * ## Not a secret
 *
 * This is the source of a published browser extension. Serving it publicly gives away
 * nothing that `chrome-extension://` inspection does not, and it carries no credential —
 * the token it uses is the user's own, read in their own session, and never leaves the
 * device. Public so the webview can fetch it without an auth dance at 08:00:00.
 */

/** Cache for the process's life. The files cannot change without a redeploy. */
let cached: string | null = null;

function buildScript(): string {
  const dir = join(process.cwd(), 'extension');
  const inject = readFileSync(join(dir, 'rc-inject.js'), 'utf8');
  const content = readFileSync(join(dir, 'content-rc.js'), 'utf8');

  // ORDER MATTERS: the capture has to be installed before the page script that waits on
  // it, or the token arrives before anyone is listening. Same reasoning as
  // installTokenCapture running before the first navigation on the bot side.
  return [
    '/* CampHawk RC precart — served from extension/, injected into the in-app webview. */',
    '(function () {',
    '  // The user tapped claim; that is the opt-in. See the route for why this is shimmed',
    '  // rather than the extension file being edited.',
    '  if (typeof chrome === "undefined" || !chrome.storage) {',
    '    window.chrome = Object.assign(window.chrome || {}, {',
    '      storage: { local: { get: function (d, cb) { cb({ accepted: true, enabled: true }); } } },',
    '    });',
    '  }',
    '})();',
    inject,
    content,
  ].join('\n');
}

export async function GET() {
  try {
    cached ??= buildScript();
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
