// The remote power cut — the lever that works when the box is running nothing.
//
// On 2026-08-17 the mini-PC ran ZERO processes for over an hour and nothing could reach it.
// Every remote lever rides a process on that machine: `bot_commands` needs `bot.mjs`, the
// watchdog needs Task Scheduler, `restart-rc` needs a poller. With nothing running there is
// nothing to receive an instruction, and no software installed on a machine can fix "the
// machine is running nothing". So the lever moved off the box entirely.
//
// THIS IS THE MOST DESTRUCTIVE CONTROL IN THE PRODUCT. It can interrupt a cart, and it can
// corrupt the Chromium profile holding RC's `DT` device cookie — the thing that lets Okta
// skip the email step, whose loss has previously cost a 12-hour block on the household IP.
// Every gate below therefore fails CLOSED, and the tests are about the refusals rather than
// the happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/lib/power-cycle.ts', 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ROUTE = readFileSync('src/app/api/admin/power-cycle/route.ts', 'utf8');
const routeCode = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('an unreadable heartbeat REFUSES — null is never a reason to cut power', () => {
  // "We could not tell" must not become "it is dead". Same rule as `unknown` never rounding
  // to `signed-out` — except this one is not recoverable by waiting.
  assert.match(code, /silentMs == null/);
  const branch = code.slice(code.indexOf('silentMs == null'));
  assert.match(branch.slice(0, 400), /Refusing/i);
  assert.match(code, /typeof age === 'number' && Number\.isFinite\(age\) \? age : null/,
    'boxSilentMs must return null rather than a fabricated age');
});

test('a live box is refused', () => {
  // A power cut is for a box running nothing. Cutting a slow one is vandalism.
  assert.match(code, /silentMs < POWER_CYCLE_MIN_SILENT_MS/);
  assert.match(code, /POWER_CYCLE_MIN_SILENT_MS = Number\(process\.env\.POWER_CYCLE_MIN_SILENT_MS \?\? 10 \* 60_000\)/);
});

test('a cart in flight outranks everything', () => {
  // `carted`/`claiming` means a real campsite is in a real cart for someone mid-hand-off.
  // A dark box costs a morning; this costs somebody their booking.
  assert.match(code, /status IN \('carted','claiming'\)/, 'the right statuses are read');
  // AND THE COUNT MUST ACTUALLY GATE. The first version of this test asserted only that the
  // query existed and that "Refusing" appeared somewhere after it — so replacing the
  // condition with `if (false)` left both true and the mutation passed. Pin the comparison.
  assert.match(code, /if \(\(holds\[0\]\?\.n \?\? 0\) > 0\) \{/,
    'the hold count must be what decides, not merely be fetched');
  const branch = code.slice(code.indexOf('(holds[0]?.n ?? 0) > 0'));
  assert.match(branch.slice(0, 500), /Refusing/);
});

test('every unreadable gate refuses rather than proceeding', () => {
  // Three DB reads gate this. If any of them cannot answer, the safe move is to do nothing —
  // a `.catch(() => [])` that returned an empty list would read as "no holds, no recent
  // cuts" and open the gate on a database blip.
  for (const guard of ['holds == null', 'recent == null']) {
    assert.ok(code.includes(guard), `${guard} must be handled as a refusal`);
  }
  assert.ok(!/\.catch\(\(\) => \[\]\)/.test(code.slice(code.indexOf('powerCycleRefusal'))),
    'a failed read must be distinguishable from an empty result');
});

test('the rate limit is read from the table, not from memory', () => {
  // This runs in a request handler that may be a fresh lambda every time, so in-process
  // state would bound nothing. A reboot loop is strictly worse than a dark box.
  assert.match(code, /FROM power_cycles/);
  assert.match(code, /POWER_CYCLE_COOLDOWN_MS = Number\(process\.env\.POWER_CYCLE_COOLDOWN_MS \?\? 2 \* 60 \* 60_000\)/);
});

test('power is ALWAYS turned back on', () => {
  // A plug left off is the one outcome strictly worse than the outage: the box cannot boot
  // and the next lever is a car journey. The `on` call must not be conditional on `off`.
  const seq = code.slice(code.indexOf("const off = await switchPlug('off')"));
  assert.match(seq, /const on = await switchPlug\('on'\)/);
  assert.ok(!/if \(off\.ok\)[\s\S]{0,80}switchPlug\('on'\)/.test(seq),
    "restoring power must never depend on the off call having succeeded");
});

test('it calls the endpoint that works on EVERY generation', () => {
  // The first version used `/device/relay/control`. Shelly's own docs say that API "is
  // deprecated and will be removed in the near future" and document Gen1/Gen2 only — so it
  // would have failed on a current Gen4 plug, and eventually on every plug. Found by the
  // owner asking whether a Gen4 would work, which is the question I should have asked before
  // writing it.
  //
  // `/v2/devices/api/set/switch` is documented to work for "all types and generations of
  // relays and plugs". That property is the whole point: the hardware is bought once, by a
  // person, and a lever that only works with a discontinued generation quietly stops
  // existing.
  assert.match(code, /\/v2\/devices\/api\/set\/switch\?auth_key=/);
  assert.ok(!/device\/relay\/control/.test(code), 'the deprecated endpoint must not come back');
  // v2 takes JSON with a boolean, not a form with turn=on|off.
  assert.match(code, /body: JSON\.stringify\(\{ id: [^}]*on: turn === 'on', channel: 0 \}\)/);
  assert.match(code, /'Content-Type': 'application\/json'/);
});

