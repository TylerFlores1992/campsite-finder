import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tidyCase,
  parseCampgroundName,
  parkOf,
  divisionLabel,
  placeLabel,
  dropRedundantState,
} from './campground-name';

/**
 * PURE — no database. Every other real-DB suite in this repo shares fixture rows with
 * whatever else is running, which is how CI came to fail on unchanged code; this one
 * cannot, so it is safe to run alongside anything.
 *
 * The inputs are REAL names copied out of the catalog, not invented ones. The two Leo
 * Carrillo rows in particular are the whole reason the parenthetical is never dropped.
 */

test('a shouting name is title-cased', () => {
  assert.equal(tidyCase('CAVE MOUNTAIN LAKE GROUP CAMP'), 'Cave Mountain Lake Group Camp');
  assert.equal(tidyCase('SIX MILE CREEK'), 'Six Mile Creek');
});

test('a name that already has lowercase is left exactly alone', () => {
  // The guard that stops us overruling a human's casing. If this ever starts
  // "fixing" mixed-case names, every ReserveCalifornia row changes.
  const mixed = 'Leo Carrillo SP — Canyon Campground (sites 25-77, 134-139)';
  assert.equal(tidyCase(mixed), mixed);
  assert.equal(tidyCase('McArthur-Burney Falls SP'), 'McArthur-Burney Falls SP');
});

test('a state code in parentheses stays upper, a two-letter word does not', () => {
  // "PORCUPINE (AK)" is a real row. "Porcupine (Ak)" would be wrong.
  assert.equal(tidyCase('PORCUPINE (AK)'), 'Porcupine (AK)');
  assert.equal(tidyCase('KENNEL CREEK CABIN (AK)'), 'Kennel Creek Cabin (AK)');
});

test('digits and site ranges are never re-cased', () => {
  assert.equal(tidyCase('GRAND LAKE CAMP SITES 1-120'), 'Grand Lake Camp Sites 1-120');
});

test('minor words lowercase, but never the first word', () => {
  assert.equal(tidyCase('LAKE OF THE WOODS'), 'Lake of the Woods');
  assert.equal(tidyCase('THE PINES'), 'The Pines');
});

test('hyphens and apostrophes capitalise the following letter', () => {
  assert.equal(tidyCase("O'BRIEN CREEK"), "O'Brien Creek");
  assert.equal(tidyCase('OAK-HILL CAMP'), 'Oak-Hill Camp');
});

test('park and division split on the FIRST dash, keeping multi-word names whole', () => {
  const p = parseCampgroundName('Leo Carrillo SP — Canyon Campground (sites 25-77, 134-139)');
  assert.equal(p.park, 'Leo Carrillo SP');
  assert.equal(p.division, 'Canyon Campground (sites 25-77, 134-139)');
});

test('a second dash belongs to the DIVISION, not to a second park', () => {
  // Splitting on every dash, or on spaces, loses the tail. An earlier version did
  // exactly that and mangled every park whose name had more than one word.
  const p = parseCampgroundName('Some SP — Loop A — Upper');
  assert.equal(p.park, 'Some SP');
  assert.equal(p.division, 'Loop A — Upper');
});

test('the parenthetical is KEPT, because it is the only discriminator', () => {
  // rc-539 and rc-542 are both "Leo Carrillo SP — Canyon Campground". Dropping the
  // site ranges makes 374 campgrounds ambiguous across the catalog.
  const a = divisionLabel('Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133)');
  const b = divisionLabel('Leo Carrillo SP — Canyon Campground (sites 25-77, 134-139)');
  assert.notEqual(a, b);
  assert.match(a, /sites 1-24/);
});

test('a name with no division is its own park, and its label is the full name', () => {
  const p = parseCampgroundName('GULL LAKE CAMPGROUND');
  assert.equal(p.park, 'Gull Lake Campground');
  assert.equal(p.division, null);
  assert.equal(divisionLabel('GULL LAKE CAMPGROUND'), 'Gull Lake Campground');
});

test('parkOf groups the real Leo Carrillo and Carpinteria rows', () => {
  const leo = [
    'Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133)',
    'Leo Carrillo SP — Canyon Campground (sites 25-77, 134-139)',
    'Leo Carrillo SP — Canyon Group Camp',
  ].map(parkOf);
  assert.deepEqual(new Set(leo), new Set(['Leo Carrillo SP']));

  assert.equal(parkOf('Carpinteria SB — Santa Rosa (sites 301-380)'), 'Carpinteria SB');
});

test('an en dash groups the same as an em dash', () => {
  assert.equal(parkOf('Some SP – Loop A'), 'Some SP');
});

test('empty and dash-only input do not throw or produce an empty park', () => {
  assert.equal(parseCampgroundName('').park, '');
  const only = parseCampgroundName('—');
  assert.equal(only.division, null, 'a lone dash has no division to speak of');
});

