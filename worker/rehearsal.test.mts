/**
 * The nightly login rehearsal — the gates, and why each one is not optional.
 *
 * WHAT THIS IS PROTECTING. A rehearsal is a REAL sign-in: it opens Chromium and posts
 * credentials from the household IP, which is the act that cost twelve hours of IP block on
 * 2026-08-06 when it was done repeatedly. Every gate below is one way that could happen by
 * accident, and none of them is reachable from a keyboard — they fire at 20:00 on a box
 * nobody is watching, which is exactly why they are tested rather than reviewed.
 *
 * The other half is the READING of the result, in health-thresholds: a skip must never be
 * able to read as a pass. That is the same mistake as `notifications.status = 'sent'`
 * meaning only "Twilio returned 2xx", and it is the one that would make this whole feature
 * worse than nothing — a green check standing in front of a broken login.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shouldRehearse, rehearsalSlot,
  REHEARSAL_HOUR, REHEARSAL_MIN_HOURS_TO_RELEASE, REHEARSAL_MIN_GAP_H,
} from '../scripts/auto-cart-bot/rehearsal.mjs';
import { rehearsalFault, REHEARSAL_STALE_MS, RC_SESSION_CRITICAL_MIN } from '../src/lib/health-thresholds.js';

/** A night with nothing in the way: the rehearsal should run. */
const ready = {
  pacificHour: REHEARSAL_HOUR,
  hoursToRelease: null,
  sessionLive: false,
  hoursSinceLastRun: 24,
  hasCredentials: true,
};

test('the ordinary evening rehearses', () => {
  assert.equal(shouldRehearse(ready).run, true);
});

test('it only runs at the rehearsal hour', () => {
  // Without this it would attempt a login on every 60-second expiry poll, all day.
  for (const h of [0, 7, 8, 12, REHEARSAL_HOUR - 1, REHEARSAL_HOUR + 1, 23]) {
    assert.equal(shouldRehearse({ ...ready, pacificHour: h }).run, false, `hour ${h} must not rehearse`);
  }
});

test('a hold within the release window stands it down', () => {
  // THE ONE THAT COULD LOSE A CAMPSITE. The rehearsal takes the Chromium profile and ends
  // the session on its way through. Doing that near a cart risks the thing it exists to
  // protect — same reasoning as the update guard's release check, and equally not liftable.
  const close = shouldRehearse({ ...ready, hoursToRelease: REHEARSAL_MIN_HOURS_TO_RELEASE - 0.1 });
  assert.equal(close.run, false);
  assert.match(close.why, /releases in/);
  // And a hold comfortably beyond it does not.
  assert.equal(shouldRehearse({ ...ready, hoursToRelease: REHEARSAL_MIN_HOURS_TO_RELEASE + 0.1 }).run, true);
});

test('a release already in the past does not block it', () => {
  // `hoursToRelease` goes negative for a hold whose moment has come and gone but whose row
  // has not been swept yet. A naive `< MIN` test treats -14h as "in 14 hours" and would
  // suppress the rehearsal for the rest of the evening, silently, on exactly the night
  // after a failed morning — when proving the login works matters most.
  assert.equal(shouldRehearse({ ...ready, hoursToRelease: -14 }).run, true);
});

test('once a night, and the gap is wider than the hour is long', () => {
  assert.equal(shouldRehearse({ ...ready, hoursSinceLastRun: REHEARSAL_MIN_GAP_H - 1 }).run, false);
  // The gate is a duration, not "have we run today", so it has to outlast the window it is
  // guarding. At anything under an hour the rehearsal hour itself would admit a second
  // login; REHEARSAL_MIN_GAP_H is the only thing making "one a night" true.
  assert.ok(REHEARSAL_MIN_GAP_H > 1, 'the gap must exceed the length of the rehearsal hour');
  assert.ok(REHEARSAL_MIN_GAP_H <= 24, 'and must not push the rehearsal off a day at a time');
});

test('never having run is not a reason to skip', () => {
  // `hoursSinceLastRun: null` is a fresh box, or a feed that has never recorded one. If
  // that read as "too soon" the feature would never start on the machine that needs it.
  assert.equal(shouldRehearse({ ...ready, hoursSinceLastRun: null }).run, true);
});

