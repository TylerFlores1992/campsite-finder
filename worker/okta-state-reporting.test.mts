// THE OKTA READING IS A COST PREDICTION. IT MUST NEVER BECOME A VERDICT.
//
// `autocart.rc_session` says whether RC accepts the current token. Migration 065 adds the
// state of the OKTA session behind it, which is a different fact and the one that decides
// what the next sign-in COSTS — measured on the same box five days apart:
//
//     okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB   (2026-08-21)
//     okta=GONE    full password form             12 minutes,  +9,434 MB   (2026-08-20)
//
// Two properties are load-bearing and pull in opposite directions, which is why this file
// exists rather than a couple of assertions bolted onto an existing suite:
//
//   1. IT MAY NOT GO RED. `okta=GONE` is the ORDINARY state between releases — the access
//      token is the session for most of the day and the T-30 repair is scheduled. Reddening
//      it is the cry-wolf failure fixed three times here, most expensively at 07:33 on
//      2026-08-16 where the printed remedy would have destroyed a working session.
//   2. IT MAY NOT GO QUIET. A box on an older build reports nothing, and that must read as a
//      gap rather than as a measured absence — `unknown` never rounding to a verdict, in
//      either direction.
//
// The behavioural half tests `oktaCostNote`, which is pure. The structural half pins the
// CHAIN, because every link is somewhere a value can be produced and silently dropped: that
// is migration 064's whole story (`notePlatform` emitting a fact into a region that then
// discarded it) and 062's (`sqlit` turning an object into `[object Object]`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oktaCostNote, RC_AUTOLOGIN_LEAD_MIN } from '../src/lib/health-thresholds.ts';

const NOW = Date.parse('2026-08-21T15:00:00Z');
const at = (minsFromNow: number) => new Date(NOW + minsFromNow * 60_000).toISOString();

// ── 1. Silence vs. a claim ────────────────────────────────────────────────────────────────

test('a box that has never reported produces NO note at all', () => {
  // NULL IS "NOT REPORTED", NEVER "GONE". Every box is on a pre-065 build until it updates,
  // and inventing an Okta state for them would be a claim about a machine that has said
  // nothing. Silence rather than "unknown" because a note on every un-updated box is noise
  // on the one page whose job is "is anything broken?".
  assert.equal(
    oktaCostNote({ alive: null, expiresAt: null, checkedAt: null, now: NOW }),
    null,
  );
  // Even with an alive flag somehow present, no probe time means no reading.
  assert.equal(
    oktaCostNote({ alive: true, expiresAt: at(60), checkedAt: null, now: NOW }),
    null,
  );
});

test('a probe that could not tell says so, and is never rounded to GONE', () => {
  // `oktaSessionAlive` returns unknown for a busy profile, a 403 from RC's edge and a
  // network blip alike. Writing that as dead is what sends somebody to the box over a
  // healthy session — the same rule that keeps `hasAvailabilityInRange` returning null.
  const note = oktaCostNote({ alive: null, expiresAt: null, checkedAt: at(-1), now: NOW });
  assert.ok(note, 'a probe that ran must produce a reading');
  assert.match(note!, /UNKNOWN/);
  assert.ok(!/GONE/.test(note!), 'unknown must not be reported as gone');
});

// ── 2. The two costs ──────────────────────────────────────────────────────────────────────

test('GONE names the expensive sign-in, in the numbers that were measured', () => {
  const note = oktaCostNote({ alive: false, expiresAt: null, checkedAt: at(-2), now: NOW });
  assert.ok(note);
  assert.match(note!, /GONE/);
  assert.match(note!, /expensive/i, 'the point of the reading is the cost');
});

test('plenty of Okta left reads as the cheap repair', () => {
  const note = oktaCostNote({
    alive: true, expiresAt: at(RC_AUTOLOGIN_LEAD_MIN + 90), checkedAt: at(-1), now: NOW,
  });
  assert.ok(note);
  assert.match(note!, /cheap/i);
  assert.ok(!/expensive/i.test(note!));
});

