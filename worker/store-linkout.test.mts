// STEERING OUT OF THE NATIVE APP IS PER STORE, AND ANDROID MUST STAY OFF.
//
// Apple rejected 1.0 (5) under guideline 3.1.1 — "the app accesses digital content
// purchased outside the app … but that content isn't available to purchase using In-App
// Purchase" — and named the remedy in the same letter: US-storefront apps may link out to
// the default browser for payment. Turning that on is one flag, and the flag is WEB-side
// and shared by both native apps.
//
// THE TWO APPS DO NOT HAVE THE SAME AVAILABILITY. iOS is United States only (App Store
// Connect, 2026-07-30), so every iOS install is a US storefront by construction. The
// Android closed test is deliberately WORLDWIDE, because the paid tester service requires
// it. So a single boolean would have fixed Apple by showing steering UI to non-US Play
// testers — the exact review failure the module's own header warns about, introduced BY the
// fix for the other store. That is what this file exists to stop happening again.
//
// The failure is invisible at every call site: the components read one flag and look
// correct either way. It is only wrong because of a property of a store console.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MODULE = 'src/components/v2/nativeSubscribe.tsx';
const SRC = readFileSync(MODULE, 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CONTEXT = readFileSync('src/lib/native/context.tsx', 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The literal, read out of source — the flags are compile-time constants by design. */
function flag(store: 'ios' | 'android'): boolean {
  const block = code.slice(code.indexOf('LINKOUT_BY_STORE'), code.indexOf('} as const'));
  const m = new RegExp(`${store}:\\s*(true|false)`).exec(block);
  assert.ok(m, `LINKOUT_BY_STORE must declare ${store}`);
  return m![1] === 'true';
}

test('ANDROID STEERING IS OFF while the Play track is worldwide', () => {
  // The one that costs money if it is wrong. Google's carve-out is US-storefront only, and
  // the closed test is global on purpose — the paid tester service requires it. Flipping
  // this before Play PRODUCTION is live and US-only shows steering UI to testers the
  // carve-out does not cover.
  assert.equal(flag('android'), false,
    'do not enable Android steering until Play production is live AND restricted to the US');
});

test('iOS steering is on, which is what answers the 3.1.1 rejection', () => {
  // App Store availability is US-only, so every install is a US storefront. If this is ever
  // turned back off, the 3.1.1 rejection returns — so the change should be deliberate.
  assert.equal(flag('ios'), true);
});

test('the two stores are SEPARATE flags, not one boolean', () => {
  // The whole point. A single switch cannot express "on for one store, off for the other",
  // and that is exactly the state the two apps are in.
  assert.match(code, /LINKOUT_BY_STORE\s*=\s*\{/, 'the flags must be a per-store map');
  assert.ok(!/export const NATIVE_LINKOUT\b/.test(code),
    'the single shared boolean must not come back — it cannot answer for two stores');
});

test('the gate is the PLATFORM hook, never a bare constant', () => {
  // A component reading `LINKOUT_BY_STORE.ios` directly would be steering on Android too.
  assert.match(code, /export function useNativeLinkout\(\): boolean/);
  assert.match(code, /const platform = useNativePlatform\(\)/,
    'the flag must be selected by the platform actually running the app');
  assert.match(code, /platform \? LINKOUT_BY_STORE\[platform\] : false/,
    'and an unidentified shell must get false, which is the safe direction');
});

test('the web is never steered — it can simply sell', () => {
  // `useNativePlatform` returns null outside the native shell, so the web falls to false.
  assert.match(CONTEXT, /if \(!ua\.includes\('CampHawkApp'\)\) return null;/,
    'a non-native UA must resolve to no platform at all');
  assert.match(CONTEXT, /getPlatformServerSnapshot = \(\): NativePlatform => null/,
    'and the server snapshot must be null, or SSR would steer everyone');
});

test('Android is tested BEFORE iOS in the UA sniff', () => {
  // An Android UA also carries "Linux", and some webviews carry Mac tokens. The specific
  // test has to win or every Android install reads as iOS — which would turn Android
  // steering on through the back door, defeating the flag above entirely.
  const body = CONTEXT.slice(CONTEXT.indexOf('const getPlatformSnapshot'));
  const android = body.indexOf("return 'android'");
  const ios = body.indexOf("return 'ios'");
  assert.ok(android > -1 && ios > -1, 'both platforms must be detected');
  assert.ok(android < ios, 'Android must be matched first');
});

test('an unrecognised native shell gets no steering', () => {
  const body = CONTEXT.slice(CONTEXT.indexOf('const getPlatformSnapshot'),
    CONTEXT.indexOf('const getPlatformServerSnapshot'));
  assert.match(body, /return null;\s*\};?\s*$/,
    'the fall-through must be null — a store we cannot name is one whose rules we do not know');
});

test('the sentence is a COMPONENT, so it is never a conditional hook call', () => {
  // Every call site sits inside a conditional branch. `{useSubscribeSentence()}` there is a
  // Rules-of-Hooks violation that works until the branch flips and the hook order changes.
  assert.match(code, /export function SubscribeSentence\(\)/);
  for (const f of ['Explore', 'SubscribeCta', 'Settings', 'PricingSection']) {
    const s = readFileSync(`src/components/v2/${f}.tsx`, 'utf8');
    assert.ok(!/\{\s*useSubscribeSentence\(\)\s*\}/.test(s),
      `${f} must render <SubscribeSentence />, not call the hook inside JSX`);
    assert.match(s, /<SubscribeSentence \/>/, `${f} must still render the sentence`);
  }
});

test('the two branching surfaces read the hook ABOVE their early returns', () => {
  // `WatchCta` bails on `!loaded` and on several subscription states; `NewWatch` renders the
  // needs-subscription message deep inside a form. A hook read below an early return is
  // called conditionally.
  for (const f of ['WatchCta', 'NewWatch']) {
    const s = readFileSync(`src/components/v2/${f}.tsx`, 'utf8');
    const hookAt = s.indexOf('useNativeLinkout()');
    const firstReturn = s.indexOf('    return (');
    assert.ok(hookAt > -1, `${f} must read the linkout hook`);
    assert.ok(hookAt < firstReturn,
      `${f} must read it before the first early return, or the hook is conditional`);
    assert.ok(!/NATIVE_LINKOUT/.test(s), `${f} must not read the removed shared boolean`);
  }
});
