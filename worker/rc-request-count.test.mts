/**
 * THE RESIDENT PAGE'S REQUEST COUNTER — see scripts/auto-cart-bot/rc-request-count.mjs.
 *
 * The 2026-09-04 ramp scan put ~35 GB of untouched shared-section commit on a renderer holding
 * 18,705 handles and could not say what created them; a per-request data pipe in a request
 * LOOP fits, and nothing had ever counted the resident page's requests. These guards pin the
 * two halves that make the counter a reading rather than a hazard: what it records (paths
 * only — never a query, which is where Okta's exchangeable `code=` lives; never a body) and
 * that the keep-warm actually ATTACHES it, prints it where a ramp ends, and posts it under a
 * kind the server allow-lists. A counter that is perfect and inert is the shape this repo has
 * paid for six times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRequestCounter, describeRequestCounts, OTHER_KEY, REQUEST_MAX_PATHS, REQUEST_WINDOW_MS,
} from '../scripts/auto-cart-bot/rc-request-count.mjs';
import { BOT_EVENT_KINDS } from '../src/lib/bot-events';

const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const KW = strip(readFileSync(new URL('../scripts/auto-cart-bot/rc-keepwarm.mjs', import.meta.url), 'utf8'));
const MOD = strip(readFileSync(new URL('../scripts/auto-cart-bot/rc-request-count.mjs', import.meta.url), 'utf8'));
const READOUT = readFileSync(new URL('../scripts/bot-events-readout.mts', import.meta.url), 'utf8');

const clock = () => {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

test('the key is origin + pathname — the query is never recorded, not even in the snapshot JSON', () => {
  const c = createRequestCounter({ now: clock().now });
  c.record('https://www.reservecalifornia.com/login/callback?code=SECRET-CODE-123&state=xyz');
  c.record('https://www.reservecalifornia.com/login/callback?code=OTHER-CODE&state=abc');
  c.record('https://signin.reservecalifornia.com/oauth2/v1/authorize?prompt=none&client_id=1#frag');
  const s = c.snapshot();
  const json = JSON.stringify(s);
  assert.ok(!json.includes('SECRET-CODE'), 'an OAuth code reached the snapshot');
  assert.ok(!json.includes('prompt=none'), 'a query string reached the snapshot');
  assert.ok(!json.includes('?'), 'no key may carry a query');
  assert.ok(!json.includes('#frag'), 'no key may carry a fragment');
  assert.equal(s.top[0].key, 'https://www.reservecalifornia.com/login/callback');
  assert.equal(s.top[0].lifetime, 2, 'two requests to one path with different queries are ONE key');
  assert.equal(s.top[1].key, 'https://signin.reservecalifornia.com/oauth2/v1/authorize');
});

test('an unparseable URL is recorded as a literal, never raw', () => {
  const c = createRequestCounter({ now: clock().now });
  c.record('not a url with code=SECRET');
  assert.equal(c.snapshot().top[0].key, '(unparseable)');
  assert.ok(!JSON.stringify(c.snapshot()).includes('SECRET'));
});

test('the rolling count forgets, the lifetime count does not', () => {
  const clk = clock();
  const c = createRequestCounter({ now: clk.now, windowMs: 120_000 });
  for (let i = 0; i < 5; i += 1) c.record('https://a.test/x');
  clk.advance(60_000);
  for (let i = 0; i < 3; i += 1) c.record('https://a.test/x');
  let [row] = c.top();
  assert.deepEqual({ recent: row.recent, lifetime: row.lifetime }, { recent: 8, lifetime: 8 });
  clk.advance(61_000);                                   // the first five are now past the window
  [row] = c.top();
  assert.deepEqual({ recent: row.recent, lifetime: row.lifetime }, { recent: 3, lifetime: 8 });
  clk.advance(120_000);
  [row] = c.top();
  assert.deepEqual({ recent: row.recent, lifetime: row.lifetime }, { recent: 0, lifetime: 8 },
    'a quiet page has a zero rolling count and its full lifetime count');
});

test('distinct paths are capped — past the cap everything new folds into <other>, existing keys keep counting', () => {
  const c = createRequestCounter({ now: clock().now, maxPaths: 3 });
  c.record('https://a.test/1');
  c.record('https://a.test/2');
  c.record('https://a.test/3');
  c.record('https://a.test/4');                          // over the cap
  c.record('https://a.test/5');
  c.record('https://a.test/1');                          // an existing key still counts itself
  const s = c.snapshot({ n: 10 });
  assert.equal(s.capped, true);
  const keys = s.top.map((r) => r.key);
  assert.ok(keys.includes(OTHER_KEY), 'the overflow bucket must exist');
  assert.ok(!keys.includes('https://a.test/4') && !keys.includes('https://a.test/5'), 'new paths past the cap are not keys');
  assert.equal(s.top.find((r) => r.key === OTHER_KEY)!.lifetime, 2);
  assert.equal(s.top.find((r) => r.key === 'https://a.test/1')!.lifetime, 2);
  assert.equal(s.distinct, 4, 'three real keys plus <other>');
  assert.ok(REQUEST_MAX_PATHS >= 100 && REQUEST_MAX_PATHS <= 1000, `the production cap ${REQUEST_MAX_PATHS} should be a few hundred`);
});

test('the window is bounded in entries too, and an overflowed count is printed as a LOWER BOUND', () => {
  const c = createRequestCounter({ now: clock().now, windowCap: 10 });
  for (let i = 0; i < 25; i += 1) c.record('https://a.test/loop');
  const s = c.snapshot();
  assert.equal(s.windowOverflowed, true);
  assert.equal(s.recentTotal, 10, 'the window holds its cap');
  assert.equal(s.lifetimeTotal, 25, 'lifetime is unaffected');
  assert.match(describeRequestCounts(c), /≥10 in the last/, 'a loop hot enough to overflow the window is exactly the case this exists for — say the figure is a floor');
});

test('top is ordered by the ROLLING count, then lifetime — a loop that started a minute ago outranks a busy lifetime', () => {
  const clk = clock();
  const c = createRequestCounter({ now: clk.now, windowMs: 120_000 });
  for (let i = 0; i < 50; i += 1) c.record('https://a.test/old-busy');
  clk.advance(180_000);
  for (let i = 0; i < 5; i += 1) c.record('https://a.test/now');
  c.record('https://a.test/old-busy');
  const top = c.top();
  assert.equal(top[0].key, 'https://a.test/now');
  assert.deepEqual([top[0].recent, top[1].recent, top[1].lifetime], [5, 1, 51]);
});

test('attach counts every request the page emits, and a handler that throws never reaches Playwright', () => {
  const handlers: Array<(r: unknown) => void> = [];
  const page = {
    on: (ev: string, h: (r: unknown) => void) => { assert.equal(ev, 'request'); handlers.push(h); },
    off: (_ev: string, h: (r: unknown) => void) => { handlers.splice(handlers.indexOf(h), 1); },
  };
  const c = createRequestCounter({ now: clock().now });
  const detach = c.attach(page);
  assert.equal(handlers.length, 1);
  handlers[0]({ url: () => 'https://a.test/main' });
  handlers[0]({ url: () => 'https://signin.reservecalifornia.com/oauth2/v1/authorize?prompt=none' }); // a subframe request rides the same event
  handlers[0]({ url: () => { throw new Error('gone'); } });   // must not throw out of the handler
  assert.equal(c.snapshot().lifetimeTotal, 2);
  detach();
  assert.equal(handlers.length, 0, 'detach removes the handler');
});

test('describe: an empty counter says so; the compact form is ONE line; the full form is one line per path', () => {
  const c = createRequestCounter({ now: clock().now });
  assert.match(describeRequestCounts(c), /none recorded/);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) c.record(`https://a.test/${k}`);
  const compact = describeRequestCounts(c, { compact: true });
  assert.equal(compact.split('\n').length, 1, 'compact is a single line — it prints on every reopen');
  assert.match(compact, /top: /);
  const full = describeRequestCounts(c);
  assert.equal(full.split('\n').length, 1 + 7, 'one header line plus one line per path');
});

test('the module reads nothing but the URL — no headers, no response body, no query', () => {
  // Do not collect a field you would then have to filter: an OAuth code was published on
  // 2026-08-09 and a password on 08-16, both by collecting something that then had to be
  // scrubbed. The counter has no scrubber because it has nothing to scrub.
  assert.ok(!/headers|\.body\(|response\(|postData|\.search\b|\.href\b/.test(MOD),
    'the counter must never touch headers, bodies, postData, the query or the full href');
  assert.match(MOD, /import \{ safeUrl \} from '\.\/okta-net-trace\.mjs'/, 'ONE normaliser, the net trace\'s — not a second copy');
  assert.match(MOD, /safeUrl\(url\)/, 'and record must actually go through it');
  assert.ok(REQUEST_WINDOW_MS >= 60_000 && REQUEST_WINDOW_MS <= 300_000, 'the window is minutes, matching the ramp arm\'s stall bar');
});

// ── the wiring ─────────────────────────────────────────────────────────────────────────────

test('the counter is attached where residentPage is assigned, so every reopen re-attaches it', () => {
  const at = KW.indexOf('residentPage = page;');
  assert.ok(at > -1, 'the assignment must exist');
  const after = KW.slice(at, at + 300);
  assert.match(after, /requestCounter\.attach\(page\)/,
    'attach must follow the assignment — a counter created and never attached counts nothing and reads as a quiet page');
  const created = KW.indexOf('const requestCounter = createRequestCounter(');
  assert.ok(created > -1 && created > KW.indexOf('async function warmResident'),
    'created inside warmResident, so "lifetime" means the life of THIS browser');
});

test('the bail prints the counts beside the alloc trail and AWAITS the request-counts event inside the bounded race', () => {
  const rb = KW.indexOf('const reportAndBail = (why, tail) => {');
  assert.ok(rb > -1);
  const body = KW.slice(rb, KW.indexOf('bail(tail);', rb));
  const trail = body.indexOf('describeAllocTrail(allocTrail.buffers()');
  const counts = body.indexOf('describeRequestCounts(requestCounter)');
  assert.ok(trail > -1 && counts > trail, 'the counts are printed after the alloc trail, in the same block');
  const race = body.indexOf('await Promise.race([');
  const post = body.indexOf("reportBotEvent('request-counts', requestCounter.snapshot({ reason: 'bail' }))");
  const timeout = body.indexOf('setTimeout(r, 4000)');
  assert.ok(race > -1 && post > race && timeout > post,
    'the POST must sit inside the awaited, bounded race — process.exit kills an unawaited POST and an unbounded one holds the profile lock');
});

test('the teardown prints ONE compact line and posts under reason teardown, inside the bounded flush', () => {
  const fin = KW.indexOf('} finally {', KW.indexOf('async function warmResident'));
  assert.ok(fin > -1);
  const body = KW.slice(fin, KW.indexOf('await ctx?.close()', fin));
  assert.match(body, /describeRequestCounts\(requestCounter, \{ compact: true \}\)/,
    'the teardown fires on every reopen into a 16k tail-log — it must be the compact form');
  const race = body.indexOf('await Promise.race([');
  const post = body.indexOf("reportBotEvent('request-counts', requestCounter.snapshot({ reason: 'teardown' }))");
  assert.ok(race > -1 && post > race && post < body.indexOf('setTimeout(r, 4000)'), 'posted inside the same bounded race as the alloc flush');
});

test('a hung close prints the full counts and posts under reason hung-close', () => {
  const at = KW.indexOf('const hungClose = takePendingRecycle();');
  assert.ok(at > -1);
  const body = KW.slice(at, KW.indexOf('if (oktaTrip) {', at));
  assert.match(body, /describeRequestCounts\(requestCounter\)/);
  assert.match(body, /reportBotEvent\('request-counts', requestCounter\.snapshot\(\{ reason: 'hung-close' \}\)\)/);
});

test('the kind is allow-listed on the server and the readout renders it', () => {
  assert.ok((BOT_EVENT_KINDS as readonly string[]).includes('request-counts'),
    'a kind the server does not allow-list is stored with kind NULL — visible as garbage, invisible to the readout');
  assert.match(READOUT, /recentBotEvents\('request-counts'/, 'the readout must fetch it');
  assert.match(READOUT, /REQUEST LOOP/, 'and say what a hot top path means');
  assert.match(READOUT, /flat:/, 'and what flat counts mean — both answers are readings');
});
