/**
 * The hand-off retry — the user's side of the 08:00 exchange.
 *
 * ## What this is a regression test for
 *
 * Until 2026-09-21 the bot made up to 40 attempts to WIN a campsite and the user's own
 * session made exactly ONE to take it back. `content-rc.js` fired a single POST and, on
 * `IsSuccess: false`, went straight to `setState('failed')`.
 *
 * `#M450`, 2026-09-21: carted at T+0.1s, held 27.5 minutes, `remove/cartentry` returned
 * **HTTP 200** (read from the runner's own log, so the release genuinely happened), and
 * the user's single POST was refused "The unit is not available for the date(s)
 * specified". That message covers both "a competitor has it" and "RC has not caught up
 * with our own release yet" — opposite facts arriving as one string — and one attempt
 * resolves them by assuming the worse.
 *
 * ## It CALLS the real file
 *
 * `extension/rc-retry.js` is served to the phone by `lib/rc-precart-script` and loaded by
 * the extension manifest. This test evaluates that exact file rather than a transcription
 * of it, because a structural scan of injected JavaScript proves only that some text is
 * present — and the whole point of pulling the decision out of `content-rc.js` was to
 * make it callable from something other than a phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Decision = { retry: boolean; waitMs: number; reason: string; held: boolean };
type Api = {
  decide: (o: Record<string, unknown>) => Decision;
  explain: (o: Record<string, unknown>) => string;
  MAX_ATTEMPTS: number; GAP_MS: number;
};

/** Evaluate the shipped file in a bare scope and hand back what it registered. */
function load(): Api {
  const src = readFileSync('extension/rc-retry.js', 'utf8');
  const g: Record<string, unknown> = {};
  new Function('globalThis', 'window', `${src}`).call(g, g, undefined);
  const api = g.__chHandoffRetry as Api | undefined;
  assert.ok(api && typeof api.decide === 'function',
    'rc-retry.js must register __chHandoffRetry — if this fails the phone has no rules');
  assert.ok(typeof api.explain === 'function',
    'rc-retry.js must also register explain() — content-rc.js calls it on every terminal ' +
    'failure, and a missing function there throws inside the catch-all and shows nothing');
  return api;
}

const RC = load();
const d = (o: Record<string, unknown>) => RC.decide(o);

test('"not available" RETRIES — the #M450 reading, and the owner\'s call', () => {
  const r = d({ attempt: 1, status: 200, error: 'The unit is not available for the date(s) specified.' });
  assert.equal(r.retry, true);
  assert.equal(r.held, false);
  assert.ok(r.waitMs > 0, 'and waits before trying again rather than hammering');
});

test('"already added" is a WIN, not a refusal', () => {
  // The exact string the hold runner logged as "could not hold #R359" ~75 times over a
  // site it was holding. RC says it when the unit is in a cart bound to this session.
  const r = d({ attempt: 1, status: 200, error: 'cart is already added' });
  assert.equal(r.held, true, 'this must be reported as carted');
  assert.equal(r.retry, false, 'and must not spend another attempt');
});

test('a capacity refusal stops — retrying cannot change it', () => {
  const r = d({ attempt: 1, status: 200, error: "the maximum number of reservations allowed in the cart is '2'" });
  assert.equal(r.retry, false);
  assert.equal(r.held, false, 'and it is NOT a win');
});

/**
 * THE TWO REFUSALS RETRYING PROVABLY WORSENS. This household IP has eaten a twelve-hour
 * WAF block from RC. A dead session hands the same dead token to the next POST.
 */
test('401 and 403 stop immediately, on any attempt', () => {
  for (const status of [401, 403]) {
    const r = d({ attempt: 1, status, error: '' });
    assert.equal(r.retry, false, `${status} must not be retried`);
    assert.equal(r.held, false);
  }
});

test('a network error retries — RC answered 19 of 20 identical calls and threw on one', () => {
  const r = d({ attempt: 1, status: 0, error: '', netError: true });
  assert.equal(r.retry, true);
  assert.match(r.reason, /reach RC/, 'and says it was transport, not a refusal');
});

