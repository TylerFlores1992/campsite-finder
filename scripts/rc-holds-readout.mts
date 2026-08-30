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
 *
 * IT WINDOWS ON `release_at`, NOT `offered_at`, and that is the whole point of the window.
 * It used to ask "offered in the last 24h", which drops a hold that is still `requested`
 * and MINUTES from releasing, purely because the offer went out more than a day earlier —
 * i.e. it hid exactly the row it exists to surface. Caught 2026-08-13, when it showed two
 * of the three holds queued for that morning and the owner corrected it from the app's
 * watches screen. A window on `release_at` cannot do that: a release in the future is
 * always in range, so a hold can only leave the list once its moment has passed.
 *
 * `release_at` is RC's own zone-less Pacific wall-clock TEXT, so the bound is built with
 * `to_char(... AT TIME ZONE 'America/Los_Angeles')` like every other call site. Comparing
 * it against a bare `NOW()` would be seven hours wrong — which at a 24h window is a whole
 * extra morning of holds, silently.
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
  last_attempt_at: string | null; last_attempt_note: string | null;
  client_last_stage: string | null; client_last_note: string | null; client_reported_at: string | null;
  client_reports: Array<{ stage: string; detail: Record<string, unknown> | null }> | null;
  client_platform: string | null; client_app_build: string | null;
  cart_lag_s: number | null;
}>(
  `SELECT r.id, r.unit_id, r.unit_name, r.arrival_date::text AS arrival, r.nights,
          r.release_at, r.status, r.error, c.name, u.email,
          r.offered_at, r.requested_at, r.carted_at, r.claim_started_at, r.released_at, r.claimed_at,
          r.last_attempt_at, r.last_attempt_note,
          r.client_last_stage, r.client_last_note, r.client_reported_at::text,
          r.client_reports, r.client_platform, r.client_app_build,
          -- HOW LATE THE CART WAS, in seconds after the release.
          --
          -- Computed HERE and not in JS because release_at is zone-less PACIFIC wall-clock
          -- text while carted_at is a real UTC timestamp -- the trap this file's header
          -- already names. Subtracting them in JS needs a Pacific offset, and any hardcoded
          -- one is wrong on the other side of a DST boundary; Postgres owns those rules.
          EXTRACT(EPOCH FROM (
            r.carted_at - (r.release_at::timestamp AT TIME ZONE 'America/Los_Angeles')
          ))::int AS cart_lag_s
     FROM rc_hold_requests r
     JOIN campgrounds c ON c.id = r.campground_id
     JOIN users u ON u.id = r.user_id
    WHERE r.release_at > to_char((NOW() - ($1 || ' hours')::interval)
                                 AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
    ORDER BY r.release_at DESC, r.offered_at DESC`,
  [String(hours)],
);

// The bot's session, which is upstream of every row above. A hold cannot be carted by a
// runner whose RC session is dead, and until migration 046 that fact lived only in a
// console on the mini-PC — so a readout could show a stalled hold and give no hint why.
const [session] = await query<{
  session_ok: boolean | null; session_at: string | null; session_since: string | null;
  session_live_since: string | null;
  session_detail: string | null; session_source: string | null; beat_at: string | null;
}>(
  `SELECT session_ok, session_at::text, session_since::text, session_live_since::text,
          session_detail, session_source, beat_at::text
     FROM rc_runner_heartbeat WHERE id = 1`,
).catch(() => []);

console.log(`RC holds releasing since ${hours}h ago (and every one still ahead) — ` +
  `${holds.length} row(s). Now: ${pacificNow} PT\n`);

// Printed BEFORE the table and even when there are no holds: a dead session with nothing
// queued is the cheapest possible moment to fix it, and the only one where a human has
// time. RC serves a reCAPTCHA on sign-in now, so this always needs a person.
/** Mirrors RC_AUTOLOGIN_LEAD_MIN in rc-keepwarm.mjs; pinned by worker/autologin-lead.test.mts. */
const RC_AUTOLOGIN_LEAD_MIN = Number(process.env.RC_AUTOLOGIN_LEAD_MIN || 30);