test('a live session skips — a pass that proved nothing is worse than a skip', () => {
  // `attemptLogin` short-circuits on `isLive()`, by design: that check is what stopped it
  // reporting phantom failures on 2026-08-09. So a rehearsal against a live session returns
  // ok without exercising one line of the sign-in, and records a green night for a login
  // that was never tried. That is the exact shape of every failure this codebase keeps
  // finding — an affirmative answer from a thing that never asked the question.
  assert.equal(shouldRehearse({ ...ready, sessionLive: true }).run, false);
  // `null` is "we could not tell", which is NOT "it is live". Skipping on unknown would
  // stand the rehearsal down every time RC's edge 403'd the liveness probe.
  assert.equal(shouldRehearse({ ...ready, sessionLive: null }).run, true);
});

test('no saved password, no rehearsal', () => {
  const r = shouldRehearse({ ...ready, hasCredentials: false });
  assert.equal(r.run, false);
  assert.match(r.why, /password/);
});

test('every skip says why', () => {
  // The reason is stored and shown in the health check. A skip with an empty reason reads
  // on the dashboard as an unexplained quiet night, which is how a run of skips starts
  // looking like a run of passes.
  for (const s of [
    { ...ready, hasCredentials: false },
    { ...ready, pacificHour: 3 },
    { ...ready, hoursSinceLastRun: 1 },
    { ...ready, hoursToRelease: 1 },
    { ...ready, sessionLive: true },
  ]) {
    const r = shouldRehearse(s);
    assert.equal(r.run, false);
    assert.ok(r.why && r.why.length > 3, 'a skip must carry a reason');
  }
});

// ── READING THE RESULT ──────────────────────────────────────────────────────────────────

test('a skip never reads as a pass', () => {
  // THE FAILURE THIS FEATURE WOULD OTHERWISE INTRODUCE. `ok: null` is a night we declined
  // to test. A check that only looked for `ok === false` would report green through a
  // fortnight of skips — a health check actively standing in front of an untested login.
  assert.equal(rehearsalFault({ ran_at: new Date().toISOString(), ok: null }, 1000), 'stale');
  assert.equal(rehearsalFault({ ran_at: new Date().toISOString(), ok: false }, 1000), 'failed');
  assert.equal(rehearsalFault({ ran_at: new Date().toISOString(), ok: true }, 1000), null);
});

test('never run is never healthy', () => {
  assert.equal(rehearsalFault(null, null), 'never');
  assert.equal(rehearsalFault({ ran_at: null, ok: null }, null), 'never');
  // A pass with no age is not evidence either — an unknown age is an unknown age.
  assert.equal(rehearsalFault({ ran_at: new Date().toISOString(), ok: true }, null), 'stale');
});

test('a pass expires', () => {
  assert.equal(rehearsalFault({ ran_at: 'x', ok: true }, REHEARSAL_STALE_MS - 1), null);
  assert.equal(rehearsalFault({ ran_at: 'x', ok: true }, REHEARSAL_STALE_MS + 1), 'stale');
  // Two missed nights, not one: a single skip is legitimate (a hold was close, or the
  // session happened to be live), and failing on it would train someone to ignore this.
  assert.ok(REHEARSAL_STALE_MS > 24 * 3600_000, 'one skipped night must not fail the check');
  assert.ok(REHEARSAL_STALE_MS <= 72 * 3600_000, 'three quiet nights is no longer a signal');
});

// ── RECORDING THE SKIP ──────────────────────────────────────────────────────────────────
//
// 2026-08-12: the rehearsal did not run and left NO reason behind. `rc_login_rehearsal`
// still held the 08-11 row, so "a gate stood it down" and "the process never reached 20:00"
// were the same evidence — silence — from the one instrument whose entire job is telling a
// human the evening BEFORE a cart that the login is broken.
//
// The caller keeps one variable so the skip is written once a night rather than on every
// poll through the hour. It held the HOUR NUMBER and was never reset, so it latched at 20
// for the life of the process and silenced every night after the first.

/** 20:05 PT on the given Pacific date. PDT is UTC-7, so 20:00 PT is 03:00Z the next day. */
const at2005PT = (utcDay: string) => new Date(`${utcDay}T03:05:00Z`);

