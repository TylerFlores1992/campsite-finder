/**
 * WHEN DOES RESERVECALIFORNIA ACTUALLY LET GO OF A LOCKED SITE?
 *
 * ## The question, and why nothing so far could answer it
 *
 * A lock's `availableAt` is a PREDICTION. Everything we know about the real flip comes from
 * the poller's transition alerts, and the poller samples every FIFTEEN SECONDS — so an alert
 * at T+3s means only that the first sample after the flip landed there. The flip is anywhere
 * in (T-12s, T+3s]. Four of our eight clean readings sit inside that blind spot, which is why
 * "RC never releases early" was asserted on 2026-09-03 and then withdrawn: the instrument's
 * resolution swallowed the whole question.
 *
 * The cart path cannot answer it either. The runner has never once asked before T (it waits
 * out `msUntilRelease` by design), so the entire early-cart record is ONE observation, at 85
 * seconds early, refused.
 *
 * ## Why a batch is cheap, which is the whole reason this is worth running
 *
 * One `/search/grid` call returns the WHOLE facility. Measured 2026-09-04: 69 units from
 * rc-539 in a single 0.64s request, and across three Leo Carrillo facilities there were
 * **49 locked nights all releasing at the same instant**. So one poll per facility per tick
 * measures every releasing unit simultaneously, and a single morning yields more flip times —
 * at 2-second resolution — than a month of poller alerts at 15.
 *
 * ## THREE RULES, EACH ONE A WAY THIS COULD LIE
 *
 * 1. **A FAILED POLL IS UNKNOWN, NEVER "FREE".** A 403, a 500, a timeout, an unparseable body
 *    — any of them recorded as availability would manufacture a flip that never happened, at
 *    precisely the moment the answer matters. This is the same rule `hasAvailabilityInRange`
 *    follows by returning `boolean | null`, and the same one `--cart-lapse` had to be given
 *    after `listCartEntries` reported an empty cart for an unreadable one.
 *
 * 2. **A FLIP IS A BRACKET, NOT A POINT.** We can only ever say "still locked at X, free at Y".
 *    Reporting the midpoint as the answer invents precision the cadence does not have — which
 *    is exactly the error that produced the claim this script exists to test.
 *
 * 3. **IT REFUSES A VERDICT IT HAS NOT EARNED.** No locked units at start, or no successful
 *    polls, means THE QUESTION WAS NEVER REACHED — not "nothing released". Same discipline as
 *    `--concurrent-mint`, whose verdict arm was the only thing that caught a run where six
 *    requests never arrived and were about to be written up as a race.
 *
 * ## It talks to RDR DIRECTLY, and that is deliberate
 *
 * `fetchGrid` routes through `/api/rc-proxy` — Vercel — because Fly cannot reach the
 * California RDR host. Using it here would spend hundreds of Vercel invocations from the same
 * lambda IP the poller uses, and RC's WAF meters per IP: the instrument would degrade the
 * thing it is measuring. Verified 2026-09-04 that this sandbox reaches RDR directly (200 in
 * 0.64s), so the run spends nobody's budget but its own.
 *
 * ## Usage
 *
 *   npx tsx scripts/rc-release-window.mts \
 *     --facilities=539,542,583 --release=2026-09-04T08:00:00 --lead=90 --after=240 --every=2000
 *
 * `--release` is RC's own zone-less PACIFIC wall clock, exactly as the Lock field reports it.
 */
import { pacificWallClockToUtcMs } from '../worker/held-cadence';
import { facilityReading, recordFacilityReading, type NightFlip } from '../src/lib/rc-release-readings';

const RDR = 'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr';

const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;

