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
  shouldRehearse, REHEARSAL_HOUR, REHEARSAL_MIN_HOURS_TO_RELEASE, REHEARSAL_MIN_GAP_H,
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
  assert.match(route, /dead && soon > 0 \? 'fail'/, 'dead only fails once the release is close');
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
  assert.match(branch, /await isLive\(\)\) === true/,
    'it must re-ask whether we are signed in before declaring failure');
  const live = branch.indexOf('isLive()');
  const fail = branch.indexOf('ok: false');
  assert.ok(live !== -1 && fail !== -1 && live < fail, 'and ask BEFORE returning the failure');
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