// ── 3. The 2026-08-21 case: alive, and about to stop being ────────────────────────────────

test('ALIVE with less than the auto-login lead left is called out as expensive', () => {
  // 14:30 signed in "token now 60m"; 14:42 read `okta=ALIVE (exp 14:47:57)`; 15:00 GONE.
  // A sign-in answered from the `idx` cookie REUSES the existing Okta session and inherits
  // its absolute cap rather than restarting the clock, so "the bot signs in at T-30" did not
  // mean twelve hours of Okta — it meant eighteen minutes. The whole reason for the column.
  const note = oktaCostNote({ alive: true, expiresAt: at(5), checkedAt: at(-1), now: NOW });
  assert.ok(note);
  assert.match(note!, /lapses in 5m/);
  assert.match(note!, /expensive/i,
    'alive-but-lapsing must predict the expensive repair; a bare "alive" is the reading that '
    + 'looked perfectly healthy on 2026-08-21 with five minutes left');
});

test('the lapsing threshold IS the auto-login lead, not a taste number', () => {
  // Below the lead, the repair the schedule counts on arrives to find nothing cheap left.
  // Pinned as a relationship so moving the lead moves this with it — the copies-in-two-
  // languages problem that `autologin-lead.test.mts` exists for.
  const inside = oktaCostNote({
    alive: true, expiresAt: at(RC_AUTOLOGIN_LEAD_MIN - 1), checkedAt: at(-1), now: NOW,
  })!;
  const outside = oktaCostNote({
    alive: true, expiresAt: at(RC_AUTOLOGIN_LEAD_MIN + 1), checkedAt: at(-1), now: NOW,
  })!;
  assert.match(inside, /expensive/i);
  assert.match(outside, /cheap/i);
});

test('ALIVE with an expiry already past is reported from the ARITHMETIC, not the flag', () => {
  // The stored flag is a fact about the past; the expiry is what makes it actionable now.
  // Averaging them would print "Okta good" over a window that closed twenty minutes ago.
  const note = oktaCostNote({ alive: true, expiresAt: at(-20), checkedAt: at(-25), now: NOW })!;
  assert.match(note, /PASSED/);
  assert.match(note, /expensive/i);
  assert.ok(!/good for/.test(note), 'a lapsed window must not read as healthy');
});

test('ALIVE with no expiry reported says exactly that', () => {
  // Neither cheap nor expensive is knowable, so claim neither.
  const note = oktaCostNote({ alive: true, expiresAt: null, checkedAt: at(-1), now: NOW })!;
  assert.match(note, /expiry not reported/);
  assert.ok(!/cheap/i.test(note) && !/expensive/i.test(note));
});

// ── 4. The age ────────────────────────────────────────────────────────────────────────────

test('every reading carries how old it is', () => {
  // `recordSessionHealth` writes these columns ONLY when the caller probed, so a session
  // verdict from ten seconds ago can sit beside an Okta reading from an hour ago. Two facts
  // of different ages printed as one record is exactly how `bot_commit`'s COALESCE misled a
  // whole evening on 2026-08-14.
  for (const arg of [
    { alive: false, expiresAt: null },
    { alive: true, expiresAt: at(120) },
    { alive: true, expiresAt: at(5) },
    { alive: true, expiresAt: at(-5) },
    { alive: true, expiresAt: null },
    { alive: null, expiresAt: null },
  ] as const) {
    const note = oktaCostNote({ ...arg, checkedAt: at(-30), now: NOW })!;
    assert.ok(note, 'a probed reading must always produce a note');
    assert.match(note, /checked 1800s ago/, `no age on: ${note}`);
  }
});

// ── 5. Structural: it cannot change severity ──────────────────────────────────────────────

