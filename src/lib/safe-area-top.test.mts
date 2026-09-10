import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY SCREEN OUTSIDE THE (app) ROUTE GROUP MUST RESERVE THE STATUS-BAR BAND ITSELF.
 *
 * WHAT BROKE, reported on a new Pixel 2026-09-10: "some pages have buttons at the very
 * top of the page that aren't clickable."
 *
 * WHY. `capacitor.config.ts` sets `StatusBar.overlaysWebView: false` and
 * `NativeBridge.tsx` calls `setOverlaysWebView({ overlay: false })` again at runtime,
 * under a comment that predicts this exact symptom. Both are no-ops on a current Pixel:
 *
 *   - The app targets SDK 36 (asserted in `codemagic.yaml`, "Assert the Play target API
 *     level"). Android 15 enforces edge-to-edge for apps targeting 35+, and Android 16
 *     ignores the `windowOptOutEdgeToEdgeEnforcement` opt-out entirely.
 *   - The plugin implements `setOverlaysWebView(false)` by CLEARING the legacy
 *     `View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN` / `_LAYOUT_STABLE` bits
 *     (`@capacitor/status-bar/android/.../StatusBar.java`). Those bits no longer decide
 *     the layout once edge-to-edge is enforced.
 *   - The same file's `shouldSetStatusBarColor()` says it in as many words: on a device
 *     above Android 15 it returns false — "opt-out ignored" — so `backgroundColor` is
 *     dead too and the bar is transparent over the page.
 *
 * So the webview draws under the status bar. The status bar is a separate SystemUI
 * window on top of ours, so a control drawn beneath it is VISIBLE and receives no taps.
 * That is the reported symptom exactly, and it is why it appeared on a NEW phone: on
 * Android 14 and below the opt-out still works.
 *
 * THE FIX IS CSS, NOT CONFIG. There is nothing to turn off on Android 16 — the only
 * remedy is to consume `env(safe-area-inset-top)`. Three surfaces already did
 * (`V2Nav`, `/admin`, `/auto-cart`), each added after its own real-device report on
 * 2026-08-01 and 2026-08-08; the rest did not, which is why this was "some pages".
 *
 * `env()` resolves to 0px in a browser, so every one of these is a no-op on the web.
 * It is web-side, so it reaches already-installed apps on a push — no rebuild, no review.
 *
 * WHY A REGISTRY RATHER THAN A SCAN. A page can own its inset directly or delegate to a
 * shared renderer (the six /camping accommodation routes are two components; /claim is
 * ClaimFlow's Shell). A scan of page files alone would report those as broken; a scan
 * that followed imports would pass on any file that merely mentions the string. Naming
 * the owner makes a NEW standalone route fail here until somebody decides which it is.
 */

const APP_DIR = 'src/app';

/** page.tsx -> the file that must carry the inset for it. */
const INSET_OWNER: Record<string, string> = {
  // Own their inset directly.
  'src/app/admin/page.tsx': 'src/app/admin/page.tsx',
  'src/app/admin/users/[id]/page.tsx': 'src/app/admin/users/[id]/page.tsx',
  'src/app/auto-cart/page.tsx': 'src/app/auto-cart/page.tsx',
  'src/app/camping/page.tsx': 'src/app/camping/page.tsx',
  'src/app/camping/[state]/page.tsx': 'src/app/camping/[state]/page.tsx',
  'src/app/camping/hardest-to-book/page.tsx': 'src/app/camping/hardest-to-book/page.tsx',
  'src/app/campsite-cancellation-alerts/page.tsx': 'src/app/campsite-cancellation-alerts/page.tsx',
  'src/app/connect/page.tsx': 'src/app/connect/page.tsx',
  'src/app/privacy/page.tsx': 'src/app/privacy/page.tsx',
  'src/app/sms-opt-in/page.tsx': 'src/app/sms-opt-in/page.tsx',
  'src/app/sold-out-campsite/page.tsx': 'src/app/sold-out-campsite/page.tsx',
  'src/app/sources/page.tsx': 'src/app/sources/page.tsx',
  'src/app/support/page.tsx': 'src/app/support/page.tsx',
  'src/app/terms/page.tsx': 'src/app/terms/page.tsx',
  'src/app/w/[token]/page.tsx': 'src/app/w/[token]/page.tsx',
  'src/app/sign-in/[[...sign-in]]/page.tsx': 'src/app/sign-in/[[...sign-in]]/page.tsx',
  'src/app/sign-up/[[...sign-up]]/page.tsx': 'src/app/sign-up/[[...sign-up]]/page.tsx',

  // Thin routes over a shared renderer — the renderer owns the inset for all of them.
  'src/app/camping/cabins/page.tsx': 'src/components/v2/SiteTypeHubPage.tsx',
  'src/app/camping/group-camping/page.tsx': 'src/components/v2/SiteTypeHubPage.tsx',
  'src/app/camping/yurts/page.tsx': 'src/components/v2/SiteTypeHubPage.tsx',
  'src/app/camping/cabins/[state]/page.tsx': 'src/components/v2/SiteTypeStatePage.tsx',
  'src/app/camping/group-camping/[state]/page.tsx': 'src/components/v2/SiteTypeStatePage.tsx',
  'src/app/camping/yurts/[state]/page.tsx': 'src/components/v2/SiteTypeStatePage.tsx',

  // The 08:00 hand-off. Every state renders through ClaimFlow's <Shell>.
  'src/app/claim/[id]/page.tsx': 'src/components/v2/ClaimFlow.tsx',
};

const INSET = 'env(safe-area-inset-top)';

function read(p: string) {
  return readFileSync(join(process.cwd(), p), 'utf8');
}

/** Every page.tsx under src/app that is NOT in the (app) route group. */
function standalonePages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === '(app)' || e.name === 'api') continue;
        walk(rel);
      } else if (e.name === 'page.tsx') {
        out.push(rel);
      }
    }
  };
  walk(APP_DIR);
  return out.sort();
}

