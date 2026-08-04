// Guards on the catalog geocoder — the ones that decide whether a park gets a pin or
// gets skipped.
//
// Run: npm test
//
// These are PURE and need no network or credentials, unlike the rest of the suite.
// They exist because every one of them was written in response to a measured wrong
// answer, and the failure mode is silent: a bad coordinate looks exactly like a good
// one on a map. A missing campground is visibly missing; a campground pinned 300 miles
// away sends someone to the wrong place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inState, isRealCoord, geocodeAddress } from '../src/lib/sources/geocode';

test('isRealCoord rejects the null-island placeholder', () => {
  // ReserveAmerica publishes `0.0, -0.0` for parks it has no location for — confirmed
  // on Clough State Park, NH. It parses as a valid number and lands in the Gulf of
  // Guinea. The old code only escaped this because those pages also omit the OG meta.
  assert.equal(isRealCoord(0, 0), false);
  assert.equal(isRealCoord(-0.0, 0.0), false);
  assert.equal(isRealCoord(NaN, 45), false);
  assert.equal(isRealCoord(-71.87, 43.38), true, 'a real New Hampshire coordinate');
});

test('inState catches a wrong-state geocode', () => {
  // The measured case: "PO Box 993, Bolton Landing NY" resolved to Moorestown, NEW
  // JERSEY. Same country, plausible-looking, 400km from the park.
  assert.equal(inState('NY', -74.912749, 39.983363), false, 'Moorestown NJ is not New York');
  assert.equal(inState('NH', -71.87696, 43.380738), true, 'Wilmot NH is New Hampshire');
  assert.equal(inState('NE', -96.802733, 40.624635), true, 'Lancaster County NE');
});

test('inState covers all 50 states, not just the four GoingToCamp needed', () => {
  // ReserveAmerica spans 18 contracts; the box used to exist only for MI/MS/WA/WI, so
  // every other state fell through the `!b` escape hatch unchecked.
  for (const st of ['AK', 'CA', 'FL', 'ME', 'TX', 'HI', 'NY', 'OR', 'KY', 'IA', 'IN', 'MT', 'CT', 'GA', 'NE', 'NH']) {
    assert.equal(inState(st, -999, -999), false, `${st} must have a real box, not a pass-through`);
  }
  assert.equal(inState('ZZ', -999, -999), true, 'an unknown state must not delete a coordinate');
});

test('a PO box is not an address', async () => {
  // A mailbox is not a place. This one is checked before any network call, so it
  // returns null with no token and no request.
  for (const street of ['PO Box 993', 'P.O. Box 65', 'p o box 12', 'Post Office Box 7']) {
    assert.equal(
      await geocodeAddress({ street, city: 'Bolton Landing', state: 'NY' }),
      null,
      `${street} must not be geocoded`
    );
  }
});

test('a street with no city, or a city with no street, is not geocoded', async () => {
  // "Kingston, NH" alone resolves to the town centre — a guess wearing the costume of
  // a location.
  assert.equal(await geocodeAddress({ street: '124 Main Street', city: '' }), null);
  assert.equal(await geocodeAddress({ street: '', city: 'Kingston', state: 'NH' }), null);
  assert.equal(await geocodeAddress({}), null);
});