test('a skip is recordable again every night — the slot cannot latch', () => {
  // THE REGRESSION. With the old hour-number latch both nights were `20`, so the second
  // night compared equal to the first and wrote nothing at all.
  const night1 = rehearsalSlot(at2005PT('2026-08-13')); // 2026-08-12 20:05 PT
  const night2 = rehearsalSlot(at2005PT('2026-08-14')); // 2026-08-13 20:05 PT
  assert.ok(night1 && night2, 'both instants are inside the rehearsal hour');
  assert.notEqual(night1, night2, 'consecutive nights must not share a slot key');
});

test('but only once within the same night', () => {
  // The other half. The keep-warm polls through the whole hour; without a stable key it
  // would overwrite the row on every tick, and a late tick's reason would bury the real one.
  const early = rehearsalSlot(new Date('2026-08-13T03:01:00Z')); // 20:01 PT
  const late = rehearsalSlot(new Date('2026-08-13T03:58:00Z')); // 20:58 PT
  assert.equal(early, late);
});

test('the slot is null outside the rehearsal hour', () => {
  // It is the caller's only test for "are we in the window?" now — the bare
  // `hour === REHEARSAL_HOUR` comparison is gone, so a slot that answered outside the hour
  // would record a skip at every hour of the day and overwrite last night's real result.
  assert.equal(rehearsalSlot(new Date('2026-08-13T02:59:00Z')), null, '19:59 PT');
  assert.equal(rehearsalSlot(new Date('2026-08-13T04:00:00Z')), null, '21:00 PT');
  assert.equal(rehearsalSlot(new Date('2026-08-13T07:00:00Z')), null, 'midnight PT');
  assert.equal(rehearsalSlot(new Date('2026-08-13T15:00:00Z')), null, '08:00 PT — release');
});

test('the slot follows Pacific, not UTC', () => {
  // 20:00 PT is the NEXT UTC day. Keying on the UTC date would roll the slot over at 17:00
  // PT — mid-evening — and on the DST boundary it would disagree with `pacificHour`, which
  // is what actually decides whether the rehearsal runs.
  assert.equal(rehearsalSlot(at2005PT('2026-08-13')), '2026-08-12');
  // Pacific Standard Time (UTC-8): 20:05 PST is 04:05Z the next day.
  assert.equal(rehearsalSlot(new Date('2026-12-13T04:05:00Z')), '2026-12-12');
  assert.equal(rehearsalSlot(new Date('2026-12-13T03:05:00Z')), null, '19:05 PST is not the hour');
});

// ── THE WIRING ──────────────────────────────────────────────────────────────────────────

const keepwarm = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
/** Source with comment lines removed — or an assertion about absence matches its own rationale. */
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the rehearsal runs the same body as --test-login', () => {
  // The entire claim is "this is what runs at 07:45". Two copies of the login sequence
  // would be two things, and the one nobody runs by hand is the one that would rot.
  const body = code(keepwarm);
  assert.equal((body.match(/async function runLoginRehearsal\(/g) ?? []).length, 1);
  assert.match(body, /testLogin[\s\S]{0,400}runLoginRehearsal\(/);
  assert.match(body, /maybeRehearse[\s\S]{0,2500}runLoginRehearsal\(/);
});

test('the nightly rehearsal does not wait on a CAPTCHA', () => {
  // `--test-login` passes humanPresent: true because somebody is at the keyboard and can
  // solve it. At 20:00 nobody is, and a five-minute wait would hold the Chromium profile
  // for a challenge that is itself the finding worth reporting.
  const call = keepwarm.match(/maybeRehearse[\s\S]*?runLoginRehearsal\([\s\S]*?\}\)/)?.[0] ?? '';
  assert.ok(call, 'could not find the rehearsal call');
  assert.match(code(call), /humanPresent:\s*false/);
});

