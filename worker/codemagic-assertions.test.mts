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

/**
 * THE SIDELOAD LEVER — the billing gate was blocking the wrong thing, and it cost a site.
 *
 * On 2026-08-29 the owner lost a real campsite because their phone ran a build with no
 * cordova-plugin-inappbrowser: the RC hand-off could not sign in or cart, and the claim
 * screen showed the plain-browser copy with nothing saying why. The plugin entered
 * package.json on 2026-08-18 and the last Play upload is versionCode 18 from 2026-08-08,
 * so NO installable build has ever contained it. This workflow is the only way to make
 * one — and the billing gate, added on 2026-08-27 for a DIFFERENT project (Play
 * Subscriptions), fails the whole build before an APK can be sideloaded.
 *
 * So the gate now has one named, opt-in mode. It does not skip the check; it changes the
 * REMEDY from "fail the build" to "delete the AAB". Play is given the AAB and nothing
 * else, so removing it is a stricter block than failing — a failing build relies on
 * Codemagic skipping `publishing:` on a non-zero exit, which codemagic.yaml itself records
 * as an inference never read from a build log.
 */
test('the sideload lever is OFF by default', () => {
  // A lever left on is the whole risk: the next green build would upload nothing to Play
  // and look exactly like one that published. Pinned as the literal default in the file.
  assert.match(
    yaml,
    /CH_SIDELOAD_ONLY:\s*"false"/,
    'CH_SIDELOAD_ONLY must default to "false" in codemagic.yaml',
  );
});

