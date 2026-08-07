/**
 * "Did the 8am cycle work?" — the state of every RC day-before hold, in one place.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts --hours=48
 *
 * WHY IT EXISTS. The chain crosses four processes — the Fly poller offers, the user taps
 * on their phone, the mini-PC runner carts and releases, the claim page hands over — and
 * no single log shows all four. Diagnosing a missed 8am from any one of them means
 * guessing at the other three.
 *
 * The column that matters is `status`. `offered` is a question nobody answered, and it is
 * NOT a failure: an unanswered offer must never authorise a cart, which is the whole
 * point of the opt-in. A hold stuck in `requested` past its release time IS a failure —
 * that is the runner being down or unable to reach RC.
 */
import { query } from '../src/lib/db/client';

const hours = Number(process.argv.find((a) => a.startsWith('--hours='))?.split('=')[1] ?? 24);

const pacificNow = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'medium', hour12: false,
}).format(new Date());

const holds = await query<{
  id: string; unit_id: string; unit_name: string | null; arrival: string; nights: number;
  release_at: string; status: string; error: string | null; name: string; email: string;
  offered_at: string; requested_at: string | null; carted_at: string | null;
  claim_started_at: string | null; released_at: string | null; claimed_at: string | null;
}>(
  `SELECT r.id, r.unit_id, r.unit_name, r.arrival_date::text AS arrival, r.nights,
          r.release_at, r.status, r.error, c.name, u.email,
          r.offered_at, r.requested_at, r.carted_at, r.claim_started_at, r.released_at, r.claimed_at
     FROM rc_hold_requests r
     JOIN campgrounds c ON c.id = r.campground_id
     JOIN users u ON u.id = r.user_id
    WHERE r.offered_at > NOW() - ($1 || ' hours')::interval
    ORDER BY r.release_at DESC, r.offered_at DESC`,
  [String(hours)],
);

console.log(`RC holds offered in the last ${hours}h — ${holds.length} row(s). Now: ${pacificNow} PT\n`);
if (!holds.length) {
  console.log('Nothing offered. That is the normal state: it needs a watched RC site to be');
  console.log('cancelled-but-held, for an entitled subscriber, with ≥1h before it releases.');
  process.exit(0);
}

const clock = (t: string | null) => (t ? new Date(t).toISOString().slice(11, 19) + 'Z' : '—');

console.table(holds.map((h) => ({
  site: h.unit_name ?? h.unit_id,
  campground: h.name.slice(0, 26),
  who: h.email.split('@')[0],
  arrival: h.arrival,
  releases: h.release_at.replace('T', ' ').slice(0, 16) + ' PT',
  status: h.status,
  offered: clock(h.offered_at),
  tapped: clock(h.requested_at),
  carted: clock(h.carted_at),
  claimed: clock(h.claimed_at ?? h.released_at),
})));

// The one state that is unambiguously broken: the user said yes, the moment came and
// went, and nothing carted. Everything else has an innocent reading.
const nowPacific = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(new Date()).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});
const nowStr = `${nowPacific.year}-${nowPacific.month}-${nowPacific.day}T${nowPacific.hour === '24' ? '00' : nowPacific.hour}:${nowPacific.minute}:${nowPacific.second}`;

const missed = holds.filter((h) => h.status === 'requested' && h.release_at < nowStr);
if (missed.length) {
  console.log(`\n⚠ ${missed.length} hold(s) were REQUESTED and their release has passed with no cart.`);
  console.log('  That is the runner down, or unable to reach RC. On the mini-PC:');
  console.log('    node rc-hold-runner.mjs --once      (and check rc-keepwarm is not reporting a dead session)');
}
for (const h of holds.filter((x) => x.status === 'failed' && x.error)) {
  console.log(`\n✗ ${h.unit_name ?? h.unit_id}: ${h.error}`);
}
const offered = holds.filter((h) => h.status === 'offered').length;
if (offered) console.log(`\n${offered} offer(s) unanswered — not a fault. Nobody tapped, so nothing was held.`);

process.exit(0);