const mins = (t: string | null) => (t ? Math.round((Date.now() - new Date(t).getTime()) / 60000) : null);
/** "7h20m". These durations run to hours and the whole question is how many. */
const hms = (t: string | null) => {
  const m = mins(t);
  if (m == null) return 'an unknown time';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
/** How long the last session survived: sign-in → death. The number the design turns on. */
const lifetime = (from: string | null, to: string | null) => {
  if (!from || !to) return 'an unmeasured time';
  const m = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);
  if (m < 0) return 'an unmeasured time';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
if (!session || session.session_ok == null) {
  console.log('RC session: UNKNOWN — never reported. Is rc-keepwarm.mjs running, with');
  console.log('  AUTOCART_TOKEN in scripts/auto-cart-bot/.env? Unknown is not healthy.\n');
} else if (session.session_ok === false) {
  console.log(`⚠ RC SESSION IS DEAD — dead for ${hms(session.session_since)}, per ${session.session_source}`);
  // THE MEASUREMENT (see migration 047). The "8-9 hours" this used to print was never a
  // measurement — nobody looked in between, so it bounded when we NOTICED. The first real
  // reading was 1h20m: about one Okta access token, which is what you see when nothing is
  // renewing. Print the number, not a remembered claim about it.
  console.log(`  IT LASTED ${lifetime(session.session_live_since, session.session_since)} after sign-in.`);
  console.log(`  ${session.session_detail ?? ''}`);
  console.log('  Nothing below can be carted until there is a session again. Since 2026-08-09');
  // DERIVED, not a remembered number. This said "~15 min" after the lead moved to 30 on
  // 2026-08-11 - and it is read at 07:50 by someone deciding whether to intervene, so a
  // stale figure here is worse than none. Same class as the hard-coded claims this
  // readout's own comments warn about two lines up.
  console.log(`  the bot can get one itself ~${RC_AUTOLOGIN_LEAD_MIN} min before a hold, so this may fix itself -`);
  console.log('  if it does not, on the mini-PC: mini-pc\\rc-login.bat\n');
} else {
  const age = mins(session.session_at);
  const stale = age != null && age > 45;
  console.log(
    `RC session: OK for ${hms(session.session_since)} (per ${session.session_source},` +
    ` checked ${age}m ago)${stale ? ' — STALE, keep-warm may be down' : ''}`);
  // WATCH THE LIFETIME, DO NOT ASSERT IT. Every figure quoted here before 047 was an
  // upper bound on when somebody happened to look, and one of them ("~8 hour cap") was
  // written down as fact and falsified within hours. The line above prints the real
  // elapsed time; that is the number, and there is nothing to add to it.
  console.log(`  ${session.session_detail ?? ''}`);
  console.log('  okta=ALIVE means a real Okta session exists (only since the ported login');
  console.log('  started ticking "Keep me signed in"); okta=GONE means the access token IS');
  console.log('  the whole session and it lasts about an hour.\n');
}

// ── CAN THE BOT STILL SIGN ITSELF IN? THE TREND, NOT LAST NIGHT ──────────────────────────
//
// Above this line is whether RC accepts the token we HAVE. This is whether we can still
// MINT one, which is the different and more consequential question — it decided 2026-08-07,
// 08-08 and 08-11, and each was found at 07:30 with twenty minutes to act.
//
// A SERIES, because the singleton could only ever show last night and stand-downs overwrote
// every failure (migration 063). A run of `skip` is NOT a run of green nights: it is a run
// of nights nobody tested, which is precisely what "no rehearsal has PASSED in 12h" looked
// like from the inside. Printed even when there are no holds — the cheapest moment to find
// out the sign-in is broken is the morning nothing depends on it.
const rehearsals = await query<{
  ran_at: string; ok: boolean | null; detail: string | null; skipped_why: string | null;
}>(
  `SELECT ran_at::text, ok, detail, skipped_why FROM rc_login_rehearsal_log
    ORDER BY ran_at DESC LIMIT 10`,
).catch(() => []);
console.log('LOGIN REHEARSALS — can the bot still sign itself in?');
if (!rehearsals.length) {
  // Migration 063 is new, so an empty table is the ordinary case for its first nights and
  // says nothing about the login. Do not read it as a broken instrument.
  console.log('  No history yet (migration 063 is recent). The singleton still holds last');
  console.log("  night's verdict; this fills in from the next rehearsal onward.\n");
} else {
  for (const r of rehearsals) {
    const mark = r.ok === true ? '✓ PASS' : r.ok === false ? '✗ FAIL' : '· skip';
    const why = r.ok === null ? (r.skipped_why ?? 'no reason recorded') : (r.detail ?? '');
    console.log(`  ${r.ran_at.slice(0, 16)}  ${mark}  ${why}`.slice(0, 160));
  }
  if (!rehearsals.some((r) => r.ok === true)) {
    console.log('  ⚠ NOT ONE PASS in this window. A skip is not a pass — nothing here has');
    console.log('    proved the bot can sign in, so treat the next release as unprotected.');
  }
  console.log('');
}

if (!holds.length) {
  console.log('No holds released in that window and none queued ahead. That is the normal');
  console.log('state: a hold needs a watched RC site to be');
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
  // HOW LATE THE CART WAS, in seconds after the release. The number that says whether the
  // capacity is real.
  //
  // The runner carts SERIALLY through one Chromium — measured 2026-08-16, the first hold
  // landed at T+43s and the second at T+49s, so ~43s of startup plus ~6s per additional
  // site. At RC_HOLD_CAPACITY = 20 the last hold lands around T+157s, and nothing has
  // measured whether a released site survives that long. Raising to 20 was a deliberate
  // product decision (see limits.ts) taken with that unmeasured.
  //
  // This column is how the decision reports on itself. Late carts that still succeed mean
  // the headroom is real; late carts that FAIL are the tail of the queue losing sites, and
  // the answer then is to parallelise the precart rather than shrink the capacity back.
  //
  // Derived from data already recorded — no new instrumentation — because the alternative
  // was believing an arithmetic estimate for as long as it took somebody to complain.
  'T+s': h.cart_lag_s == null ? '—' : `${h.cart_lag_s}s`,
  claimed: clock(h.claimed_at ?? h.released_at),
})));

