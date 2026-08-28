// The assertions inside codemagic.yaml, pinned so they cannot be dropped or widened.
//
// Every one of them guards a failure that BUILDS GREEN and is only discovered later: an
// unsigned APK that will not install, a targetSdkVersion Play rejects months on, an
// InAppBrowser plugin whose absence turns the RC hand-off into a system-browser fallback
// with nothing saying why, and — since 2026-08-27 — a missing com.android.vending.BILLING,
// which is the entire reason the Play console will not offer a "create subscription"
// button (docs/STOREKIT-PLAN.md 9a-bis).
//
// It is worth pinning them HERE rather than trusting review because every green
// `android-release` build PUBLISHES itself to Play closed testing. There is no dry run, so
// an assertion quietly deleted is a bad binary shipped, not a red build.
//
// TWO TRAPS THIS FILE HAS TO AVOID, both of which this repo has paid for repeatedly:
//
//  1. AN EXTRACTOR THAT FINDS NOTHING MAKES EVERY ABSENCE TEST VACUOUS. `chromium-
//     attribution.test.mts` went green against a deliberately broken pattern for exactly
//     this reason. So the parse is asserted FIRST — both workflows, a floor on the step
//     count — and every absence check runs against a body that was proven non-empty.
//
//  2. A COMMENT QUOTING THE FORBIDDEN THING. codemagic.yaml line 92 literally reads
//     `DO NOT "simplify" this to \`grep -r ios/\``, so a naive "grep -r ios/ must not
//     appear" test fails on the explanation of why not — and gets "fixed" by deleting the
//     explanation. `code()` strips comment lines before any absence assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const yaml = readFileSync(join(import.meta.dirname, '..', 'codemagic.yaml'), 'utf8');

interface Step { name: string; body: string }

/**
 * Split the file into workflows -> steps without a YAML dependency (none is installed, and
 * adding one to read a CI file would be its own liability). Indentation in this file is
 * fixed: workflows at 2 spaces, `- name:` steps at 6.
 */
function stepsOf(workflow: string): Step[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${workflow}:`);
  assert.notEqual(start, -1, `workflow \`${workflow}\` not found in codemagic.yaml`);
  const steps: Step[] = [];
  let current: Step | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break; // the next workflow
    const m = line.match(/^ {6}- name: (.+)$/);
    if (m) {
      current = { name: m[1].trim(), body: '' };
      steps.push(current);
    } else if (current) {
      current.body += line + '\n';
    }
  }
  return steps;
}

/** A step's script with comment lines removed — what actually RUNS. */
const code = (s: Step) =>
  s.body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const find = (steps: Step[], needle: string) => {
  const i = steps.findIndex((s) => s.name.includes(needle));
  assert.notEqual(i, -1, `no step named like "${needle}" — steps: ${steps.map((s) => s.name).join(' | ')}`);
  return i;
};

const android = stepsOf('android-release');
const ios = stepsOf('ios-testflight');

test('the workflows parsed — without this every absence check below is vacuous', () => {
  // A floor, not an exact count, so adding a step is free and losing the parse is loud.
  assert.ok(android.length >= 10, `android-release parsed as ${android.length} steps`);
  assert.ok(ios.length >= 8, `ios-testflight parsed as ${ios.length} steps`);
  for (const s of [...android, ...ios]) {
    assert.ok(code(s).includes('script:'), `step "${s.name}" parsed with no script body`);
  }
});

test('android-release asserts the Play Billing permission', () => {
  // THE GATE. Play offers only "Upload a new APK" and no create button until an uploaded
  // binary declares this. Nothing we wrote declares it and neither does the RevenueCat
  // plugin, whose own android manifest is empty — it arrives by AAR manifest merge from
  // com.android.billingclient:billing, three hops down a transitive chain. So a dependency
  // bump can remove it with no line of ours changing.
  const step = android[find(android, 'Play Billing permission')];
  assert.match(code(step), /com\.android\.vending\.BILLING/);
});