const FACILITIES = (arg('facilities') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RELEASE = arg('release') ?? '';
const LEAD_S = Number(arg('lead', '90'));
const AFTER_S = Number(arg('after', '240'));
const EVERY_MS = Number(arg('every', '2000'));
/**
 * `--record` writes one row per facility to `rc_release_readings` (migration 076) AFTER the
 * reading is printed, so the seven runs of a daily Routine can be read side by side instead
 * of from seven ephemeral transcripts. Needs the database, i.e. NODE_USE_ENV_PROXY=1 — the
 * same variable the polls already need. A run that never reached the question records
 * nothing: an empty day is "not measured", never "RC released nothing".
 */
const RECORD = process.argv.includes('--record');

if (!FACILITIES.length || !RELEASE) {
  console.error('need --facilities=539,542 and --release=2026-09-04T08:00:00');
  process.exit(2);
}

const releaseMs = pacificWallClockToUtcMs(RELEASE);
if (!Number.isFinite(releaseMs)) { console.error(`unparseable --release: ${RELEASE}`); process.exit(2); }

/** A real hold, or .NET's DateTime.MinValue? 94% of Lock fields are the zero date. */
const realLock = (l: unknown) => {
  const y = Number(String(l ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 2000;
};

/** `locked` maps key → the Lock VALUE, because which release a lock names is the filter. */
interface Poll { ok: boolean; free: Set<string>; locked: Map<string, string> }

/** ONE grid read. Returns ok:false for anything we could not read — see rule 1. */
async function poll(facilityId: string, start: string, end: string): Promise<Poll> {
  const free = new Set<string>();
  const locked = new Map<string, string>();
  try {
    const res = await fetch(`${RDR}/search/grid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        FacilityId: facilityId, StartDate: start, EndDate: end,
        UnitSort: 'orderby', IsADA: false, MinVehicleLength: 0, WebOnly: true, RestrictADA: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, free, locked };
    const grid = await res.json() as any;
    const units = grid?.Facility?.Units;
    // An ABSENT grid is not an empty one. RC answers a proxied call with a bare 500 and an
    // empty body for a facility that returns 200 elsewhere; treating that as "no units" would
    // read as every site being free.
    if (!units || typeof units !== 'object') return { ok: false, free, locked };
    for (const u of Object.values(units) as any[]) {
      for (const s of Object.values(u.Slices ?? {}) as any[]) {
        const key = `${u.UnitId}|${String(s.Date).slice(0, 10)}|${u.Name ?? u.UnitId}`;
        if (realLock(s.Lock)) locked.set(key, String(s.Lock).slice(0, 19));
        else if (s.IsFree && !s.IsBlocked) free.add(key);
      }
    }
    return { ok: true, free, locked };
  } catch {
    return { ok: false, free, locked };
  }
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const START = dayOf(releaseMs - 86_400_000);
const END = dayOf(releaseMs + 45 * 86_400_000);

console.log(`RC RELEASE WINDOW — release ${RELEASE} PT, facilities ${FACILITIES.join(', ')}`);
console.log(`  window T-${LEAD_S}s → T+${AFTER_S}s, one poll per facility every ${EVERY_MS}ms\n`);

// ── Phase 1: who is releasing at this instant? ───────────────────────────────
const tracked = new Map<string, { facility: string; name: string; date: string }>();
let unreadable = 0;
for (const f of FACILITIES) {
  const p = await poll(f, START, END);
  if (!p.ok) { console.log(`  rc-${f}: grid unreadable — excluded from this run`); unreadable++; continue; }
  let n = 0, other = 0;
  for (const [key, lock] of p.locked) {
    // ONLY THE UNITS WHOSE LOCK NAMES *THIS* RELEASE — and this really is a filter now.
    // The first draft carried this comment over code that tracked every locked night at the
    // facility. A lock releasing next week never flips inside our window, so it would sit
    // "never freed" for ever and drag the denominator: 21 watched, 3 flipped, and a reader
    // concluding RC only released three. A comment asserting a filter that is not there is
    // the shape this repo records more than any other, and it was in the instrument built
    // to stop exactly that.
    if (lock !== RELEASE.slice(0, 19)) { other++; continue; }
    const [, date, name] = key.split('|');
    tracked.set(key, { facility: `rc-${f}`, name, date });
    n++;
  }
  console.log(`  rc-${f}: ${n} locked night(s) for this release`
    + (other ? ` (${other} more locked for other times — not watched)` : ''));
}

if (tracked.size === 0) {
  // "WE COULD NOT LOOK" AND "THERE IS NOTHING THERE" ARE DIFFERENT ANSWERS, and the first
  // draft printed the second for both. On a run where every grid was unreadable that reads
  // as a finding about RC when it is a finding about us — and the likeliest cause is the
  // one this repo already documents: Node's fetch needs NODE_USE_ENV_PROXY=1, and without
  // it every request fails in a way that looks exactly like an empty facility.
  console.log(unreadable === FACILITIES.length
    ? '\n✗ THE QUESTION WAS NEVER REACHED — EVERY grid was unreadable. That is us, not RC.'
      + '\n  Check NODE_USE_ENV_PROXY=1 first; without it Node fetch cannot reach RDR at all.'
    : '\n✗ THE QUESTION WAS NEVER REACHED — nothing is locked for this release.'
      + '\n  Not a finding about RC. Re-check the --release value against the Lock field.');
  process.exit(0);
}
console.log(`\nwatching ${tracked.size} locked night(s). Waiting for the window…`);

// ── Phase 2: poll across the window ──────────────────────────────────────────
interface Flip { lastLockedAt: number | null; firstFreeAt: number | null; retakenAt: number | null }
const flips = new Map<string, Flip>();
for (const k of tracked.keys()) flips.set(k, { lastLockedAt: null, firstFreeAt: null, retakenAt: null });

let polls = 0, failed = 0;
// Per facility too, because a row is per facility and "0 of 194 unreadable" for the whole run
// hides a facility that answered nothing all window.
const perFacility = new Map<string, { polls: number; failed: number }>();
for (const f of FACILITIES) perFacility.set(`rc-${f}`, { polls: 0, failed: 0 });
const until = releaseMs + AFTER_S * 1000;
const startAt = releaseMs - LEAD_S * 1000;
// CHECK THE END BEFORE SLEEPING TO THE START. Reversed, a window that has already closed
// still parks for however long the START is away — which for a release ten hours out is a
// ten-hour sleep before doing nothing. Found by running it.
if (Date.now() >= until) {
  console.log('the window has already closed — nothing to poll.');
} else {
  if (Date.now() < startAt) {
    console.log(`  sleeping ${((startAt - Date.now()) / 60000).toFixed(1)}m until T-${LEAD_S}s…`);
    await new Promise((r) => setTimeout(r, startAt - Date.now()));
  }

while (Date.now() < until) {
  const tick = Date.now();
  for (const f of FACILITIES) {
    const at = Date.now();
    const p = await poll(f, START, END);
    polls++;
    perFacility.get(`rc-${f}`)!.polls++;
    if (!p.ok) { failed++; perFacility.get(`rc-${f}`)!.failed++; continue; }  // rule 1: unknown, never "free"
    for (const [key, flip] of flips) {
      if (tracked.get(key)!.facility !== `rc-${f}`) continue;
      if (p.locked.has(key)) {
        if (flip.firstFreeAt == null) flip.lastLockedAt = at;
      } else if (p.free.has(key)) {
        if (flip.firstFreeAt == null) flip.firstFreeAt = at;
      } else if (flip.firstFreeAt != null && flip.retakenAt == null) {
        // Neither locked nor free: booked. Only meaningful AFTER we saw it free.
        flip.retakenAt = at;
      }
    }
    // Stagger inside the tick so the facilities do not fire simultaneously.
    await new Promise((r) => setTimeout(r, Math.max(0, Math.floor(EVERY_MS / FACILITIES.length) - (Date.now() - at))));
  }
  const rest = EVERY_MS - (Date.now() - tick);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
}
}

// ── Phase 3: the reading ─────────────────────────────────────────────────────
const rel = (ms: number) => `${ms < releaseMs ? '-' : '+'}${(Math.abs(ms - releaseMs) / 1000).toFixed(1)}s`;
console.log(`\n${polls} poll(s), ${failed} unreadable.\n`);
// THREE OUTCOMES, NOT TWO. "we never polled" and "every poll failed" have different causes
// and different fixes — a window that had already passed versus RC or the network refusing
// us — and collapsing them is how an absent reading becomes a negative.
if (polls === 0) {
  console.log('✗ THE QUESTION WAS NEVER REACHED — the window had already passed, so nothing');
  console.log('  was ever polled. Check --release, --lead and --after against the clock.');
  process.exit(0);
}
if (polls - failed === 0) {
  console.log('✗ THE QUESTION WAS NEVER REACHED — every poll failed. Connectivity, not RC.');
  process.exit(0);
}

const freed = [...flips.entries()].filter(([, f]) => f.firstFreeAt != null);
console.log(`FLIPPED FREE: ${freed.length} of ${tracked.size}`);
for (const [key, f] of freed.sort((a, b) => a[1].firstFreeAt! - b[1].firstFreeAt!)) {
  const t = tracked.get(key)!;
  // Rule 2: a BRACKET. "still locked at X, free by Y" is all the cadence supports.
  const from = f.lastLockedAt ? rel(f.lastLockedAt) : 'before the window';
  console.log(`  ${t.facility} ${t.name} @${t.date}: locked ${from} → free ${rel(f.firstFreeAt!)}`
    + (f.retakenAt ? `  · TAKEN by ${rel(f.retakenAt)}` : ''));
}
const never = tracked.size - freed.length;
if (never) console.log(`\n${never} night(s) never freed inside the window — the lock did not lapse (or lapsed later).`);

if (freed.length) {
  const early = freed.filter(([, f]) => f.firstFreeAt! < releaseMs).length;
  const offsets = freed.map(([, f]) => (f.firstFreeAt! - releaseMs) / 1000).sort((a, b) => a - b);
  console.log(`\nEARLIEST free ${offsets[0].toFixed(1)}s · MEDIAN ${offsets[Math.floor((offsets.length - 1) / 2)].toFixed(1)}s`
    + ` · LATEST ${offsets[offsets.length - 1].toFixed(1)}s  (relative to T)`);
  console.log(early
    ? `\n>>> ${early} night(s) were free BEFORE the predicted release. Firing early is worth it.`
    : '\n>>> Nothing freed before T, at this resolution. The lead can be trimmed toward 0.');
  const taken = freed.filter(([, f]) => f.retakenAt).length;
  console.log(taken
    ? `${taken} of ${freed.length} were taken again inside the window.`
    : 'None was re-taken inside the window — so this run says NOTHING about how fast a\n'
      + 'contested site goes. These are low-demand nights; that reading needs a popular one.');
}

// ── Phase 4: persist, if asked ───────────────────────────────────────────────
// After the printout, never instead of it, and only for a run that reached the question:
// the verdict arms above exit before this point on THE QUESTION WAS NEVER REACHED.
if (RECORD) {
  const toS = (ms: number | null) => (ms == null ? null : (ms - releaseMs) / 1000);
  let stored = 0;
  for (const f of FACILITIES) {
    const facility = `rc-${f}`;
    const nights: NightFlip[] = [];
    for (const [key, flip] of flips) {
      const t = tracked.get(key)!;
      if (t.facility !== facility) continue;
      nights.push({ name: t.name, date: t.date, lockedS: toS(flip.lastLockedAt), freeS: toS(flip.firstFreeAt), retakenS: toS(flip.retakenAt) });
    }
    if (nights.length === 0) continue;                 // excluded in phase 1, or nothing locked
    const pf = perFacility.get(facility) ?? { polls: 0, failed: 0 };
    const reading = facilityReading(facility, nights, pf.polls, pf.failed);
    try {
      await recordFacilityReading(RELEASE, reading);
      stored++;
    } catch (e) {
      console.log(`  ✗ could not record ${facility}: ${(e as Error).message}`);
    }
  }
  console.log(`\nrecorded ${stored} facility row(s) to rc_release_readings for ${RELEASE} — read them with scripts/rc-release-readout.mts`);
}