/**
 * THE BOUND IS THE SAFETY PROPERTY. Without it this is an unbounded loop against the
 * site we are trying to book from, from a handset, with a user watching.
 */
test('it stops at MAX_ATTEMPTS even on the most retryable error there is', () => {
  const retryable = { status: 200, error: 'not available' };
  for (let a = 1; a < RC.MAX_ATTEMPTS; a++) {
    assert.equal(d({ ...retryable, attempt: a }).retry, true, `attempt ${a} should retry`);
  }
  assert.equal(d({ ...retryable, attempt: RC.MAX_ATTEMPTS }).retry, false,
    'the last attempt must not schedule another');
  assert.ok(RC.MAX_ATTEMPTS >= 2 && RC.MAX_ATTEMPTS <= 8,
    'bounded from BOTH sides: 1 is the bug this fixes, and a long loop is a spinner');
  assert.ok(RC.GAP_MS >= 500 && RC.GAP_MS <= 3000, 'and the gap likewise');
});

/**
 * AN UNRECOGNISED REFUSAL RETRIES, AND THAT IS THE DELIBERATE DIFFERENCE FROM THE BOT.
 * `isNotAvailable` stops the burst on anything it does not positively recognise, because
 * 40 POSTs from one IP into a fault makes it worse. Five POSTs from one handset do not,
 * and the expensive outcome here is giving up on a site about to come free.
 */
test('an unrecognised refusal retries, unlike the bot burst', () => {
  assert.equal(d({ attempt: 1, status: 500, error: '' }).retry, true);
  assert.equal(d({ attempt: 1, status: 200, error: 'something nobody has seen before' }).retry, true);
});

test('the matching is case-insensitive and substring-based, as RC\'s wording drifts', () => {
  assert.equal(d({ attempt: 1, status: 200, error: 'Cart Is ALREADY ADDED for this unit' }).held, true);
  assert.equal(d({ attempt: 1, status: 200, error: 'The MAXIMUM number of reservations' }).retry, false);
});

