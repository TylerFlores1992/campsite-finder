/**
 * The alarm call — the one notification that wakes somebody up.
 *
 * These guard properties that are invisible when broken. A single call instead of two
 * still places a call, still returns success, still shows up in the Twilio log — and
 * silently stops piercing Do Not Disturb, which is the entire reason this exists rather
 * than a push. A rate limit keyed per attempt instead of per incident also "works": it
 * just permits a call every twenty minutes all night. And a repeat call scheduled with a
 * bare timer inside a Vercel route is frozen with the invocation and never placed, while
 * every log line still reads as success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alarmCall } from '../src/lib/notifications/voice';

/** Stand in for Twilio and record what was asked of it. */
function captureTwilio() {
  const calls: { to: string; twiml: string; timeout: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({
      to: body.get('To') ?? '', twiml: body.get('Twiml') ?? '', timeout: body.get('Timeout') ?? '',
    });
    return new Response(JSON.stringify({ sid: `CA${calls.length}`, status: 'queued' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/**
 * MUST BE ASYNC AND MUST AWAIT `fn()`.
 *
 * The first version was sync — `try { return fn() } finally { restore() }` — which restores
 * the environment the moment the promise is CREATED, not when it settles. The first call in
 * each test happened to pass anyway, because `placeOne` reads the env synchronously before
 * its first await; every call after one suspension point saw an unconfigured Twilio. The
 * test failed for a reason that had nothing to do with the code under test, which is the
 * worst kind of red.
 */
async function withTwilioEnv<T>(fn: () => Promise<T>): Promise<T> {
  const before = {
    s: process.env.TWILIO_ACCOUNT_SID, a: process.env.TWILIO_AUTH_TOKEN, f: process.env.TWILIO_FROM_NUMBER,
  };
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_FROM_NUMBER = '+15550001111';
  try { return await fn(); } finally {
    if (before.s) process.env.TWILIO_ACCOUNT_SID = before.s; else delete process.env.TWILIO_ACCOUNT_SID;
    if (before.a) process.env.TWILIO_AUTH_TOKEN = before.a; else delete process.env.TWILIO_AUTH_TOKEN;
    if (before.f) process.env.TWILIO_FROM_NUMBER = before.f; else delete process.env.TWILIO_FROM_NUMBER;
  }
}

test('it calls TWICE — one call does not pierce Do Not Disturb', async () => {
  const t = captureTwilio();
  try {
    await withTwilioEnv(async () => {
      // Capture the repeat task rather than waiting 45 real seconds for it. This is also
      // exactly what the route does with `after`, so the shape is the production one.
      let repeat: (() => Promise<void>) | null = null;
      const r = await alarmCall('+15551234567', 'wake up', 'hold-a', (task) => { repeat = task; });
      assert.equal(r.placed, 1, 'the first call goes immediately');
      assert.equal(t.calls.length, 1);
      assert.ok(repeat, 'a repeat call MUST be scheduled — it is the mechanism, not a retry');
      // Each call must stop ringing before the next arrives, or the second lands as
      // call-waiting on a call already in progress rather than as a repeat caller.
      assert.equal(t.calls[0].timeout, '25');
    });
  } finally { t.restore(); }
});

test('the repeat is placed whether or not the first was answered', () => {
  // Draining a 45-second timer would just be testing setTimeout, so this asserts the one
  // thing that would quietly turn the mechanism back into a retry: a condition on it.
  const src = readFileSync('src/lib/notifications/voice.ts', 'utf8');
  const body = src.slice(src.indexOf('export async function alarmCall'));
  assert.match(body, /schedule\(async \(\) => \{/, 'the repeat must still be scheduled');
  const scheduleAt = body.indexOf('schedule(async');
  const preceding = body.slice(0, scheduleAt);
  // The only early return before it is the hard failure of the FIRST call — anything else
  // (unanswered, busy, voicemail) must still get a repeat.
  const returns = [...preceding.matchAll(/return \{ placed: 0[^}]*\}/g)].length;
  assert.equal(returns, 3, 'no phone, rate limited, first call errored — and nothing else');
});

test('the rate limit is keyed on the incident, not the attempt', async () => {
  const t = captureTwilio();
  try {
    await withTwilioEnv(async () => {
      const noop = () => {};
      const first = await alarmCall('+15551234567', 'wake up', 'hold-b', noop);
      assert.equal(first.placed, 1);
      // The keep-warm reports session health every pass. Same incident, same key.
      const second = await alarmCall('+15551234567', 'wake up', 'hold-b', noop);
      assert.equal(second.placed, 0, 'a second report of the same dead session must not re-ring');
      assert.match(second.error ?? '', /rate limited/);
      // A genuinely different hold is a different emergency and is NOT suppressed.
      const other = await alarmCall('+15551234567', 'wake up', 'hold-c', noop);
      assert.equal(other.placed, 1);
    });
  } finally { t.restore(); }
});

test('no phone number means no call, and no crash', async () => {
  const t = captureTwilio();
  try {
    await withTwilioEnv(async () => {
      for (const to of [null, undefined, '']) {
        const r = await alarmCall(to, 'wake up', `none-${String(to)}`, () => {});
        assert.equal(r.placed, 0);
        assert.equal(r.error, 'no phone number');
      }
      assert.equal(t.calls.length, 0);
    });
  } finally { t.restore(); }
});

test('a campground name with an ampersand does not break the TwiML', async () => {
  const t = captureTwilio();
  try {
    await withTwilioEnv(async () => {
      await alarmCall('+15551234567', 'Ben & Jerry <SP> releases', 'xml-1', () => {});
    });
  } finally { t.restore(); }
  const { twiml } = t.calls[0];
  assert.ok(!/Ben & Jerry/.test(twiml), 'a bare ampersand is invalid XML and Twilio rejects the whole call');
  assert.match(twiml, /Ben &amp; Jerry &lt;SP&gt; releases/);
  // Three repeats: someone woken by this misses the first one entirely.
  assert.equal((twiml.match(/<Say/g) ?? []).length, 3);
});

test('an unconfigured Twilio reports why instead of pretending', async () => {
  const before = process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_ACCOUNT_SID;
  try {
    const r = await alarmCall('+15551234567', 'wake up', 'unconfigured-1', () => {});
    assert.equal(r.placed, 0);
    assert.match(r.error ?? '', /not configured/);
  } finally {
    if (before) process.env.TWILIO_ACCOUNT_SID = before;
  }
});

test('the route schedules the repeat with `after`, not a bare timer', () => {
  // On Vercel the invocation can be frozen the instant it responds, so a setTimeout in a
  // route handler may never fire — and the failure is silent: the first call still goes and
  // the log still reads as though the alarm worked.
  const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
  const call = route.match(/await alarmCall\([\s\S]{0,200}?\);/);
  assert.ok(call, 'the route still places an alarm call');
  assert.match(call[0], /\(task\) => after\(task\)/, 'the repeat must be scheduled with after()');
  assert.match(route, /^import \{[^}]*\bafter\b[^}]*\} from 'next\/server';/m);
  // `after` runs inside the invocation's budget, so the ceiling has to clear the 45s gap.
  const m = route.match(/export const maxDuration = (\d+)/);
  assert.ok(m && Number(m[1]) >= 60, 'maxDuration must outlast the repeat gap');
});
