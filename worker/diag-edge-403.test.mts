// `rc-diag`'s 2x2 is only a comparison if nothing but the flag changed.
//
// 2026-08-17: two runs seconds apart read `node fetch: HTTP 403` then `HTTP 200`, with a
// `--capture` flag flipping in between. Read as a 2x2 that says "the token-capture hook
// fixes ReserveCalifornia", which is nonsense — the fetch happens BEFORE Chromium launches
// and uses plain Node, so no flag of that script can touch it. RC's edge changed its mind.
// Every 403 was on a STATIC asset (/, the bundle, the CSS, manifest.json), which no page
// script can cause.
//
// Same confound as the 08-05 SMS test, where every 2-segment message also happened to carry
// a camphawk.app link and both theories predicted all 50 rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-diag.mjs', 'utf8');

test('a 403 on the node fetch stops the reader before the 2x2', () => {
  // The fetch is the ONE flag-independent line in the output, so it is the only thing that
  // can reveal a time-varying cause — and the 2x2 said nothing about it.
  assert.match(SRC, /if \(res\.status === 403\)/,
    'a 403 from the edge must be called out where it is measured');
  const block = SRC.slice(SRC.indexOf('if (res.status === 403)'), SRC.indexOf('} catch (e)'));
  assert.match(block, /REFUSING THIS IP/i);
  assert.match(block, /no browser flag can change that/i,
    'it must say the flags are irrelevant, which is the whole point');
  assert.match(block, /STOP/,
    'it must stop the run being read as a browser result');
});

test('the 2x2 tells the reader to check the runs agree first', () => {
  const how = SRC.slice(SRC.indexOf('THE 2x2'));
  assert.match(how, /do the runs agree on/i,
    'the comparison is void unless the flag-independent line matches across runs');
  assert.match(how, /TIME, not/,
    'it must name the alternative variable explicitly');
});

test('the diagnostic still never signs in', () => {
  // The property that makes this safe to run during an edge block: no credential is
  // submitted, so a throwaway profile cannot look like a fresh-device login — the shape
  // that cost 12 hours of IP block on 2026-08-06.
  assert.match(SRC, /No credential is typed and nothing is signed into/);
  assert.ok(!/loadCreds|RC_PASSWORD/.test(SRC), 'rc-diag must never touch credentials');
});
