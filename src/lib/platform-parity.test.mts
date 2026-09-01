/**
 * EVERY EXPLICIT PLATFORM BRANCH IS REGISTERED, OR THE BUILD FAILS.
 *
 * ## Why (2026-09-01)
 *
 * "iOS is the baseline" has been the standing instruction for weeks, and four separate
 * sessions have acted on it, found one more thing Android does differently, fixed it, and
 * hit the next one. The owner's complaint is exactly right: these arrive one at a time
 * because nothing anywhere enumerates them. `worker/codemagic-assertions.test.mts` checks
 * each build workflow on its own and has never compared the two to each other.
 *
 * So the explicit surface is pinned here. It is SMALL — ten lines in five files — and every
 * one is deliberate. A new branch that nobody registered fails this test, which turns a
 * discovery into a decision.
 *
 * ## WHAT THIS DOES NOT COVER, STATED UP FRONT
 *
 * **Not one bug that has cost us a campsite was an explicit branch.** They were all
 * EMERGENT: identical code behaving differently because the password manager pre-filled a
 * field, or the cookie store persists differently, or one plugin has two native
 * implementations. No scanner can find those — the whole property is that the code is the
 * same — and a test claiming to cover them would be a guard that inspects nothing while
 * reading as proof, which this repo has shipped several times.
 *
 * `docs/PLATFORM-PARITY.md` §2 carries that half in prose, deliberately. This file asserts
 * the doc exists and lists what is registered here, so the two cannot drift apart — but it
 * makes no claim about the emergent surface, and neither should anyone quoting it.
 *
 * ## UNDER `src/`, NOT `worker/`
 *
 * `npm test` globs both, but `worker/**` is the FIRST entry in `worker-deploy.yml`'s
 * `paths:`, so a guard over web modules there would restart both poller machines. Checked
 * against the workflow rather than remembered — CLAUDE.md records getting that claim wrong
 * twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The registry. `file` → the branches it is allowed to contain, each with the reason.
 *
 * THE REASON IS THE POINT, not the bookkeeping. A branch nobody can justify in one line is
 * a branch that should not exist, and the review that adds one to this list is the review
 * where somebody asks whether it belongs in the first place.
 */
const REGISTERED: Record<string, { match: RegExp; why: string }[]> = {
  'src/lib/native/context.tsx': [
    { match: /\/Android\/i\.test\(ua\)/,
      why: 'ANDROID IS TESTED FIRST: an Android UA also contains "Linux", and some webviews carry both markers' },
    { match: /\/iPhone\|iPad\|iPod\/i\.test\(ua\)/,
      why: 'the iOS half of the same sniff' },
  ],
  'src/components/NativeBridge.tsx': [
    { match: /platform === 'android'\) await StatusBar\.setBackgroundColor/,
      why: 'setBackgroundColor is an Android-only API and THROWS on iOS' },
    { match: /platform === 'android'\) \{/,
      why: 'iOS has no hardware back button; without this listener Capacitor exits the app from any screen' },
  ],
  'src/components/v2/nativeSubscribe.tsx': [
    { match: /ios: true,/, why: 'LINKOUT_BY_STORE — the anti-steering carve-outs are US-storefront only and iOS is US-only' },
    { match: /android: false,/, why: 'LINKOUT_BY_STORE — the Android track is deliberately WORLDWIDE, so steering stays off' },
    { match: /ios: false,/, why: "IN_APP_PURCHASE_BY_STORE — Apple's products do not exist yet (STOREKIT-PLAN §4e)" },
    { match: /android: true,/, why: 'IN_APP_PURCHASE_BY_STORE — Play products are live' },
  ],
  'src/lib/native/purchases.ts': [
    { match: /platform === 'android' \? ANDROID_KEY : IOS_KEY/,
      why: 'RevenueCat issues one API key per store' },
  ],
  'src/lib/notifications/push.ts': [
    { match: /android: \{ priority: 'high' \}/,
      why: "FCM's own per-platform payload shape, not a behaviour branch of ours" },
  ],
};

