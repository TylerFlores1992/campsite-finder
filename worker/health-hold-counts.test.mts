/**
 * A CI RUN MUST NOT TURN `autocart.rc_session` RED.
 *
 * `npm test` hits the production database on purpose, so CI on any pull request briefly
 * inserts non-terminal `rc_hold_requests` rows. On 2026-08-23 that flipped the check from
 * warn to **fail** with the detail *"run mini-pc\rc-login.bat … 4 hold(s) ahead and the
 * next is within 25 min"*. Ninety seconds later there were zero holds.
 *
 * THE COST IS THE REMEDY IT PRINTS, NOT THE COLOUR. `rc-login.bat` force-kills the Chromium
 * the RC token lives in — so the check told a human to destroy a session with nothing wrong
 * with it, on the one page whose job is "is anything broken?", and it is the check a 07:30
 * pre-flight Routine reads. That is the 2026-08-16 cry-wolf reached by a new route.
 *
 * THE FIX WAS A RULE ALREADY APPLIED ELSEWHERE. `REAL_UNIT` (`unit_id ~ '^[0-9]+$'`) went
 * into `nextHoldRelease` and `holdAtRisk` on 2026-08-18, so a fixture could no longer make
 * the bot sign in or ring the owner's phone. The health route carried FIVE hand-rolled
 * copies of the same question and none of them got it — a rule applied to one consumer and
 * not to its siblings, which is the shape this repo keeps paying for.
 *
 * REAL DB for the predicate, because the fix IS one clause inside SQL and a test asserting
 * a copy of the clause would assert the copy. STRUCTURAL for the route, because the danger
 * is a SIXTH inline count appearing, and no behavioural test can see one that has not been
 * written yet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import { holdsAhead, holdsDueWithin } from '../src/lib/rc-holds';

/** Namespaced to this suite — three older suites sweep `LIKE '__t%'` globally (issue #76). */
const FIXTURE = '__thc0001';
const REAL = '999000111';
const USER = 'test-health-counts-user';
const WATCH = 'test-health-counts-watch';
let campgroundId = '';

/** Pacific wall-clock, N minutes out — the shape `release_at` is compared against. */
function pacific(minutesFromNow: number): string {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

async function sweep() {
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id IN ($1, $2)`, [FIXTURE, REAL]);
  await mutate(`DELETE FROM watches WHERE id = $1`, [WATCH]);
  await mutate(`DELETE FROM users WHERE id = $1`, [USER]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $2)`,
    [USER, 'health-counts@camphawk.invalid']);
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1, $2, $3, '2020-01-01', '2020-01-03', true, '2020-01-01T00:00:00Z')`,
    [WATCH, USER, campgroundId]);
});
after(sweep);

async function hold(unit: string, minutesOut: number) {
  await mutate(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1, $2, $3, $4, '2030-06-05', 1, $5, 'requested')`,
    [WATCH, USER, campgroundId, unit, pacific(minutesOut)]);
}

test('A TEST FIXTURE IS INVISIBLE TO BOTH COUNTS — the 08-23 false alarm', async () => {
  const aheadBefore = await holdsAhead();
  const dueBefore = await holdsDueWithin(10);

  // The exact thing CI inserts: a non-numeric sentinel unit, imminent.
  await hold(FIXTURE, 5);

  assert.equal(await holdsAhead(), aheadBefore,
    'a fixture must not count as a hold ahead — it is what turned autocart.rc_session red');
  assert.equal(await holdsAhead(25), aheadBefore,
    'nor as an IMMINENT one, which is the count that drives the fail level');
  assert.equal(await holdsDueWithin(10), dueBefore,
    'nor as one the runner has failed to cart');
});

test('A REAL HOLD IS STILL COUNTED — the filter must not blind the check entirely', async () => {
  // The dangerous over-correction: `AND false` would pass every negative assertion above
  // and switch off the whole morning's health reporting.
  const aheadBefore = await holdsAhead();
  const dueBefore = await holdsDueWithin(10);
  await hold(REAL, 5);
  assert.equal(await holdsAhead(), aheadBefore + 1, 'a numeric unit id is a real hold');
  assert.equal(await holdsAhead(25), aheadBefore + 1, 'and it is imminent');
  assert.equal(await holdsDueWithin(10), dueBefore + 1);
});

test('THE BOUND IS A BOUND — a hold far out is ahead but not imminent', async () => {
  // Why the bounded count exists at all: the token lives ~60 min, so the session is
  // legitimately dead most of the day. Counting any hold at all made this check FAIL every
  // night between tapping a hold and the morning it released.
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id = $1`, [REAL]);
  const aheadBefore = await holdsAhead();
  const soonBefore = await holdsAhead(25);
  await hold(REAL, 600);
  assert.equal(await holdsAhead(), aheadBefore + 1, 'ten hours out is still ahead');
  assert.equal(await holdsAhead(25), soonBefore, 'but it is NOT within 25 minutes');
});

// ---------------------------------------------------------------------------
// STRUCTURAL. The predicate can be perfect and a sixth copy appear next to it — which is
// precisely how this bug was born, from a rule applied to two consumers and not to five.
// ---------------------------------------------------------------------------

const route = readFileSync(
  new URL('../src/app/api/health/status/route.ts', import.meta.url), 'utf8');

test('THE HEALTH ROUTE COUNTS NO HOLDS OF ITS OWN', () => {
  // Comments are stripped first: the note left at the old sites quotes the table name to
  // explain what was removed, and a guard that fails on its own explanation gets "fixed"
  // by deleting the explanation.
  const code = route.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.doesNotMatch(code, /FROM\s+rc_hold_requests/i,
    'the health route must ask `holdsAhead`/`holdsDueWithin`, never SQL of its own — an '
    + 'unfiltered count here turns the check red on a CI fixture and prints rc-login.bat, '
    + 'which force-kills the Chromium holding the RC token');
  assert.match(code, /import \{[^}]*\bholdsAhead\b[^}]*\} from '@\/lib\/rc-holds'/,
    'and it must import the shared definition');
});

test('BOTH HELPERS CARRY REAL_UNIT — the filter is in the definition, not the callers', () => {
  const src = readFileSync(new URL('../src/lib/rc-holds.ts', import.meta.url), 'utf8');
  for (const fn of ['holdsAhead', 'holdsDueWithin']) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start > -1, `${fn} must exist`);
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /\$\{REAL_UNIT\}/,
      `${fn} must filter fixtures out itself — a caller-side filter is how five copies drifted`);
  }
});
