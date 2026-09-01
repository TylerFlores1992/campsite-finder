/**
 * THE SIGN-IN WINDOW CLOSES ON RC'S OWN SIGNAL, AND ON NOTHING ELSE — DRIVEN, NOT GREPPED.
 *
 * `rc-signin-close.test.mts` guards the pure decision and pins the host structurally. This
 * file drives the real seam with a stub InAppBrowser and asserts what the window actually
 * DOES: the shape `rc-load-watchdog.test.mts` established, because the whole change is event
 * wiring and structural assertions verify wiring poorly. A version of the host that called
 * `rcCloseAction` and ignored its answer would pass every structural guard and fail here.
 *
 * The rule under test (2026-09-01, #249): RC's SPA boots `isLoggedIn` from
 * `!!localStorage.customerId`, written only by the second step of its sign-in. The bundle
 * reports that as `rc-session { loggedIn }`. A token — live or not — is step one and is
 * captured off step two's own request, so closing on it races the response. Three
 * generations of this handler did exactly that.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Listener = (ev?: unknown) => void;

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
  g.fetch = async () => ({ ok: true, text: async () => 'precartdataforbookingmodify' });
  const fire = (e: string, ev?: unknown) => (listeners.get(e) ?? []).forEach((cb) => cb(ev));
  /** A report from the injected bundle, as the plugin delivers it. */
  const report = (stage: string, detail: unknown) =>
    fire('message', { data: { camphawk: 'rc-precart', n: 1, stage, detail } });
  return { fire, report, closes };
}

async function openHandoff(closeOnToken: boolean, onReport: (r: { stage: string; detail?: unknown }) => void) {
  const { openRcHandoff } = await import('../src/lib/native/rc-handoff');
  return openRcHandoff(
    { url: 'https://www.reservecalifornia.com/park/690/612' },
    { onReport, closeOnToken },
  );
}

const LIVE_TOKEN = { captured: true, decodable: true, expiresInSec: 3598, ageSec: 1 };

test('RC reporting signed in closes the sign-in window, with reason `session`', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff(true, (r) => reports.push(r));
  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });

  shell.report('rc-session', { loggedIn: true, at: 'https://www.reservecalifornia.com/park/690/612' });

  assert.equal(shell.closes.length, 1, 'the window must be taken down');
  const close = reports.find((r) => r.stage === 'close');
  assert.equal((close?.detail as { reason?: string })?.reason, 'session');
});

test('a LIVE token does NOT close the window — that was the defect, on every page', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string; detail?: unknown }[] = [];
  await openHandoff(true, (r) => reports.push(r));

  for (const url of [
    'https://www.reservecalifornia.com/login/callback',
    'https://www.reservecalifornia.com/park/690/612',
  ]) {
    shell.fire('loadstop', { url });
    shell.report('token', LIVE_TOKEN);
    shell.report('rc-session', { loggedIn: false, at: url });
  }
  // And however long we wait: there is no timer that closes a sign-in window any more.
  mock.timers.tick(10 * 60_000);

  assert.equal(shell.closes.length, 0, 'nothing may close on a token, or on a clock');
  assert.ok(!reports.some((r) => r.stage === 'close'), 'no close may be reported either');
});

test('the cart path never closes, even when RC reports signed in', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  await openHandoff(false, () => {});
  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  shell.report('rc-session', { loggedIn: true });
  shell.report('token', LIVE_TOKEN);
  assert.equal(shell.closes.length, 0, 'the cart window IS the job — it must never be closed by us');
});

test('the close is idempotent — a rebroadcast must not close a dead ref twice', async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  const reports: { stage: string }[] = [];
  await openHandoff(true, (r) => reports.push(r));
  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  shell.report('rc-session', { loggedIn: true });
  shell.report('rc-session', { loggedIn: true });
  assert.equal(shell.closes.length, 1);
  assert.equal(reports.filter((r) => r.stage === 'close').length, 1);
});

test('a bundle older than #249 (no rc-session, token only) leaves the window open', async (t) => {
  // The failure direction is the status quo the 08-31 bisect proved: an open window the
  // user closes once the name shows. Never a close before RC has said it is done.
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const shell = stubShell();
  await openHandoff(true, () => {});
  shell.fire('loadstop', { url: 'https://www.reservecalifornia.com/park/690/612' });
  shell.report('token', LIVE_TOKEN);
  mock.timers.tick(10 * 60_000);
  assert.equal(shell.closes.length, 0);
});