test('the act is a POST and the preview is a GET', () => {
  // A GET can be fired by a link preview or a scanner with nobody involved — the same
  // reasoning that makes "hold it for me" a form POST rather than a link.
  assert.match(routeCode, /export async function GET\(\)/);
  assert.match(routeCode, /export async function POST\(\)/);
  const get = routeCode.slice(routeCode.indexOf('export async function GET'), routeCode.indexOf('export async function POST'));
  assert.ok(!/powerCycle\(/.test(get), 'GET must never cut power');
  assert.match(get, /powerCycleRefusal/, 'GET previews the refusal so the button is not a coin toss');
});

test('the route is admin-only and outlives the off-window', () => {
  assert.match(routeCode, /currentUserIsAdmin/);
  assert.match(routeCode, /status: 404/, '404 rather than 403, matching the rest of /api/admin');
  assert.match(routeCode, /maxDuration = 60/,
    'the handler holds the power off, so it must outlive the default timeout');
});

/**
 * TWO VENDORS, added 2026-08-17 because the hardware is bought by a person under whatever
 * delivery date they can get — the Shelly was four days out. Both have PUBLISHED APIs, which
 * is the real requirement: Kasa, Meross and Wyze were rejected for having only
 * reverse-engineered ones, and a lever reached for at 07:50 must not depend on an endpoint
 * that can change without notice.
 */
test('both configured is a REFUSAL, not a preference', () => {
  // Picking one of two plugs by an ordering rule nobody remembers means cutting power to
  // whatever is in the other socket — and this act is not undoable from here. Ambiguity about
  // WHICH physical thing loses power is the one input that must never be resolved silently.
  assert.match(code, /if \(shellySet\(\) && switchbotSet\(\)\) return 'ambiguous'/);
  const branch = code.slice(code.indexOf("vendor === 'ambiguous'"));
  assert.match(branch.slice(0, 400), /Refusing/);
});

test('SwitchBot reads its OWN status code, not the HTTP status', () => {
  // SwitchBot answers 200 with a JSON body carrying `statusCode` — so an HTTP 200 is not
  // success. Exactly the trap as RC returning 200 with IsSuccess:false, and as
  // `notifications.status = 'sent'` meaning only "Twilio returned 2xx".
  assert.match(code, /inner = JSON\.parse\(text\)\?\.statusCode \?\? null/);
  assert.match(code, /ok: r\.ok && inner === 100/,
    'the payload must gate success, not the transport');
});

test('the SwitchBot signature follows their JS sample, not their prose', () => {
  // Their docs say "convert the signature to upper case"; their own JavaScript example does
  // not, and PHP/Go do. Base64 is case-sensitive so those cannot all be right. This follows
  // the JS sample — the language we are in, and what the working Node clients do. A regression
  // here fails at 07:50 with an auth error, so it is pinned rather than left to taste.
  assert.match(code, /createHmac\('sha256', secret\)\.update\(token \+ t \+ nonce\)\.digest\('base64'\)/);
  assert.ok(!/digest\('base64'\)\.toUpperCase\(\)/.test(code),
    'do not uppercase on the strength of the prose alone — see the comment');
});

test('each vendor is reached only when it is the selected one', () => {
  // The dispatch must not fall through to a default vendor: sending a turnOff to the wrong
  // API is harmless, but silently doing nothing while reporting success is not.
  assert.match(code, /if \(vendor === 'switchbot'\) return switchbot\(turn\)/);
  assert.match(code, /if \(vendor === 'shelly'\) return shelly\(turn\)/);
  assert.match(code, /return \{ ok: false, detail: `\$\{turn\}: no plug configured` \}/,
    'no vendor must report failure, never a silent success');
});

// ── The read-only pre-flight (added 2026-08-19) ────────────────────────────────────────
//
// `powerPlugConfigured()` checks three environment variables are non-empty. It makes no
// network call, so it can only ever answer "are the credentials PRESENT" — and on the night
// the plug was set up it answered `configured: true` over credentials that had never once
// been exercised from production. Presence is not liveness, the same way
// `notifications.status = 'sent'` only ever meant "Twilio returned 2xx". Without a pre-flight
// the first real test of the production credentials is the night the box is dark.

const STATUS_ROUTE = readFileSync('src/app/api/admin/power-cycle/status/route.ts', 'utf8');
const statusRouteCode = STATUS_ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The body of `plugStatus`, so "it cannot switch anything" is asserted about that function
 *  and not about a file that obviously contains `turnOn` elsewhere. */
function plugStatusBody(): string {
  const from = code.indexOf('export async function plugStatus');
  // `export async function powerCycle` ALSO matches `powerCycleRefusal`, which sits four
  // hundred lines EARLIER — so the bare prefix sliced backwards and every assertion below
  // ran against an empty string. Caught only because the bounds are asserted rather than
  // trusted. Anchor on the signature, which is unique.
  const to = code.indexOf('export async function powerCycle(by:');
  assert.ok(from > -1, 'plugStatus must exist');
  assert.ok(to > from, 'plugStatus must sit above powerCycle — the slice below depends on it');
  return code.slice(from, to);
}

test('plugStatus READS and can never switch — that is the whole safety argument', () => {
  const body = plugStatusBody();
  assert.match(body, /method: 'GET'/, 'a status read is a GET');
  assert.match(body, /v1\.1\/devices\/\$\{id\}\/status/, 'it must hit /status, not /commands');
  // The dangerous regression is this function growing a command body. Being read-only is why
  // it is safe to expose as a GET route at all, and why it can be fired accidentally for the
  // price of one API call rather than a power cut.
  for (const forbidden of ['turnOn', 'turnOff', 'commandType', '/commands']) {
    assert.ok(!body.includes(forbidden),
      `plugStatus must not contain ${forbidden} — it reads, it does not act`);
  }
});

test('the status read signs IDENTICALLY to the cut, through one shared helper', () => {
  // THIS IS THE LOAD-BEARING ONE. The pre-flight is only worth having because a green status
  // check proves the CUT can authenticate. Give the two their own copies of the signing and
  // that inference silently stops holding — the status could pass while the command path
  // fails, which is precisely the reassurance-that-proves-nothing shape (`--once` reporting
  // "Feed reachable, token accepted" above the early return that skipped the session test).
  assert.match(code, /async function switchbotAuth\(\)/, 'one signing helper must exist');
  assert.match(plugStatusBody(), /await switchbotAuth\(\)/, 'plugStatus must sign via the helper');
  const cutFrom = code.indexOf("async function switchbot(turn");
  assert.ok(cutFrom > -1, 'the command path must exist');
  assert.match(code.slice(cutFrom, cutFrom + 400), /await switchbotAuth\(\)/,
    'the command path must sign via the same helper');
  // And there must be exactly ONE of them. Counting the primitive is what makes a second
  // hand-rolled copy fail here rather than pass by looking similar.
  assert.equal((code.match(/createHmac\(/g) ?? []).length, 1,
    'exactly one signing implementation in this file');
});

test('the status read judges on SwitchBot\'s statusCode, not the HTTP status', () => {
  // Same trap as the command path: SwitchBot answers HTTP 200 carrying its own statusCode.
  // 171 is "device offline" — a real answer, and it must not read as a broken credential.
  const body = plugStatusBody();
  assert.match(body, /inner = j\?\.statusCode \?\? null/);
  assert.match(body, /ok: r\.ok && inner === 100/,
    'the payload must gate success, not the transport');
});

test('Shelly is refused explicitly rather than guessed', () => {
  // This file already shipped a DEPRECATED Shelly endpoint written from memory, and the owner
  // caught it. An unverified status request would turn "the plug is fine" into a sentence
  // whose provenance is a guess — worse than having no pre-flight, because it would be
  // believed. The refusal must also say the CUT still works, or it reads as the plug being
  // broken.
  const body = plugStatusBody();
  assert.match(body, /vendor === 'shelly'/);
  assert.match(body, /ok: false/, 'Shelly must not report a successful status');
  assert.ok(!/shelly\.cloud|\/v2\/devices\/api\/get/.test(body),
    'do not invent a Shelly status endpoint — see the note above shelly()');
});

test('the status route is admin-gated and returns its verdict in the payload', () => {
  assert.match(statusRouteCode, /currentUserIsAdmin\(\)/, 'admin only');
  assert.match(statusRouteCode, /status: 404/, '404 rather than 403, matching the rest of /api/admin');
  // A 5xx on an unhappy plug would read as "this endpoint is broken", which is the one
  // reading that stops somebody trusting the pre-flight when it matters. The request
  // succeeded; the answer is simply no.
  assert.ok(!/status: 5\d\d/.test(statusRouteCode), 'never a 5xx for a plug that answered');
  // It must not be able to act, whatever plugStatus does.
  assert.ok(!statusRouteCode.includes('powerCycle('), 'the status route must never cut power');
});
