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
  assert.deepEqual([...BOT_EVENT_KINDS].sort(), ['ramp-scan', 'tab-close']);
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
  const rows = (await recentBotEvents('ramp-scan', 1, 200)).filter((r) => r.source === SENTINEL);
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
  const rows = (await recentBotEvents('tab-close', 1, 500)).filter((r) => r.source === SENTINEL);
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
