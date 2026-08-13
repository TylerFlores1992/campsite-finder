/**
 * Every hand-off must say which platform it ran on.
 *
 * ── WHY (2026-08-13) ───────────────────────────────────────────────────────────────────
 * The two RC cart POSTs were proven on a real hold, and the write-up of that run was one
 * edit away from saying "proven on Android". It wasn't — it was iOS — and the only reason
 * anyone knew is that the owner happened to send a screenshot whose status bar gave it
 * away. `client_reports` carried no platform field at all.
 *
 * That matters because the platforms differ exactly where this feature lives: WKWebView
 * has its own cookie store and its own ITP rules, which is why the 08-09 sign-in tests
 * were repeated on iOS rather than inferred from Android. A result on one is not a result
 * on both — so a trace that cannot say which it was settles neither, and the next run's
 * write-up would be another coin toss.
 *
 * ── WHAT THIS HOLDS ────────────────────────────────────────────────────────────────────
 * `ClaimFlow` must stamp the platform before EVERY `openRcHandoff`, not just the first
 * one it happens to call. There are three exits from that screen and they were added at
 * different times; the failure mode is a new fourth exit that reports nothing, which is
 * invisible until someone tries to read a trace months later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/components/v2/ClaimFlow.tsx', import.meta.url);
const src = readFileSync(SRC, 'utf8');

/** Comments explain the rule; they must not be able to satisfy it. */
const code = src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

test('every openRcHandoff is preceded by a platform stamp', () => {
  const opens = (code.match(/openRcHandoff\(/g) ?? []).length;
  assert.ok(opens >= 3, `expected the three known hand-off exits, found ${opens}`);
  const stamps = (code.match(/notePlatform\(\)/g) ?? []).length;
  // One definition + one call per exit. The definition is `const notePlatform = useCallback`,
  // which does not match `notePlatform()`, so this counts calls only.
  assert.equal(
    stamps, opens,
    `${opens} openRcHandoff call(s) but ${stamps} notePlatform() call(s) — a hand-off that ` +
    'reports no platform produces a trace nobody can attribute to a platform later.',
  );
});

test('the stamp carries the platform AND the build, and nothing sensitive', () => {
  const block = code.slice(code.indexOf('const notePlatform'), code.indexOf('async function prepareRc'));
  assert.ok(block.includes("stage: 'platform'"), 'the report needs a stable stage name to query on');
  for (const field of ['platform', 'appBuild', 'nativeShell']) {
    assert.ok(block.includes(field), `${field} is the point of the stamp`);
  }
  // This report does NOT pass through the injected script's scrub(), which is what strips
  // tokens and query strings. Anything URL- or credential-shaped must never be added here.
  for (const banned of ['token', 'cartKey', 'href', 'location', 'search']) {
    assert.ok(
      !new RegExp(`\\b${banned}\\s*:`).test(block),
      `"${banned}" must not be reported from ClaimFlow — it bypasses the precart's scrub(), ` +
      'and Okta signs in inside that webview, so URLs there can carry an exchangeable code.',
    );
  }
});

test('it stamps once, or the cart verdict gets pushed off a capped list', () => {
  const block = code.slice(code.indexOf('const platformNoted'), code.indexOf('async function prepareRc'));
  assert.ok(/platformNoted\.current/.test(block), 'needs a latch');
  assert.ok(
    /if \(platformNoted\.current\) return;/.test(block),
    'the latch must short-circuit: client_reports is capped, and a repeat on every open ' +
    'pushes the cart\'s own outcome line further from the end.',
  );
});