test('the billing assertion runs AFTER the build, or it reads nothing', () => {
  // The merged manifest is a build OUTPUT. Moved above the build, this step would find no
  // manifest at all — which the no-manifest branch correctly fails on, but only by luck of
  // that branch existing. Ordering is the real property.
  assert.ok(
    find(android, 'Play Billing permission') > find(android, 'Build the AAB and APK'),
    'the billing assertion must come after the build step',
  );
});

test('the billing assertion FAILS when it could not read anything', () => {
  // "We could not look" must never read as "we looked and it was fine". Two branches, and
  // the assertions pin the COMPARISONS rather than the branches around them, because a
  // condition mutated to a constant leaves the branch itself perfectly intact.
  const body = code(android[find(android, 'Play Billing permission')]);
  assert.match(body, /if \[ -z "\$MANIFESTS" \]/, 'must detect finding no merged manifest at all');
  assert.match(body, /if \[ "\$CHECKED" -eq 0 \]/, 'must detect that no source was actually read');

  // Each of those branches has to EXIT, not warn. Extract them and look.
  for (const cond of ['-z "$MANIFESTS"', '"$CHECKED" -eq 0']) {
    const at = body.indexOf(cond);
    assert.notEqual(at, -1);
    const block = body.slice(at, body.indexOf('\n          fi', at));
    assert.match(block, /exit 1/, `the \`${cond}\` branch must exit 1, not warn and continue`);
  }
});

test('android-release still carries the three assertions that predate billing', () => {
  // Adding one assertion must not cost another. Each of these has an incident behind it.
  assert.match(code(android[find(android, 'target API level')]), /targetSdkVersion/);
  assert.match(code(android[find(android, 'InAppBrowser')]), /InAppBrowser/);
  assert.match(code(android[find(android, 'APK is actually signed')]), /unsigned/);
});

test('the iOS InAppBrowser assertion stays SCOPED and is never widened to the whole tree', () => {
  // ios/App/App/public holds our own `cordova.InAppBrowser` probe, so `grep -r ios/` would
  // pass with the plugin entirely absent — an assertion that cannot fail, which reads as
  // proof. Checked against comment-stripped source: the warning against it is written in a
  // comment three lines above, and a naive scan would fail on the explanation.
  const body = code(ios[find(ios, 'InAppBrowser')]);
  assert.match(body, /ios\/capacitor-cordova-ios-plugins/, 'must check the real plugin directory');
  // ANCHORED ON THE COMPARISON, NOT THE TOKEN. `CordovaPlugins` also appears in this
  // step's own error message, so a bare /CordovaPlugins/ match survived replacing the
  // grep with `true ||` — verified, and it is the same anchoring mistake this repo has
  // now made two dozen times. Pin the check itself.
  assert.match(
    body,
    /grep -q "CordovaPlugins" ios\/App\/Podfile/,
    'sources landing is not enough — the Podfile must pull the pod in',
  );
  assert.ok(!/grep -r\w* ios\/\s/.test(body), 'must not be widened to a whole-tree grep');
});

test('the billing assertion looks in the right place, and filters the variant precisely', () => {
  // Not a silent failure — a wrong search root makes every build fail on the no-manifest
  // branch. It is pinned anyway because a build here is a PUBLISH: finding a typo in a
  // test costs seconds, finding it in the workflow costs a build slot and a versionCode.
  const body = code(android[find(android, 'Play Billing permission')]);
  // ANCHORED ON THE ASSIGNMENT. The same `find app/build/intermediates ...` line appears
  // again inside the FATAL branch that lists what the build DID produce, so a bare match
  // on the find command survived corrupting the search root — the second time in one
  // sitting that a guard here matched a token occurring twice.
  assert.match(body, /MANIFESTS=\$\(find app\/build\/intermediates -type f -name AndroidManifest\.xml/);

  // `*/merged_manifest*/release/*` is exact on purpose: the slashes are what exclude
  // `releaseUnitTest`, a different variant whose manifest says nothing about what ships.
  // Loosened to `*release*` it would sweep that in and fail builds for no reason —
  // and the next person would "fix" it by dropping the check.
  assert.match(body, /-path '\*\/merged_manifest\*\/release\/\*'/, 'the variant filter must stay anchored on /release/');
});
