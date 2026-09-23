/**
 * BOT EVENTS (migration 075): allow-listed kind, capped detail, NUL-free text, and a route
 * that actually stores them.
 *
 * REAL-DB for the round trip, because the write is one INSERT with a `::jsonb` cast and the
 * `[object Object]` bug that switched the memory series off for ten minutes lived in exactly
 * that shape — a mock would have passed it. Structural for the route: the danger is the
 * `body.event` branch being dropped or moved below the hold work, and no behavioural test
 * can drive a Next route handler from here.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import {
  recordBotEvent, recentBotEvents, cleanText, cleanDetail, eventKind,
  MAX_TEXT_CHARS, MAX_DETAIL_CHARS, BOT_EVENT_KINDS,
} from '../src/lib/bot-events';

const SENTINEL = `__tbe-${process.pid}-${Date.now()}`;
after(async () => {
  await mutate(`DELETE FROM bot_events WHERE source = $1`, [SENTINEL]).catch(() => {});
});

test('the kind is allow-listed — anything else stores as NULL, never as what the caller sent', () => {
  assert.equal(eventKind('ramp-scan'), 'ramp-scan');
  assert.equal(eventKind('tab-close'), 'tab-close');
  assert.equal(eventKind('<script>'), null);
  assert.equal(eventKind(42), null);
  assert.equal(eventKind('request-counts'), 'request-counts');
  assert.equal(eventKind('cart-burst'), 'cart-burst');
  assert.equal(eventKind('recgov-cart'), 'recgov-cart');
  // BY VALUE ON PURPOSE, so adding a kind is a DECISION rather than a drift. `cart-burst`
  // was taken deliberately on 2026-09-17: the 08:00 fast lane had never once been observed
  // running, because its summary lived in a field the slow lane overwrote and in a log that
  // rolls in thirteen minutes. src/lib/cart-burst-record.test.mts carries that account.
  //
  // `recgov-cart` on 2026-09-23, for the same reason one table along: the rec.gov cart bot
  // ran a bounded RETRY ladder from that day, and the netlog that says WHY an add did not
  // take existed only in a box console that rolls in ~89 minutes — so the question was
  // unanswerable ten hours after a real job gave up on a site that was still open.
  // src/lib/autocart-cart-retry.test.mts carries that account.
  //
  // AND NOTE WHAT THIS COSTS, BECAUSE IT IS NOT OBVIOUS FROM HERE: the kind list lives in
  // `src/lib/bot-events.ts`, which is NOT in `worker-deploy.yml`'s `paths:` — but this guard
  // lives under `worker/**`, which is the FIRST entry in that list. So adding a kind fires a
  // worker deploy and restarts all three pollers, however web-side the change looks. That is
  // the trap `docs/LANES.md` records twice; it is stated here so the next person reads it
  // before writing "no worker deploy" in a PR body.
  assert.deepEqual([...BOT_EVENT_KINDS].sort(),
    ['cart-burst', 'mem-dump', 'ramp-scan', 'recgov-cart', 'request-counts', 'tab-close']);
});

test('text loses every control character except newline and tab, and is capped', () => {
  assert.equal(cleanText('a\u0000b\r\nc\td\u001b[0m'), 'ab\nc\td[0m');
  assert.equal(cleanText(''), null);
  assert.equal(cleanText(123), null);
  const big = cleanText('x'.repeat(MAX_TEXT_CHARS + 10))!;
  assert.ok(big.length < MAX_TEXT_CHARS + 100);
  assert.match(big, /truncated at/);
});

test('detail is a plain object under the cap, stringified HERE — never an array, string or oversize blob', () => {
  assert.equal(cleanDetail({ a: 1 }), '{"a":1}');
  assert.equal(cleanDetail([1, 2]), null);
  assert.equal(cleanDetail('{"a":1}'), null);
  assert.equal(cleanDetail({}), null);
  assert.equal(cleanDetail({ big: 'x'.repeat(MAX_DETAIL_CHARS) }), null);
});

test('round trip: a ramp-scan event with a NUL in its text is stored and read back clean', async () => {
  await recordBotEvent(
    { kind: 'ramp-scan', detail: { rcMb: 3500, complete: true }, text: 'OS commitUsedMB=46000\u0000\nEND' },
    SENTINEL,
  );
  // `includeFixtures` because this suite's own rows ARE fixtures — the sentinel is
  // `__`-prefixed, which is exactly what the readout now excludes.
  const rows = (await recentBotEvents('ramp-scan', 1, 200, { includeFixtures: true }))
    .filter((r) => r.source === SENTINEL);
  assert.equal(rows.length, 1, 'stored — a NUL that reached Postgres would have thrown and stored nothing');
  assert.equal(rows[0].kind, 'ramp-scan');
  assert.deepEqual(rows[0].detail, { rcMb: 3500, complete: true }, 'jsonb came back as an object, not "[object Object]"');
  assert.equal(rows[0].text, 'OS commitUsedMB=46000\nEND');
});

test('round trip: a tab-close event with no text stores NULL text and its detail intact', async () => {
  await recordBotEvent(
    { kind: 'tab-close', detail: { label: 'renewal', tripMs: 61000, closeMs: 40, hung: false } },
    SENTINEL,
  );
  const rows = (await recentBotEvents('tab-close', 1, 500, { includeFixtures: true }))
    .filter((r) => r.source === SENTINEL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, null);
  assert.equal((rows[0].detail as Record<string, unknown>).hung, false);
});

test('an unknown kind is stored with kind NULL, so it is visible as garbage and never as a reading', async () => {
  await recordBotEvent({ kind: 'not-a-kind', detail: { x: 1 } }, SENTINEL);
  const rows = await query<{ kind: string | null }>(
    `SELECT kind FROM bot_events WHERE source = $1 AND detail->>'x' = '1'`, [SENTINEL],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, null);
});

// ── THE ROUTE ────────────────────────────────────────────────────────────────────────────

test('the rc-holds route records body.event BEFORE the hold work, like the memory sample', () => {
  const src = readFileSync(new URL('../src/app/api/auto-cart/rc-holds/route.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /import \{ recordBotEvent \} from '@\/lib\/bot-events';/);
  const ev = code.indexOf("if (body?.event && typeof body.event === 'object') {");
  assert.ok(ev > -1, 'the branch exists');
  const block = code.slice(ev, ev + 400);
  assert.match(block, /await recordBotEvent\(body\.event, typeof body\.source === 'string' \? body\.source : null\);/);
  assert.match(block, /state: 'event-recorded'/);
  const claim = code.indexOf("if (typeof body?.updateClaim === 'string') {");
  assert.ok(claim > ev, 'returns before the update claim and the hold work — at 08:00:00 nothing goes in front of a cart');
});

/**
 * THE READOUT MUST NOT SHOW TEST ROWS — and until 2026-09-21 it did.
 *
 * `npm test` writes real `bot_events` rows against the production database on purpose.
 * Every suite that does names itself with a `__`-prefixed sentinel so its cleanup can find
 * them again, and a suite KILLED before that cleanup runs — a cancelled CI twin, which
 * happens on every push to a branch with a PR open — leaves them behind for ever.
 *
 * `bot-events-readout.mts` is the leak investigation's primary instrument, so a stray
 * `ramp-scan` or `cart-burst` row there is indistinguishable from a measurement. The
 * suites above never noticed because they filter on their own sentinel and so were never
 * reading the unfiltered result.
 */
