/**
 * EVERY OKTA NAVIGATION IS SAMPLED, OR IS A RECORDED EXCEPTION.
 *
 * WHY THIS EXISTS. On 2026-08-24 a real test hold was queued to MANUFACTURE a memory ramp at
 * a predictable time, so the native-allocation sampler would finally get a reading of a real
 * event instead of waiting for one. The ramp arrived exactly as ordered — 9,338 MB,
 * 05:00:51→05:11 PT, 89% COMMIT, renderer 90% of it, two minutes after the T−3h warm-up
 * window opened — and `native_alloc_readings` recorded NOTHING, because `maybeWarmupLogin`
 * was the third Okta-navigating path and the only one with no instrument on it.
 *
 * That is the fifth instance of the house shape — a guard or instrument bolted to some of the
 * doors — after `expireStaleHolds` living in a feed only a live runner polls,
 * `reclaimLapsedHolds` living inside `withRC`, the size-guard recycle checked in the body of
 * the loop that stops advancing, and `holdAtRisk`'s fixture filter reaching two queries and
 * not the health route's copies. It is the first where it cost a measurement somebody
 * deliberately set up.
 *
 * SO THE GUARD IS THE GENERAL ONE, NOT A PIN ON THIS INSTANCE. Pinning "the warm-up samples"
 * would be the sixth instance in waiting: it would pass while a FIFTH path was added with no
 * instrument. This enumerates every call that navigates to Okta and requires each to be
 * sampled or to appear in EXCEPTIONS with a reason.
 *
 * ── AND THE SAMPLER ALONE WAS NOT ENOUGH (2026-08-25) ─────────────────────────────────────
 *
 * Wiring every door was necessary and did not produce a reading. Three more ramps arrived
 * unprompted in thirty hours and the instrument missed all three, and the reason is WHEN it
 * reads rather than which paths it covers: `reportNativeAlloc` fires on the RETURN path, so a
 * trip killed mid-ramp never reports, and the instrument records by SELECTION the cheap retry
 * that FOLLOWS a ramp. The leading candidate for the remainder is that the ramping renderer is
 * not the one being sampled — every call site is on the trip's own tab and the RESIDENT page
 * has never been sampled at all.
 *
 * `rc-alloc-trail.mjs` is the fix — sample on the watchdog tick, which is the only code proven
 * to keep executing while the loop is stalled. The tests below extend the SAME general rule to
 * it: every sampled renderer must be on the trail, every registered target must come off it,
 * and the contexts the two files use must agree. Pinning "the renewal is on the trail" would
 * be the same mistake one layer along.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KW = readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8');
const ALLOC = readFileSync(new URL('../src/lib/native-alloc.ts', import.meta.url), 'utf8');

/**
 * Comments quote the shapes these tests forbid — and this file's own header quotes
 * `maybeWarmupLogin`. Stripping them is what stops a guard failing on its own explanation,
 * which is the correction that gets "fixed" by deleting the explanation.
 */
const code = KW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The body of one top-level `async function`, by name. */
function bodyOf(name: string): string {
  const from = code.indexOf(`async function ${name}`);
  assert.ok(from > -1, `${name} must exist — anchor not found`);
  const to = code.indexOf('\nasync function ', from + 10);
  assert.ok(to > from, `the end anchor for ${name} must be found AFTER the start`);
  return code.slice(from, to);
}

/**
 * THE ONE DELIBERATE EXCEPTION, AND IT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 * `runLoginRehearsal` navigates to Okta with `prompt=login` forced, so it renders the password
 * form and is plausibly the expensive variant too. It is NOT sampled, because it runs on the
 * RESIDENT page rather than a throwaway tab: there is no close to reclaim what it allocates,
 * and an all-time profile on that renderer carries hours of the resident SPA's history. That
 * is a different change with different risks, not this one. It also runs once a night at
 * 20:00 PT, deliberately hours from any release, so it is the least urgent of the four.
 *
 * Recorded here rather than left silent so the next reader finds a decision, not a gap —
 * CLAUDE.md's rule that a decision nobody has taken is not an oversight to quietly fix.
 */
const EXCEPTIONS = new Set(['runLoginRehearsal']);

