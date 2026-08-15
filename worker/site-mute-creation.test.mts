/**
 * Muting on the NEW WATCH screen — the write half, and the chain that makes it mean
 * something.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * Muting was reachable only from `/manage/<token>`, which the owner reported almost
 * nobody finds. It is now offered at creation too. That adds a second way for the same
 * feature to be silently decorative, and this codebase has shipped exactly that defect
 * twice in the file being changed:
 *
 *   - `site_type` was collected on the New watch screen, transmitted, persisted — and
 *     read by NOTHING in `worker/`. A user picked RV and was alerted for tent sites.
 *   - `rvLength`, `electric`, `showers` and `pets` were collected on the same screen and
 *     DROPPED ON SUBMIT, so they never even reached the database.
 *   - `NewWatch.tsx` already carried a comment recording that its auto-cart toggle was
 *     "PURELY DECORATIVE until 2026-08-01".
 *
 * So there are two distinct ways to build this and get nothing: never send it, or send it
 * somewhere no reader looks. Both are checked here.
 *
 * ── THE CHAIN THIS PINS ────────────────────────────────────────────────────────────────
 *   1. `SiteMuteList` loads ids from `/api/campgrounds/<id>/availability`.
 *   2. That route is `getAvailabilityFromRecGov` (rec.gov) / `getRCAvailabilityForMonth`
 *      (ReserveCalifornia) — the SAME functions the poller reads.
 *   3. RC's emits `campsiteId: String(unit.UnitId)`, which is byte-for-byte what
 *      `findRCOpenUnit` / `findRCHeldUnits` compare (`muted.has(String(unit.UnitId))`).
 *   4. `NewWatch` posts those ids as `mutedSiteIds`.
 *   5. `/api/watches` POST writes them to `watches.muted_site_ids`.
 *   6. `loadWatches` SELECTs that column and the finders exclude on it.
 *
 * Break any link and the feature fails SILENTLY — the write persists, the screen lists it
 * back, and the alert arrives anyway. That is the 2026-08-13 Carpinteria bug exactly, and
 * the reason the 08-09 verification missed it: it proved the write and never a reader.
 * `worker/site-mute.test.mts` holds links 3 and 6; this file holds 1, 2, 4 and 5.
 *
 * Structural rather than behavioural because the failure is invisible in any one file:
 * every piece looks correct on its own, and only the JOIN between them is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Comments explain these rules at length and must not be able to satisfy them. */
const strip = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

const newWatch = strip(read('../src/components/v2/NewWatch.tsx'));
const manageWatch = strip(read('../src/components/v2/ManageWatch.tsx'));
const muteList = strip(read('../src/components/v2/SiteMuteList.tsx'));
const watchesRoute = strip(read('../src/app/api/watches/route.ts'));
const manageRoute = strip(read('../src/app/api/manage/[token]/route.ts'));
const availabilityRoute = strip(read('../src/app/api/campgrounds/[id]/availability/route.ts'));
const rcAvailability = strip(read('../src/lib/availability/reservecalifornia.ts'));
const poller = strip(read('./poller.ts'));

// ── Link 4: the screen must SEND it ────────────────────────────────────────────────────

test('NewWatch posts mutedSiteIds', () => {
  assert.ok(
    /mutedSiteIds:\s*\[\.\.\.muted\]/.test(newWatch),
    'NewWatch collects mutes but does not put them in the POST body. That is the ' +
      'rvLength/electric/showers/pets defect from this same file: a control the user ' +
      'operates whose value never leaves the browser.',
  );
});

test('NewWatch mounts the mute list, and clears mutes when the campground changes', () => {
  assert.ok(/<SiteMuteList/.test(newWatch), 'NewWatch does not render SiteMuteList at all');
  assert.ok(
    /setMuted\(new Set\(\)\)/.test(newWatch),
    'NewWatch must reset the mute set when campgroundId changes. rec.gov campsite ids ' +
      'are global, so a stale id carried across a campground change does not merely ' +
      'fail to match — it can mute a real site at the new campground that the user ' +
      'never saw.',
  );
});