/**
 * placeLabel — "some campgrounds show a city and state and others do not" (2026-08-15).
 *
 * Every call site wrote `city && ...`, so a campground with a state and no city rendered
 * NOTHING. Measured: of 7,610 visible campgrounds 1,957 (26%) have no city but only 274
 * (3.6%) have no state, and all 859 ReserveAmerica rows are `{city: null, state: "NY"}` —
 * a state we had and threw away. Gating on the rarer of the two fields is the bug.
 */
test('placeLabel joins city and state when both exist', () => {
  assert.equal(placeLabel('Big Sur', 'CA'), 'Big Sur, CA');
});

test('placeLabel RETURNS THE STATE ALONE when there is no city', () => {
  // The reported bug, and the ReserveAmerica shape — 859 campgrounds.
  assert.equal(placeLabel(null, 'NY'), 'NY');
  assert.equal(placeLabel('', 'NY'), 'NY');
  assert.equal(placeLabel('   ', 'NY'), 'NY');
});

test('placeLabel returns the city alone when there is no state', () => {
  assert.equal(placeLabel('Celina', null), 'Celina');
});

test('placeLabel returns null for neither, rather than inventing a label', () => {
  // 274 campgrounds (3.6%) genuinely have neither. An empty string would render a stray
  // separator; a placeholder would be a label we made up.
  assert.equal(placeLabel(null, null), null);
  assert.equal(placeLabel(undefined, undefined), null);
  assert.equal(placeLabel('  ', ''), null);
});

const readSrc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stripComments = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
const exploreSrc = stripComments(readSrc('./Explore.tsx'));
const newWatchSrc = stripComments(readSrc('./NewWatch.tsx'));
const geoSrc = stripComments(readSrc('./geo.ts'));

test('no suggestion row gates its place label on the city', () => {
  for (const [name, src] of [['Explore', exploreSrc], ['NewWatch', newWatchSrc]] as const) {
    // MATCHES BOTH SHAPES. The first version of this anchored on `{<obj>.city && (`
    // and so missed Explore's compound condition, which spans two lines and opens with
    // `hit.kind === "campground" &&`. The mutation that restored the bug there passed.
    // `.city && (` is the render gate itself, whatever precedes it.
    assert.ok(
      !/\.city && \(/.test(src),
      `${name} still renders its place label only when a city exists, so every ` +
        'campground with a state and no city shows nothing — 26% of the catalog.',
    );
  }
});

test('all three rows and hitLabel share one definition of the place label', () => {
  assert.ok((exploreSrc.match(/placeLabel\(/g) ?? []).length >= 1, 'Explore does not use placeLabel');
  assert.ok((newWatchSrc.match(/placeLabel\(/g) ?? []).length >= 2, 'NewWatch has two rows and must use placeLabel in both');
  assert.ok(
    (geoSrc.match(/placeLabel\(/g) ?? []).length >= 1,
    'geo.hitLabel keeps its own copy. It was the ONLY one of the four that was right, ' +
      'which is precisely why it should not be a separate expression.',
  );
});

test("Explore's place label survives a name longer than the rail", () => {
  // The rail is 316px (--ch-rail). The name and the place used to share ONE truncating
  // span, so the place — the half that tells two identical names apart — was what got
  // cut. Separate blocks now, so truncation eats the name instead.
  const start = exploreSrc.indexOf('<span className="min-w-0 flex-1"');
  assert.notEqual(start, -1, 'the suggestion row was not found — restructured?');
  const row = exploreSrc.slice(start, start + 600);
  assert.ok(
    !/min-w-0 flex-1 truncate/.test(row),
    'the name and the place are back in one truncating span, so a long name hides the ' +
      'town and state entirely',
  );
  assert.ok(
    /block truncate font-semibold/.test(row),
    'the campground NAME should be the part that truncates',
  );
});

test('a trailing state is dropped only when the SAME state is shown beside it', () => {
  // "Silver Lake Campground (WY) · Saratoga, WY" says WY twice.
  assert.equal(dropRedundantState('Silver Lake Campground (WY)', 'WY'), 'Silver Lake Campground');
  assert.equal(dropRedundantState('Silver Lake Campground June Lake (CA)', 'CA'),
    'Silver Lake Campground June Lake');
});

test('a trailing state is KEPT when nothing repeats it', () => {
  // The catalog holds BOTH "Silver Lake Campground" and "Silver Lake Campground (WY)".
  // Stripping unconditionally renders two different campgrounds identically — the same
  // collision this module refuses to create by stripping site ranges.
  assert.equal(dropRedundantState('Silver Lake Campground (WY)', null), 'Silver Lake Campground (WY)');
  assert.equal(dropRedundantState('Silver Lake Campground (WY)', 'CA'), 'Silver Lake Campground (WY)');
  assert.equal(dropRedundantState('Porcupine (AK)', undefined), 'Porcupine (AK)');
});

test('dropRedundantState leaves anything that is not a trailing 2-letter code', () => {
  assert.equal(dropRedundantState('Leo Carrillo SP — Canyon Campground (sites 1-24)', 'CA'),
    'Leo Carrillo SP — Canyon Campground (sites 1-24)');
  assert.equal(dropRedundantState('(CA)', 'CA'), '(CA)', 'never strips a name to nothing');
});
