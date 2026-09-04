/**
 * Queue a hold that carts RIGHT NOW, so the hand-off can be tested without waiting for 8am.
 *
 * ## Why this exists
 *
 * The two RC cart POSTs are the last unproven link in the whole auto-cart chain, and until
 * now the only way to exercise them was a real 08:00 release — a few mornings a month, and
 * the single worst moment to discover a problem. `/api/admin/test-claim` already opens the
 * claim screen for a hold that is *already* carted; nothing could produce one on demand.
 *
 * Nothing new is needed to do it. `dueHolds` selects `requested` rows whose `release_at` is
 * within `leadSeconds` ahead and `graceMinutes` behind — it does not care whether that time
 * is 08:00 or two minutes from now — and the runner's `msUntilRelease` wait is already
 * clamped at zero for a time that has passed. So a row with a release time a couple of
 * minutes out is picked up on the runner's next poll and carted immediately.
 *
 * ## What it proves, and what it does not
 *
 * With a REAL numeric unit id on a genuinely available site, this exercises the entire
 * chain end to end: the runner's precart, `load` + `submit`, the cart read-back, the claim
 * screen, `token captured`, the release, and the client's own recapture. That is the whole
 * open question.
 *
 * With the non-numeric sentinel (`--unit __camphawk-verify-DO-NOT-USE__`) it proves only
 * the screen and the sign-in — the cart will fail, which is the point: nothing real is
 * locked. Use that first if you only want to see the flow.
 *
 * ## SAFETY — a real unit id locks a real campsite
 *
 * RC takes the unit off the market until the cart is released or lapses (~15 min). So:
 *   • pick a site nobody is competing for — far-future date, midweek, unpopular loop;
 *   • never invent a unit id. An invented number can collide with a real site. Take it
 *     from a live availability grid or from an alert link's `#camphawk-rc=` fragment;
 *   • finish the claim, or `--release` it, rather than walking away mid-test.
 *
 * It refuses to run while a REAL hold is queued, because a test cart consumes a seat in the
 * cart the bot would otherwise hold that user's site with.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --find
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --list
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts \
 *     --unit 45725 --arrival 2026-12-15 --nights 1
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --delete <id>
 *
 * `--find` exists because "never invent a unit id" is the one instruction here whose
 * failure mode is locking a stranger's campsite, and it was left to a human with no tool
 * to obey it. It asks RC's own grid which units are genuinely bookable on a far-future
 * midweek night, so the id is copied rather than guessed.
 */
import { query, mutate } from '@/lib/db/client';
import { manageTokenFor } from '@/lib/notifications/actions';
import { fetchGrid, USEDIRECT_PROVIDERS, facilityIdFromCampgroundId }
  from '@/lib/sources/reservecalifornia/client';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
/** Marks a row as ours, so `--list` and `--delete` can never touch a real user's hold. */
const MARK = 'TEST · ';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const has = (name: string) => argv.includes(`--${name}`);

/** RC's own format: Pacific wall-clock, no zone. Never `new Date().toISOString()` — that
 *  is UTC, and `dueHolds` compares against Pacific, so a UTC string is seven hours wrong. */
function pacific(offsetMinutes: number): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

async function list() {
  const rows = await query<Record<string, string>>(
    `SELECT id, unit_id, unit_name, arrival_date::text AS arrival_date, release_at, status, error
       FROM rc_hold_requests WHERE unit_name LIKE $1 ORDER BY updated_at DESC LIMIT 10`,
    [`${MARK}%`],
  );
  if (!rows.length) return console.log('No test holds.');
  for (const r of rows) {
    console.log(`${r.id}  ${String(r.status).padEnd(9)} unit ${String(r.unit_id).padEnd(12)} ` +
      `release ${r.release_at}${r.error ? `  — ${String(r.error).slice(0, 60)}` : ''}`);
  }
}

/**
 * Which units are actually bookable, for each RC campground we watch?
 *
 * Deliberately far-future and midweek: a site nobody is competing for is one whose loss
 * for the length of a test costs nobody anything. It prints the `--unit`/`--arrival` pair
 * ready to paste, and the watch id, because a unit only means anything inside the
 * campground its watch points at.
 *
 * SLICES ARE KEYED "2026-12-01T00:00:00", NOT "2026-12-01". Indexing the map by the bare
 * date silently matches nothing, and "no availability anywhere in California in December"
 * looks enough like a sold-out season to be believed — it was, for a few minutes, while
 * writing this. Read `slice.Date`, exactly as `lib/availability/reservecalifornia.ts` does.
 */