test('a fixture row is invisible to the readout and visible to its own suite', async () => {
  const kind = 'ramp-scan';
  await recordBotEvent({ kind, detail: { probe: 'source-filter' } }, SENTINEL);

  const asReadout = await recentBotEvents(kind, 1, 500);
  assert.equal(asReadout.filter((r) => r.source === SENTINEL).length, 0,
    'the default read must not carry a __-prefixed fixture row');

  const asSuite = await recentBotEvents(kind, 1, 500, { includeFixtures: true });
  assert.ok(asSuite.some((r) => r.source === SENTINEL),
    'and a suite asking for its own rows must still get them');
});

/**
 * THE UNDERSCORE IS A WILDCARD, WHICH IS THE WHOLE REASON FOR THE `ESCAPE` CLAUSE.
 *
 * Unescaped, `'__%'` matches ANY source of two or more characters — i.e. every real bot
 * row — and the readout would come back empty. An empty readout reads as "the bot did
 * nothing", which is this file's own subject: an absence rendered as a fact.
 *
 * ASSERTED AGAINST POSTGRES, WITHOUT WRITING A ROW. The obvious version of this test
 * inserts an event with a short real-looking source like 'rc' and reads it back — and that
 * row is indistinguishable from a real bot event in the very readout this change exists to
 * clean up, for ever if the suite is killed before its cleanup (which is the exact scenario
 * being guarded). A test for "fixtures must not pollute the readout" must not pollute the
 * readout. The predicate is what matters and Postgres can be asked about it directly.
 */
test('a real two-character source is not swallowed by the wildcard', async () => {
  // TWO HALVES, AND THE FIRST ONE ALONE PROVED NOTHING. This test originally asserted the
  // semantics with LITERALS — `'rc' NOT LIKE '__%'` — which is a true statement about
  // Postgres and says nothing whatever about OUR query. Deleting the ESCAPE clause from
  // `recentBotEvents` was a mutation that survived it completely. Verified, then fixed.
  //
  // So: assert the semantics (why it matters) AND the source (that we actually do it).
  const [row] = await query<{ escaped: boolean; unescaped: boolean }>(
    `SELECT ('rc' NOT LIKE '\\_\\_%' ESCAPE '\\') AS escaped,
            ('rc' NOT LIKE '__%')                   AS unescaped`,
  );
  assert.equal(row.escaped, true, "'rc' must survive the escaped predicate");
  assert.equal(row.unescaped, false,
    'and the unescaped form must be shown to swallow it, or this proves nothing');

  // THE QUERY ITSELF. Read from source because `recentBotEvents` cannot be asked what SQL
  // it ran, and a behavioural check would have to INSERT a short real-looking source — a
  // row indistinguishable from a real bot event in the very readout this change cleans up,
  // permanently if the suite is killed before cleanup. That is the scenario being guarded,
  // so the test must not create one.
  const src = readFileSync('src/lib/bot-events.ts', 'utf8');
  const fn = src.slice(src.indexOf('export async function recentBotEvents'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/^\s*(\/\/|\*|\/\*)/m.test(body.split('\n').find((l) => l.includes('NOT LIKE')) ?? ''),
    'the predicate must be live code, not a commented-out line');
  assert.match(body, /source NOT LIKE '\\_\\_%' ESCAPE '\\'/,
    'the query must escape both underscores AND name the escape character — without it, '
    + "'__%' matches every source of two or more characters and the readout comes back "
    + 'empty, which reads as "the bot did nothing"');
});