test('every Okta-navigating path is sampled, or is a recorded exception', () => {
  // The two calls that take a browser through Okta. `attemptLogin` submits the credential
  // form; `renewSession` clicks RC's sign-in control, which navigates to
  // signin.reservecalifornia.com — the controlled comparison of 2026-08-18 showed the click
  // is what costs gigabytes and the reload before it costs nothing.
  const sites = [...code.matchAll(/\b(attemptLogin|renewSession)\(/g)]
    .map((m) => m.index as number);
  assert.ok(sites.length >= 3, `expected at least 3 Okta navigations, found ${sites.length}`);

  for (const at of sites) {
    // Which function contains it — the nearest `async function` declaration above it.
    const head = code.lastIndexOf('async function ', at);
    assert.ok(head > -1, 'every Okta navigation must sit inside a named async function');
    const name = /async function (\w+)/.exec(code.slice(head, head + 80))?.[1] ?? '';
    if (EXCEPTIONS.has(name)) continue;
    const body = code.slice(head, at);
    assert.match(body, /startNativeSampling\(/,
      `${name} navigates to Okta and does not start the native sampler — wire it, or add it `
      + 'to EXCEPTIONS with the reason. An unsampled path is how the 08-24 ramp was lost.');
  }
});

test('the warm-up samples on its own tab, before the login runs', () => {
  // Started HERE and not at launch, for the reason `attachHeapProbe` exists: the expensive
  // CDP negotiation must happen while the browser is healthy. CDP has twice been measured
  // going quiet as a ramp peaks, so only the cheap read may land afterwards.
  const body = bodyOf('maybeWarmupLogin');
  const cdp = body.indexOf('ctx.newCDPSession(tab)');
  const start = body.indexOf('startNativeSampling(');
  const attempt = body.indexOf('attemptLogin(');
  assert.ok(cdp > -1, 'the sampler must get a CDP session on the TAB, not the resident page');
  assert.ok(start > cdp, 'sampling must start on that session');
  assert.ok(attempt > start, 'sampling must start BEFORE the login it is measuring');
  assert.match(body.slice(start, attempt), /readNativeProfile\(/,
    'and a BEFORE profile must be taken, or the diff attributes the resident page’s history '
    + 'to this trip — whether a new tab shares that renderer is not established');
});

test('the warm-up login is wrapped in the network trace, or the sampling is inert', () => {
  // NOT COSMETIC. `reportNativeAlloc` refuses to store a reading whose RAM delta is missing
  // or smaller than NATIVE_ALLOC_RAMP_MB, and the delta comes from the trace. Without the
  // wrapper the sampler above runs, renders a line into a log that is truncated to the last
  // 16,000 characters, and stores nothing — a fix present and doing nothing, which is the
  // shape this repo has shipped three times (6006428, the `--claimed` omission, the
  // declared-not-assigned ref).
  const body = bodyOf('maybeWarmupLogin');
  assert.match(body, /withNetworkTrace\(tab, \(\) => attemptLogin\(/,
    'the warm-up login must run inside withNetworkTrace on the TAB');
  assert.match(body, /trace\?\.ram/,
    'and the RAM pair must be read off that trace, so the profile and the delta describe the '
    + 'same window — a sampler reading with no delta is the artifact that nearly retired the '
    + 'buffering candidate on 2026-08-19');
});

test('the warm-up reports its reading, and reports it before closing the tab', () => {
  // The log is where these readings went to die: two 9 GB ramps were sampled on 08-22/23 and
  // BOTH attributions were lost to `tail-log`'s 16k window. Migration 066 is the fix and it
  // only works if the call is made. Before the close because the profile read needs the tab
  // alive, and `saveFailureShot` photographs it.
  const body = bodyOf('maybeWarmupLogin');
  const report = body.indexOf('reportNativeAlloc(');
  const close = body.indexOf('tab.close()');
  assert.ok(report > -1, 'the warm-up must store its reading, not merely log it');
  assert.ok(close > report, 'the reading must be taken and sent BEFORE the tab is closed');
  const fin = body.indexOf('} finally {');
  assert.ok(fin > -1 && report > fin,
    'and it must be in the finally, or a login that throws — the 9 GB kind — reports nothing');
});

test('the warm-up uses the allow-listed context spelling', () => {
  // THE CROSS-FILE AGREEMENT, which is the half that rots silently. `recordNativeAlloc` keeps
  // a CONTEXTS set and stores anything outside it as NULL — so a plausible 'warmup-login'
  // would land the reading UNATTRIBUTED: present in the table, absent from the readout, and
  // looking exactly like the instrument working. Same family as `muted_site_ids` being text[]
  // while the unit id is a number, where an unstringified compare silently never matched.
  const set = /const CONTEXTS = new Set\(\[([^\]]*)\]\)/.exec(ALLOC);
  assert.ok(set, 'native-alloc.ts must keep a CONTEXTS allow-list');
  const allowed = new Set([...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const sent = [...code.matchAll(/reportNativeAlloc\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(sent.length >= 3, `expected a reading from each sampled path, found ${sent.length}`);
  assert.ok(sent.includes('warmup'), 'the warm-up must report under a context of its own');
  for (const c of sent) {
    assert.ok(allowed.has(c),
      `the bot sends context '${c}' and native-alloc.ts does not allow it — the row would `
      + 'store NULL and the reading would be unattributed');
  }
});

/** The watchdog timer's body — the one place a reading is still taken while the loop is stuck. */
function watchdogBody(): string {
  const from = code.indexOf('const renew = setInterval(() => {');
  assert.ok(from > -1, 'the watchdog timer must exist — anchor not found');
  const to = code.indexOf('}, WATCHDOG_MS);', from);
  assert.ok(to > from, 'the watchdog timer must be closed with its own cadence constant');
  return code.slice(from, to);
}

/** Every renderer the bot registers for trail sampling, by the name it registers under. */
function registeredTargets(): string[] {
  return [...code.matchAll(/allocTrail\.register\('([^']+)'/g)].map((m) => m[1]);
}

test('every renderer that is sampled is also on the trail', () => {
  // THE GENERAL RULE, and the reason it is general: the sampler was wired to every Okta door
  // on 2026-08-24 and still produced nothing, because being started is not the same as being
  // READ at a moment when the answer exists. A path that arms a sampler and never puts it on
  // the trail can only ever produce a return-path reading, which is the blind kind.
  const starts = [...code.matchAll(/startNativeSampling\(/g)].map((m) => m.index as number);
  assert.ok(starts.length >= 4,
    `expected the three Okta tabs plus the resident page, found ${starts.length}`);
  for (const at of starts) {
    const after = code.slice(at, at + 600);
    assert.match(after, /allocTrail\.register\(/,
      'a renderer is sampled here and never registered on the trail, so only the return-path '
      + 'reading can ever come from it — and that one has now missed six ramps');
  }
});

/**
 * THE ONE TARGET THAT DOES NOT COME OFF, AND IT IS A DECISION.
 *
 * `resident` is the RC page the keep-warm holds open for the life of the browser. There is no
 * close to unregister at, and the whole point of sampling it is that it spans the trips: if
 * the gigabytes are there rather than in the throwaway tab, PR #142's cure is aimed at the
 * wrong renderer. Its session dies with the context, and `readNativeProfile` answers null
 * rather than throwing, so a stale registration costs a failed read and not a crash.
 */
const NO_UNREGISTER = new Set(['resident']);

test('every trail target is unregistered, or is a recorded exception', () => {
  // A tab's renderer dies with the tab. A registration left behind asks a dead target every
  // sample interval for the life of the process — and worse, its buffer never becomes final,
  // so the peak it holds is never reported. Silent both ways.
  const off = new Set([...code.matchAll(/allocTrail\.unregister\('([^']+)'/g)].map((m) => m[1]));
  for (const name of registeredTargets()) {
    if (NO_UNREGISTER.has(name)) continue;
    assert.ok(off.has(name),
      `'${name}' is registered on the trail and never unregistered — add the unregister beside `
      + 'the tab close, or add it to NO_UNREGISTER with the reason');
  }
});

test('the trail is sampled in the watchdog timer, not in the loop it watches', () => {
  // THE HOUSE SHAPE, five times recorded: a guard placed inside the thing it guards against.
  // The size-guard recycle was checked in the body of the loop that stops advancing, so on all
  // twenty ramps control never reached it. The ramps happen DURING a renewal, i.e. while the
  // loop is not advancing, so a sample taken from the loop body is a sample never taken.
  const body = watchdogBody();
  assert.match(body, /allocTrail\.sample\(/,
    'the trail must be sampled from the watchdog timer — the only code proven to still be '
    + 'executing while the loop is stalled, which is exactly the window a ramp happens in');
  assert.match(body, /flushAllocRamps\(/,
    'and flushed from it, or a finished segment waits for a loop that is not advancing');
});

test('the runaway bail waits for the reading to leave the box', () => {
  // `bail` calls process.exit(1), which kills an in-flight POST. Without the await the one
  // reading this arm exists to capture dies with the process that captured it — the exact
  // shape of the two 9 GB attributions lost to `tail-log`'s 16k window in August.
  const body = watchdogBody();
  const flush = body.indexOf('flushAllocRamps({ final: true })');
  assert.ok(flush > -1, 'the bail must flush the OPEN segment — a ramp that kills the browser '
    + 'never produces the renderer swap that would make its segment final');
  const before = body.slice(0, flush);
  assert.match(before.slice(-400), /await Promise\.race\(\[\s*$/,
    'the flush must be awaited, and bounded — an unawaited POST dies with process.exit, and an '
    + 'unbounded one delays releasing the profile lock, which is what loses a cart at 08:00');
});

test('the teardown takes the open segment, because a recycle replaces the browser', () => {
  // Every `break` in the resident loop lands in that finally — the post-Okta recycle, the size
  // guard, the runner's preemption — and each replaces the browser. That is the other way a
  // ramp ends without a renderer swap we can see. `final: false` there would lose it.
  // ANCHORED ON CODE, NOT ON A COMMENT. `code` has comment lines stripped — deliberately, so
  // a guard cannot fail on its own explanation — and the first version of this test anchored
  // on the comment above the flush and failed against a correct file. Twenty-fourth instance.
  const fin = code.indexOf('} finally {', code.indexOf('async function warmResident'));
  assert.ok(fin > -1, 'the resident loop must have a finally to flush the trail in');
  const end = code.indexOf('releaseProfileLockIfMine', fin);
  assert.ok(end > fin, 'the teardown must still release the profile lock');
  const body = code.slice(fin, end);
  // ANCHORED ON THE PROPERTY, NOT THE EXPRESSION. This pinned the literal
  // `flushAllocRamps({ final: true })` and broke on 2026-08-28 when `describeIfEmpty: true`
  // was added beside it — a change that alters nothing about what this test guards. That is
  // the twenty-fifth time a guard here has been invalidated by an addition rather than a
  // regression, so it now asserts that the teardown asks for the open segment however the
  // call is spelled.
  assert.match(body, /flushAllocRamps\(\{[^}]*\bfinal:\s*true\b[^}]*\}\)/,
    'the teardown must take the OPEN segment, or a browser replaced by a recycle takes the '
    + 'reading with it — the trail does not survive that point');
  assert.ok(body.indexOf('flushAllocRamps') < body.indexOf('ctx?.close()'),
    'and it must run BEFORE the context closes, or the samples describe a browser that is gone');
});

test('the long-lived resident target is sampled coarsely', () => {
  // MEASURED, not tuned: the all-time profile's response grows linearly with bytes ever
  // allocated, at ~1.7 KB per MB (373 MB -> 0.7 MB of JSON; 2,346 MB -> 4.0 MB). The resident
  // page is read every 20s for the LIFE of the browser, so at the 9 GB these ramps reach, the
  // fine setting would have us asking a renderer that is already eating the machine to
  // serialize ~16 MB, over and over, at the peak — the instrument becoming part of the
  // disease, which this repo has shipped in three costumes already.
  const body = code.slice(code.indexOf('async function warmResident'));
  const at = body.indexOf('startNativeSampling(heapProbe');
  assert.ok(at > -1, 'the resident renderer must be sampled — it is the one nothing used to '
    + 'sample, and the leading candidate for where the gigabytes actually are');
  assert.match(body.slice(at, at + 200), /intervalBytes: LONG_LIVED_INTERVAL/,
    'the resident target must use the coarse interval; the short-lived trip tabs keep the fine '
    + 'default because they exist for one navigation and never accumulate');
});

test('the resident sampler says whether it armed, on the healthy path too', () => {
  // "ARMED AND QUIETLY WORKING" AND "THIS CODE NEVER RAN" MUST NOT BE THE SAME SILENCE. The
  // first version logged only on failure, and a trail that reports nothing is then
  // indistinguishable from a trail that is not running — which is `status = 'sent'` meaning
  // only "Twilio returned 2xx", and the watchdog that produced nothing for thirty consecutive
  // firings. The whole value of this instrument is what it says when a ramp happens; that is
  // worthless if nobody can confirm it was listening.
  const body = code.slice(code.indexOf('async function warmResident'));
  const at = body.indexOf('residentSampling');
  assert.ok(at > -1, 'the resident sampler must exist');
  const near = body.slice(at, at + 1200);
  assert.match(near, /log\(`\s*alloc trail: \$\{residentSampling\.ok/,
    'the arming must be announced on BOTH branches of one log call — a line that only fires on '
    + 'failure makes a working instrument and an absent one produce identical output');
});

test('the trail contexts the bot sends are allow-listed on the server', () => {
  // THE CROSS-FILE AGREEMENT AGAIN, and the trail sends its context as a TEMPLATE LITERAL —
  // `trail-${r.name}` — so the literal scan below cannot see these. Derived from the register
  // calls instead, which is the same rule stated about the values that actually reach the wire.
  // A name outside the set stores NULL: in the table, absent from the readout, and looking
  // exactly like the instrument working.
  const set = /const CONTEXTS = new Set\(\[([^\]]*)\]\)/.exec(ALLOC);
  assert.ok(set, 'native-alloc.ts must keep a CONTEXTS allow-list');
  const allowed = new Set([...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const targets = registeredTargets();
  assert.ok(targets.length >= 4, `expected four sampled renderers, found ${targets.length}`);
  for (const name of targets) {
    assert.ok(allowed.has(`trail-${name}`),
      `the trail reports renderer '${name}' as context 'trail-${name}' and native-alloc.ts does `
      + 'not allow it — the row would store NULL and the reading would be unattributed');
  }
});
