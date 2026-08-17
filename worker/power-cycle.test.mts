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
  const seq = code.slice(code.indexOf('const off = await shelly'));
  assert.match(seq, /const on = await shelly\('on'\)/);
  assert.ok(!/if \(off\.ok\)[\s\S]{0,80}shelly\('on'\)/.test(seq),
    "restoring power must never depend on the off call having succeeded");
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
