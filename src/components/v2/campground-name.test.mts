import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tidyCase,
  parseCampgroundName,
  parkOf,
  divisionLabel,
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