/** Comments discuss these shapes at length; a scan that read them would flag its own prose. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BRANCH = new RegExp([
  String.raw`platform\s*===?\s*['"](?:ios|android)['"]`,
  String.raw`\bisIOS\b`,
  String.raw`\bisAndroid\b`,
  String.raw`/Android/`,
  String.raw`/iPhone\|iPad\|iPod/`,
  String.raw`^\s*(?:ios|android)\s*:`,
].join('|'));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

function foundBranches(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of walk('src')) {
    const lines = code(readFileSync(f, 'utf8')).split('\n');
    const hits = lines.filter((l) => BRANCH.test(l)).map((l) => l.trim());
    if (hits.length) found.set(f.replace(/\\/g, '/'), hits);
  }
  return found;
}

test('the scan finds something — a scanner that inspects nothing approves everything', () => {
  const found = foundBranches();
  // Both floors are under today's numbers (5 files, 10 lines) so ordinary growth does not
  // trip them, and a regex that silently stops matching does. This is the assertion that
  // stops the whole file becoming vacuous, which is the failure mode CLAUDE.md records for
  // `chromium-attribution.test.mts` — it passed against a deliberately broken pattern.
  assert.ok(found.size >= 4, `only ${found.size} files matched — the scan is broken, not the code`);
  const total = [...found.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(total >= 8, `only ${total} branches matched — the scan is broken, not the code`);
});

test('every explicit platform branch in src/ is registered with a reason', () => {
  const found = foundBranches();
  const unregistered: string[] = [];

  for (const [file, hits] of found) {
    const allowed = REGISTERED[file] ?? [];
    for (const line of hits) {
      if (!allowed.some((a) => a.match.test(line))) unregistered.push(`${file}: ${line}`);
    }
  }

  assert.deepEqual(unregistered, [],
    'these branch on platform and nobody registered them:\n  ' + unregistered.join('\n  ')
    + '\n\nAdd each to REGISTERED with a one-line reason, and to docs/PLATFORM-PARITY.md §1.'
    + '\nIf you cannot say in one line why the platforms must differ here, they probably must not.');
});

test('the registry has no dead entries — a stale reason is worse than none', () => {
  // A registered branch that no longer exists means somebody deleted the code and left the
  // justification standing, so the next reader believes a difference exists that does not.
  // Same rule the log-allowlist guard applies in the other direction.
  const found = foundBranches();
  const dead: string[] = [];
  for (const [file, entries] of Object.entries(REGISTERED)) {
    const hits = found.get(file) ?? [];
    for (const e of entries) {
      if (!hits.some((l) => e.match.test(l))) dead.push(`${file}: ${e.match}`);
    }
  }
  assert.deepEqual(dead, [], `registered but no longer present:\n  ${dead.join('\n  ')}`);
});

test('the RC hand-off path carries NO platform branch, and that is load-bearing', () => {
  // THE PROPERTY THE WHOLE INVESTIGATION RESTS ON. Every "what is different on Android?"
  // question about the cart and the sign-in has been answered "nothing in our code", and
  // that answer is only worth anything if it stays true. A branch appearing in one of these
  // makes an Android-only symptom explainable by our own source, which changes where the
  // next person looks — so it must be a decision, not a drift.
  for (const f of [
    'src/lib/rc-login-script.ts',
    'src/lib/rc-precart-script.ts',
    'src/lib/rc-token-liveness.ts',
    'src/lib/claim-gate.ts',
  ]) {
    const hits = code(readFileSync(f, 'utf8')).split('\n').filter((l) => BRANCH.test(l));
    assert.deepEqual(hits, [],
      `${f} now branches on platform:\n  ${hits.join('\n  ')}\n`
      + 'The sign-in and cart path is identical on both platforms by design. If it must stop'
      + ' being, register it and say so in docs/PLATFORM-PARITY.md §1.');
  }
});

test('the doc exists and covers both halves', () => {
  // The emergent half cannot be enforced, so the doc IS the mechanism for it. A guard that
  // let the doc rot would leave the enforceable half looking like the whole story — which is
  // exactly the misreading this file's own header is written to prevent.
  const doc = readFileSync('docs/PLATFORM-PARITY.md', 'utf8');
  assert.match(doc, /## 1\./, 'the explicit surface must be documented');
  assert.match(doc, /## 2\./, 'the emergent surface must be documented — it is where the bugs are');
  for (const file of Object.keys(REGISTERED)) {
    const short = file.replace(/^src\//, '');
    assert.ok(doc.includes(short),
      `${short} is registered in code and missing from docs/PLATFORM-PARITY.md`);
  }
  // The build-number confounder is the one fact that invalidates every comparison, so it is
  // pinned rather than left to survive an edit.
  assert.match(doc, /PROJECT_BUILD_NUMBER/,
    'the build-number confounder must stay documented — it invalidates the comparison itself');
});