test('the run is recorded BEFORE the attempt, not after', () => {
  // The once-a-day gate is what stands between a crash-loop and a login every time the
  // supervisor restarts this process. Recording afterwards leaves the gate open for the
  // whole rehearsal hour if the attempt never returns — and an attempt that never returns
  // is precisely the case where a restart is about to happen.
  const fn = keepwarm.match(/async function maybeRehearse\([\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(fn, 'could not find maybeRehearse');
  // Anchored on the pre-stamp's OWN text, not on the first `reportRehearsal(null, …)` in
  // the function — the skip branch above makes one of those too, so a positional check
  // would pass with the pre-stamp deleted entirely.
  const stamped = fn.indexOf("reportRehearsal(null, 'rehearsal started', null)");
  const attempted = fn.indexOf('runLoginRehearsal(');
  assert.ok(stamped !== -1, 'the rehearsal must stamp ran_at before attempting');
  assert.ok(attempted !== -1);
  assert.ok(stamped < attempted, 'ran_at must be stamped before the login is attempted');
});

test('the keep-warm gates its skip-record on the slot, not on a bare hour', () => {
  // THE INERT-FIX GUARD. `rehearsalSlot` can be correct and imported and still change
  // nothing if the caller keeps comparing hour numbers — the shape of `6006428`, which
  // claimed to fix the RC URL and only touched the copy, and of the update-guard fix that
  // was present but never passed `--claimed`. The defect lived in the CALLER, so that is
  // where it has to be asserted.
  const fn = code(keepwarm.match(/async function maybeRehearse\([\s\S]*?\n}/)?.[0] ?? '');
  assert.ok(fn, 'could not find maybeRehearse');
  assert.match(fn, /rehearsalSlot\(\)/, 'maybeRehearse must derive its slot from rehearsalSlot');
  // The latch it replaced, in either spelling: a variable compared against the hour.
  assert.doesNotMatch(fn, /rehearsedThisHour/, 'the hour-number latch must be gone');
  assert.doesNotMatch(
    fn, /\w+\s*!==\s*hour\b/,
    'a skip must not be gated on an hour number — that is the latch that silenced 08-12',
  );
  // And the skip has to still be recorded, or the slot is just bookkeeping.
  assert.match(fn, /recordedSlot\s*!==\s*slot[\s\S]{0,300}reportRehearsal\(null,\s*null,/);
});

test('an unreachable feed cancels the rehearsal', () => {
  // Unknown is not safe. Without the feed we do not know whether a hold is due, and the
  // rehearsal ends the session on its way through — the same rule as the update guard
  // refusing to update blind, with the same thing at stake.
  const fn = keepwarm.match(/async function maybeRehearse\([\s\S]*?\n}/)?.[0] ?? '';
  assert.match(code(fn), /!facts\.reachable[\s\S]{0,40}return false/);
});

// ── THE SESSION CHECK'S SEVERITY ────────────────────────────────────────────────────────

test('a dead session hours before a release is not a failure', () => {
  // 2026-08-11: tapping a hold at 18:34 turned `autocart.rc_session` RED for the whole night
  // — 13 hours before the release — because the check failed on ANY hold ahead. The token
  // lives about an hour, so the session is legitimately dead most of the day, and
  // `maybeAutoLogin` signs in at T-30 unattended. Nothing was wrong; the check simply had no
  // notion of "how soon".
  //
  // That is the 2026-08-09 alarm-gate lesson, which arrived here two days late: the alarm
  // waits for the repair to have had its turn, and so must this.
  const route = readFileSync('src/app/api/health/status/route.ts', 'utf8');
  // The severity now reads `repairSpent`, which is `dead && (loginFailed || soon > 0)` —
  // same property, one threshold further corrected. It used to be spelled `dead && soon > 0`
  // with `soon` counting holds within 45 minutes; that window was ALSO being used to mean
  // "the auto-login has had its turn", which it is not, and the check told the owner to go
  // to the box at T-34 over a repair that ran at T-31. See
  // worker/autologin-lead.test.mts, which pins the two windows apart.
  assert.match(route, /repairSpent \? 'fail'/, 'dead only fails once the repair has had its turn');
  assert.match(
    route,
    /const repairSpent = dead && \(loginFailed \|\| soon > 0\)/,
    'and "spent" must still require the session to be dead AND the release to be close',
  );
  assert.ok(!/\(dead \|\| sessionStale\) && ahead > 0 \? 'fail'/.test(route),
    'the old any-hold-ahead rule must be gone');
});

test('but a STALE verdict still fails on any hold ahead', () => {
  // Dead and stale are different faults. Dead means the keep-warm is alive and reporting
  // honestly, with a scheduled repair. STALE means the keep-warm is not reporting at all —
  // and `maybeAutoLogin` lives inside it, so the repair mechanism is absent rather than
  // pending. That is 2026-08-10: a wedged keep-warm sat amber for ten hours and the 08:00
  // cart failed. Relaxing this one would re-open it.
  const route = readFileSync('src/app/api/health/status/route.ts', 'utf8');
  assert.match(route, /sessionStale && ahead > 0 \? 'fail'/, 'stale keeps the stricter rule');
});

test('the critical window matches the alarm lead', () => {
  // The moment the phone alarm decides a human is the fallback is exactly the moment this
  // stops being routine. Two different numbers here would mean the page and the dashboard
  // disagreed about whether anyone needed to act.
  assert.equal(RC_SESSION_CRITICAL_MIN, 45);
  assert.ok(RC_SESSION_CRITICAL_MIN > 30,
    'it must exceed RC_AUTOLOGIN_LEAD_MIN, or it fails before the repair has even run');
});

test('a routine dead session does not send anyone to the mini-PC', () => {
  // The detail said "a human must run `node rc-keepwarm.mjs --login`" on EVERY dead verdict,
  // which is most of the day. On 2026-08-09 I read exactly that and told the owner to sign in
  // by hand — over the session that carted a site fifteen minutes later. Instructions are
  // part of the check: one that asks for work the machine is about to do itself trains people
  // to ignore it.
  const route = readFileSync('src/app/api/health/status/route.ts', 'utf8');
  assert.match(route, /normal between releases/, 'the routine case must say so');
  assert.match(route, /the auto-login has had its turn/, 'and the urgent case must be distinct');
});

// ── "NO FORM APPEARED" MEANS TWO OPPOSITE THINGS ────────────────────────────────────────

test('an already-signed-in page is inconclusive, never a failure', () => {
  // THE FIRST PRODUCTION REHEARSAL FAILED THIS WAY (2026-08-11 20:02). It cleared the token,
  // reloaded, saw "not live", went hunting for a sign-in form — and RC's SPA re-authenticated
  // from the live Okta session in between, so there was no form to find. It reported a
  // FAILURE, quoting RC's own banner: "You have a reservation arriving on today's date".
  //
  // That banner is only ever rendered to a SIGNED-IN user. It is evidence of success, and
  // this is the SECOND time it has been read as the obstacle — the first cost a morning on
  // 2026-08-09, when the owner was sent to sign in by hand over the session that carted a
  // site fifteen minutes later.
  const login = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
  const branch = login.match(/if \(!user && !pw\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.ok(branch, 'could not find the no-form branch');
  // ROUTED THROUGH `acceptable()` SINCE 2026-08-15, and the behaviour this test protects is
  // unchanged: `acceptable()` calls `isLive()` and, when the caller passes no deadline — which
  // the rehearsal never does — returns exactly its answer. The equivalence is pinned below so
  // this cannot quietly become a different question.
  assert.match(branch, /await acceptable\(\)/,
    'it must re-ask whether we are signed in before declaring failure');
  const live = branch.indexOf('acceptable()');
  const fail = branch.indexOf('ok: false');
  assert.ok(live !== -1 && fail !== -1 && live < fail, 'and ask BEFORE returning the failure');

  // `acceptable()` must still ASK `isLive()`, or the re-ask is gone however it is spelled.
  const helper = login.match(/const acceptable = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
  assert.ok(helper, 'could not find acceptable()');
  assert.match(helper, /await isLive\(\)/, 'acceptable() must consult isLive()');
  // ...and with no deadline supplied it must reduce to plain liveness, which is what keeps the
  // rehearsal and --test-login behaving as they always have.
  assert.match(helper, /sufficient \? .* : undefined/,
    'a caller with no deadline must reach sessionAcceptable with undefined, not false');
});

test('and it is not recorded as a pass either', () => {
  // Nothing was typed and no sign-in was exercised. A green mark for a test that did not run
  // is the failure mode this whole file exists to prevent — the same rule as skipping when
  // the session is live: a pass that proved nothing reads as evidence.
  const login = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
  assert.match(login, /provedNothing: true/, 'the caller must be told nothing was exercised');
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  assert.match(kw, /r\.provedNothing[\s\S]{0,220}result: 'inconclusive'/,
    'and the rehearsal must record it as inconclusive, not ok');
});

test('a re-authenticating session is never recorded as a failed login', () => {
  // THE BANNER TRAP, THIRD OCCURRENCE (2026-08-14 03:01). The rehearsal recorded a FAILURE
  // quoting RC's own "You have a reservation arriving on today's date ... Pre Check In" —
  // which RC renders only to a SIGNED-IN user. The session was healthy and the one question
  // this test exists to answer was reported backwards, on the check the 07:40 pre-flight
  // reads. The first occurrence (2026-08-09) sent the owner to sign in by hand over the
  // session that carted a site fifteen minutes later.
  //
  // A single `isLive()` at the form-hunt exit was already the fix for occurrences one and
  // two, and it was not enough: RC paints the banner as soon as it knows who you are and
  // stores the token a moment later, so asking once lands in the gap. It must ask REPEATEDLY.
  const src = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  // The retry loop, and that provedNothing is what it returns.
  assert.match(
    code,
    /for \(let i = 0; i < \d+; i\+\+\) \{[\s\S]{0,400}?await acceptable\(\)[\s\S]{0,300}?provedNothing: true/,
    'the form-hunt exit must poll isLive() before calling it a failure',
  );
  assert.match(code, /await page\.waitForTimeout\(\d+\)/, 'and must actually wait between asks');

  // NOT matched on RC's copy. A rule built on the banner's wording fails silently the day
  // RC rewords it, and the fact that matters is a live token, not a sentence.
  assert.ok(
    !/reservation arriving on today/i.test(code),
    'do not classify on RC banner text — a live token is the fact, the banner is only the tell',
  );

  // And the mapping that makes it inconclusive rather than a pass must survive.
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  assert.match(kw, /provedNothing[\s\S]{0,200}?result: 'inconclusive'/,
    'proved-nothing must record as inconclusive — never a pass, never a failure');
});

/* ── THE HAND-RUN PATH THREW THE REASON AWAY (2026-08-18) ──────────────────────────── */

/**
 * `runLoginRehearsal` computes the real reason — Okta's own banner, folded in by
 * `withBanner`, which is what separates "the password was mistyped when you saved it" from
 * "a CAPTCHA is up" from "RC's app never rendered" — and RETURNS it as `detail`.
 *
 * `testLogin` took `.result` and discarded `.detail`, reporting the canned string
 * "test login failed — a human must sign in". The NIGHTLY path always reported the real one,
 * so the single path a human runs when actively trying to find out why was the one that threw
 * the answer away — and `rc-test-login.bat` keeps no log, so the reason existed only in that
 * console window. Observed on the first row this instrument ever wrote.
 */

test('the hand-run test reports the REASON, not a canned string', () => {
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const fn = kw.slice(kw.indexOf('async function testLogin()'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.match(body, /const detail = outcome === BUSY \|\| !outcome \? null : outcome\.detail \?\? null;/,
    'testLogin must take the detail off the rehearsal result');
  // BOTH REPORTS. The dashboard reads reportSession; the history reads reportRehearsal. A fix
  // to one leaves the other saying nothing, which is how this survived in the first place.
  assert.match(body, /reportRehearsal\(false, detail \?\?/, 'the history must carry it');
  assert.match(body, /reportSession\('dead', detail \?\?/, 'and so must the dashboard');
  // The canned sentence survives ONLY as a fallback — never as the value itself.
  assert.ok(!/reportRehearsal\(false, 'test login failed/.test(body),
    'the canned string must not be what gets reported');
});

test('an INCONCLUSIVE hand-run is reported, not returned in silence', () => {
  // The singleton's `ok` is three-valued for exactly this. The nightly path has always sent
  // `null` with the reason; the hand path returned silently, so after a real failure the
  // dashboard kept showing "the bot COULD NOT SIGN IN" while the latest run had actually been
  // unable to test at all. Two different wrong answers about one run.
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const fn = kw.slice(kw.indexOf('async function testLogin()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /reportRehearsal\(null, detail, null\)/,
    'inconclusive must be recorded as ok=null WITH its reason');
  assert.ok(!/if \(result === 'inconclusive'\) return false;/.test(body),
    'it must not return in silence');
});
