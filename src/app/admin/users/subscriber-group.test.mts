/**
 * THE SUBSCRIBERS LIST PUTS EACH PERSON IN THE RIGHT GROUP — above all, Cancelling.
 *
 * The one real cancelling subscriber (measured 2026-09-23) has a `cancel_at` and a FALSE
 * `cancel_at_period_end`. Any grouping that reads the flag alone files them under Active,
 * which is the bug the admin page already had once. So this runs the REAL `CANCELLING`
 * SQL against Postgres over inline VALUES — no table is read or written — and feeds each
 * answer through the REAL `subscriberGroup`, so both halves of the chain are exercised.
 *
 * Under `src/` rather than `worker/`: `worker/**` is the first `paths:` entry in
 * worker-deploy.yml, and a guard over an admin page must not restart the pollers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query } from '@/lib/db/client';
import { CANCELLING } from '@/app/admin/users/queries';
import { subscriberGroup, sourceLabel } from '@/app/admin/users/subscriber-group';

const code = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*|--)/.test(l))
    .join('\n');

test('cancelling outranks the status — a cancelling subscriber is still `active`', () => {
  assert.equal(subscriberGroup({ status: 'active', cancelling: true }), 'cancelling');
  assert.equal(subscriberGroup({ status: 'trialing', cancelling: true }), 'cancelling');
});

test('trialing is a subscriber, not lapsed and not folded into active', () => {
  assert.equal(subscriberGroup({ status: 'trialing', cancelling: false }), 'trialing');
  assert.equal(subscriberGroup({ status: 'active', cancelling: false }), 'active');
});

test('everything not live is lapsed — including statuses we have never seen', () => {
  for (const status of ['canceled', 'expired', 'past_due', 'unpaid', 'incomplete', 'something_new', null]) {
    assert.equal(subscriberGroup({ status, cancelling: false }), 'lapsed', String(status));
  }
});

test('an unknown provider is shown verbatim, never guessed', () => {
  assert.equal(sourceLabel('stripe'), 'Web (Stripe)');
  assert.equal(sourceLabel('apple'), 'App Store (RevenueCat)');
  assert.equal(sourceLabel('google'), 'Google Play (RevenueCat)');
  assert.equal(sourceLabel('amazon'), 'amazon');
  assert.equal(sourceLabel(null), 'unknown');
});

test('EITHER cancel field makes a live row Cancelling — run as real SQL', async () => {
  // [status, flag, cancel_at, expected group]
  const cases: Array<[string, boolean | null, string | null, string]> = [
    ['active', false, '2026-10-08T14:38:01Z', 'cancelling'], // THE invisible one: date, flag off
    ['active', true, null, 'cancelling'],                    // flag, no date
    ['active', true, '2026-10-08T14:38:01Z', 'cancelling'],  // both
    ['trialing', false, '2026-10-08T14:38:01Z', 'cancelling'],
    ['active', false, null, 'active'],                       // neither
    ['active', null, null, 'active'],                        // NULL flag is not a NULL answer
    ['trialing', false, null, 'trialing'],
    ['canceled', true, '2026-01-01T00:00:00Z', 'lapsed'],    // a dead row keeps its fields
    ['expired', false, '2026-01-01T00:00:00Z', 'lapsed'],
  ];
  const values = cases
    .map(
      ([st, flag, at], i) =>
        `(${i}, '${st}', ${flag === null ? 'NULL::boolean' : String(flag)}, ${at ? `'${at}'::timestamptz` : 'NULL::timestamptz'})`,
    )
    .join(', ');
  const rows = await query<{ i: number; status: string; cancelling: boolean | null }>(
    `SELECT s.i, s.status, ${CANCELLING('s')} AS cancelling
       FROM (VALUES ${values}) AS s(i, status, cancel_at_period_end, cancel_at)
      ORDER BY s.i`,
  );
  assert.equal(rows.length, cases.length, 'every case must come back — a short result proves nothing');
  for (const r of rows) {
    const [st, flag, at, want] = cases[r.i];
    assert.equal(typeof r.cancelling, 'boolean', `case ${r.i}: CANCELLING returned ${r.cancelling}, not a boolean`);
    assert.equal(
      subscriberGroup({ status: r.status, cancelling: r.cancelling === true }),
      want,
      `status=${st} flag=${flag} cancel_at=${at}`,
    );
  }
});

test('the list and the history reach the ONE definition, not the columns', () => {
  const src = code('src/app/admin/users/subscribers.ts');
  assert.equal((src.match(/\$\{CANCELLING\('s'\)\}/g) ?? []).length, 2,
    'both the list and the per-user history must compute `cancelling` through CANCELLING.');
  // The history also projects the raw flag so a disagreement is VISIBLE — that is the
  // only other read allowed, and it must not be the one deciding the group.
  assert.equal((src.match(/\b[a-z]\.cancel_at_period_end/g) ?? []).length, 1,
    'the SQL may name cancel_at_period_end once, for the displayed flag — a second read is a second gate.');
  assert.match(src, /COALESCE\(s\.cancel_at_period_end, false\) AS cancel_flag/);
});

test('the section is rendered, and every state carries a shape and a word', () => {
  const tabs = code('src/components/admin/AdminTabs.tsx');
  assert.match(tabs, /<SubscribersBox data=\{data\.subscribers\} \/>/, 'computed and never rendered is the inert shape.');
  const box = code('src/components/admin/SubscribersBox.tsx');
  assert.match(box, /<StatusMark level=\{GROUP_LEVEL\[s\.group\]\} label=\{statusWord\(s\)\} \/>/);
  const detail = code('src/app/admin/users/[id]/page.tsx');
  assert.match(detail, /hasAutocartEntitlement\(user\.id\)/, 'entitlement must come from lib/auth itself.');
  assert.match(detail, /unresolved: \{ level: 'warn', word: 'Unresolved' \}/,
    'an unresolved hold must read as unresolved, never as won or lost.');
});