/**
 * How many unit ids `--find` prints per campground. `--show 8` for a --cart-ladder run.
 * Clamped: a huge list is just noise, and one is not enough to be useful.
 */
const showCount = Math.min(20, Math.max(1, Number(
  process.argv[process.argv.indexOf('--show') + 1] ?? 4,
) || 4));

async function find() {
  const rc = USEDIRECT_PROVIDERS.find((p) => p.idPrefix === 'rc')!;
  const dates = (flag('dates') ?? '2026-12-01,2026-12-08,2027-01-12').split(',');
  const watches = await query<{ watch_id: string; cg_id: string; name: string }>(
    `SELECT DISTINCT ON (c.id) w.id AS watch_id, c.id AS cg_id, c.name
       FROM watches w JOIN campgrounds c ON c.id = w.campground_id
      WHERE w.active AND c.source = 'reservecalifornia'
      ORDER BY c.id, w.created_at DESC`,
  );
  if (!watches.length) return console.log('No active ReserveCalifornia watches.');

  for (const w of watches) {
    for (const date of dates) {
      const end = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
      let grid;
      try {
        grid = await fetchGrid(rc, facilityIdFromCampgroundId(w.cg_id), date, end);
      } catch (err) {
        console.log(`  ! ${w.name.slice(0, 32)} ${date}: ${(err as Error).message.slice(0, 60)}`);
        continue;
      }
      const free = Object.values(grid.Facility?.Units ?? {}).filter((u) => {
        if (!u.AllowWebBooking || !u.IsWebViewable) return false;
        const s = Object.values(u.Slices ?? {}).find((x) => x.Date === date);
        // `Lock` set means cancelled-but-held — the very thing the 8am flow races for, so
        // the worst possible choice for a test that must disturb nobody.
        return !!s && s.IsFree && !s.IsBlocked && !s.IsWalkin && !s.Lock
          && !s.ReservationId && (s.MinStay ?? 1) <= 1;
      });
      if (!free.length) continue;
      console.log(`\n${w.name}`);
      console.log(`  --watch ${w.watch_id}   (${free.length} bookable on ${date})`);
      // HOW MANY TO PRINT. Four is right for queueing one test hold, and WRONG for
      // `rc-probe.mjs --cart-ladder`, which needs six at an absolute minimum and does
      // better with eight — every refusal it has to disambiguate spends one more.
      //
      // A tool that shows fewer ids than the caller needs pushes them toward inventing
      // one, which is the single instruction here whose failure mode is locking a
      // stranger's campsite, and the whole reason `--find` exists. So it is a flag.
      for (const u of free.slice(0, showCount)) {
        console.log(`    --unit ${String(u.UnitId).padEnd(7)} --arrival ${date}    ${u.Name}`);
      }
      // Ready to paste into the ladder, which wants them comma-separated in one string.
      if (showCount > 4) {
        console.log(`    RC_CAP_UNITS=${free.slice(0, showCount).map((u) => u.UnitId).join(',')}`);
      }
      break;
    }
  }
  console.log('\nPrefer a campground with MANY free — locking one of fifty disturbs nobody.');
}

