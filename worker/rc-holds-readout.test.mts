/**
 * The hold readout must not hide a hold that is about to release.
 *
 * ── THE BUG (2026-08-13) ───────────────────────────────────────────────────────────────
 * `rc-holds-readout.mts` windowed on `offered_at` — "offered in the last 24h". A hold that
 * is still `requested` and MINUTES from its release therefore fell off the list purely
 * because the offer had gone out more than a day earlier. That is precisely the row the
 * readout exists to surface, and it is the row somebody is reading it to find.
 *
 * It showed two of the three holds queued for the 08-13 release; the owner corrected it
 * from the app's watches screen. Nobody would have caught it from the output alone,
 * because a hold that is absent looks exactly like a hold that was never offered — the
 * house failure shape (`status = 'sent'` meaning only "Twilio returned 2xx";
 * `claimBotCommands` returning `[]` for both "nobody asked" and "the query threw").
 *
 * ── WHY IT RUNS THE REAL SCRIPT ────────────────────────────────────────────────────────
 * The defect was one column name in one WHERE clause. Asserting against a copy of that
 * clause would assert the copy. So this inserts a fixture and runs `rc-holds-readout.mts`
 * as the owner runs it, and reads its actual stdout.
 *
 * ── WHY THE FIXTURE IS SAFE ────────────────────────────────────────────────────────────
 * A row with a near-future `release_at` is exactly what `dueHolds` looks for, and `dueHolds`
 * does not care whether the watch is active — so a careless fixture here would have the
 * PRODUCTION runner cart a site. Two independent guards, either one sufficient:
 *   • status is `offered`, and only `requested` ever authorises a cart;
 *   • the unit id is the non-numeric sentinel, which cannot collide with a real RC unit.
 * The fixture watch is dated 2020 as well, so the poller's `end_date > CURRENT_DATE`
 * filter cannot see it.
 *
 * Run: npm test  (real DB, like the other hold suites)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, mutate } from '../src/lib/db/client';

const run = promisify(execFile);

/** Non-numeric on purpose: real RC unit ids are numeric, so this can never name a site. */
const SENTINEL = '__camphawk-verify-DO-NOT-USE__';
const ABOUT_TO_RELEASE = 'TEST · readout-window-ahead';
const LONG_GONE = 'TEST · readout-window-past';
/**
 * 20 hours ago: inside a 24h window, and the fixture that pins the TIME ZONE.
 *
 * `release_at` is Pacific wall-clock text and `NOW()` is UTC, so a bound built without
 * `AT TIME ZONE 'America/Los_Angeles'` is seven hours adrift — still valid SQL, still a
 * plausible-looking clause, and it silently amputates the oldest seven hours of the
 * window. At −20h that skew is the difference between listed and hidden; at the ±3-day
 * margins the other two fixtures use, it is invisible.
 */
const JUST_INSIDE = 'TEST · readout-window-edge';

let watchId: string;

/** RC's own format: Pacific wall-clock, no zone. */
const pacific = (offsetMinutes: number) => {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
};

/** `offered_at` is set well into the past — the whole point is that it must not matter. */
async function seed(unitName: string, releaseAt: string, offeredDaysAgo: number) {
  const [u] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const [c] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'reservecalifornia' ORDER BY id LIMIT 1`);
  assert.ok(u && c, 'needs one user and one RC campground to hang a fixture off');
  await mutate(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights,
        release_at, status, offered_at)
     VALUES ($1, $2, $3, $4, $5, '2026-12-15', 1, $6, 'offered',
             NOW() - ($7 || ' days')::interval)`,
    [watchId, u.id, c.id, `${SENTINEL}-${unitName.slice(-4)}`, unitName, releaseAt,
     String(offeredDaysAgo)],
  );
}

before(async () => {
  const [u] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const [c] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'reservecalifornia' ORDER BY id LIMIT 1`);
  assert.ok(u && c);
  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [u.id, c.id],
  );
  watchId = w.id;

  // Offered THREE DAYS ago, releasing in twenty minutes. Under the old window this row was
  // invisible at the one moment it mattered.
  await seed(ABOUT_TO_RELEASE, pacific(20), 3);
  // Offered three days ago and released three days ago: genuinely out of a 24h window, and
  // the reason the window exists at all. If this shows up, the window has stopped bounding.
  await seed(LONG_GONE, pacific(-3 * 24 * 60), 3);
  // Released 20h ago — comfortably inside 24h, and outside it by the width of a missing
  // time-zone conversion.
  await seed(JUST_INSIDE, pacific(-20 * 60), 3);
});

after(async () => {
  if (!watchId) return;
  await mutate(`DELETE FROM rc_hold_requests WHERE watch_id = $1`, [watchId]).catch(() => {});
  await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]).catch(() => {});
});

async function readout(): Promise<string> {
  const { stdout } = await run(
    'npx', ['tsx', 'scripts/rc-holds-readout.mts'],
    { cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

test('a hold offered days ago but releasing in minutes is still listed', async () => {
  const out = await readout();
  assert.ok(
    out.includes(ABOUT_TO_RELEASE),
    'THE BUG: a hold minutes from its release vanished because the OFFER was old.\n' +
    'The readout must window on release_at, never offered_at.\n\n' + out,
  );
});

test('a hold whose release passed long ago is still bounded out', async () => {
  const out = await readout();
  assert.ok(
    !out.includes(LONG_GONE),
    'the window must still bound: a release three days past has no business in a 24h view.\n\n' + out,
  );
});

test('the window bound is Pacific, so a release 20h ago is inside 24h', async () => {
  const out = await readout();
  assert.ok(
    out.includes(JUST_INSIDE),
    'a release 20h ago belongs in a 24h window. Losing it means the bound was built from\n' +
    'a bare NOW() (UTC) and compared against Pacific wall-clock text — seven hours adrift.\n\n' + out,
  );
});

test('--hours widens the window on the release, not on the offer', async () => {
  const { stdout } = await run(
    'npx', ['tsx', 'scripts/rc-holds-readout.mts', '--hours=96'],
    { cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      maxBuffer: 8 * 1024 * 1024 },
  );
  assert.ok(stdout.includes(LONG_GONE),
    '--hours must reach further back through RELEASE times; at 96h a 3-day-old release is in range.\n\n' + stdout);
});
