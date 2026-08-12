/**
 * TWILIO CREDENTIALS ARE READ TRIMMED, IN EXACTLY ONE PLACE.
 *
 * On 2026-08-12 `scripts/sms-link-test.mts` failed all four sends with Twilio's
 * `Authentication Error - invalid username`. That message names the *username* — the
 * Account SID — so it reads as a wrong, revoked or mistyped credential, and the obvious
 * next move is to go asking for the SID again. The SID was correct. It simply arrived with
 * a **leading space**: 35 characters where `AC` + 32 hex is 34. Nothing trimmed, so the
 * space went into the basic-auth header and Twilio rejected it.
 *
 * The lost run is the cheap half. The same untrimmed read guarded `/api/webhooks/twilio`,
 * which verifies each delivery receipt against `TWILIO_AUTH_TOKEN` and **fails CLOSED**. A
 * padded token there 403s 100% of carrier callbacks — every message sits `sent` with no
 * `delivery_status`, which is exactly the blindness migration 038 exists to end, and shows
 * on the admin panel as "all pending, no answers", i.e. the signature for a broken callback
 * URL. The investigation would have gone somewhere else entirely.
 *
 * A credential differing from the real one by one invisible character is the same family as
 * `notifications.status = 'sent'` meaning only "Twilio returned 2xx": the broken path and
 * the healthy one produce indistinguishable output.
 *
 * The scan is the load-bearing half. Six call sites were correct after the fix; the point
 * is that the SEVENTH cannot reintroduce it, and that is invisible by reading any one file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  twilioAccountSid,
  twilioAuthToken,
  twilioFromNumber,
  twilioMessagingServiceSid,
} from '../src/lib/notifications/twilio-env.ts';

const VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'TWILIO_MESSAGING_SERVICE_SID',
] as const;

/** Set the four vars around one assertion, restoring whatever was really there. */
function withEnv(values: Partial<Record<(typeof VARS)[number], string>>, fn: () => void) {
  const before = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  try {
    for (const v of VARS) {
      if (values[v] === undefined) delete process.env[v];
      else process.env[v] = values[v]!;
    }
    fn();
  } finally {
    for (const v of VARS) {
      if (before[v] === undefined) delete process.env[v];
      else process.env[v] = before[v]!;
    }
  }
}

test('a padded credential is trimmed, not passed through', () => {
  // The exact shape that failed: a leading space, which no editor and no `echo` shows.
  withEnv(
    {
      TWILIO_ACCOUNT_SID: ' AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: ' 00000000000000000000000000000000\n',
      TWILIO_FROM_NUMBER: '  +15550001111  ',
      TWILIO_MESSAGING_SERVICE_SID: '\tMG00000000000000000000000000000000 ',
    },
    () => {
      assert.equal(twilioAccountSid(), 'AC00000000000000000000000000000000');
      assert.equal(twilioAuthToken(), '00000000000000000000000000000000');
      assert.equal(twilioFromNumber(), '+15550001111');
      assert.equal(twilioMessagingServiceSid(), 'MG00000000000000000000000000000000');
    },
  );
});

test('whitespace-only reads as ABSENT, not as configured', () => {
  // `'   '` is truthy. Untrimmed it passes every `!accountSid` guard and then fails at the
  // API — "configured but broken", which is the worst of the three states because the
  // not-configured path is the one that reports honestly.
  withEnv({ TWILIO_ACCOUNT_SID: '   ', TWILIO_AUTH_TOKEN: '\n\t ' }, () => {
    assert.equal(twilioAccountSid(), undefined);
    assert.equal(twilioAuthToken(), undefined);
  });
});

test('an unset variable is undefined, not the empty string', () => {
  withEnv({}, () => {
    for (const read of [twilioAccountSid, twilioAuthToken, twilioFromNumber, twilioMessagingServiceSid]) {
      assert.equal(read(), undefined);
    }
  });
});

/** Comments stripped — every rule below is quoted in the note explaining it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(p)) out.push(p);
  }
  return out;
}

test('nothing outside twilio-env reads a TWILIO_ var straight from process.env', () => {
  const OWNER = 'src/lib/notifications/twilio-env.ts';
  const offenders: string[] = [];

  for (const f of [...walk('src'), ...walk('scripts')]) {
    if (f === OWNER) continue;
    const body = code(readFileSync(f, 'utf8'));
    const hits = body.match(/process\.env\.TWILIO_[A-Z_]+/g);
    if (hits) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
  }

  assert.deepEqual(
    offenders,
    [],
    'read Twilio credentials through lib/notifications/twilio-env — an untrimmed value ' +
      'fails authentication in a way that reads as a wrong credential, and silently 403s ' +
      'every delivery receipt at the webhook',
  );
});