/** A missing/garbage input must not throw on the one path that hands over a campsite. */
test('it never throws, whatever it is handed', () => {
  for (const bad of [undefined, null, {}, { attempt: NaN }, { error: null }, { status: 'x' }]) {
    assert.doesNotThrow(() => d(bad as Record<string, unknown>));
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE WIRING. Everything above tests a module that the phone might never run.
 *
 * Nine-plus recorded instances in this repo of a fix that was present, reviewed, merged
 * and unreachable. This decision module has FOUR independent ways to be inert: not
 * consulted by `content-rc.js`, not loaded by the extension manifest, not concatenated
 * into the served bundle, or not traced into the Vercel deployment. Each gets an
 * assertion, because each fails silently and three of them fail only in production.
 * ──────────────────────────────────────────────────────────────────────────── */

const CONTENT = readFileSync('extension/content-rc.js', 'utf8');

test('content-rc.js actually consults the module', () => {
  assert.match(CONTENT, /window\.__chHandoffRetry/,
    'the consumer must read the global the module registers');
  assert.match(CONTENT, /RETRY\.decide\(/,
    'and must CALL decide — holding a reference to it is not consulting it');
  assert.match(CONTENT, /if \(d\.retry\)/, 'and must branch on the answer');
  assert.match(CONTENT, /if \(d\.held\)/,
    'including the "already added" win, which is the #R359 reading');
});

test('the retry path loops rather than falling through', () => {
  assert.match(CONTENT, /for \(let attempt = 1; ; attempt\+\+\)/,
    'the load+submit pair must be inside a loop');
  assert.match(CONTENT, /await sleep\(d\.waitMs\)/, 'and must wait the decided gap');
  assert.match(CONTENT, /continue;/, 'and go round again');
  // A SUCCESS MUST LEAVE THE LOOP. goToCart() navigates, so a fall-through would fire a
  // second submit against a page that is leaving.
  const ok = CONTENT.slice(CONTENT.indexOf("'✓ Added to cart — check the dates"));
  assert.ok(ok.indexOf('return;') < ok.indexOf('} else {'),
    'the success arm must return before the failure arm is reachable');
});

test('a thrown fetch is retried, not sent to the outer catch', () => {
  // Without this, RC's documented one-in-twenty transport failure renders as
  // "book manually" on the first blip — the single-attempt behaviour, restored by an
  // exception path nobody looked at.
  assert.match(CONTENT, /catch \(netErr\)/, 'the submit needs its own catch');
  assert.match(CONTENT, /netError: true/, 'which must tell the decision it was transport');
});

test('the extension manifest loads it BEFORE its consumer', () => {
  const m = JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as {
    content_scripts: { js: string[] }[];
  };
  const cs = m.content_scripts.find((c) => c.js.includes('content-rc.js'));
  assert.ok(cs, 'content-rc.js must still be registered');
  assert.ok(cs!.js.includes('rc-retry.js'), 'and rc-retry.js beside it');
  assert.ok(cs!.js.indexOf('rc-retry.js') < cs!.js.indexOf('content-rc.js'),
    'ORDER: a decision module that loads after its consumer is present and inert');
});

test('the served bundle carries it, ahead of the consumer', async () => {
  const { buildPrecartScript } = await import('./rc-precart-script');
  const bundle = buildPrecartScript();
  assert.ok(bundle.includes('__chHandoffRetry = api'),
    'the webview bundle must contain the module — the phone gets this, not the manifest');
  assert.ok(bundle.indexOf('__chHandoffRetry = api') < bundle.indexOf('window.__chHandoffRetry) || {'),
    'and it must be concatenated ahead of content-rc.js');
  // THE WHOLE BUNDLE MUST PARSE. A syntax error anywhere runs NOTHING, and an injection
  // that runs nothing is indistinguishable from a webview that refused us.
  assert.doesNotThrow(() => new Function(bundle), 'the assembled bundle must parse');
});

test('the deployment actually ships the file', () => {
  // `buildPrecartScript` reads it with readFileSync at request time. A file missing from
  // outputFileTracingIncludes is not a degraded bundle — the route 500s and the hand-off
  // has no script at all. This one cannot fail locally, only in production.
  const cfg = readFileSync('next.config.ts', 'utf8');
  const block = cfg.slice(cfg.indexOf("'/api/rc-precart'"));
  assert.ok(block.length > 0, 'the tracing entry must still exist — anchor not found');
  for (const f of ['rc-inject.js', 'rc-retry.js', 'content-rc.js']) {
    assert.ok(block.slice(0, 400).includes(f), `${f} must be traced into the deployment`);
  }
});

// ── what the PERSON is shown (2026-09-22) ───────────────────────────────────────────
//
// A real hand-off failure rendered as **"RC declined (401) — see console"**. An
// abbreviation nobody expands, an HTTP status that means nothing to a customer, and an
// instruction that cannot be followed: there is no console on a phone inside an in-app
// webview. It appeared precisely when no developer was present, which is the only time it
// was ever shown. `explain` replaces the sentence; `data-detail` keeps the status code.

test('no user-facing failure sentence leaks jargon, a status code, or "see console"', () => {
  const { explain, MAX_ATTEMPTS } = load();
  const cases = [
    { status: 401 }, { status: 403 }, { status: 500 }, { status: 0, netError: true },
    { error: 'Maximum number of carts' }, { error: 'The unit is not available for the date(s) specified' },
    { error: 'cart is already added' }, {}, { status: 429, error: '' },
    { status: 500, attempt: MAX_ATTEMPTS },
  ];
  for (const c of cases) {
    const out = explain(c);
    assert.ok(out.length > 0, `${JSON.stringify(c)} produced an empty sentence`);
    // THE EXACT STRING THAT SHIPPED. Pinned by name so reinstating it fails here.
    assert.ok(!/see console/i.test(out), `"see console" survived for ${JSON.stringify(c)}`);
    // `RC` as a standalone word. The substring appears inside "ReserveCalifornia", which is
    // the spelled-out form we WANT, so a naive indexOf would forbid the fix.
    assert.ok(!/\bRC\b/.test(out), `bare "RC" survived for ${JSON.stringify(c)}: ${out}`);
    // No HTTP status codes. Three digits starting 4 or 5 is what the old line printed.
    assert.ok(!/\b[45]\d{2}\b/.test(out), `a status code survived for ${JSON.stringify(c)}: ${out}`);
    assert.match(out, /[.!]$/, `not a sentence for ${JSON.stringify(c)}: ${out}`);
  }
});

test('the two failures a person can ACT on say so, and differently', () => {
  const { explain } = load();
  // A dead session is fixable on the page they are already looking at, in about twenty
  // seconds. A full cart is fixable too, by a completely different action. The old line
  // rendered both as "RC declined" — which is why this asserts they DIFFER, not merely
  // that each is non-empty.
  const expired = explain({ status: 401 });
  const full = explain({ error: 'Maximum number of carts reached' });
  assert.match(expired, /sign.?in/i, 'a 401 must name signing in as the remedy');
  assert.match(full, /cart is full/i, 'a capacity refusal must say the cart is full');
  assert.notEqual(expired, full, 'two different remedies must not render as one sentence');
  // And the honest loss is said plainly rather than hedged — somebody told "something went
  // wrong" retries a site that has gone.
  assert.match(explain({ error: 'The unit is not available for the date(s) specified' }),
    /booked it first|is gone/i);
});

test('explain and decide agree about which cases they recognise', () => {
  // TWO FUNCTIONS, ONE CLASSIFICATION. They are separate so that a retry rule cannot
  // acquire copy and copy cannot acquire a retry rule — but a case one recognises and the
  // other does not is exactly the drift that produces a correct decision with a wrong
  // sentence. Driven through both from one table.
  const { decide, explain } = load();
  const table = [
    { o: { status: 200, error: 'cart is already added' }, held: true, says: /already in your cart/i },
    { o: { status: 200, error: 'Maximum carts' }, held: false, says: /cart is full/i },
    { o: { status: 401 }, held: false, says: /sign.?in/i },
    { o: { status: 403 }, held: false, says: /would not accept/i },
  ];
  for (const row of table) {
    const d = decide({ attempt: 1, netError: false, ...row.o });
    assert.equal(d.retry, false, `${JSON.stringify(row.o)} must be terminal for decide`);
    assert.equal(d.held, row.held, `${JSON.stringify(row.o)} disagrees about held`);
    assert.match(explain(row.o), row.says);
  }
});

test('content-rc.js CALLS explain, and keeps the diagnostic on data-detail', () => {
  // FIX PRESENT AND INERT is the way this change fails: a perfect `explain` that nothing
  // invokes leaves "RC declined (401) — see console" on the phone with every pure test
  // above still green.
  const cr = readFileSync('extension/content-rc.js', 'utf8');
  assert.match(cr, /setStatus\(\s*RETRY\.explain\(/,
    'the terminal failure must be phrased by explain()');
  assert.ok(!/RC declined \(\$\{res\.status\}\)/.test(cr),
    'the old status-code sentence must be gone from the visible status');
  assert.match(cr, /setAttribute\('data-detail'/,
    'the technical string must still be written somewhere a diagnostic can read it');
  // AND THE DIAGNOSTIC MUST STILL RECEIVE IT. `lib/rc-precart-script`'s epilogue forwards
  // the status line; forwarding only `textContent` after this change would leave us with a
  // plain sentence and no status code anywhere — strictly worse than what it replaced.
  const ep = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  assert.match(ep, /getAttribute\("data-detail"\)/,
    'the epilogue must read data-detail, or the status code reaches nobody at all');
  assert.match(ep, /attributeFilter: \["data-detail"\]/,
    'data-detail is an attribute — a childList observer alone never fires for it');
});