test('the sideload lever DELETES the AAB rather than skipping the billing check', () => {
  const body = code(android[find(android, 'Billing')]);
  assert.ok(body.length > 0, 'the billing step must have a script body to guard');

  // THE CHECK STILL RUNS. If the lever ever became an early `exit 0` or wrapped the whole
  // step, a binary with no BILLING permission could reach Play and the Subscriptions page
  // would silently refuse to create products again — the exact failure this gate exists
  // for, restored by the thing meant to work around it.
  assert.match(body, /MISSING="\$MISSING/, 'the permission check itself must still run');

  // THE ARTIFACT IS THE BLOCK. Pinned on the delete, not on the branch that guards it:
  // pinning `if [ "$CH_SIDELOAD_ONLY" ...]` would still pass if the body stopped deleting.
  assert.match(
    body,
    /find app\/build\/outputs -type f -name '\*\.aab' -print -delete/,
    'sideload mode must DELETE the AAB, so Play cannot be given a billing-less build',
  );
  // And it must PROVE the delete worked rather than assume it — a surviving AAB is
  // publishable, and "we ran a delete" is not "nothing is left".
  assert.match(body, /REMAINING/, 'the delete must be verified, not assumed');

  // THE APK MUST SURVIVE — it is the only reason this mode exists. A delete widened to
  // `-name '*.ap*'` or to the whole outputs directory would pass every assertion above and
  // leave nothing to sideload.
  assert.ok(
    !/-name '\*\.apk'\s+-delete/.test(body) && !/rm -rf app\/build\/outputs/.test(body),
    'the APK must never be deleted — sideloading it is the point of this mode',
  );

  // WITHOUT THE LEVER, NOTHING CHANGES. The default path still fails the build.
  assert.match(body, /else\n\s*exit 1/, 'with the lever off, a missing permission still fails the build');
});

// ─── THE iOS RevenueCat POD (2026-08-30) ──────────────────────────────────────────────
//
// Android proves RevenueCat landed via the BILLING permission — the plugin's own android
// manifest is EMPTY, so that permission can only have arrived through the
// purchases-hybrid-common -> purchases chain. iOS had no equivalent assertion at all until
// this date, so the pod could be absent from every build and nothing would say so.

test('the iOS build asserts the RevenueCat pod, not just InAppBrowser', () => {
  const step = ios[find(ios, 'RevenueCat plugin')];
  const body = code(step);

  // THE POD NAME IS THE ARTIFACT. @capacitor/cli's fixName() maps
  // '@revenuecat/purchases-capacitor' to exactly this; a wrong name is an assertion that
  // can never pass, which is the opposite failure and just as bad.
  assert.match(body, /RevenuecatPurchasesCapacitor/, 'the derived pod name must be checked');

  // BOTH HALVES, because they are different facts. The Podfile is what we ASKED for; the
  // lock file is what CocoaPods actually RESOLVED. A pod can be named and still fail to
  // come down, and only the second catches that.
  //
  // ANCHORED ON THE COMMANDS, NOT THE PATHS. The first version of this test matched
  // /Podfile\.lock/ anywhere in the step — and the FAILURE MESSAGE says "NOT in
  // Podfile.lock", so replacing the grep with `true` left the token in place and the guard
  // passed against a step that no longer checked the lock file at all. Verified by
  // mutation. Twenty-somethingth instance of a guard anchored on a token that occurs twice.
  assert.match(body, /grep -q "pod '\$POD'" ios\/App\/Podfile\b/, 'the Podfile must be grepped');
  assert.match(body, /grep -q "\$POD" ios\/App\/Podfile\.lock/, 'the lock file must be grepped');

  // IT MUST BE ABLE TO FAIL, AND MUST HAVE NO WAY OUT. `exit 1` being present proved
  // nothing — an early `exit 0` inserted above it left every other assertion true. A step
  // whose whole job is to fail the build has no legitimate reason to exit 0 early.
  assert.match(body, /exit 1/, 'a missing pod must fail the build');
  assert.doesNotMatch(body, /exit 0/, 'no early success path — that neuters the assertion');
  assert.match(body, /set -e/, 'an unchecked command must not be able to pass silently');
});

test('the RevenueCat assertion is not widened to a whole-tree grep', () => {
  // ios/App/App/public holds our own web bundle, which contains the literal string
  // '@revenuecat/purchases-capacitor' in the dynamic import that loads the SDK. So
  // `grep -r ios/` passes with the pod entirely absent — the same trap already documented
  // for InAppBrowser, with a different string.
  const body = code(ios[find(ios, 'RevenueCat plugin')]);
  assert.ok(!/grep -r\w*\s+["']?RevenuecatPurchasesCapacitor["']?\s+ios\/\s*$/m.test(body),
    'must not grep the whole ios/ tree — the web bundle contains the package name');
  assert.ok(!/\bios\/App\/App\/public\b/.test(body),
    'must never read the web bundle as evidence the native pod installed');
});

test('the assertion runs AFTER the sync that creates the Podfile', () => {
  // Ordering is the whole thing: before `cap sync ios` there is no Podfile and no lock
  // file, so the step would fail on every build for the wrong reason — and the natural
  // "fix" for that is to weaken it.
  assert.ok(
    find(ios, 'RevenueCat plugin') > find(ios, 'Capacitor sync'),
    'the RevenueCat assertion must come after Capacitor sync',
  );
});

test('the RevenueCat assertion runs BEFORE the IPA is built', () => {
  // A build that ships and then reports the plugin missing has already cost the upload,
  // the processing wait and a TestFlight slot.
  assert.ok(
    find(ios, 'RevenueCat plugin') < find(ios, 'Build the IPA'),
    'assert before building, not after',
  );
});

// ─── THE PURPOSE STRINGS (2026-09-18) ─────────────────────────────────────────────────
//
// Apple rejected `1.0 (27)` under Guideline 2.1(a) — "App crashed when we tapped on
// camera", iPad Air 11-inch (M3), iPadOS 27.0. There was no NSCameraUsageDescription
// anywhere in the repo, and iOS TERMINATES a process that touches the camera without one.
//
// This is the `grep -rn "NSCamera"` returning nothing that nobody ran for five
// submissions, turned into a test. It is the same blind spot `src/lib/store-listing.test.mts`
// exists for: a native Info.plist key is plain text in a YAML file that `tsc`, `next build`
// and the whole suite are structurally unable to see — so the first reader is App Review.
//
// ANCHORING, because this file has now been bitten by it a dozen-plus times: every key name
// below occurs TWICE in the comment-stripped body — once where it is written and once in the
// list that verifies it. A bare /NSCameraUsageDescription/ match therefore survives deleting
// the write entirely. Both occurrences are pinned separately, and that was verified by
// mutation rather than reasoned about.

const PURPOSE_KEYS = [
  'NSCameraUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
] as const;

const LOCATION_KEYS = [
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
] as const;

test('the iOS build WRITES all three camera/photo purpose strings', () => {
  const body = code(ios[find(ios, 'camera and photo library usage descriptions')]);
  for (const key of PURPOSE_KEYS) {
    // Pinned on the CALL, not the key name: the name also appears in the verification
    // loop, so matching it bare passes against a step that writes nothing.
    assert.match(
      body,
      new RegExp(`set_desc ${key} "\\$[A-Z]+"`),
      `${key} must actually be written, not merely mentioned`,
    );
  }
});

test('the strings describe what the app does, and are not empty', () => {
  // An empty or placeholder string is worse than none: it satisfies a grep, ships, and
  // App Review reads it. Apple rejects "" and a bare app name under 5.1.1 as it is.
  const body = code(ios[find(ios, 'camera and photo library usage descriptions')]);
  for (const v of ['CAMERA=', 'LIBRARY=', 'SAVE=']) {
    const line = body.split('\n').find((l) => l.trim().startsWith(v));
    assert.ok(line, `${v} must be assigned`);
    const value = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
    assert.ok(value.length >= 40, `${v} is "${value}" — too short to be a real purpose string`);
    assert.match(value, /CampHawk/, `${v} must name the app`);
    // The location step's own argument, applied here: do not justify behaviour we do not
    // have. Nothing in this app opens a camera by itself.
    assert.match(value, /only when you/, `${v} must say the user initiates it`);
  }
});

test('a purpose string that did not land FAILS the build, with a reason', () => {
  const body = code(ios[find(ios, 'camera and photo library usage descriptions')]);

  // AN EXPLICIT `if`, NOT A BARE `Print`. The location step above ends with a bare Print
  // and relies on the shell aborting; whether Codemagic runs these under `set -e` has
  // never been read off a build log here. This one declares `set -e` AND does not need it.
  assert.match(body, /set -e/, 'the step must not rely on Codemagic\'s default shell flags');
  assert.match(
    body,
    /if ! \/usr\/libexec\/PlistBuddy -c "Print :\$KEY" ios\/App\/App\/Info\.plist; then/,
    'the verification must be a checked `if`, not a bare Print',
  );
  for (const key of PURPOSE_KEYS) {
    assert.ok(
      new RegExp(`for KEY in [^\\n]*${key}`).test(body),
      `${key} must be in the verification loop, not just written`,
    );
  }
  assert.match(body, /exit 1/, 'a missing key must fail the build');
  assert.doesNotMatch(body, /exit 0/, 'no early success path — that neuters the assertion');

  // THE WRITE MUST NOT ABORT BEFORE THE CHECK REPORTS. Found by running this script body
  // against a PlistBuddy stub told to refuse one key: under `set -e` the Add-or-Set pair
  // killed the script at the write, so the build went red with NO explanation of which key
  // or why. The trailing `|| echo` is what keeps the loop below as the single gate.
  assert.match(
    body,
    /\|\| echo "could not write \$1 here/,
    'set_desc must not abort under set -e before the verification loop runs',
  );
});

test('adding the camera strings did not cost the location ones', () => {
  // The lesson from `android-release still carries the three assertions that predate
  // billing`, one workflow along: every round here has added a key and this is the step
  // where one would quietly go missing.
  const body = code(ios[find(ios, 'location usage description')]);

  // ANCHORED ON THE LOOP, NOT THE NAME — and this version exists because the first one
  // was not. NSLocationAlwaysAndWhenInUseUsageDescription ALSO appears in this step's
  // trailing `Print`, so a bare match on the name survived deleting the key from the loop
  // that writes it. Caught by mutation; it would never have been caught by reading. That
  // is the same token-occurs-twice mistake this file already documents three times above,
  // made once more in a test written directly underneath a comment describing it — which
  // is the entire argument for running the mutations rather than reasoning about them.
  const loop = body.split('\n').find((l) => l.includes('for KEY in NSLocation'));
  assert.ok(loop, 'the location step must still write its keys in a loop');
  for (const key of LOCATION_KEYS) {
    assert.ok(loop.includes(key), `${key} must still be WRITTEN, not merely mentioned`);
  }
});

test('both purpose-string steps run before the IPA is built', () => {
  // After the build they would edit a plist nothing reads again. And both must come after
  // the native project exists at all — before `cap add ios` there is no Info.plist, so the
  // step would fail on every build for the wrong reason, and the natural fix for that is
  // to weaken it.
  for (const step of ['location usage description', 'camera and photo library usage descriptions']) {
    assert.ok(find(ios, step) > find(ios, 'Generate the iOS native project'), `${step} needs ios/ to exist`);
    assert.ok(find(ios, step) < find(ios, 'Build the IPA'), `${step} must run before the build`);
  }
});

// ─── AND THE ONE THAT READS WHAT APPLE RECEIVES ───────────────────────────────────────
//
// Everything above verifies the file the step just wrote — the WRITE half. `android-release`
// has read a BUILD OUTPUT since 2026-08-27 (the merged manifest) and `ios-testflight` had no
// equivalent at all: the location keys had been written since build 15 and NO BUILD LOG HERE
// HAD EVER CONFIRMED THEY REACH THE BINARY. That gap is what would make this whole fix a
// silent no-op — green build, upload, sixth rejection, identical cause.

test('the iOS workflow asserts the purpose strings in the SHIPPED binary', () => {
  const body = code(ios[find(ios, 'survived into the IPA')]);
  // ALL FIVE, camera and location. If the PlistBuddy mechanism does not work, it does not
  // work for either family, and one build answers both questions.
  for (const key of [...PURPOSE_KEYS, ...LOCATION_KEYS]) {
    assert.ok(new RegExp(`for KEY in [\\s\\S]*?${key}`).test(body), `${key} must be checked in the IPA`);
  }
  assert.match(body, /exit 1/, 'a missing key must fail the build');
  assert.doesNotMatch(body, /exit 0/, 'no early success path');
});

test('every purpose string this workflow writes is also checked in the IPA', () => {
  // THE SELF-MAINTAINING HALF, and the reason this test is worth more than the five names
  // above it. A sixth key added next round — microphone, contacts, Face ID — would be
  // written by some step and silently never verified, which is exactly today's failure in
  // a new costume. Derived from the file rather than listed.
  const written = new Set<string>();
  for (const s of ios) {
    if (s.name.includes('survived into the IPA')) continue;
    for (const m of code(s).matchAll(/\bNS\w+UsageDescription\b/g)) written.add(m[0]);
  }
  assert.ok(written.size >= 5, `expected the five known purpose strings, found ${[...written]}`);
  const verified = code(ios[find(ios, 'survived into the IPA')]);
  for (const key of written) {
    assert.ok(verified.includes(key), `${key} is written into Info.plist but never verified in the IPA`);
  }
});

test('the IPA assertion runs AFTER the build, or it reads nothing', () => {
  // The same property the Android billing test pins, for the same reason: the IPA is a
  // build OUTPUT. Moved above the build it would hit the no-IPA branch every time — which
  // fails correctly, but only by luck of that branch existing.
  assert.ok(
    find(ios, 'survived into the IPA') > find(ios, 'Build the IPA'),
    'the IPA assertion must come after the build step',
  );
});

test('the IPA assertion FAILS when it could not read anything', () => {
  // "We could not look" must never read as "we looked and it was fine" — the rule this
  // file already applies to the Android merged manifest. Three ways to read nothing here:
  // no IPA produced, an IPA with no app plist inside it, and keys genuinely absent.
  const body = code(ios[find(ios, 'survived into the IPA')]);
  for (const cond of ['-z "$IPA"', '-z "$PLIST"', '-n "$MISSING"']) {
    const at = body.indexOf(cond);
    assert.notEqual(at, -1, `must handle ${cond}`);
    const end = body.indexOf('\n          fi', at);
    assert.notEqual(end, -1, `no closing fi for ${cond}`);
    assert.match(body.slice(at, end), /exit 1/, `the \`${cond}\` branch must exit 1, not warn and continue`);
  }
});

test('the IPA assertion does not hardcode the .app name', () => {
  // capacitor.config.ts's `appName: 'CampHawk'` sets CFBundleDisplayName, NOT the product
  // name — the bundle is App.app because the Xcode target is "App". Hardcoding either
  // spelling makes this an assertion that stops matching instead of one that fails, which
  // is the failure mode this whole file is written against.
  const body = code(ios[find(ios, 'survived into the IPA')]);
  assert.doesNotMatch(body, /Payload\/(App|CampHawk)\.app/, 'glob the bundle, do not name it');
  // Single-level on purpose: Payload/*.app/Frameworks/*.framework/Info.plist must not be
  // mistaken for the app's own plist. Verified by mutation against a built fixture.
  assert.match(body, /-path '\*\/Payload\/\*\/Info\.plist'/, 'the app plist must be matched one level deep');
});

// ─── THE TWO WORKFLOWS, READ SIDE BY SIDE (2026-09-18) ────────────────────────────────
//
// This file has always checked each workflow ALONE and has never compared them, which is
// how iOS went thirteen months with no build-output assertion while Android had one. The
// comparison is now a test, so the next divergence is loud.

test('every assertion step in EITHER workflow can actually fail', () => {
  // A step named "Assert"/"Verify" that cannot exit non-zero is decoration, and it reads
  // as proof. Both workflows, one rule — the point of comparing them.
  const asserts = [
    ...android.map((s) => ['android-release', s] as const),
    ...ios.map((s) => ['ios-testflight', s] as const),
  ].filter(([, s]) => /^(Assert|Verify)\b/.test(s.name));

  assert.ok(asserts.length >= 7, `expected at least 7 assertion steps, found ${asserts.length}`);
  for (const [wf, s] of asserts) {
    assert.match(code(s), /exit 1/, `${wf} / "${s.name}" has no way to fail`);
  }
});

// WHAT THAT TEST DOES NOT CLAIM, stated because a mutation run showed the gap rather than
// leaving it to be discovered later. Deleting ONE of several `exit 1`s from a step — say the
// `-z "$APK"` branch of "Verify the APK is actually signed" — leaves the step able to fail
// and the test green. That is correct: the property asserted is "this step can fail at all",
// which is the one that catches a step gutted into decoration. Pinning every individual
// branch across both workflows generically is what the per-step tests above do by hand, with
// the condition named, and a generic version would either miss them or fire on legitimate
// edits until somebody deleted it.

// THE OTHER ASYMMETRY, RECORDED RATHER THAN ENFORCED. `ios-testflight` injects five
// Info.plist purpose strings; `android-release` injects no permissions at all, because on
// Android they arrive by AAR manifest merge — which is precisely why its assertion reads the
// MERGED manifest and iOS's (until 2026-09-18) read nothing. Android has no equivalent
// exposure to this rejection either: a WebView file chooser routes the camera through an
// Intent to the system camera app, so a missing declaration there is not a termination.
// There is no test to write for that; it is a fact about the platforms.