const THRESHOLDS = readFileSync('src/lib/health-thresholds.ts', 'utf8');
const ROUTE = readFileSync('src/app/api/health/status/route.ts', 'utf8');
/** Comments quote the shapes these tests forbid; strip them before asserting an absence. */
const stripComments = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The body of `oktaCostNote`, bounded by the next export so nothing wanders. */
function noteBody(): string {
  const from = THRESHOLDS.indexOf('export function oktaCostNote');
  assert.ok(from > -1, 'oktaCostNote must still exist — anchor not found');
  const to = THRESHOLDS.indexOf('\nexport ', from + 10);
  assert.ok(to > from, 'the end anchor must be found AFTER the start, or the slice runs backwards');
  return stripComments(THRESHOLDS.slice(from, to));
}

test('oktaCostNote returns prose and has no severity to return', () => {
  // THE STRUCTURAL GUARANTEE. Not "it currently returns ok" — it has no level in its type,
  // so no later edit can quietly promote a cost prediction into a verdict. `okta=GONE` is
  // the normal state between releases and a fail on it would page nightly.
  assert.match(THRESHOLDS, /export function oktaCostNote\([\s\S]{0,400}?\): string \| null \{/,
    'the return type must stay `string | null` — a level here is a fail waiting to happen');
  const body = noteBody();
  assert.ok(!/level/.test(body), 'no severity may appear inside the note builder');
  assert.ok(!/'fail'|"fail"|'warn'|"warn"/.test(body), 'and certainly no literal severity');
});

test('the route appends the note to the DETAIL, never near the level', () => {
  const code = stripComments(ROUTE);
  const call = code.indexOf('oktaCostNote({');
  assert.ok(call > -1, 'the health route must call it');
  // `level:` for this check is computed above `detail:`; the call must land after it.
  const check = code.indexOf("name: 'autocart.rc_session'");
  assert.ok(check > -1 && call > check, 'the call belongs inside the rc_session check');
  const levelAt = code.indexOf('level:', check);
  const detailAt = code.indexOf('detail:', check);
  assert.ok(levelAt > -1 && detailAt > levelAt, 'level is computed before detail here');
  assert.ok(call > detailAt, 'the note must be appended to the detail, not folded into level');
});

test('a null note appends nothing rather than the word "null"', () => {
  // `?? ''` is the whole difference between silence and a box on an old build printing
  // "null" into the sentence a human reads to decide whether to drive to the machine.
  const code = stripComments(ROUTE);
  const call = code.indexOf('oktaCostNote({');
  assert.match(code.slice(call, call + 320), /\}\)\s*\?\?\s*''/,
    'the call must coalesce to an empty string');
});

// ── 6. Structural: the chain from the bot to the column ───────────────────────────────────

test('the keep-warm posts okta only from the arms that actually probed', () => {
  // A fabricated reading is worse than none. `warmOnce` does not probe Okta, so it must not
  // pass the field — undefined means "not measured this time" and leaves the stored value
  // alone, which is a different thing from writing null.
  const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  assert.match(KEEPWARM, /async function reportSession\(state, renewalNote = '', okta = undefined\)/,
    'the third parameter must default to undefined — "not measured", not "measured absent"');
  // Every call that supplies it must be inside checkAndReport, the only Okta prober.
  const probeAt = KEEPWARM.indexOf('async function checkAndReport');
  assert.ok(probeAt > -1, 'checkAndReport must still exist');
  // MATCH CALLS, NOT THE DEFINITION. The first version of this assertion used a bare
  // /reportSession\(/ and matched the `async function reportSession(...)` line — which sits
  // ABOVE checkAndReport, so it failed against correct code claiming a caller had not
  // probed. Same trap as anchoring on `maybeAutoLogin(ctx, page)` and landing on its
  // definition four hundred lines above the call site. Eighteenth time.
  const calls = [...KEEPWARM.matchAll(/(?<!function )reportSession\([^)]*\)/g)];
  const withOkta = calls.filter((m) => /okta/.test(m[0]));
  assert.ok(withOkta.length >= 3,
    `every reporting arm of checkAndReport must carry the reading, found ${withOkta.length}`);
  for (const m of withOkta) {
    assert.ok(m.index! > probeAt,
      `a caller outside checkAndReport passes okta without having probed: ${m[0]}`);
  }
});

