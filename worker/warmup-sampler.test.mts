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
