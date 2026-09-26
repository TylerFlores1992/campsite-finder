/**
 * THE SCREEN AFTER "YES — HOLD IT FOR ME" MUST READ AS A YES (2026-09-26).
 *
 * The hold POST redirects back to `/w/<token>`, and by then the row is `requested` — so the
 * person who had just said yes was shown the REPEAT-TAP screen: "You're already down for
 * this one … Tapping again changes nothing". The owner read it as an error. The success
 * screen and the repeat-tap screen were one screen, and the two hedged outcomes (window
 * full, bot offline) never reached the web at all because the redirect discarded the
 * message that carried them.
 *
 * Source scans, no database: every property here is a property of the copy and of the
 * wiring between the route, the page and the component. Each anchor is asserted present
 * before anything is asserted about it — a guard whose anchor misses reads nothing and
 * approves everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
/** Comments out — they quote the old copy on purpose, to explain why it went. */
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a > -1, `anchor missing: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > -1, `end anchor missing: ${to}`);
  return src.slice(a, b);
}

const confirm = code(read('src/components/v2/HoldConfirm.tsx'));
const confirmed = between(confirm, 'function Confirmed(', 'function Caution(');

test('the confirmed screen never reads as a refusal, a duplicate or an error', () => {
  assert.ok(/We have your request/.test(confirmed), 'anchor: the just-confirmed wording is gone');
  for (const bad of [/already/i, /changes nothing/i, /tapping again/i, /\bsorry\b/i, /\bcouldn/i]) {
    assert.ok(!bad.test(confirmed), `the confirmed screen must not say ${bad} — it is read right after a yes`);
  }
});

test('the confirmed screen promises a TRY, never a cart, and says to keep an alarm', () => {
  assert.match(confirmed, /will try to put it in the cart/);
  assert.ok(!/we(&rsquo;|'|’)ll (grab|cart|get) it\b/i.test(confirmed), 'no flat promise of the cart');
  assert.match(confirmed, /Set an alarm/, 'a user who believes the site is handled stops watching');
  assert.match(confirmed, /AUTOCART_BETA_NOTE/, 'the beta note stays on the screen people rely on');
  assert.match(confirmed, /RC_CART_HOLD_MINUTES/, 'what happens next includes claiming quickly');
});

test('the just-confirmed heading depends on the outcome, and the hedged outcomes are shown', () => {
  assert.match(confirmed, /const fresh = outcome === 'held'/);
  assert.match(confirmed, /outcome === 'held-full'/, 'a full window must not read as secured');
  assert.match(confirmed, /outcome === 'held-bot-offline'/, 'an offline bot must not read as secured');
  // The row decides which screen; the marker only picks the words on it.
  const main = between(confirm, 'export default function HoldConfirm(', 'return (\n    <Shell>\n      <HomeMark />\n      <h1');
  assert.match(main, /if \(preview\.alreadyRequested\) \{\s*return <Confirmed/);
  assert.match(main, /outcome === 'not-entitled'/, 'a refused hold must not re-render the offer as if nothing happened');
});

test('the route carries the outcome to the page, and a failure can never map to "held"', () => {
  const route = code(read('src/app/api/w/hold/route.ts'));
  assert.match(route, /searchParams\.set\('r', result\.outcome \?\? \(result\.ok \? 'held' : 'gone'\)\)/);
  const page = code(read('src/app/w/[token]/page.tsx'));
  assert.match(page, /parseHoldOutcome\(/);
  assert.match(page, /<HoldConfirm preview=\{preview\} outcome=\{outcome\} \/>/);
});

test('every hold return in performAction names an outcome that matches its ok', () => {
  const actions = code(read('src/lib/notifications/actions.ts'));
  const hold = between(actions, "case 'hold': {", "case 'mute_site':");
  const returns = hold.match(/return \{[\s\S]*?\n\s*\};/g) ?? [];
  assert.ok(returns.length >= 5, `expected every hold outcome, found ${returns.length} returns`);
  for (const r of returns) {
    const outcome = r.match(/outcome: '([a-z-]+)'/)?.[1];
    assert.ok(outcome, `a hold return without an outcome falls back to a guess:\n${r}`);
    if (/ok: false/.test(r)) {
      assert.ok(['not-entitled', 'gone'].includes(outcome!), `a failure labelled as ${outcome}:\n${r}`);
    } else {
      assert.match(r, /ok: true/);
      assert.ok(/^held|^in-cart$/.test(outcome!), `a success labelled as ${outcome}:\n${r}`);
    }
  }
});

test('parseHoldOutcome accepts only the known outcomes', async () => {
  const { parseHoldOutcome, HOLD_OUTCOMES } = await import('./notifications/actions');
  for (const o of HOLD_OUTCOMES) assert.equal(parseHoldOutcome(o), o);
  for (const bad of ['', 'HELD', 'held ', 'x', undefined, null, ['held']]) {
    assert.equal(parseHoldOutcome(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('a queued hold in the list never tells the user there is nothing to do', () => {
  const row = code(read('src/components/v2/HoldRow.tsx'));
  const line = between(row, 'case "requested":', 'case "carted":');
  assert.match(line, /try for this/, 'anchor: the queued line');
  assert.ok(!/Nothing to do/i.test(line), 'a user who believes the site is handled stops watching');
  assert.match(line, /alarm/);
});