test('every standalone page names the file that reserves its status-bar band', () => {
  const missing = standalonePages().filter((p) => !(p in INSET_OWNER));
  assert.deepEqual(
    missing,
    [],
    `These routes are outside the (app) group, so V2Nav never supplies the safe-area ` +
      `inset for them, and nothing in INSET_OWNER says what does. On Android 16 the ` +
      `webview draws under the status bar and anything they render in the top ~48px ` +
      `takes no taps. Add the inset (see the three examples above) and register it here.`,
  );
});

test('no registry entry points at a route that no longer exists', () => {
  const live = new Set(standalonePages());
  const stale = Object.keys(INSET_OWNER).filter((p) => !live.has(p));
  assert.deepEqual(stale, [], 'stale INSET_OWNER entries — the route is gone');
});

test('every named owner actually reserves the band', () => {
  for (const [page, owner] of Object.entries(INSET_OWNER)) {
    assert.ok(existsSync(join(process.cwd(), owner)), `${owner} does not exist (owner of ${page})`);
    assert.ok(
      read(owner).includes(INSET),
      `${owner} owns the status-bar inset for ${page} and no longer contains ` +
        `${INSET}. Restore it, or the top of that screen stops taking taps in the app.`,
    );
  }
});

test('a page that delegates its inset actually renders the file it names', () => {
  // The fix-present-and-inert shape: the owner can be perfect and unreachable. A thin
  // route must genuinely import the renderer it points at.
  for (const [page, owner] of Object.entries(INSET_OWNER)) {
    if (owner === page) continue;
    const component = owner.split('/').pop()!.replace(/\.tsx$/, '');
    assert.ok(
      read(page).includes(component),
      `${page} names ${owner} as its inset owner but does not import ${component}`,
    );
  }
});

test('the root viewport still opts into the display cutout', () => {
  // WITHOUT THIS EVERY OWNER ABOVE IS SILENTLY INERT. env(safe-area-inset-*) is 0 in
  // every direction unless the viewport is viewport-fit=cover, so dropping this one
  // line un-fixes twenty-one screens at once and nothing else goes red.
  const layout = read('src/app/layout.tsx');
  assert.match(
    layout,
    /viewportFit:\s*["']cover["']/,
    'src/app/layout.tsx must set viewportFit: "cover" or env(safe-area-inset-*) is 0 everywhere',
  );
});

test('the root layout does not add a top inset of its own', () => {
  // The tempting "just do it once at the root" — it would double-count against all
  // twenty-one owners and against V2Nav, pushing every screen down by a second band.
  assert.ok(
    !read('src/app/layout.tsx').includes(INSET),
    'src/app/layout.tsx must not add the top inset: every screen already reserves its own',
  );
});

test('the (app) group is covered by V2Nav, and mounts it', () => {
  const nav = read('src/components/v2/V2Nav.tsx');
  assert.ok(nav.includes(INSET), 'V2Nav reserves the band for every page in the (app) group');
  assert.ok(
    read('src/app/(app)/layout.tsx').includes('<V2Nav'),
    'the (app) layout must mount V2Nav — it is what supplies the inset for that whole group',
  );
});