async function main() {
  if (has('list')) return list();
  if (has('find')) return find();

  const del = flag('delete');
  if (del) {
    // Scoped to marked rows. A mistyped id must not be able to delete a real hold.
    const gone = await mutate<{ id: string }>(
      `DELETE FROM rc_hold_requests WHERE id = $1 AND unit_name LIKE $2 RETURNING id`,
      [del, `${MARK}%`],
    );
    console.log(gone.length ? `Deleted ${del}.` : `No TEST hold with id ${del} (real holds are not deletable here).`);
    return;
  }

  const unit = flag('unit');
  const arrival = flag('arrival');
  if (!unit || !arrival) {
    console.error('Need --unit <id> and --arrival YYYY-MM-DD. See the header. --list / --delete <id> also work.');
    process.exitCode = 1;
    return;
  }
  const nights = Number(flag('nights') ?? 1);
  const inMin = Number(flag('in') ?? 2);

  // REFUSE OVER A REAL HOLD. The bot's cart has a hard ceiling of two sites (measured
  // 2026-08-13) and every hold currently shares one cart, so a test cart can take the seat
  // a paying user's site would have gone into.
  const real = await query<Record<string, string>>(
    `SELECT id, unit_name, release_at, status FROM rc_hold_requests
      WHERE status IN ('requested', 'carted', 'claiming')
        AND unit_name NOT LIKE $1
      ORDER BY release_at LIMIT 5`,
    [`${MARK}%`],
  );
  if (real.length) {
    console.error(`REFUSING — ${real.length} real hold(s) are live right now:`);
    for (const r of real) console.error(`  ${r.status} ${r.unit_name ?? ''} releasing ${r.release_at}`);
    console.error('A test cart would consume a seat in the cart those need. Wait until they clear.');
    process.exitCode = 1;
    return;
  }

  // `watches` HAS NO `updated_at` — it has `created_at`. Ordering by the former threw
  // `column w.updated_at does not exist` on every run that reached here, which is to say
  // every run that was not refused first. The refusal above is why it shipped unnoticed:
  // the only previous run had a live hold and exited one step earlier, so the first line
  // of this script's actual job had never executed.
  const watchId = flag('watch') ?? (await query<{ id: string }>(
    `SELECT w.id FROM watches w JOIN campgrounds c ON c.id = w.campground_id
      WHERE w.active AND c.source = 'reservecalifornia' ORDER BY w.created_at DESC LIMIT 1`,
  ))[0]?.id;
  if (!watchId) {
    console.error('No active ReserveCalifornia watch to hang a test hold off. Pass --watch <id>.');
    process.exitCode = 1;
    return;
  }
  const [w] = await query<{ user_id: string; campground_id: string; name: string }>(
    `SELECT w.user_id, w.campground_id, c.name FROM watches w
       JOIN campgrounds c ON c.id = w.campground_id WHERE w.id = $1`, [watchId],
  );
  if (!w) { console.error(`No watch ${watchId}.`); process.exitCode = 1; return; }

  const releaseAt = pacific(inMin);
  // Inserted straight as `requested`. `offered` is a question nobody answered and the bot
  // correctly refuses to cart one — going through the tap would only add a step that is
  // already covered by its own tests.
  const [row] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights, release_at,
        status, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', NOW())
     -- FOUR COLUMNS SINCE MIGRATION 074, and release_at can no longer be the thing
     -- being SET because it is part of the key. Re-running this script with a new offset
     -- therefore inserts a fresh row rather than recycling the last one, which is the
     -- correct reading now: two different release times are two different test holds, and
     -- the old row expires on its own. Left as an upsert so a re-run at the SAME offset
     -- within the same second is still idempotent.
     ON CONFLICT (watch_id, unit_id, arrival_date, release_at) DO UPDATE
       SET status = 'requested', requested_at = NOW(),
           carted_at = NULL, cart_key = NULL, cart_entry_key = NULL, error = NULL,
           updated_at = NOW()
     RETURNING id`,
    [watchId, w.user_id, w.campground_id, unit, `${MARK}${unit}`, arrival, String(nights), releaseAt],
  );

  const token = await manageTokenFor(watchId);
  const numeric = /^\d+$/.test(unit);
  console.log(`\nQueued test hold ${row.id}`);
  console.log(`  ${w.name} · unit ${unit} · arrive ${arrival} · ${nights} night(s)`);
  console.log(`  releases ${releaseAt} PT (${inMin} min from now)`);
  console.log(numeric
    ? '\n  REAL unit id — this will LOCK that site until the claim releases it or RC drops\n' +
      `  the cart (~15 min). Release it from the claim screen, or run --delete ${row.id}\n` +
      '  and clear the cart by hand if you abandon the test.'
    : '\n  Sentinel unit id — the cart WILL fail, by design. This tests the claim screen and\n' +
      '  the sign-in only, and cannot lock a real site.');
  console.log('\nNext:');
  console.log(`  1. the runner polls every ~15s; it should cart within a minute of ${releaseAt}`);
  console.log('  2. watch it:  NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts');
  console.log('  3. claim screen — OPEN IT IN THE APP, or canInject is false and the injected');
  console.log('     precart is never exercised (Admin → System Health → "Open the claim screen",');
  console.log('     which finds whatever is carted):');
  console.log(token ? `       ${APP_URL}/claim/${row.id}?t=${token}` : '       (could not mint a manage token — use the admin button)');
  console.log('\n  The answer to look for is in client_reports: a `load` and a `submit` stage, and');
  console.log('  "✓ Added to cart". `token captured` as the last line is NOT a successful cart.');
  console.log(`\n  Clean up:  npx tsx scripts/rc-test-hold.mts --delete ${row.id}\n`);
}

await main();
