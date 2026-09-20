import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bookingPolicy,
  watchable,
  FIRST_COME_BADGE,
  FIRST_COME_WHY,
  type BookingPolicy,
} from './booking-policy';

/**
 * THE DECISION IS FOUR LINES; THE GUARDS ARE ABOUT WHETHER ANYTHING CALLS IT.
 *
 * A pure function nothing reads is the shape this repo keeps paying for — a paywall with
 * no route to it, a link-out that was live and invisible, `rankHoldLine` correct and
 * unreachable behind a claim gate. So the behavioural tests are short and most of the
 * file is structural: each surface that advertises a watch is named, and a surface that
 * stops honouring the policy fails here rather than in production.
 *
 * FOUR ENFORCERS, AND THE SERVER IS THE ONE THAT COUNTS. The three client surfaces
 * withhold the offer; `/api/watches` refuses the POST, because the client sends it and a
 * hidden offer is not a gate. Same argument the watch cap makes for itself and the
 * auto-cart entitlement makes six times over: check it where it would be spent.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/**
 * Source with comments removed.
 *
 * REQUIRED, NOT TIDINESS. The route's own comment quotes `NOT reservable` to explain the
 * rule, so a guard reading raw source PASSES against a query that has stopped asking —
 * the explanation satisfies the assertion. Verified by mutation: removing the clause left
 * the suite green until this existed.
 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/** Lines that CALL something, i.e. not the import that names it. */
const callLines = (src: string, needle: string) =>
  src.split('\n').filter((l) => l.includes(needle) && !/^\s*import\b/.test(l));

// ── the decision ──────────────────────────────────────────────────────────────────
test('only an explicit false is first-come', () => {
  assert.equal(bookingPolicy(false), 'first-come');
  assert.equal(bookingPolicy(true), 'reservable');
});

test('an absent reading is UNKNOWN and is not first-come', () => {
  // The house rule. Guessing 'first-come' from silence would withhold a watch from a
  // campground somebody can really book — the expensive direction — and it is the exact
  // absent-reading-as-a-negative failure this module's own report is an instance of.
  assert.equal(bookingPolicy(undefined), 'unknown');
  assert.equal(bookingPolicy(null), 'unknown');
});

test('an unknown policy keeps the offer; only first-come withholds it', () => {
  assert.equal(watchable('reservable'), true);
  assert.equal(watchable('unknown'), true);
  assert.equal(watchable('first-come'), false);
});

test('every policy is decided — no value falls through to a default nobody chose', () => {
  const all: BookingPolicy[] = ['reservable', 'first-come', 'unknown'];
  for (const p of all) assert.equal(typeof watchable(p), 'boolean');
  // And the round trip: the three inputs the catalog can produce map onto three policies.
  assert.deepEqual(
    [false, true, undefined].map(bookingPolicy),
    ['first-come', 'reservable', 'unknown'],
  );
});

test('the copy states the fact and blames nobody', () => {
  // It must not read as a fault (nothing went wrong) and must not read as a refusal
  // (nothing is being withheld from this user in particular). A sentence that reads
  // either way sends somebody to support over a campground behaving normally.
  for (const bad of ['error', 'sorry', 'unable', 'failed', "couldn't check", 'not allowed']) {
    assert.ok(
      !FIRST_COME_WHY.toLowerCase().includes(bad),
      `FIRST_COME_WHY must not read as a failure — found ${bad}`,
    );
  }
  assert.ok(/reservation/i.test(FIRST_COME_WHY), 'it has to say why');
  assert.ok(FIRST_COME_BADGE.length > 0 && FIRST_COME_BADGE.length < 32, 'badge fits a chip');
});

