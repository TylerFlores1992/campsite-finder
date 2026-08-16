// An action token must survive being auto-linked.
//
// 2026-08-16, found by walking the claim flow on a phone: a claim link carrying
// `?t=HaPUjQd_` opened as `?t=HaPUjQd`, the API 404'd, and the screen said "This link is no
// longer valid." Reproduced against production — the full token answers 200, the truncated
// one 404s — so the mechanism is not in doubt.
//
// base64url's alphabet contains `-` and `_`, so 2 of 64 characters can land last, and a URL
// ending in one is the classic linkification casualty: chat and mail clients read trailing
// punctuation as sentence punctuation and drop it from the href while the visible text still
// looks correct. Measured at the time: 4 of 97 live tokens, ~1 in 32 alert links.
//
// These tokens carry `manage`, `mute_site`, `stop`, `cancel` and — the expensive one — the
// `hold` claim link somebody taps at 08:00 with a campsite on a fifteen-minute fuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { genToken } from '../src/lib/notifications/actions.js';

const SRC = readFileSync('src/lib/notifications/actions.ts', 'utf8');
/** Comments quote the broken shape to explain it; a guard must not read its own explanation. */
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('genToken rejects a trailing - or _', () => {
  const body = code.slice(code.indexOf('export function genToken'), code.indexOf('export function actionLink'));
  assert.match(body, /\[-_\]\$/, 'the trailing-character rule must be present');
  assert.match(body, /for \(;;\)|while \(/, 'a bad draw must be re-rolled, not patched');
});

/**
 * DRIVEN, NOT READ. The regex could be present and inverted, or applied to the wrong end —
 * both of which look right in a diff. This runs the real function.
 */
test('no generated token ends in a character a linkifier will eat', () => {
  const gen = genToken;

  // ~3% of draws end badly, so a few hundred makes a missing rule essentially certain to show.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const t = gen();
    assert.ok(!/[-_]$/.test(t), `token ends in a linkifier-hostile character: ${t}`);
    assert.match(t, /^[A-Za-z0-9_-]{8}$/, `token is not 8 base64url chars: ${t}`);
    seen.add(t);
  }
  assert.ok(seen.size > 1900, 'entropy must be unchanged — this rejects a suffix, not a character');
});

test('the rule does not ban - and _ outright', () => {
  // Banning them everywhere would be the over-correction: it costs real entropy for a problem
  // that only exists at the END of a URL, and 17 of 97 live tokens contain one mid-string
  // without ever having been mangled.
  const gen = genToken;
  let withInner = 0;
  for (let i = 0; i < 2000; i++) if (/[-_]/.test(gen().slice(0, -1))) withInner++;
  assert.ok(withInner > 100, 'tokens should still contain - and _ away from the end');
});
