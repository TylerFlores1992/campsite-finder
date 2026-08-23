// THE READING MUST SURVIVE THE EVENT THAT PRODUCED IT.
//
// The native sampler works. Its readings kept vanishing, because its only output was
// `logs\rc-keepwarm.log` and `tail-log` returns the last 16,000 characters. Measured
// 2026-08-23: two nine-gigabyte ramps in thirty-two hours, the sampler running for both,
// and BOTH attributions gone before anyone read them.
//
//     08-22 23:12 -> 23:23   rc 8,983 MB   free RAM 6,744 -> 3,191   COMMIT 82%
//     08-23 07:31 -> 07:41   rc 9,180 MB   free RAM 5,960 -> 3,328   COMMIT 88%
//
// `chromium_memory_samples` survived those same events by being in Postgres. Migration 066 is
// that fix applied to the other half — the series says a ramp HAPPENED, this says what was
// allocating while it did.
//
// Two properties carry it, and they pull against each other: it must store the rare rows that
// matter (or it is the log again) and refuse the common ones (or the interesting rows are as
// hard to find here as they were there).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanSites } from '../src/lib/native-alloc.ts';

// ── 1. What gets stored, and what must not ────────────────────────────────────────────────

test('an empty site list is NULL, never []', () => {
  // "The browser answered with nothing attributable" and "we never asked" are different
  // facts. Storing [] for the second is the zero-for-an-absent-reading mistake this project
  // has made twice — the memory sampler recording a zero it had not measured, and
  // `[object Object]` reaching a jsonb column.
  assert.equal(cleanSites([]), null);
  assert.equal(cleanSites(null), null);
  assert.equal(cleanSites(undefined), null);
  assert.equal(cleanSites('nonsense'), null);
  assert.equal(cleanSites({} as never), null, 'a non-array must not become a row');
});

test('a real site list survives intact', () => {
  const sites = cleanSites([
    { site: 'chrome.dll.pdb+0x9961707 <- chrome.dll.pdb+0x370aa42', bytes: 2_100_000_000 },
    { site: '<V8 Heap>', bytes: 16_000_000 },
  ]);
  assert.equal(sites?.length, 2);
  assert.equal(sites?.[0].bytes, 2_100_000_000);
  assert.match(sites?.[0].site ?? '', /chrome\.dll/);
});

test('malformed entries are dropped, not coerced', () => {
  // This crosses the network from the box. A NaN or a non-string reaching a numeric or jsonb
  // column is a thrown INSERT, and `recordNativeAlloc` swallows those — so a coerced value
  // would be stored wrong rather than loudly.
  const sites = cleanSites([
    { site: 'good', bytes: 100 },
    { site: '', bytes: 100 },
    { site: 'nan', bytes: Number.NaN },
    { site: 'zero', bytes: 0 },
    { site: 'negative', bytes: -5 },
    { bytes: 100 },
    null,
    'string',
  ]);
  assert.equal(sites?.length, 1, `only the good row survives, got ${JSON.stringify(sites)}`);
  assert.equal(sites?.[0].site, 'good');
});

test('the list is capped, so one bad profile cannot flood the table', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ site: `s${i}`, bytes: 1000 - i }));
  const sites = cleanSites(many);
  assert.ok(sites && sites.length <= 40, `expected a cap, got ${sites?.length}`);
});

// ── 2. Only ramps are sent — the gate is on the bot ───────────────────────────────────────

const KW = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = KW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function reporterBody(): string {
  const from = code.indexOf('function reportNativeAlloc(');
  assert.ok(from > -1, 'reportNativeAlloc must exist — anchor not found');
  const to = code.indexOf('\nasync function ', from);
  assert.ok(to > from, 'the end anchor must be found AFTER the start');
  return code.slice(from, to);
}

test('a trip that did not ramp is NOT stored', () => {
  // The renewal makes an Okta trip roughly hourly and almost all cost 50-350 MB. Storing
  // every one buries the interesting rows exactly as the log did — which is the whole
  // failure being fixed, reintroduced one layer down.
  const body = reporterBody();
  assert.match(body, /ramMb > -NATIVE_ALLOC_RAMP_MB/,
    'the gate must compare the SIGNED delta against the threshold');
});

