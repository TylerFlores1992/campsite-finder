/**
 * "Auto-cart is on but not connected" — who gets told, and who is missed.
 *
 * THE GAP THIS EXISTS FOR. The nudge shipped with two triggers: the enrollment route on
 * a live connection DYING (event-driven), and a daily cron for someone who NEVER
 * connected. Between them sits the state that actually costs a campsite — connected once,
 * dead ever since — and on 2026-08-11 the one account it was written for was in exactly
 * that state and reachable by neither path: iamtylerflores12345@yahoo.com, verified
 * 2026-07-29, `connected=false`, thirteen days, no future transition to fire on because
 * the transition had already happened unobserved.
 *
 * The SQL is asserted rather than executed because these rows are live users: a test that
 * mails real people to prove it can mail real people is not a test worth having. What is
 * checked is the predicate — that is where the gap was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cron = readFileSync('src/app/api/cron/autocart-nudge/route.ts', 'utf8');
const enrollment = readFileSync('src/app/api/auto-cart/enrollment/route.ts', 'utf8');
const migrations = readFileSync('src/lib/db/migrations/052_autocart_nudge.sql', 'utf8');

test('the sweep catches a connection that lapsed, not only one that never existed', () => {
  // The original predicate was `autocart_verified_at IS NULL` — never connected, full
  // stop. A user with a verified_at from an earlier success was excluded by construction.
  assert.match(cron, /autocart_verified_at IS NOT NULL/,
    'the previously-connected case must be in scope');
  assert.match(cron, /autocart_verified_at < NOW\(\) - /,
    'and it is judged on how long the connection has been dead');
});

test('both shapes are still distinguished, and reported apart', () => {
  // "Never finished signing up" and "was working and stopped" are different faults with
  // different fixes. Collapsing them into one total is how thirteen days of the second
  // hid behind zero of the first.
  assert.match(cron, /'never-connected'/);
  assert.match(cron, /byShape/, 'the run reports them separately');
});

test('a brief blip does not generate an email', () => {
  // The keepalive runs every 30 minutes and can now repair the session from a saved
  // password by itself. Mailing on the first failed check would tell people to go and fix
  // something that fixes itself — and an email nobody needed is how a useful one starts
  // getting ignored.
  const m = cron.match(/AUTOCART_LAPSED_HOURS \|\| (\d+)/);
  assert.ok(m, 'the delay must be a named, overridable constant');
  assert.ok(Number(m[1]) >= 24, `${m[1]}h is too eager for a connection that self-repairs`);
});

test('the nudge flag resets on a genuine reconnect', () => {
  // Otherwise it latches and the email is once-per-account-forever: reconnect today,
  // lapse again in three months, hear nothing. Same rule as the claim's `nudged_at`.
  assert.match(
    enrollment,
    /autocart_nudge_sent_at = CASE WHEN \$2 IS TRUE THEN NULL ELSE autocart_nudge_sent_at END/,
    'a confirmed live connection clears the flag',
  );
});

test('sending is still gated on entitlement and on not having sent already', () => {
  // A lapsed subscriber must never be nagged about a plan they no longer pay for — the
  // "a subscriber is never sold to" rule, pointed the other way.
  assert.match(cron, /hasAutocartEntitlement/);
  assert.match(cron, /autocart_nudge_sent_at IS NULL/, 'one email per lapse, not per day');
});

test('the migration is 052, because 051 is taken', () => {
  // 051 is bot_update_requests, applied to production on 2026-08-10. A runner tracking
  // applied migrations by number would consider this one done and skip it silently, and
  // /api/user/autocart would 500 against columns that never got created.
  assert.match(migrations, /autocart_enabled_at/);
  assert.match(migrations, /autocart_nudge_sent_at/);
  for (const f of [cron, enrollment]) {
    assert.ok(!/migration 051/i.test(f), 'no stale reference to the old number');
  }
});