test('the submit callback closes over every value it posts', () => {
  /**
   * useCallback deps decide which values `submit` actually READS. An omission is
   * invisible everywhere it matters: the JSX is right, the body is right, the API is
   * right, and the value is stale before it reaches any of them — `autoCart` sat missing
   * from this list until the divisions work restored it, so turning auto-cart off and
   * pressing Start watching posted `true` unless a date was edited afterwards.
   *
   * Matched by CONTENT rather than by the array's opening tokens: the previous version
   * of this test anchored on `[campgroundId, range` and stopped matching the moment
   * divisions added two deps in front, which is a guard that goes quiet on an ordinary
   * refactor rather than on a bug.
   */
  const arrays = [...newWatch.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  const deps = arrays.find((a) => /\bcampgroundId\b/.test(a) && /\brouter\b/.test(a));
  assert.ok(deps, 'submit useCallback dependency array not found — renamed?');
  for (const name of ['muted', 'autoCart']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(deps),
      `submit posts \`${name}\` but does not depend on it, so it sends whatever the ` +
        `value was when the callback was last rebuilt:\n[${deps}]`,
    );
  }
});

/**
 * THE MUTE LIST MUST OFFER EXACTLY WHAT THE WATCH WILL COVER — no less, no more.
 *
 * ── LESS: the Leo Carrillo bug (reported 2026-08-15) ───────────────────────────────────
 * The picker was gated on `divisions.length <= 1`, so a multi-division park got no mute
 * list at all. That gate was written when one submit meant one watch PER division, and it
 * outlived the change that made a park ONE watch. The owner found it by opening Leo
 * Carrillo and seeing nothing where the list should be.
 *
 * ── MORE: the id rule ──────────────────────────────────────────────────────────────────
 * `muted_site_ids` is ONE column applying to every campground the watch covers, so an id
 * from a campground it does NOT cover must never reach it. Within a park that is safe
 * (campsite ids measured unique — 10,757 sampled, zero collisions); across unrelated
 * campgrounds it is not, because rec.gov ids are global.
 *
 * Both directions now come from ONE definition of "what does this watch cover?" —
 * `targets`. They were briefly two, the picker keyed on the park and the payload on the
 * selection, and that disagreement IS the bug.
 */