// DID THE USER'S OWN DEVICE CART IT? The bot's half of the hand-off ends at `released`,
// and until migration 050 that was the last word either way — a hold whose injected
// precart carted the site and one whose injection threw on line 1 were the same row. The
// two RC cart POSTs are the only link in the chain that has never been measured.
const handed = holds.filter((h) => h.client_reported_at || ['released', 'claimed'].includes(h.status));
if (handed.length) {
  console.log('\nHAND-OFF — what the phone/desktop reported back:');
  for (const h of handed) {
    const who = h.unit_name ?? h.unit_id;
    if (!h.client_reported_at) {
      // NOT the same as a failure, and saying so matters: no extension and no app is the
      // ordinary desktop case, where the user books by hand and that is a success.
      console.log(`  • ${who}: nothing reported — no injectable client (plain browser), or it never ran.`);
      continue;
    }
    // WHICH PLATFORM. Stamped by ClaimFlow before anything opens, because the cart POSTs
    // were proven on 2026-08-13 and `client_reports` carried no platform at all — the
    // write-up was one edit from saying "Android" out of habit, and the real answer (iOS)
    // came from the status bar of a screenshot. That is luck, not instrumentation, and the
    // two platforms are exactly where this feature differs: WKWebView has its own cookie
    // store and its own ITP rules. A result on one is not a result on both, so a trace that
    // cannot say which it was cannot settle either.
    //
    // READ THE COLUMN FIRST (migration 064). It was read out of `client_reports` until
    // 2026-08-20, and that could never work: the platform is reported ONCE, FIRST, and
    // `recordClientReports` keeps the TAIL of 40 — so it sat at the head of exactly the
    // region that gets trimmed. Every hand-off ever summarised here said "not reported",
    // and it was read as the feature being unbuilt rather than as its output being deleted.
    // The reports fallback stays for rows written before the column existed.
    const plat = h.client_reports?.find((r) => r.stage === 'platform')?.detail as
      | { platform?: string; appBuild?: string } | undefined;
    const platform = h.client_platform ?? plat?.platform;
    const build = h.client_app_build ?? plat?.appBuild;
    const where = platform
      ? `${platform}${build ? ` build ${build}` : ''}`
      : 'platform not reported (a claim from before 2026-08-20, or a plain browser)';

    // THE OUTCOME, NOT THE LAST LINE — and the difference is not cosmetic. On both proven
    // holds `client_last_note` reads `RC declined (200) - cart is already added`, because
    // RC's SPA navigates after a successful cart, the script is re-injected, and it submits
    // again over an entry we already hold. **That refusal is proof the cart SURVIVED**, and
    // this readout was reporting it as the verdict on the two runs that settled the
    // question. A success anywhere in the run outranks it.
    const said = (h.client_reports ?? [])
      .map((r) => String(r.detail?.status ?? r.detail?.message ?? ''))
      .filter(Boolean);
    const carted = said.find((s) => s.includes('Added to cart'));
    const already = said.some((s) => /already added/i.test(s));
    const outcome = carted
      ? `${carted}${already ? '  (and a later re-injection got "already added", which confirms it stuck)' : ''}`
      : (h.client_last_note ?? h.client_last_stage);

    console.log(`  • ${who} [${where}]: ${outcome} (${mins(h.client_reported_at)}m ago)`);

    // THE READ-BACK, WHICH OUTRANKS THE STATUS STRING ABOVE IT.
    //
    // `✓ Added to cart` is judged on the submit's own `IsSuccess` — our word for what we
    // think happened. `cart-verified` is RC's answer to "what is actually in this cart",
    // asked from the cart page on a separate call, which is the step `rc-cart.mjs` has
    // always taken and the injected precart could not until it started landing there.
    //
    // Printed as its own line rather than folded into the outcome: `entries: 0` is a
    // SUCCESS report shape carrying a failure, and it must be impossible to skim past.
    // THE NEWEST, NOT THE FIRST — and reading the first cost a diagnosis on 2026-08-29.
    // The bundle re-injects on every navigation, so one hand-off produces several
    // `cart-verified` reports; `find` returned the OLDEST, which was written by whichever
    // bundle version the webview had cached at the time. The run that finally carried
    // `keySource` was reported as not carrying it, and the instrument built that morning was
    // written off as not deployed. `findLast` is the whole fix.
    const verified = h.client_reports?.findLast((r) => r.stage === 'cart-verified')?.detail as
      | { entries?: number; keySource?: string; attached?: boolean | null } | undefined;
    const unverified = h.client_reports?.findLast((r) => r.stage === 'cart-unverified')?.detail as
      | { reason?: string } | undefined;
    if (verified && typeof verified.entries === 'number') {
      console.log(verified.entries > 0
        ? `      cart read back: ${verified.entries} entr${verified.entries === 1 ? 'y' : 'ies'} — RC holds this under the key WE asked with`
        : '      ⚠ cart read back: EMPTY. RC accepted the submit and is holding nothing.');
      // THE TWO FIELDS THAT SAY WHETHER THE OWNER CAN REACH IT. Added 2026-08-29 after a
      // read-back of 1 entry sat beside a cart UI asking a signed-in user to log in.
      // `marker` means the key came from OUR marker and not from `localStorage`, i.e. RC's
      // own SPA has no idea this cart exists. `attached: false` means CustomerId 0 — a
      // free-floating cart with no account on it. Either is a reachability failure that
      // `entries` alone reports as a success.
      if (verified.keySource && verified.keySource !== 'localStorage') {
        console.log(`      ⚠ the key came from ${verified.keySource}, NOT localStorage — RC's own`
          + " page reads localStorage to decide which cart it is showing, so the owner may see nothing");
      }
      if (verified.attached === false) {
        console.log('      ⚠ the cart carries CustomerId 0 — it is not attached to the account');
      }
      if (verified.keySource === undefined) {
        console.log('      (pre-2026-08-29 report: it cannot say whether the owner could reach this)');
      }
    } else if (unverified?.reason) {
      // NOT A FAILURE. The cart may be perfectly fine; we could not ask. Same rule as
      // `unknown` never rounding to `signed-out`.
      console.log(`      cart not read back: ${unverified.reason}`);
    }
  }
  // THE ARRAY CAN HAVE A HOLE IN IT, and a reader who assumes otherwise misreads the order.
  // The trim keeps the head and the tail and drops the middle, so a hand-off longer than the
  // cap is reported with a gap. Saying so is what stops the next person reconstructing a
  // sequence that never happened — the 08-29 comparison was attempted against a trace whose
  // decisive middle had been deleted, and nothing on screen said so.
  const capped = holds.filter((h) => (h.client_reports?.length ?? 0) >= 80);
  if (capped.length > 0) {
    console.log(`  NOTE: ${capped.length} hold(s) are at the report cap — the MIDDLE of those`);
    console.log('  traces is dropped, head and tail kept. Do not read them as contiguous.');
  }
  console.log("  '✓ Added to cart' proves the two RC cart POSTs fired and RC accepted them.");
  console.log('  Seen on iOS (2026-08-13, 08-24) and on Android (2026-08-29).');
  // THE CORRECTION OF 2026-08-29. This block used to call `cart read back` "stronger still:
  // RC's own answer, not our status string". It is RC's answer to OUR question, asked with
  // OUR key — and on 08-29 it read 1 entry while the owner, on that same page, was shown a
  // sign-in prompt and an empty cart. Neither line establishes the owner can check out.
  console.log("  'cart read back' is RC's answer to OUR question, with OUR key. It does NOT");
  console.log('  establish the owner can SEE or check out that cart — 2026-08-29 it read 1');
  console.log('  entry while the cart UI asked a signed-in user to log in. The only proof of');
  console.log("  reachability is a human looking at RC's cart page. Ask for it."); 
}

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
  // THE QUESTION THIS COULD NOT ANSWER BEFORE. On 2026-08-07 the row was byte-identical
  // to one nothing had ever looked at, so "the runner is down" and "the runner is up and
  // cannot open Chromium" were indistinguishable. `last_attempt_note` separates them.
  for (const h of missed) {
    console.log(
      h.last_attempt_note
        ? `  • ${h.unit_name ?? h.unit_id}: the runner TRIED ${mins(h.last_attempt_at)}m ago — ${h.last_attempt_note}`
        : `  • ${h.unit_name ?? h.unit_id}: NOTHING has tried to act on this hold at all.`,
    );
  }
  console.log('  On the mini-PC:');
  console.log('    node rc-hold-runner.mjs --once');
}
for (const h of holds.filter((x) => x.status === 'failed' && x.error)) {
  console.log(`\n✗ ${h.unit_name ?? h.unit_id}: ${h.error}`);
}
const offered = holds.filter((h) => h.status === 'offered').length;
if (offered) console.log(`\n${offered} offer(s) unanswered — not a fault. Nobody tapped, so nothing was held.`);

process.exit(0);