test('recordSessionHealth writes the columns ONLY when a reading was supplied', () => {
  // The alternative — writing null whenever the field is absent — makes every non-probing
  // report erase a good reading, and the health note would then flip to "not reported"
  // between probes. A stale reading with its age attached beats a destroyed one.
  const HOLDS = readFileSync('src/lib/rc-holds.ts', 'utf8');
  const from = HOLDS.indexOf('export async function recordSessionHealth');
  assert.ok(from > -1, 'recordSessionHealth must still exist');
  const body = HOLDS.slice(from, HOLDS.indexOf('\nexport ', from + 10));
  for (const col of ['okta_alive', 'okta_expires_at', 'okta_checked_at']) {
    const at2 = body.indexOf(`${col}      =`) > -1 ? body.indexOf(`${col}      =`) : body.indexOf(`${col} =`);
    assert.ok(at2 > -1, `${col} must be written`);
    assert.match(body.slice(at2, at2 + 90), /CASE WHEN \$4/,
      `${col} must be conditional on a reading having been supplied`);
  }
  assert.match(body, /okta !== undefined/,
    'and the condition must distinguish ABSENT from null — null is a measured unknown');
});

test('an unparseable expiry becomes NULL and cannot take the session verdict with it', async () => {
  // `::timestamptz` on rubbish THROWS, and that statement also carries the session verdict —
  // so a malformed diagnostic field would destroy the reading it rides along with, and
  // `recordSessionHealth`'s `.catch` would turn that into silence. A diagnostic that can
  // break the thing it observes is not worth having: this is the multi-GB heap snapshot
  // written at the moment the box cannot spawn, in one column.
  const { oktaExpiresAt } = await import('../src/lib/rc-holds.ts');
  for (const bad of [null, undefined, '', 'not a date', 'okta=ALIVE (exp …)', '[object Object]']) {
    assert.equal(oktaExpiresAt(bad as string | null), null, `must reject: ${String(bad)}`);
  }
  // A real reading survives, normalised rather than passed through — nothing reaches the
  // cast that has not already been proved to be a date on this side.
  assert.equal(oktaExpiresAt('2026-08-21T14:47:57.000Z'), '2026-08-21T14:47:57.000Z');
  assert.equal(oktaExpiresAt('2026-08-21T14:47:57Z'), '2026-08-21T14:47:57.000Z');
});

test('the route SELECTs the columns it renders', () => {
  // A column added, written, and never fetched is the shape that made "platform not
  // reported" look like a missing feature for every hand-off ever summarised.
  //
  // BOUNDED TO THE SQL, NOT A WINDOW OF CHARACTERS. The first version sliced 700 chars back
  // from the FROM clause and reached past the query into the TypeScript row type declared
  // directly above it — which names the same columns — so it PASSED against a route whose
  // SELECT had had all three removed (verified). It was reading the type and reporting on
  // the query. Nineteenth time a guard here has anchored on the wrong thing.
  const from = ROUTE.indexOf('FROM rc_runner_heartbeat');
  assert.ok(from > -1, 'the heartbeat query must still exist');
  const selectAt = ROUTE.lastIndexOf('`SELECT', from);
  assert.ok(selectAt > -1 && selectAt < from,
    'the SELECT must be found BEFORE the FROM, or the slice is not the query');
  const sel = ROUTE.slice(selectAt, from);
  for (const col of ['okta_alive', 'okta_expires_at', 'okta_checked_at']) {
    assert.ok(sel.includes(col), `${col} must be in the SELECT, not merely in the row type`);
  }
});