test('an UNKNOWN delta is not stored as a ramp', () => {
  // `trace.ram` is null when the trace never closed. `unknown` must not round to a verdict —
  // the rule that keeps a failed availability read from being "fully booked".
  const body = reporterBody();
  assert.match(body, /typeof ramMb !== 'number'/,
    'a non-numeric delta must return before anything is sent');
});

test('a trip that FREED memory is not stored as a ramp', () => {
  // The signed comparison is what makes this true: free RAM RISING is a positive delta and
  // fails `ramMb > -THRESHOLD` in the safe direction. An abs() here would file a browser
  // handing memory back as an allocation event.
  const body = reporterBody();
  assert.ok(!/Math\.abs\(/.test(body),
    'an abs() would store a trip that freed a gigabyte as if it had allocated one');
});

test('the reporter never blocks or throws into the renewal', () => {
  // A diagnostic that can delay the thing it observes is not worth having — the mistake
  // `rcFamilyMb` would have made in the guard arm, and the reason the client report channel
  // is never awaited either.
  const body = reporterBody();
  assert.ok(!/await fetch\(/.test(body), 'the POST must not be awaited');
  assert.match(body, /\.then\(/, 'it reports its own outcome instead');
});

// ── 3. Both trips are wired, and they are distinguishable ─────────────────────────────────

test('BOTH sampler call sites report, with different contexts', () => {
  // The auto-login is the 9.4 GB trip and the renewal is the hourly one; they have different
  // shapes and different stakes. One wired and one not is the inert-fix shape that has cost
  // this project three commits.
  assert.match(code, /reportNativeAlloc\('auto-login',/, 'the auto-login site must report');
  assert.match(code, /reportNativeAlloc\('renewal',/, 'the renewal site must report');
});

test('the reported diff is the one that was RENDERED, not a second computation', () => {
  // Computing `diffProfiles` twice would let the log and the stored row disagree about the
  // same event — two facts of different provenance presented as one, which is the shape that
  // made `bot_commit` misleading beside a live heartbeat.
  for (const ctx of ['auto-login', 'renewal']) {
    const at = code.indexOf(`reportNativeAlloc('${ctx}',`);
    assert.ok(at > -1);
    const before = code.slice(Math.max(0, at - 300), at);
    assert.match(before, /const diff = diffProfiles\(/,
      `${ctx}: the diff must be computed once and shared with renderProfile`);
    assert.match(before, /renderProfile\(diff,/, `${ctx}: the log must render that same diff`);
  }
});

// ── 4. The server half ────────────────────────────────────────────────────────────────────

const SRV = readFileSync('src/lib/native-alloc.ts', 'utf8');

test('the context is allow-listed, not stored verbatim', () => {
  // It crosses the network from the box and renders on an admin page. Same rule as `max_type`
  // in migration 062.
  assert.match(SRV, /const CONTEXTS = new Set\(/);
  assert.match(SRV, /CONTEXTS\.has\(input\.context\)/);
});

test('sites are stringified for the jsonb column', () => {
  // `sqlit` INTERPOLATES rather than binds and falls back to `String(val)`, which turned an
  // object into the literal `[object Object]` and switched the memory series off for ten
  // minutes on 2026-08-18.
  assert.match(SRV, /JSON\.stringify\(sites\)/);
  assert.match(SRV, /\$4::jsonb/);
});

test('a failed INSERT cannot fail the feed request', () => {
  // This rides the hold feed's POST. A diagnostic that 500s a request the cart depends on has
  // inverted the priority — the rule `recordSessionHealth` already follows.
  assert.match(SRV, /\.catch\(/);
});

test('it does NOT import server-only, and says why', () => {
  // `server-only` resolves to a throwing stub outside a server bundle, `node:test` included —
  // which would make this file testable only through a COPY of its rules. `stripe-client.ts`
  // records the same call, and both siblings (`chromium-memory.ts`, `rc-holds.ts`) omit it.
  assert.ok(!/^import 'server-only'/m.test(SRV),
    'server-only here would make these very tests impossible');
  assert.match(SRV, /server-only/,
    'the omission is deliberate and must stay explained, or someone re-adds it as a tidy-up');
});
