/**
 * THE CANCELLATION BADGE — one definition, and it has to see BOTH of Stripe's fields.
 *
 * ## The bug
 *
 * Stripe expresses a pending cancellation two ways and they are independent: a non-null
 * `cancel_at` does NOT imply `cancel_at_period_end`. Three separate gates read the flag
 * alone — the user list, the user detail page and the dashboard's churn count — so they
 * agreed with each other and were all wrong about the same person.
 *
 * Measured 2026-09-23 across the whole table: exactly one row carries a `cancel_at`, it is
 * `active`, and its flag is **false**. One real churn, invisible in all three places.
 *
 * ## Why this is mostly a STRUCTURAL test
 *
 * The rule is a SQL fragment, so there is no function to call and no way to unit-test the
 * predicate directly. What can be pinned is that there is exactly ONE definition and that
 * every gate goes through it — which is the property that actually failed. A fourth gate
 * added later reading `cancel_at_period_end` on its own fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANCELLING } from '../app/admin/users/queries.ts';

const QUERIES = 'src/app/admin/users/queries.ts';
const DASH = 'src/app/admin/page.tsx';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

test('the definition reads BOTH Stripe fields, not just the flag', () => {
  const sql = CANCELLING();
  assert.match(sql, /cancel_at_period_end/, 'the flag must still count');
  assert.match(sql, /cancel_at IS NOT NULL/,
    'a DATED cancellation with the flag false is the case that was invisible');
  // OR, not AND. Requiring both would reproduce the bug with extra steps.
  assert.match(sql, /\bOR\b/, 'either field alone means cancelling');
});

test('COALESCE guards the flag, because NULL is not false in SQL', () => {
  // `WHERE NULL` is not false, it is unknown, and `NOT NULL` is unknown too — a bare
  // column reference in a boolean position silently drops rows either way.
  assert.match(CANCELLING(), /COALESCE\([a-z]+\.cancel_at_period_end, false\)/);
});

test('a DEAD row can never read as cancelling', () => {
  // A cancelled subscription keeps whatever killed it, and nearly always has a
  // `cancel_at` — so widening to the second field makes this MORE dangerous, not less.
  // The liveness check lives inside the definition so no caller has to remember it.
  assert.match(CANCELLING(), /status IN \('active','trialing'\)/,
    'the definition must exclude dead rows itself');
  assert.match(CANCELLING(), /status IN[\s\S]*AND[\s\S]*cancel_at/,
    'liveness must gate the cancellation fields, not sit beside them');
});

test('the alias is a parameter, so one definition serves every caller', () => {
  assert.match(CANCELLING('s'), /\bs\.cancel_at_period_end\b/);
  assert.match(CANCELLING(), /\bsub\.cancel_at_period_end\b/, 'the LIVE_SUB lateral is the default');
  assert.ok(!CANCELLING('s').includes('sub.'), 'an explicit alias must not leak the default');
});

// ── the wiring, which is the part that regressed ────────────────────────────────────

test('EVERY gate goes through the one definition — no gate reads the flag directly', () => {
  // THIS IS THE REAL GUARD. `CANCELLING` can be perfect while a fourth call site reads
  // `cancel_at_period_end` on its own, which is precisely how three gates came to agree
  // and all be wrong.
  //
  // IT FAILED ON ITS FIRST RUN AGAINST CORRECT CODE, and the reason is worth keeping: it
  // matched `COALESCE([a-z]+\.cancel_at_period_end` — the EVALUATED form — while scanning
  // SOURCE, where the definition reads `COALESCE(${t}.cancel_at_period_end`. A guard
  // anchored on the wrong representation of its own subject, in the file whose subject is
  // gates that quietly disagree. The two forms are now asserted separately and by name.
  const q = code(QUERIES);
  const reads = [...q.matchAll(/cancel_at_period_end/g)].length;
  const definition = [...q.matchAll(/COALESCE\(\$\{t\}\.cancel_at_period_end, false\)/g)].length;
  // LIVE_SUB SELECTs the raw columns so `sub.` has them to gate on. A projection, not a
  // gate — matched by its own shape so it cannot cover for a real one.
  const projection = [...q.matchAll(/s\.cancel_at_period_end, s\.cancel_at/g)].length;
  assert.equal(definition, 1, 'there must be exactly ONE definition');
  assert.equal(projection, 1, 'and exactly one LIVE_SUB projection');
  assert.equal(reads, definition + projection,
    `${QUERIES} reads cancel_at_period_end ${reads} times but only ${definition + projection} ` +
    'are accounted for — the extra is a fourth gate, and it will disagree with the others');

  // The dashboard must not read the column at all any more; it imports the definition.
  assert.equal([...code(DASH).matchAll(/cancel_at_period_end/g)].length, 0,
    `${DASH} must reach the rule through CANCELLING, never by naming the column`);
});

test('the dashboard count and the user rows cannot drift apart', () => {
  const q = code(QUERIES), d = code(DASH);
  assert.equal([...q.matchAll(/\$\{CANCELLING\(\)\}/g)].length, 2,
    'both user queries must use it');
  assert.match(d, /\$\{CANCELLING\('s'\)\}/, 'the churn count must use it too');
  assert.match(d, /from '\.\/users\/queries'/, 'and import it rather than restate it');
});
