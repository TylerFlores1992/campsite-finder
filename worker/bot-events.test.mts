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
  MAX_TEXT_CHARS, MAX_DETAIL_CHARS, BOT_EVENT_KINDS, NOT_A_FIXTURE_SQL,
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
 * THE FILTER THIS REPLACES HID EVERY REAL ROW FOR THREE DAYS, AND ITS GUARD PASSED THE WHOLE TIME.
 *
 * It was `source NOT LIKE '\_\_%' ESCAPE '\'` with SINGLE backslashes inside a template
 * literal. A template literal drops the backslash from an unknown escape like `\_`, so Postgres
 * received `'__%' ESCAPE ''` — which matches every source of two or more characters, i.e. every
 * real bot row — and `bot-events-readout.mts` printed "none in this window" from 2026-09-21 to
 * 2026-09-24 over a table holding 102 rows in 72 hours. Two guards passed throughout:
 *
 *   - the one below it asserted a REGEX over the SOURCE TEXT, which did contain the backslashes.
 *     It checked what was written, not what ran. The guard-anchored-on-the-wrong-thing shape,
 *     with the anchor one layer of string processing away from the subject;
 *   - 'a fixture row is invisible to the readout' passed VACUOUSLY — every row was invisible.
 *
 * So both replacements run the REAL STRING. The first evaluates the exported predicate against
 * literal sources; the second compares the readout's default read with the suite's unfiltered
 * one over REAL production rows, which is the property the readout exists for: it must show the
 * bot's rows, not merely hide the test's. Neither writes a real-looking row — the reason the
 * original was written against source text at all, and still a good reason.
 */
test('the fixture predicate, as it actually runs, keeps real sources and drops sentinels', async () => {
  const rows = await query<{ source: string | null; kept: boolean }>(
    `SELECT source, ${NOT_A_FIXTURE_SQL} AS kept
       FROM (VALUES ('rc'), ('rc-keepwarm'), ('recgov-bot'), ('_x'), ('__tbe-1'), (NULL::text)) AS v(source)`,
  );
  const kept = Object.fromEntries(rows.map((r) => [String(r.source), r.kept]));
  assert.equal(rows.length, 6, 'every probe source must come back — a short read proves nothing');
  assert.equal(kept.rc, true, "a two-character real source must survive (the wildcard's victim)");
  assert.equal(kept['rc-keepwarm'], true, 'the box\'s real source must survive');
  assert.equal(kept['recgov-bot'], true, 'the rec.gov bot\'s real source must survive');
  assert.equal(kept._x, true, 'one leading underscore is not the sentinel prefix');
  assert.equal(kept['__tbe-1'], false, 'a __-prefixed fixture must be dropped');
  assert.equal(kept.null, true, 'an absent source is not evidence of a fixture');
});

test('the readout returns every real production row the suite can see — not zero', async () => {
  // Against real rows on purpose: this is the property that was broken, and a fixture cannot
  // stand in for it without being exactly the pollution this filter exists to prevent. The
  // window is wide so that the production table always has real rows in it; if it genuinely
  // has none, the first assertion says so rather than letting the comparison pass as 0 === 0.
  const kind = 'tab-close';
  const hours = 24 * 90;
  const all = await recentBotEvents(kind, hours, 5000, { includeFixtures: true });
  const realExpected = all.filter((r) => !(r.source ?? '').startsWith('__')).length;
  assert.ok(realExpected > 0,
    `no real ${kind} rows in ${hours}h — this comparison would pass vacuously, so it refuses to`);
  const asReadout = await recentBotEvents(kind, hours, 5000);
  assert.equal(asReadout.length, realExpected,
    `the readout saw ${asReadout.length} of ${realExpected} real ${kind} rows. An empty readout reads as ` +
      '"the bot did nothing" — which is what it printed for three days.');
});
