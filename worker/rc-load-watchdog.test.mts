/**
 * A WEBVIEW THAT NEVER LOADS MUST NOT NEED A FORCE-QUIT.
 *
 * Reported 2026-09-01 and confirmed twice: RC's web app tier fails while its DATA API stays
 * healthy — on 08-30 and again on 09-01, `www.reservecalifornia.com` answered 200 in ~0.38s
 * from our infrastructure and `detect:reservecalifornia` was green, while the owner could not
 * load RC on a phone OR a PC OR through a VPN. The 08:00 cart path only talks to the API and
 * is immune; the HAND-OFF loads the SPA and is not.
 *
 * Until this change nothing in `rc-handoff` guarded that: no open timeout, `loaderror`
 * recorded and ignored, no `loadstart`. The user was left on a dead window and force-quit was
 * the only way out.
 *
 * These are BEHAVIOURAL, not structural — the seam is driven with a stub InAppBrowser and a
 * fake clock, so they test that the window actually closes rather than that the file contains
 * a `setTimeout`. That matters here because the whole change is timer wiring, which structural
 * assertions verify poorly.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Listener = (ev?: unknown) => void;

/** A stand-in for the plugin's window handle. Records what the seam did to it. */
function stubShell() {
  const listeners = new Map<string, Listener[]>();
  const closes: number[] = [];
  const ref = {
    addEventListener(e: string, cb: Listener) {
      listeners.set(e, [...(listeners.get(e) ?? []), cb]);
    },
    executeScript(_d: { code: string }, cb?: (r: unknown) => void) { cb?.([null]); },
    close() { closes.push(Date.now()); },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    Capacitor: { isNativePlatform: () => true },
    cordova: { InAppBrowser: { open: () => ref } },
  };
  // No `navigator` stub: it is a getter in Node and cannot be assigned, and `isNativeShell`
  // returns true on the `Capacitor` branch before it ever reaches the user-agent fallback.
  // The served bundle, only enough of it to pass the seam's own sanity check.
  g.fetch = async () => ({ ok: true, text: async () => 'precartdataforbookingmodify' });
  const fire = (e: string, ev?: unknown) => (listeners.get(e) ?? []).forEach((cb) => cb(ev));
  return { fire, closes, listeners };
}

async function openHandoff(onReport: (r: { stage: string; detail?: unknown }) => void) {
  // Imported inside the test so the stubbed globals are in place first.
  const { openRcHandoff } = await import('../src/lib/native/rc-handoff');
  return openRcHandoff({ url: 'https://www.reservecalifornia.com/park/690/612' }, { onReport });
}

test('a webview that never loads is closed, and says so', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff((r) => reports.push(r));

  // RC never renders. Before this change, nothing at all happened here — for ever.
  mock.timers.tick(60_000);

  assert.equal(shell.closes.length, 1, 'the window must be taken down');
  const close = reports.find((r) => r.stage === 'close');
  assert.ok(close, 'the close must be reported — the page cannot report on itself');
  assert.equal((close!.detail as { reason: string }).reason, 'never-loaded');
});

test('a webview that DOES load is left alone', async (t) => {
  // The regression that would matter most: a watchdog that closes a working hand-off at
  // 08:00 is far worse than the fault it guards.
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff((r) => reports.push(r));

  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  mock.timers.tick(60_000);

  assert.equal(shell.closes.length, 0, 'a page that rendered must not be closed');
  assert.equal(reports.filter((r) => r.stage === 'close').length, 0);
});

test('the watchdog guards the FIRST load only — reading a page must not close it', async (t) => {
  // Re-arming per loadstop would make this "no navigation for 20s", which is what a user
  // reading the page looks like. That version closes the window under somebody halfway
  // through checking their dates.
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  await openHandoff(() => {});

  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  mock.timers.tick(300_000); // five minutes of reading, no further navigation

  assert.equal(shell.closes.length, 0);
});

test('a load error before any successful load closes the window', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff((r) => reports.push(r));

  shell.fire('loaderror', { message: 'net::ERR_TIMED_OUT', code: -8 });

  assert.equal(shell.closes.length, 1, 'a webview that failed outright must not just sit there');
  const close = reports.find((r) => r.stage === 'close');
  assert.equal((close!.detail as { reason: string }).reason, 'load-error');
  // And it is still reported as its own stage — the message and code are the diagnostic.
  assert.ok(reports.some((r) => r.stage === 'loaderror'), 'the error itself must be recorded');
});

test('a load error AFTER a successful load does not close — it may be a sub-resource', async (t) => {
  // An image, a font, one analytics beacon RC failed to fetch. Closing a working hand-off
  // over a missing icon at 08:00 is the expensive direction.
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff((r) => reports.push(r));

  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  shell.fire('loaderror', { message: 'net::ERR_FAILED', code: -2 });
  mock.timers.tick(60_000);

  assert.equal(shell.closes.length, 0, 'the page is up — a later error is not fatal');
  assert.ok(reports.some((r) => r.stage === 'loaderror'), 'but it is still recorded');
});

test('a user-driven close cancels the watchdog', async (t) => {
  // Otherwise the timer fires on a webview that is gone: close() on a dead ref, and a `close`
  // report naming a reason that never happened.
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff((r) => reports.push(r));

  shell.fire('exit');
  mock.timers.tick(60_000);

  assert.equal(shell.closes.length, 0, 'nothing to close — the user already did');
  assert.equal(reports.filter((r) => r.stage === 'close').length, 0);
});

test('the watchdog is bounded at both ends', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/lib/native/rc-handoff.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const m = src.match(/LOAD_WATCHDOG_MS\s*=\s*([\d_]+)/);
  assert.ok(m, 'LOAD_WATCHDOG_MS must be a readable literal');
  const ms = Number(m![1].replace(/_/g, ''));
  // Long enough not to cut off a slow connection; short enough that nobody sits wondering,
  // and well inside the seconds-wide window an 08:00 cart actually has.
  assert.ok(ms >= 8_000, `too eager — a slow but working load would be killed: ${ms}ms`);
  assert.ok(ms <= 45_000, `long enough to read as frozen: ${ms}ms`);
});
