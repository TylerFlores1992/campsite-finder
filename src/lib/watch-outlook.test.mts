import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { watchOutlook, OUTLOOK_QUIET_LEAD_DAYS, outlookBody, OUTLOOK_HEADING } from './watch-outlook';

/**
 * Guards for the "this will be quiet for a while" note.
 *
 * HALF OF THESE ARE STRUCTURAL ON PURPOSE. `watchOutlook` can be perfect while the
 * route rounds an unreadable portal to "nothing is free", or drops `user_id` from its
 * WHERE clause, or the component renders the note on a failed fetch — and then the
 * decision is right, inert, and looks correct in review. That is the shape this repo
 * has paid for repeatedly, most recently in the four hold-offer guards that pinned
 * `mayHold` and would have passed against a poller that had stopped checking anything.
 */

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ROUTE = () => src('../app/api/watches/[id]/outlook/route.ts');
const COMPONENT = () => src('../components/v2/NewWatchOutlook.tsx');
const POLLER = () => readFileSync(new URL('../../worker/poller.ts', import.meta.url), 'utf8');
/** Comments explain the traps, so a structural guard that reads them can be satisfied
 *  by an explanation of the bug rather than by the fix. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FAR = OUTLOOK_QUIET_LEAD_DAYS + 1;

test('a booked-out stay far enough off gets the note', () => {
  assert.deepEqual(watchOutlook({ leadDays: FAR, available: false }), { show: true, silent: null });
});

test('AVAILABLE NOW IS SILENT — do not tell someone to wait for a site they can book', () => {
  const r = watchOutlook({ leadDays: 90, available: true });
  assert.equal(r.show, false);
  assert.equal(r.silent, 'already-available');
});

test('UNKNOWN NEVER ROUNDS TO "nothing is free"', () => {
  // The 2026-07-31 rule: null is "we never found out", and reading it as booked solid
  // is what rendered fifteen live Moab campgrounds as full. Here it would tell someone
  // to settle in for a long wait about a stay they could book in thirty seconds.
  const r = watchOutlook({ leadDays: 90, available: null });
  assert.equal(r.show, false);
  assert.equal(r.silent, 'availability-unknown');
});

test('a trip inside the quiet window says nothing', () => {
  for (const lead of [0, 1, 7, OUTLOOK_QUIET_LEAD_DAYS]) {
    const r = watchOutlook({ leadDays: lead, available: false });
    assert.equal(r.show, false, `lead ${lead} should be silent`);
    assert.equal(r.silent, 'arriving-soon');
  }
});

test('THE BOUNDARY IS EXCLUSIVE, so the gate cannot drift by a day unnoticed', () => {
  assert.equal(watchOutlook({ leadDays: OUTLOOK_QUIET_LEAD_DAYS, available: false }).show, false);
  assert.equal(watchOutlook({ leadDays: OUTLOOK_QUIET_LEAD_DAYS + 1, available: false }).show, true);
});

test('AVAILABILITY OUTRANKS LEAD TIME, both ways', () => {
  // Order matters: if the lead gate were checked first, a bookable stay 90 days out
  // would get the "settle in and wait" note.
  assert.equal(watchOutlook({ leadDays: 365, available: true }).show, false);
  assert.equal(watchOutlook({ leadDays: 1, available: true }).show, false);
});

test('THE COPY MAY NAME THE WINDOW AND MAY NOT QUANTIFY IT', () => {
  // THIS GUARD WAS INVERTED ON 2026-09-04, DELIBERATELY. It used to assert that the
  // copy promised NO lead-time cliff, on the strength of our roster showing 6-8 weeks
  // out busier than 2-3 weeks out. That reading was wrong about the question: the
  // roster put 1,073 checks inside 13 days against 121,433 in the two bands it did
  // sample, so it never measured the window the claim is about. External data does —
  // Campsite Tonight's ~32,000 Yosemite reservations show a 27% cancellation spike in
  // the seven days before check-in — and RC's 7-day refund cliff is a mechanism for it.
  // See the header of watch-outlook.ts for the full sourcing.
  //
  // WHAT IS STILL FORBIDDEN IS A NUMBER. Nothing we hold licenses a probability, and a
  // percentage in this note would be the one sentence a disappointed user quotes back.
  const body = `${OUTLOOK_HEADING} ${outlookBody(40)}`.toLowerCase();
  for (const claim of ['unlikely', 'no chance', "won't happen", 'never', '%', 'odds', 'chance of', 'guarantee']) {
    assert.ok(!body.includes(claim), `the copy must not quantify or promise: found "${claim}"`);
  }
  assert.ok(!/\d+ *(percent|in \d)/.test(body), 'no rate, in any spelling');

  // REQUIRED. The timing claim is the thing the owner asked for and the thing the
  // external evidence supports; dropping it silently would leave the note saying only
  // "it may be quiet", which is what it said before anyone went and checked.
  assert.ok(body.includes('week or two'), 'the copy must name the window cancellations cluster in');
  assert.ok(body.includes('cancels'), 'the copy must say an opening depends on a cancellation');
  assert.ok(body.includes('15 seconds'), 'the copy must say we are still checking');
});

test('the body names the trip, so it cannot read as boilerplate', () => {
  assert.ok(outlookBody(42).includes('6 weeks'));
  assert.ok(outlookBody(20).includes('3 weeks'));
});

test('STRUCTURAL: the route scopes the watch to the caller', () => {
  const c = code(ROUTE());
  assert.ok(/WHERE w\.id = \$1 AND w\.user_id = \$2/.test(c),
    'the id comes off a URL — without user_id this reports on any watch whose id is guessed');
});

test('STRUCTURAL: an unreadable division makes the whole answer unknown', () => {
  const c = code(ROUTE());
  assert.ok(/if \(open == null\) available = null;/.test(c),
    'a park watch division we could not read must not be counted as "nothing free"');
  assert.ok(/if \(open === true\) \{ available = true; break; \}/.test(c),
    'one bookable division means go and book — a true has to win');
  assert.ok(c.indexOf('available = true; break;') < c.indexOf('if (open == null) available = null;'),
    'the true short-circuit must come first, or a later null erases it');
});

test('STRUCTURAL: a throwing probe is unknown, not "fully booked"', () => {
  const c = code(ROUTE());
  const m = /catch \(err\)[\s\S]{0,240}?open = null;/.exec(c);
  assert.ok(m, 'a probe that throws must produce null, not false');
});

test('STRUCTURAL: the component renders nothing without a created-watch id', () => {
  const c = code(COMPONENT());
  assert.ok(/const id = new URLSearchParams\(window\.location\.search\)\.get\("new"\);/.test(c));
  assert.ok(/if \(!id\) return;/.test(c), 'no ?new= means no note at all');
  assert.ok(/if \(!note\) return null;/.test(c), 'silence is the default render');
  assert.ok(/j\?\.show/.test(c), 'the server decides whether to show it, not the component');
  assert.ok(/\.catch\(\(\) => \{\}\)/.test(c), 'a failed fetch must be silent, never a note');
});

test('STRUCTURAL: the component is actually mounted', () => {
  // A perfect component nobody renders is the fix-present-and-inert shape.
  const list = code(readFileSync(new URL('../components/v2/WatchesList.tsx', import.meta.url), 'utf8'));
  assert.ok(/<NewWatchOutlook\b/.test(list), 'NewWatchOutlook is not rendered by WatchesList');
});

test('STRUCTURAL: the create flow passes the id across', () => {
  const nw = code(readFileSync(new URL('../components/v2/NewWatch.tsx', import.meta.url), 'utf8'));
  assert.ok(/\/watches\?new=\$\{encodeURIComponent\(created\.id\)\}/.test(nw),
    'without the id on the URL the note can never fire');
  assert.ok(/created\?\.id \? /.test(nw),
    'a response with no id must still navigate — the note is a hint, not a precondition');
});

test('STRUCTURAL: the poller uses the extracted probe rather than a private copy', () => {
  // The extraction exists so a web route can ask the same question. If the poller kept
  // its own copy the two would drift, and the drift would be invisible: both would look
  // right, and only one of them decides what a user is told.
  const p = code(POLLER());
  assert.ok(/import \{ wholeStayOpen \} from '\.\.\/src\/lib\/availability\/whole-stay';/.test(p));
  assert.ok(/await wholeStayOpen\(/.test(p), 'the poller must call the extracted function');
  assert.ok(!/async function probeWholeStayOpen/.test(p), 'the old private copy is back');
});
