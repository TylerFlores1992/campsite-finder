/**
 * Two real-DB tests flaked on 2026-08-11 with `DB mutate error: DNS resolution failure`,
 * and both times the response was to re-run and shrug. That habit is how a genuine
 * regression gets waved through, so the transport failure is handled where it happens
 * instead of in the reader's head.
 *
 * ── THE DANGEROUS HALF ─────────────────────────────────────────────────────────────────
 * A retry is only free for something that can be done twice. `query` goes to `exec_select`,
 * which refuses anything data-modifying, so a read may be repeated after any network
 * failure. `mutate` may not: if the statement reached Postgres and the ANSWER was lost, a
 * repeat is a duplicate row or a double increment — a wrong number that nothing reports.
 *
 * So the split is by what the message PROVES, not by how transient it feels:
 *   - name never resolved / connection refused  -> nothing was sent, safe for both
 *   - socket died, timed out, `fetch failed`    -> may have run, reads only
 *
 * `fetch failed` is the one worth arguing about. Undici raises it for DNS failures too,
 * but supabase-js hands us `error.message` alone with the `cause` already gone — so it is
 * indistinguishable from a socket that died mid-statement, and the ambiguous case has to
 * be treated as the dangerous one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableDbError } from '../src/lib/db/client.js';

const READ = { idempotent: true };
const WRITE = { idempotent: false };

test('the error that actually flaked is retried, for reads and writes alike', () => {
  // Verbatim from the failing run: `DB mutate error: DNS resolution failure`.
  assert.equal(isRetryableDbError('DNS resolution failure', WRITE), true);
  assert.equal(isRetryableDbError('DNS resolution failure', READ), true);
});

test('errors that prove the statement was never sent are retried on a write', () => {
  for (const msg of [
    'getaddrinfo EAI_AGAIN db.supabase.co',
    'getaddrinfo ENOTFOUND db.supabase.co',
    'connect ECONNREFUSED 10.0.0.1:443',
  ]) {
    assert.equal(isRetryableDbError(msg, WRITE), true, `${msg} should be retried`);
  }
});

test('errors that MIGHT have executed are retried on a read and never on a write', () => {
  // Each of these is compatible with Postgres having committed the statement and the
  // reply being lost on the way back.
  for (const msg of [
    'TypeError: fetch failed',
    'read ECONNRESET',
    'connect ETIMEDOUT 10.0.0.1:443',
    'socket hang up',
    'request timed out',
  ]) {
    assert.equal(isRetryableDbError(msg, READ), true, `${msg} is safe to repeat as a read`);
    assert.equal(isRetryableDbError(msg, WRITE), false,
      `${msg} may already have run — repeating it writes twice`);
  }
});

test('a real database error is never retried', () => {
  // Retrying these buys nothing and costs the backoff on every failing statement — the
  // cheapest way to make a broken query look like a slow one.
  for (const msg of [
    'syntax error at or near "CREATE"',
    'duplicate key value violates unique constraint "watch_site_alerts_pkey"',
    'permission denied for table users',
    'null value in column "location" violates not-null constraint',
  ]) {
    assert.equal(isRetryableDbError(msg, READ), false, `${msg} must not be retried`);
    assert.equal(isRetryableDbError(msg, WRITE), false, `${msg} must not be retried`);
  }
});

test('a write failure carrying the word "timeout" in DATA is still not retried', () => {
  // The classifier reads a message that can contain arbitrary text from the row being
  // written. It must not become retryable because a campground description says so — the
  // patterns are anchored to transport wording, and this pins that they stay that way.
  const msg = 'duplicate key value violates unique constraint "sms_timeout_idx"';
  assert.equal(isRetryableDbError(msg, WRITE), false);
  assert.equal(isRetryableDbError(msg, READ), false,
    'the transport patterns must match transport wording, not a substring of a table name');
});