// ── the enforcers ─────────────────────────────────────────────────────────────────
test('the SERVER refuses a watch on a first-come campground', () => {
  const src = read('src/app/api/watches/route.ts');
  assert.match(code('src/app/api/watches/route.ts'), /NOT reservable/, 'the create path must ask the catalog');
  assert.match(src, /not_reservable/, 'and name the refusal');
  // 422 AND NOT 409: the client turns any 409 into the watch-limit sentence without
  // reading the body, so a 409 here would tell somebody they had hit a cap they are
  // nowhere near — two different facts collapsed into one reading.
  const at = src.indexOf('not_reservable');
  assert.ok(at > -1, 'anchor moved — this guard is measuring nothing');
  assert.match(src.slice(at, at + 400), /status: 422/, 'must not collide with the 409 cap');
});

test('a failed policy check costs nobody a watch', () => {
  // A DB blip must behave exactly as before this check existed. `watchableIds` starts as
  // the full request and is only ever narrowed, so a throw leaves it untouched.
  const src = read('src/app/api/watches/route.ts');
  const at = src.indexOf('let watchableIds = requested;');
  // BOUNDED STRUCTURALLY, NOT BY A CHARACTER COUNT. A window measured in characters is a
  // guess about layout, and this one broke on its first run the moment a comment landed
  // inside it — the fourth time this repo has recorded exactly that. The block ends where
  // the next statement begins.
  const end = src.indexOf('const primaryId', at);
  assert.ok(at > -1 && end > at, 'anchors moved — this guard is measuring nothing');
  const block = src.slice(at, end);
  assert.match(block, /catch\s*\(/, 'the query must be guarded');
  assert.doesNotMatch(block, /catch[\s\S]*?return NextResponse/, 'a throw must not refuse');
});

test('the server drops rather than refuses when a mixed park has survivors', () => {
  // 33 parks are MIXED. Refusing the whole request would withhold a watch somebody can
  // really use, so the unwatchable parts fall out and the rest proceeds.
  const src = read('src/app/api/watches/route.ts');
  assert.match(src, /watchableIds = requested\.filter\(/, 'it must filter, not reject');
  assert.match(src, /watchableIds\.length === 0/, 'and only refuse when nothing survives');
});

for (const [file, what] of [
  ['src/components/v2/ResultCard.tsx', 'the Explore card'],
  ['src/components/v2/CampgroundDetail.tsx', 'the campground page'],
  ['src/components/v2/NewWatch.tsx', 'the New watch screen'],
] as const) {
  test(`${what} decides from booking-policy rather than its own copy`, () => {
    const src = read(file);
    assert.match(src, /from "@\/lib\/booking-policy"/, `${what} must import the decision`);
    // The rule, not a re-implementation of it. A second `reservable === false` somewhere
    // is how the site mute came to be honoured by one RC finder and not the other.
    assert.doesNotMatch(
      src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      /reservable === false/,
      `${what} must not re-implement the comparison`,
    );
    assert.match(src, /watchable\(/, `${what} must gate the watch offer on it`);
  });
}

test('the auto-cart badge is withheld from a first-come campground too', () => {
  // `supportsAutoCart` is `source === 'ridb'` — a fact about the PROVIDER — and every one
  // of the 678 non-reservable campgrounds is rec.gov, so the badge was on all of them,
  // promising to put a site in a cart that can never exist. The provider fact is left
  // alone and each call site answers the second question.
  for (const file of [
    'src/components/v2/ResultCard.tsx',
    'src/components/v2/CampgroundDetail.tsx',
    'src/components/v2/NewWatch.tsx',
  ]) {
    // THE CALL, NEVER THE IMPORT. `indexOf('supportsAutoCart(')` finds the import line
    // first in all three files, so a window around it passed against an un-gated call
    // site — the ~20th time a guard in this repo has anchored on an import. Verified by
    // mutation: removing NewWatch's gate left the suite green until this changed.
    const lines = callLines(code(file), 'supportsAutoCart(');
    assert.ok(lines.length > 0, `${file}: anchor moved — this guard is measuring nothing`);
    for (const line of lines) {
      // ON THE SAME EXPRESSION, not merely somewhere in the file: all three write the
      // gate inline, and a gate elsewhere is a gate that can stop applying silently.
      assert.match(
        line,
        /watchable\(|!firstCome/,
        `${file}: the auto-cart promise must be gated on the booking policy — ${line.trim()}`,
      );
    }
  }
});

test('the suggest route carries reservable PER DIVISION and filters nothing', () => {
  // Two consumers want opposite things: the New watch picker must withhold, and Explore's
  // location box must still find the place. A route that answered one caller's question
  // would have made the other wrong silently.
  const src = read('src/app/api/suggest/route.ts');
  assert.match(src, /'reservable', c2\.reservable/, 'each division must carry its own answer');
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
    /NOT c2?\.reservable|reservable = true/,
    'the route must not filter — the consumer decides',
  );
});


test('the Explore card withholds the watch and puts the reason in its place', () => {
  // A card that offers nothing and says nothing reads as broken, so the sentence has to
  // REPLACE the button rather than merely hide it.
  const src = code('src/components/v2/ResultCard.tsx');
  const at = src.indexOf('<WatchCta');
  assert.ok(at > -1, 'anchor moved — this guard is measuring nothing');
  const before = src.slice(0, at);
  assert.match(before.slice(-200), /watchable\(policy\) \? \(/, 'the watch must be gated');
  assert.match(src.slice(at, at + 700), /FIRST_COME_WHY/, 'and the reason must take its place');
});

test('the campground page withholds the watch AND the availability grid', () => {
  // NOT an empty grid. It would render every night as unavailable, which reads as
  // "booked solid" — the exact opposite of what is true.
  const src = code('src/components/v2/CampgroundDetail.tsx');
  for (const [needle, what] of [
    ['<WatchCta', 'the watch'],
    ['<AvailabilityGrid', 'the availability grid'],
  ] as const) {
    const at = src.indexOf(needle);
    assert.ok(at > -1, `anchor moved for ${what} — this guard is measuring nothing`);
    assert.match(
      src.slice(0, at).slice(-260),
      /watchable\(policy\)/,
      `${what} must be gated on the booking policy`,
    );
  }
});

test('the New watch screen refuses to submit a first-come campground', () => {
  const src = code('src/components/v2/NewWatch.tsx');
  const at = src.indexOf('disabled={saving');
  assert.ok(at > -1, 'anchor moved — this guard is measuring nothing');
  assert.match(src.slice(at, at + 200), /firstCome/, 'submit must be disabled');
  // And the picker must not offer a click that leads nowhere in the first place.
  //
  // ANCHORED ON THE ASSIGNMENT, NOT THE NAME. A bare count of lines mentioning
  // `suggestionWatchable(` includes the FUNCTION DECLARATION, so with two call sites the
  // count was 3 and deleting one still passed `>= 2` — a mutation that un-gated the search
  // hits survived on the strength of a line that is not a call site at all. `callLines`
  // already skips imports; a declaration is the same trap one step along.
  assert.ok(
    callLines(src, 'const pickable = suggestionWatchable(').length === 2,
    'both the favourites list and the search hits must ask before offering a click',
  );
});

test("the New watch picker offers only a park's watchable parts", () => {
  // THE MIXED-PARK CASE, AND IT IS THE ONE THAT CANNOT BE SEEN FROM THE ROW. 33 parks
  // have a reservable division beside first-come ones, so the row stays clickable and the
  // checkbox list underneath is where the filtering has to happen. Handing `pick()` the
  // raw `divisions` would tick a first-come part by default and create a watch that can
  // never fire — and every surface above it would still look correct.
  const src = code('src/components/v2/NewWatch.tsx');
  for (const [anchor, what] of [
    ['const bookable = ', 'the picker'],
    ['const bookable = all.filter', 'the deep link'],
  ] as const) {
    const at = src.indexOf(anchor);
    assert.ok(at > -1, `anchor moved for ${what} — this guard is measuring nothing`);
  }
  // Both paths derive the checkbox list from the policy rather than from `divisions`.
  const assigns = callLines(src, 'const bookable =');
  assert.equal(assigns.length, 2, 'the picker and the deep link each build one list');
  for (const line of assigns) {
    assert.match(
      line,
      /watchableParts\(|watchable\(bookingPolicy\(/,
      'a checkbox list must be filtered by the booking policy',
    );
  }
});
