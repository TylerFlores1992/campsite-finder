// COUNT THE BYTES THE OKTA NAVIGATION MOVES — the first instrument aimed at the CAUSE.
//
// Five have been built against this leak (a size guard, a RAM arm, a heap trail, a post-Okta
// recycle, an orphan sweep) and every one of them is aftermath. The cause hunt itself is
// narrow: NOT the JS heap (15-18 MB flat against a 4,903 MB process), the RENDERER and the
// BROWSER PROCESS with GPU/utility/crashpad flat, and exactly on the Okta navigation.
//
// "Network/IPC buffering" was recorded as the leading candidate three times and never tested,
// though it is directly observable — non-JS memory growing by gigabytes in the renderer AND
// the browser process is the shape of a huge or looping response, and the browser process is
// where Chromium's network stack lives when the network service is not in a utility process.
//
// A NEGATIVE IS AS USEFUL AS A POSITIVE HERE, which is what makes this worth shipping: small
// numbers eliminate the whole buffering family at a stroke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  safeUrl, summariseTrace, describeTrace, withNetworkTrace,
} from '../scripts/auto-cart-bot/okta-net-trace.mjs';

const SRC = readFileSync('scripts/auto-cart-bot/okta-net-trace.mjs', 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('THE OAUTH CODE NEVER REACHES THE LOG', () => {
  // Okta's callback is `/login/callback?code=…&state=…` and that code is exchangeable for the
  // session. The precart diagnostic published exactly that on 2026-08-09 by reporting
  // `location.href`, and on 08-16 a TypeError published a user's password because WebKit
  // quotes the failing expression. The rule both times: do not COLLECT a field you would then
  // have to filter.
  const withCode = 'https://www.reservecalifornia.com/login/callback?code=SECRET&state=xyz';
  const out = safeUrl(withCode);
  assert.equal(out, 'https://www.reservecalifornia.com/login/callback');
  assert.ok(!out.includes('SECRET') && !out.includes('code='), 'the query must be dropped whole');
  assert.equal(safeUrl('https://x.test/a#frag=SECRET'), 'https://x.test/a', 'and the fragment');
  // An unparseable URL is the case MOST likely to be carrying something, so it must not fall
  // through to the raw string.
  assert.equal(safeUrl('%%%not a url'), '(unparseable)');
});

test('response bodies are never read — the instrument must not allocate what it measures', () => {
  // `response.body()` buffers the whole payload into this process. On a page suspected of
  // pulling hundreds of megabytes that is the cure arriving as part of the disease — the same
  // mistake as writing a multi-GB heap snapshot at the moment the box cannot spawn.
  assert.ok(!/\.body\(\)/.test(code), 'must never call response.body()');
  assert.ok(!/\.text\(\)/.test(code), 'nor response.text()');
  assert.match(code, /content-length/, 'size must come from the header already in hand');
});

test('a loop is aggregated by path, not lost among individual responses', () => {
  // Forty requests to one endpoint at 30 MB each is a LOOP, and it looks nothing like one
  // enormous download — but it is the shape that would explain a ramp growing steadily over
  // ninety seconds rather than arriving at once.
  const t = summariseTrace(Array.from({ length: 40 }, () => ({
    url: 'https://signin.reservecalifornia.com/idp/idx/introspect', status: 200, bytes: 30 * 1024 * 1024,
  })));
  assert.equal(t.responses, 40);
  assert.equal(t.biggest.length, 1, 'one path, not forty rows');
  assert.equal(t.biggest[0].hits, 40, 'and the repeat count is what names it a loop');
  assert.ok(t.totalBytes > 1_000 * 1024 * 1024);
  assert.match(describeTrace(t), /x40/, 'the count must survive into the log line');
});

test('the verdict is stated, and it points BOTH ways', () => {
  // A diagnostic that can only confirm is worth much less than one that can eliminate. The
  // whole reason this ships is that small numbers retire the buffering family.
  const big = summariseTrace([{ url: 'https://a/b', status: 200, bytes: 900 * 1024 * 1024 }]);
  assert.match(describeTrace(big), /LEAD, not a candidate/);

  const small = summariseTrace([{ url: 'https://a/b', status: 200, bytes: 900_000 }]);
  assert.match(describeTrace(small), /does NOT explain the ramp/,
    'small numbers must ELIMINATE the candidate, not merely fail to confirm it');
});

test('responses with no content-length are counted, never silently treated as zero', () => {
  // The house rule: an absent reading is not a reading of zero. A chunked response with no
  // declared length is exactly the shape a streaming leak would take, so it must be visible.
  const t = summariseTrace([
    { url: 'https://a/b', status: 200, bytes: null },
    { url: 'https://a/c', status: 200, bytes: 1024 },
  ]);
  assert.equal(t.unsized, 1);
  assert.match(describeTrace(t), /1 with no content-length/,
    'the unmeasured responses must be surfaced — they could be the whole story');
});

test('"nothing observed" is its own reading, not a clean bill of health', () => {
  assert.match(describeTrace(summariseTrace([])), /the trace did not run/);
  assert.match(describeTrace(null as never), /the trace did not run/);
});

test('the listener is bounded, so the instrument cannot join in', async () => {
  // A pathological loop is what we are looking for; an unbounded array of records is how the
  // diagnostic becomes part of the problem.
  assert.match(code, /responses\.length >= 2000/, 'the record count must be capped');
});

test('the listener is detached even when the callback throws', async () => {
  // It sits on the RESIDENT page, which lives for hours. One left attached accumulates a
  // record per response for the life of the browser — a small leak added by the thing
  // investigating a large one.
  let detached = 0;
  const handlers: Function[] = [];
  const page = { on(_e: string, h: Function) { handlers.push(h); }, off() { detached++; } };

  const { trace } = await withNetworkTrace(page as never, async () => {
    handlers[0]({ url: () => 'https://a/b', status: () => 200, headers: () => ({ 'content-length': '10' }) });
  });
  assert.equal(trace.responses, 1, 'responses during the run are counted');
  assert.equal(detached, 1, 'and the listener comes off');

  await assert.rejects(
    () => withNetworkTrace(page as never, async () => { throw new Error('renew blew up'); }),
    /renew blew up/,
  );
  assert.equal(detached, 2, 'including when the renewal throws — which is the common case here');
});

test('the disarm flag is checked FIRST, so a leaked listener is inert', () => {
  /**
   * PINNED STRUCTURALLY, AND THE REASON IS WORTH KEEPING. The first version of this test
   * tried to prove it behaviourally: let `off()` throw, fire the leaked handler, then start a
   * SECOND trace and assert it saw nothing. It passed against a build with the flag deleted —
   * because a leaked handler pushes into the FIRST run's array, which has already been
   * summarised, while the second trace has its own array and its own handler. The effect is
   * genuinely not observable from outside, so the honest guard is the source one.
   *
   * Same two-mechanism disarm as the authorize route: `off()` in a `finally`, and a flag that
   * does not depend on Playwright's detach working.
   */
  const handler = code.slice(code.indexOf('const onResponse = ('), code.indexOf('page.on('));
  assert.match(handler, /if \(!armed\) return;/, 'the flag must be checked');
  assert.ok(handler.indexOf('!armed') < handler.indexOf('responses.push'),
    'and checked BEFORE anything is recorded, or the flag guards nothing');
  assert.match(code, /finally \{[\s\S]{0,200}armed = false;[\s\S]{0,200}page\.off/,
    'disarm first, then detach — so the handler is inert whatever off() does');
});

test('a broken response object never fails the renewal', async () => {
  const handlers: Function[] = [];
  const page = { on(_e: string, h: Function) { handlers.push(h); }, off() {} };
  const { result } = await withNetworkTrace(page as never, async () => {
    handlers[0](null); // headers() will throw
    return 'renewed';
  });
  assert.equal(result, 'renewed', 'the trace must never take down the thing it observes');
});

test('the trace wraps the renewal and is logged pass OR fail', () => {
  // The FAILING renewals are the ones that ramp — all five guard firings were mid-renewal — so
  // a trace only printed on success would miss every event it was built for.
  assert.match(KEEPWARM, /withNetworkTrace\(page, \(\) => renewSession\(/,
    'the renewal must run inside the trace');
  const at = KEEPWARM.indexOf('withNetworkTrace(page, () => renewSession(');
  const after = KEEPWARM.slice(at, at + 1200);
  const logAt = after.indexOf('describeTrace(trace)');
  const recordAt = after.indexOf('recordRenewal(');
  assert.ok(logAt > -1, 'the summary must be logged');
  assert.ok(logAt < recordAt,
    'and logged before anything that can throw, or a failing renewal loses its trace');
  // Not inside a success branch.
  assert.ok(!/r\?\.renewed[\s\S]{0,80}describeTrace/.test(after),
    'the trace must not be gated on the renewal having succeeded');
});
