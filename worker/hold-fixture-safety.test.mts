// A HOLD FIXTURE MAY NEVER CARRY A NUMERIC UNIT ID.
//
// `dueHolds` selects `requested` rows by `release_at` alone. It does not join `watches`, so
// nothing about a fixture watch - not its 2020 dates, not `active = false` - keeps a fixture
// away from the production RC hold runner on the mini-PC. The runner POSTs whatever unit id
// it is given to ReserveCalifornia's precart. A numeric fixture id is therefore an
// instruction to lock whatever real campsite happens to carry that number.
//
// It happened on 2026-08-15: a `worker/rc-holds.test.mts` run died before its `after()` and
// left four `requested` fixtures with ids 9003/9005/9101/9105 on a real RC campground. The
// runner retried unit 9003 at Westport-Union Landing SB every 15 seconds for a quarter of an
// hour. Nothing was locked only because the RC session was dead at the time.
//
// WHY THIS IS A SCAN AND NOT A RUNTIME ASSERT. The dangerous line looks completely ordinary -
// `offer('9108', pacific(60))` is what anyone would write next to nine identical neighbours,
// and it is only wrong because of a property of a different process on a different machine.
// Nothing at the call site can show that. Same reasoning as `sql-routing.test.mts` (a
// data-modifying statement handed to `query()`) and `stripe-init.test.mts` (module-scope
// `new Stripe`): invisible by reading the file, so it is guarded mechanically or not at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '.');

/**
 * Files that can create a row `dueHolds` will return.
 *
 * A RAW INSERT COUNTS, AND LEAVING IT OUT IS HOW THIS GUARD MISSED A REAL ONE. The first
 * version selected on `offerHold|requestHold`, describing "files that drive the hold state
 * machine" by the two helpers that happened to exist when it was written. Six suites write
 * `rc_hold_requests` with plain SQL instead and none of them was ever scanned - so on
 * 2026-08-27 `health-hold-counts.test.mts` shipped a `requested` fixture on unit `999000111`,
 * INSERTed directly, and this test went green. It survived only because the feed's lead is 90
 * seconds and the suite sweeps in seconds; nothing about it was safe by design.
 *
 * The selector is therefore about the CAPABILITY, not the idiom: anything that writes the
 * table is in scope. The rc-holds import is no longer required either - a raw INSERT needs
 * no import, which is exactly the case that escaped.
 */
function holdTestFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.test.mts'))
    .filter((f) => {
      const src = readFileSync(join(DIR, f), 'utf8');
      return /offerHold|requestHold/.test(src) || /INSERT INTO rc_hold_requests/i.test(src);
    });
}

