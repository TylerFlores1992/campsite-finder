// Which rows count as campgrounds. Pure — no DB — because the rule is a regex and the
// interesting part is which real catalog names it gets right.
//
// EVERY name below is a REAL row from the production catalog. That is the point: the
// GoingToCamp regex looked fine in the abstract and was wrong on two dozen real
// campgrounds the moment it was run against the data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonCampground, nonCampgroundReason } from '../src/lib/campground-visibility';

test('hides the things you cannot sleep in', () => {
  for (const name of [
    'Catawba Island Day Use Area',
    'Sand Harbor State Park — Day Use Parking Space - 7 days in advance or less',
    'Pocahontas State Park — Shelter',
    'Macedonia Brook Picnic Shelter',
    'Frank Holten State Recreation Area — Golf Course Side',
    'Monadnock Hq',
    'HEADQUARTERS',
    'Ginkgo IC',
    'Heron Lake Visitor Center Great Room',
  ]) {
    assert.ok(isNonCampground(name), `should hide: ${name}`);
  }
});

test('a lodging word ALWAYS wins — combined facilities are campgrounds', () => {
  // Portals name a combined facility after both halves and the campground half is the one
  // we care about. Every one of these matches a day-use/HQ/shelter term.
  for (const name of [
    'KYEN CAMPGROUND AND OAK GROVE DAY USE AREA',
    'Starrigavan Campground and Day Use',
    'Egin Lakes Campground/Day Use Area',
    'Pike Lake Cabins and Day Use Shelters',
    'Salton Sea SRA — Headquarters Hookup (sites 2-15)',
    'KENTUCKY CAMP CABIN AND HEADQUARTERS BUILDING',
    'FISH LAKE REMOUNT DEPOT CABINS',
    'Frosty Hollow Shelter Camping Area',
    'Buck Creek Shelters/Group Camp',
    'Sycamore Equestrian Camp and Shelter',
    // The plural that the first version of the rule missed. Ohio's shelter camps are
    // bookable overnight, and `\bcamp\b` does not match "Camps".
    'Tar Hollow Non Electric Shelter Camps',
  ]) {
    assert.ok(!isNonCampground(name), `must NOT hide: ${name}`);
  }
});

test('"trail" is not a signal — it was the whole reason not to reuse the GTC regex', () => {
  // The GoingToCamp NON_CAMPGROUND regex includes \btrail\b. Applied catalog-wide it
  // matched two dozen real campgrounds, which is why this rule does not contain the term
  // at all. A false positive here removes a campground from search; a false negative
  // leaves a picnic shelter in it. They are not equally bad.
  for (const name of [
    'SHEEP TRAIL CAMPGROUND',
    'Trail Creek Bridge Campground',
    'EAST TOTTEN TRAIL CAMPGROUND (ND)',
    'Lincoln Trail State Park — Lakeside Campground',
    'Scioto Trail State Park — Caldwell Lake Campground',
    'Suwannee River Wilderness Trail — Holton Creek',
    'Cumberland Trail State Park',
    'Lake Oroville SRA — Bloomer North Fork Trail Camp',
    'New River Trail State Park — Millrace Sites in Foster Falls',
  ]) {
    assert.ok(!isNonCampground(name), `must NOT hide: ${name}`);
  }
});

test('"ic" only counts as a suffix, never inside a word', () => {
  assert.ok(isNonCampground('Ginkgo IC'));
  // Would be a catastrophe unanchored — these are ordinary names.
  assert.ok(!isNonCampground('Pacific Crest Group Site'));
  assert.ok(!isNonCampground('Atlantic Beach Campground'));
});

test('the reason names the matched term, for the admin page and the audit trail', () => {
  assert.equal(nonCampgroundReason('Catawba Island Day Use Area'), 'day use');
  assert.equal(nonCampgroundReason('Pocahontas State Park — Shelter'), 'shelter');
  assert.equal(nonCampgroundReason('Lakeside Campground'), null);
});

test('an empty or missing name is not a classification', () => {
  // Never invent a verdict from no information — the same rule as a null availability
  // read. A blank name is a data problem, not a picnic shelter.
  assert.equal(nonCampgroundReason(''), null);
});