test('the mute picker covers exactly the campgrounds the watch will cover', () => {
  assert.ok(
    /\{targets\.length > 0 && \(/.test(newWatch),
    'the mute picker is not gated on `targets`. Gating on the PARK is what hid it '
      + 'entirely for Leo Carrillo; gating on anything narrower hides it again.',
  );
  assert.ok(
    /campgroundIds=\{targets\.map\(\(t\) => t\.id\)\}/.test(newWatch),
    'the picker is not given the covered campgrounds, so a park watch would list one '
      + 'division and silently offer no way to mute the rest',
  );
  assert.ok(
    /const targets = useMemo\(/.test(newWatch),
    '`targets` must be ONE derived value read by both the picker and the submit body. '
      + 'Two definitions of what the watch covers is exactly how they disagreed.',
  );
});

test('mutes are pruned when the covered set shrinks', () => {
  assert.ok(
    /onInventory=\{pruneMutes\}/.test(newWatch),
    'the picker does not report its inventory, so nothing prunes stale mutes: untick a '
      + 'division after muting its sites and those ids are still posted',
  );
  assert.ok(
    /const pruneMutes = useCallback/.test(newWatch) && /offered\.has\(id\)/.test(newWatch),
    'pruneMutes must filter the muted set down to the ids the list can currently offer',
  );
  // SCOPED TO pruneMutes' OWN BODY. The first version of this matched
  // `setMuted((prev) =>` anywhere in the file and was satisfied by `muteLocally`, which
  // has the identical line — so a pruneMutes rewritten to close over a stale `muted`
  // passed. A guard that can be satisfied by a different function guards nothing.
  const pruneBody = newWatch.slice(
    newWatch.indexOf('const pruneMutes = useCallback'),
    newWatch.indexOf('}, []);', newWatch.indexOf('const pruneMutes = useCallback')),
  );
  assert.ok(pruneBody.length, 'pruneMutes not found — renamed?');
  assert.ok(
    /setMuted\(\(prev\) =>/.test(pruneBody),
    'pruneMutes must use a functional update — pruning against a stale `muted` would '
      + `resurrect ids it had just dropped:\n${pruneBody}`,
  );
});

test('the mute list fetches EVERY covered campground, not just the first', () => {
  // A park watch that fetched only `campgroundIds[0]` would look right — a list appears,
  // rows are mutable — while silently offering no way to mute the other divisions. That
  // is the reported bug wearing a different costume, so it is pinned separately from the
  // prop being passed.
  const loader = muteList.slice(
    muteList.indexOf('const perCampground = await Promise.all('),
    muteList.indexOf('if (cancelled) return;', muteList.indexOf('const perCampground')),
  );
  assert.ok(loader.length, 'the per-campground loader is gone — renamed?');
  assert.ok(
    /campgroundIds\.map\(/.test(loader),
    `the loader does not map over every covered campground:\n${loader}`,
  );
  assert.ok(
    !/\.slice\(|\[0\]/.test(loader),
    `the loader narrows campgroundIds before fetching, so only some divisions are `
      + `listed:\n${loader}`,
  );
});

// ── Link 5: the API must PERSIST it ────────────────────────────────────────────────────

test('POST /api/watches reads mutedSiteIds and writes muted_site_ids', () => {
  assert.ok(
    /const \{[^}]*mutedSiteIds[^}]*\} = body/.test(watchesRoute),
    'the watches route never destructures mutedSiteIds from the body',
  );
  const insert = watchesRoute.slice(watchesRoute.indexOf('INSERT INTO watches'));
  assert.ok(insert, 'INSERT INTO watches not found');
  const stmt = insert.slice(0, insert.indexOf(');') + 2);
  assert.ok(
    /muted_site_ids/.test(stmt),
    `the INSERT does not carry muted_site_ids, so a mute set at creation is discarded ` +
      `on the way to the database:\n${stmt}`,
  );
  assert.ok(
    /mutedVal/.test(stmt),
    `the INSERT names the column but does not bind the validated value:\n${stmt}`,
  );
});

// ── Links 1-3: the ids must be the ones the poller compares ────────────────────────────

test('the availability route is the same source the poller reads', () => {
  assert.ok(
    /getRCAvailabilityForMonth/.test(availabilityRoute) &&
      /ridbSource\.getAvailability|getAvailabilityFromRecGov/.test(availabilityRoute),
    'the availability route no longer serves both providers from the poller\'s own ' +
      'availability modules. The mute list gets its ids from here; if this starts ' +
      'returning ids from anywhere else, every mute silently stops matching.',
  );
});

test('RC availability emits exactly the id the RC finders compare', () => {
  const fn = rcAvailability.slice(rcAvailability.indexOf('export async function getRCAvailabilityForMonth'));
  assert.ok(fn.length, 'getRCAvailabilityForMonth not found — renamed?');
  assert.ok(
    /campsiteId:\s*String\(unit\.UnitId\)/.test(fn),
    'getRCAvailabilityForMonth must emit `campsiteId: String(unit.UnitId)`. The mute ' +
      'list writes whatever this returns and the finders compare ' +
      '`muted.has(String(unit.UnitId))`; any other shape here means the two halves are ' +
      'comparing different things and no RC mute ever matches.',
  );
  assert.ok(
    /muted\.has\(String\(unit\.UnitId\)\)/.test(rcAvailability),
    'the finders no longer compare String(unit.UnitId) — the other end of the same chain',
  );
});

test('the poller still selects and uses muted_site_ids', () => {
  assert.ok(
    /w\.muted_site_ids/.test(poller),
    'loadWatches does not SELECT muted_site_ids. This is how `site_type` was dead: the ' +
      'column existed, the API wrote it, and the poller never asked for it.',
  );
  assert.ok(
    /muted\.has\(campsiteId\)/.test(poller),
    'the rec.gov path no longer excludes muted sites',
  );
});

// ── One implementation, two screens ────────────────────────────────────────────────────

test('both mute surfaces mount the same component', () => {
  for (const [name, src] of [['NewWatch', newWatch], ['ManageWatch', manageWatch]] as const) {
    assert.ok(
      /import SiteMuteList/.test(src) && /<SiteMuteList/.test(src),
      `${name} does not use the shared SiteMuteList. Two copies of this list is how ` +
        '`content-rc.js` spent months telling users to click a cart icon while ' +
        '`rc-cart.mjs` did the right thing — the forgotten copy is by definition the ' +
        'one running when it matters.',
    );
  }
});

// ── The bulk control the owner asked for ───────────────────────────────────────────────

test('the shared list offers mute-all and unmute-all', () => {
  assert.ok(/Mute all \$\{/.test(muteList), 'no "Mute all" control');
  assert.ok(/Unmute all \$\{/.test(muteList), 'no "Unmute all" control');
});

test('a bulk button under an active filter says "these", not "all"', () => {
  // A user who filtered to "B" and pressed a button reading "Mute all" would
  // reasonably expect all 300 sites. The word is the entire safeguard.
  assert.ok(
    /filtered \? `Mute these \$\{toMute\.length\}` : `Mute all \$\{toMute\.length\}`/.test(muteList),
    'the mute-all label does not distinguish a filtered list from the whole list',
  );
  assert.ok(
    /filtered \? `Unmute these \$\{toUnmute\.length\}` : `Unmute all \$\{toUnmute\.length\}`/.test(muteList),
    'the unmute-all label does not distinguish a filtered list from the whole list',
  );
  assert.ok(
    /const toMute = visible\.filter\(\(s\) => !muted\.has\(s\.id\)\)/.test(muteList) &&
      /const toUnmute = visible\.filter\(\(s\) => muted\.has\(s\.id\)\)/.test(muteList),
    'the bulk targets must be derived from the VISIBLE rows and their current mute ' +
      'state, so the number in the label is what will actually change',
  );
});

test('bulk muting is one request, not one per site', () => {
  assert.ok(
    /onChange\(\{ mute: toMute \}/.test(muteList.replace(/\s+/g, ' ')) ||
      /apply\(\{ mute: toMute \}/.test(muteList),
    'the bulk control must hand its whole list to onChange in one call. Muting a ' +
      '300-site campground one request per site is 300 round trips from a phone, and ' +
      'any one of them failing leaves a state nobody can describe.',
  );
  const setMutes = manageRoute.slice(manageRoute.indexOf("case 'setMutes'"));
  assert.ok(setMutes.length, "the manage route has no 'setMutes' op to receive a batch");
  assert.ok(
    /applyMutes\(watchId,/.test(setMutes),
    'the setMutes op does not call applyMutes — the batch write has nowhere to happen',
  );
});

/**
 * BOTH HALVES, because the batch SQL moved out of the route and into `lib/watch-mutes`.
 *
 * A guard that pinned only the route would now go green against a route that no longer
 * writes anything, and a guard that pinned only the helper would go green against a
 * helper nothing calls. Five guards in this repo have needed this correction after an
 * extraction, and the version that passes review is always the inert one.
 */
test('applyMutes writes through mutate(), not query()', () => {
  const helper = strip(read('../src/lib/watch-mutes.ts'));
  assert.ok(
    /export async function applyMutes/.test(helper),
    'applyMutes is gone — the manage route calls something that does not exist',
  );
  assert.ok(
    (helper.match(/await mutate\(/g) ?? []).length >= 2,
    'applyMutes must issue both UPDATEs through mutate(). query() goes to the ' +
      'exec_select RPC and throws on anything data-modifying, every time, forever — and ' +
      'the two are indistinguishable by type because the difference is a string three ' +
      'files away.',
  );
  assert.ok(
    !/\bawait query\(/.test(helper),
    'watch-mutes hands data-modifying SQL to query(), which cannot write',
  );
  assert.ok(
    /COALESCE\(/.test(helper) && (helper.match(/'\{\}'\)/g) ?? []).length >= 2,
    "both statements must COALESCE to '{}'. array_agg over an empty set returns NULL " +
      'and muted_site_ids is NOT NULL, so unmuting the last site would fail the ' +
      'constraint — the case a bulk "unmute all" hits every time.',
  );
});

test('creation and the manage screen validate ids the same way', () => {
  assert.ok(
    /cleanSiteIds\(mutedSiteIds\)/.test(watchesRoute),
    'the watches route rolls its own id validation instead of sharing cleanSiteIds. ' +
      'Two definitions of "a usable site id" is two things that can disagree, and the ' +
      'one that disagrees is the one nobody is looking at.',
  );
  assert.ok(
    /cleanSiteIds\(mute\)/.test(manageRoute) && /cleanSiteIds\(unmute\)/.test(manageRoute),
    'the manage route does not share cleanSiteIds either',
  );
});

/**
 * EVERY PART OF THE PARK STARTS TICKED — and the reason this needs a test is that the
 * correct code was already there and was being overwritten.
 *
 * `pick()` set them all, exactly as its comment claimed. But `pick()` also sets
 * `campgroundId`, which triggers the resolve effect, which set `chosen` to just the
 * representative — a moment later, so it won every time. The comment was true of the line
 * beneath it and false of the screen: searching Leo Carrillo gave "1 of 3 selected", and
 * the owner reported it with a screenshot.
 *
 * That is the inert-fix shape inverted: not a fix that does nothing, but a correct line
 * silently undone by a second writer. Both writers are pinned here, because fixing either
 * one alone leaves the bug.
 */
test('all divisions start ticked, from both paths that set them', () => {
  const calls = [...newWatch.matchAll(/setChosen\(([^;]*?)\);/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'expected setChosen in both pick() and the resolve effect');
  const initialisers = calls.filter((c) => !/prev|new Set\(\)\s*$/.test(c));
  assert.ok(
    initialisers.length >= 2,
    `expected two places to INITIALISE the selection; found ${initialisers.length}`,
  );
  for (const c of initialisers) {
    assert.ok(
      /defaultChosen\(/.test(c),
      'a division selection is initialised without defaultChosen(), so the two paths ' +
        `can disagree about the default — which is the reported bug:\n  setChosen(${c})`,
    );
  }
  assert.ok(
    !/setChosen\(new Set\(\[j\.campground\.id\]\)\)/.test(newWatch),
    'the resolve effect still narrows the selection to the representative division, ' +
      'overwriting pick()\'s all-ticked default milliseconds after it is set',
  );
});

test('the default selection is capped, and the cap is enforced before submit', () => {
  // Three parks exceed MAX_DIVISIONS_PER_WATCH (Grand Lake St. Marys has seventy), and
  // the server 400s over it. Defaulting to all of them would make the very first press
  // of Start watching fail on a limit the user never chose.
  assert.ok(
    /function defaultChosen[\s\S]*?slice\(0, MAX_DIVISIONS_PER_WATCH\)/.test(newWatch),
    'defaultChosen does not cap at MAX_DIVISIONS_PER_WATCH',
  );
  assert.ok(
    /onClick=\{\(\) => setChosen\(defaultChosen\(divisions\)\)\}/.test(newWatch),
    'the "All" button selects every division uncapped, so pressing it on a large park ' +
      'produces a selection the server will refuse',
  );
  assert.ok(
    /const tooManyDivisions =/.test(newWatch) && /tooManyDivisions \|\| gate/.test(newWatch),
    'nothing stops a submit over the cap client-side; a limit you can only discover by ' +
      'pressing the button reads as a bug',
  );
});