/**
 * Comments are stripped before scanning. The header of `rc-holds.test.mts` quotes the exact
 * ids that caused the incident, and a test that failed on its own explanation would be
 * "fixed" by deleting the explanation - which is the half worth keeping. Same rule the
 * mini-PC pattern tests already follow.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

test('no hold fixture uses a numeric unit id', () => {
  const files = holdTestFiles();
  assert.ok(files.length > 0, 'expected at least one hold test to scan - has the import path moved?');

  for (const f of files) {
    const src = code(readFileSync(join(DIR, f), 'utf8'));
    // SCOPED TO LINES THAT ACTUALLY CARRY A UNIT ID, not to the whole file. The first version
    // scanned everything and flagged '24' and '00' inside the `pacific()` hour helper - noise
    // that has nothing to do with holds. A guard that cries wolf is a guard somebody deletes,
    // and it would take the real finding with it. The digit floor stays at 2 rather than being
    // raised to dodge those, because a short real unit id is exactly the collision that hurts.
    // THE SCAN FOLLOWS THE FILE'S OWN INSERT HELPERS, not a fixed list of names. `offer(` and
    // `requestHold(` are the two that happened to exist when this was written; a suite that
    // calls its helper `hold(` or `cartedHold(` was invisible, and a whole-file scan is not the
    // answer either - it flags `'24'`/`'00'` from the `pacific()` helper in six files and an
    // `appBuild: '19'` in a seventh. Any function whose body writes `rc_hold_requests` is a way
    // to create the dangerous row, so its call sites are exactly the lines worth reading, and
    // this cannot go stale when somebody names the next one differently.
    const inserters = [...src.matchAll(
      /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter((m) => /INSERT INTO rc_hold_requests/i.test(m[2]))
      .map((m) => m[1]);
    const callsAnInserter = inserters.length
      ? new RegExp(`\\b(?:${inserters.join('|')})\\(`)
      : /(?!)/;

    const hits = src
      .split('\n')
      .filter((l) => /\boffer\(|\brequestHold\(|unit_id/.test(l)
        || callsAnInserter.test(l)
        // AND A BARE NUMERIC CONSTANT, because that is the shape that got through. The three
        // tokens above describe where a unit id is USED; a fixture id is just as often DECLARED
        // once at the top and referenced by name, and `const REAL = '999000111';` carries none
        // of them. Checked against every file this scans before being added - it flags nothing
        // that exists, so it buys the case with no cry-wolf. The two-digit floor below still
        // applies, which is what keeps the fixed one-digit form green.
        || /^\s*(?:const|let|var)\s+\w+\s*(?::[^=]*)?=\s*'\d+'\s*;/.test(l))
      // An id already inside the sentinel helper is the FIXED form, and its digits are still
      // digits - so they must come out before the scan or the guard flags its own remedy and
      // can never go green. Removing the whole `U('...')` call rather than just the quotes
      // keeps a bare neighbour on the same line visible.
      .map((l) => l.replace(/\bU\('\d+'\)/g, ''))
      .flatMap((l) => l.match(/'\d{2,}'/g) ?? []);
    assert.deepEqual(
      hits, [],
      `${f} passes a numeric-looking unit id (${hits.join(', ')}). Real RC unit ids are ` +
      `numeric, so a leaked fixture would tell the production runner to cart a real site. ` +
      `Wrap it in the file's non-numeric sentinel helper.`,
    );
  }
});

test('EVERY suite that writes rc_hold_requests is scanned', () => {
  // PINS THE 2026-08-27 WIDENING. The selector used to require `offerHold|requestHold`, so the
  // six suites that INSERT with plain SQL were never read - and one of them shipped a
  // `requested` fixture on a nine-digit unit id with this test green. Narrowing it back would
  // look like a tidy-up and would restore that hole silently, so the coverage is asserted
  // rather than left to the selector's wording.
  const scanned = new Set(holdTestFiles());
  const writers = readdirSync(DIR)
    .filter((f) => f.endsWith('.test.mts'))
    .filter((f) => /INSERT INTO rc_hold_requests/i.test(readFileSync(join(DIR, f), 'utf8')));
  assert.ok(writers.length > 0, 'expected some suite to insert holds - has the table been renamed?');
  for (const f of writers) {
    assert.ok(scanned.has(f),
      `${f} writes rc_hold_requests but is not scanned for numeric unit ids - it can create `
      + `the exact row the production runner would POST to ReserveCalifornia`);
  }
});

test('the fixture sentinel is not numeric, and is a prefix a sweep can match', () => {
  // The helper is defined in the test file rather than exported, so this reads it as text -
  // an exported helper would be a second thing to keep in step with the fixtures.
  const src = readFileSync(join(DIR, 'rc-holds.test.mts'), 'utf8');
  const m = src.match(/const U = \(n: string\) => `([^`]*)\$\{n\}`/);
  assert.ok(m, 'rc-holds.test.mts should define U() as a prefix template');
  const prefix = m![1];
  assert.ok(prefix.length > 0, 'U() must add a prefix, or the id stays numeric');
  assert.ok(/^\D/.test(prefix), `U()'s prefix must not start with a digit (got ${prefix})`);

  // And `before()` must actually sweep on that prefix. A sentinel with no sweep still leaves
  // rows behind after an aborted run - harmless to RC, but they sit in the readout for ever
  // and make a real stuck hold harder to see.
  const swept = src.match(/DELETE FROM rc_hold_requests WHERE unit_id LIKE '([^']*)'/);
  assert.ok(swept, 'before() must sweep leaked fixtures by unit_id prefix');
  // Postgres LIKE escaping: `\_` is a literal underscore. Undo it to compare with the prefix.
  const pattern = swept![1].replace(/\\\\/g, '\\').replace(/\\_/g, '_').replace(/%$/, '');
  assert.equal(pattern, prefix, 'the sweep pattern and U()\'s prefix must be the same string');
});
