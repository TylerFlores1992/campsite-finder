import { NextRequest, NextResponse, after } from 'next/server';
import { dueHolds, markCarted, markFailed, markReleased, expireStaleHolds, pendingClaims, getHold, noteAttempt, recordSessionHealth, recordRehearsal, lastRehearsal, reportCartFailure, nextHoldRelease, holdAtRisk, beatIsFromRunner, isRealUnitId, type HoldRequest } from '@/lib/rc-holds';
import { alarmCall } from '@/lib/notifications/voice';
import { rcSessionFault, type RcSessionFault } from '@/lib/health-thresholds';
import { markBotUpdateApplied, noteBotUpdateAttempt, claimBotUpdate } from '@/lib/bot-update';
import { recordBotCommandResult } from '@/lib/bot-commands';
import { botControlFor } from '@/lib/bot-control';
import { recordMemorySample } from '@/lib/chromium-memory';
import { recordNativeAlloc } from '@/lib/native-alloc';
import { query, mutate } from '@/lib/db/client';
import { notifyHoldMissed } from '@/lib/rc-holds-notify';
import { manageTokenFor } from '@/lib/notifications/actions';
import { dispatchNotifications } from '@/lib/notifications';
import { RC_HOLD_FEED_MAX_LEAD_SEC } from '@/lib/limits';

export const dynamic = 'force-dynamic';
// Long enough to cover the alarm's repeat call, which is scheduled with `after` and so
// runs INSIDE this invocation's budget. At the default 15s the second call — the one that
// actually pierces Do Not Disturb — would be cut off mid-sleep and never placed.
export const maxDuration = 90;

/**
 * The RC hold feed for the mini-PC bot.
 *
 * Same master-token model as /api/auto-cart/roster: the bot holds no database
 * credentials, so everything it needs arrives over an authorised HTTP call. That is a
 * deliberate property of the existing design, not an accident — the box sits on a
 * residential connection and has already been blocked by a WAF once.
 *
 * ONE call returns both halves of the job, because they are the same pass:
 *   cart[]    — requested holds whose 8am release is due. `requested` only; an
 *               `offered` row is a question nobody answered (see lib/rc-holds).
 *   release[] — holds we carted that nobody claimed. The bot must LET GO. Sitting on
 *               a site the user never came for is the inventory-grabbing this whole
 *               design exists to avoid, so it is not a tidy-up task, it is the job.
 */
function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

const forBot = (h: HoldRequest) => ({
  id: h.id,
  unitId: h.unit_id,
  unitName: h.unit_name,
  arrivalDate: h.arrival_date,
  nights: h.nights,
  releaseAt: h.release_at,
  campgroundId: h.campground_id,
  cartKey: h.cart_key,
  cartEntryKey: h.cart_entry_key,
});

export async function GET(req: NextRequest) {
  const bad = unauthorized(req);
  if (bad) return bad;

  // LIVENESS, stamped on the authorized poll itself (same pattern as the rec.gov roster,
  // migration 015). The runner's death was undetectable until a user's hold silently
  // failed — and `autocart.bot` stayed green throughout, because that is a DIFFERENT
  // process which was genuinely fine. Fire-and-forget: a heartbeat write must never be
  // able to fail the request that carts a site.
  // AND WHAT CODE IT IS RUNNING (migration 056). The same poll already proves the box can
  // reach us; these two headers make it prove which checkout is doing the reaching, which
  // nothing else could answer without a human asking `git-status` through bot_commands.
  //
  // COALESCE, never a bare assignment: a runner too old to send the headers must not
  // ERASE a commit an up-to-date one reported. The columns are meant to go stale, not
  // blank — a stale value plus `beat_at` is readable ("this is what it said, N ago"),
  // whereas a NULL written over a real value destroys the only record we had.
  const commit = req.headers.get('x-bot-commit');
  const commitAt = req.headers.get('x-bot-commit-at');

  // ── ONLY THE RUNNER MAY STAMP THE RUNNER'S HEARTBEAT (2026-08-14) ────────────────────
  // `beat_at` is the sole evidence behind `rcBotUsable()` and `autocart.rc_runner`, and its
  // stated meaning is "there is a bot alive that will cart this". It was stamped on EVERY
  // authorized GET of this feed, and three different processes make one:
  //
  //   rc-hold-runner.mjs   every 15s   <- the only one the field is about
  //   rc-keepwarm.mjs      every 20m   (?rehearsal=1)
  //   update-guard.mjs     every 5m    (the Windows scheduled task, ?leadSeconds=0)
  //
  // So the heartbeat could not go stale while the box had a working scheduled task - which
  // is always. MEASURED on 2026-08-14: the hold runner was dead for hours and `beat_at`
  // advanced every 301 seconds, exactly the updater's tick, while the health check read OK
  // and the poller went on offering "Hold it for me" buttons nothing would honour. That is
  // precisely the failure `rcBotUsable` was written to prevent, arriving through the
  // instrument instead of around it.
  //
  // THE TEST IS "SAYS IT IS SOMETHING ELSE", NOT "SAYS IT IS THE RUNNER". A runner too old
  // to send the header must keep stamping, or this change turns a healthy box red the
  // moment it deploys and stays red until a human runs update.bat - the two-halves-deploy
  // gap that caused the T-30/T-25 alarm hole on 08-11. Unknown callers therefore stamp, as
  // they always did; only a caller that positively identifies as NOT the runner is skipped.
  // The failure direction is the status quo, never a new false alarm.
  //
  // The rule itself lives in `beatIsFromRunner` so it can be tested without standing up a
  // route, and so the two bot-side callers can be pinned against the same constant.
  const isRunner = beatIsFromRunner(req.headers.get('x-bot-role'));

  mutate(
    `UPDATE rc_runner_heartbeat
        SET beat_at       = CASE WHEN $3 THEN NOW() ELSE beat_at END,
            bot_commit    = COALESCE($1, bot_commit),
            bot_commit_at = COALESCE($2::timestamptz, bot_commit_at)
      WHERE id = 1`,
    // Bounded before they reach SQL. These are attacker-controllable in the sense that any
    // holder of AUTOCART_TOKEN sets them, and a sha is 40 hex characters — anything else is
    // not a sha and is dropped rather than stored and rendered on the admin page.
    [/^[0-9a-f]{7,40}$/i.test(commit ?? '') ? commit : null,
     commitAt && !Number.isNaN(Date.parse(commitAt)) ? commitAt : null,
     isRunner],
  ).catch(() => {});

  // Lead time on purpose: the bot should be mid-request when the site frees, not
  // starting to think about it a second late. RC releases on the exact minute.
  // THE CEILING IS SHARED WITH `cancelHold`, which derives its cutoff from it: how early
  // the feed may hand a row to the runner is exactly the question "can this still be
  // called off?" has to answer. A second copy of 600 here would drift from that.
  const lead = Math.min(
    RC_HOLD_FEED_MAX_LEAD_SEC,
    Math.max(0, Number(req.nextUrl.searchParams.get('leadSeconds') ?? 90)),
  );
  // OPT-IN, because this is the 15-second hot path and only ONE caller wants it. The
  // keep-warm asks once every twenty minutes to decide whether tonight's login rehearsal
  // is due; the hold runner polls this same endpoint every 15s and would be paying for a
  // row it never reads. At 08:00:00 the answer that carts a site is the only thing this
  // response is for.
  const wantRehearsal = req.nextUrl.searchParams.get('rehearsal') === '1';
  const [cart, stale, claims, nextRelease, control, rehearsal] = await Promise.all([
    dueHolds(lead), expireStaleHolds(), pendingClaims(),
    // For the keep-warm, not the runner: it signs in shortly before this, because RC
    // issues no renewable session and a token only lasts an hour. See rc-autologin.mjs.
    nextHoldRelease(),
    // ON-DEMAND UPDATES ride this poll. The box has no inbound path (it is behind a home
    // router — cloudflared exists for the broker for that reason), and opening one on the
    // machine holding the RC session to save a scheduled task would be a poor trade. It
    // already asks us for work every 15s; this is one more field in the answer.
    // Diagnostics and the update flag ride the same poll: the box has no inbound path, and
    // this call is already authenticated and already happening. The KINDS are all the box is
    // told - see scripts/auto-cart-bot/bot-commands.mjs, which holds the authoritative
    // allowlist and implements each one itself.
    //
    // THE SAME CHANNEL IS ON /api/auto-cart/roster, which the rec.gov bot polls. This
    // process died at 09:36 PT on 2026-08-11 and took every remote lever with it; the
    // duplication is the fix. The flag here is INFORMATIONAL - a poller that means to spawn
    // the updater claims it with a POST first, because reading a feed is not intending to
    // act on it. See lib/bot-control.
    botControlFor('rc-hold-runner'),
    wantRehearsal ? lastRehearsal() : Promise.resolve(null),
  ]);

  // `claim` is separated from `release` on purpose. A stale release is merely overdue;
  // a claim has a person watching a spinner, and every second before the bot lets go is
  // a second they cannot take the site. `pollMs` tells the runner to come back fast
  // while anything is claimable — on its lazy cadence the exposure would be the poll
  // interval, not the ~2.5s the release probe measured.
  //
  // A DUE CART GETS ITS OWN FAST LANE for the same reason, one step less urgent. Since
  // `reportCartFailure`, an early or beaten attempt stays `requested` and is retried —
  // and the gap between retries is the runner's poll interval, which at the idle cadence
  // would hand a contested site to whoever else is watching. 5s is a compromise, not a
  // maximum: the precart is a real POST from a residential IP that RC's WAF has 403'd
  // before, so retrying every second for twenty minutes is how we lose the address.
  // With the runner now waiting out the lead, the first attempt should be correctly
  // timed anyway and this is the fallback, not the plan.
  // THE DEAD-MAN'S SWITCH. Everything about the session alarm used to be driven by the
  // keep-warm REPORTING — so a keep-warm that stops reporting silences the alarm that
  // exists to catch it. This poll is the pull side: the runner hits this endpoint every
  // 15s whatever the keep-warm is doing, so a verdict that has gone stale is noticed here
  // even when nothing is left to notice it on the mini-PC.
  //
  // Fire-and-forget for the same reason the heartbeat write is: at 08:00:00 nothing may
  // delay the response that carries a due cart.
  void alarmIfSessionUnusable().catch((e) => console.error('[rc-holds] stale-session alarm failed:', e));

  // ── A TEST FIXTURE MUST NEVER MAKE THE RUNNER TAKE THE PROFILE (2026-08-19) ──────────────
  // Every one of these three lists is WORK: the runner asks the keep-warm for the Chromium
  // profile whenever any of them is non-empty. The keep-warm yields, closes its browser and
  // reopens — and the live token lives in page memory, not localStorage, so the reopen comes
  // back signed out. That destroyed a seven-hour-old session today, for a hold whose unit id
  // was `__t9003`: a `npm test` sentinel, during CI for a Markdown-only pull request.
  //
  // FILTERED HERE AND NOT IN THE QUERIES, DELIBERATELY. `dueHolds` and `pendingClaims` are
  // what the hold suites exist to test; filtering them would gut the tests that make this
  // table safe at all, which is exactly why the 2026-08-18 fix stopped at `nextHoldRelease`
  // and `holdAtRisk`. Filtering the FEED costs those suites nothing and still means the
  // runner never sees a fixture. Server-side, so it reaches the box on a push.
  //
  // `stale.expired` is NOT filtered: it is a count of rows already swept, not work, and the
  // runner only logs it.
  const real = (rows: HoldRequest[]) => rows.filter((h) => isRealUnitId(h.unit_id));
  const claimReal = real(claims);
  const cartReal = real(cart);

  return NextResponse.json({
    claim: claimReal.map(forBot),
    cart: cartReal.map(forBot),
    release: real(stale.toRelease).map(forBot),
    expired: stale.expired,
    // THE FAST LANES FOLLOW THE FILTERED LISTS. Keyed on the raw ones, a fixture would put
    // the runner on its 1s cadence — polling hard for work it is no longer being given.
    pollMs: claimReal.length ? 1000 : cartReal.length ? 5000 : null,
    nextRelease,
    // Read by update-guard.mjs, which still applies the release check on top: an update
    // asked for by hand must not take the session down twenty minutes before a cart.
    updateRequested: control.updateRequested,
    commands: control.commands,
    // WHEN IT LAST RAN, not whether it passed. The bot's only question is "am I due?", and
    // the once-a-day gate has to survive a restart — `supervise.ps1` restarts the keep-warm
    // on exit and `update.bat` restarts everything, so a process-local timestamp would let
    // a restart loop re-run the login as often as it crashed. That is the shape that cost
    // twelve hours of IP block on 2026-08-06.
    lastRehearsalAt: rehearsal?.ran_at ?? null,
  });
}

/**
 * The bot reporting back.
 *
 * `ok: true` must carry the cart AND entry keys — without the entry key the only way
 * to release later is emptying the whole cart, which would drop every other user's
 * hold with it. A success that cannot be undone is not a success we want recorded.
 */
export async function POST(req: NextRequest) {
  const bad = unauthorized(req);
  if (bad) return bad;

  const body = await req.json().catch(() => ({}));
  const { id, ok, cartKey, cartEntryKey, released, error } = body ?? {};

  // SESSION LIVENESS — no hold id, because it is about the bot, not about one hold.
  // `rc-keepwarm.mjs` posts this every pass; the runner posts it whenever it opens the
  // profile and finds out the hard way. See migration 046: a runner that polls this feed
  // happily and cannot drive RC is the exact failure 045's heartbeat cannot see.
  if (body?.session && typeof body.session.live === 'boolean') {
    const why = typeof body.session.why === 'string' ? body.session.why : null;
    // THE OKTA READING, only when this caller actually took one — see migration 065. The
    // key being ABSENT and the key being null mean different things and must stay
    // distinguishable all the way down: absent is "I did not ask", null is "I asked and
    // could not tell", and only the second is a reading worth storing over an older one.
    const o = body.session.okta;
    const okta = o && typeof o === 'object'
      ? {
          alive: typeof o.alive === 'boolean' ? o.alive : null,
          expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : null,
        }
      : undefined;
    await recordSessionHealth(
      body.session.live,
      why,
      typeof body.source === 'string' ? body.source : 'unknown',
      okta,
    );
    // AND IF A SITE IS ABOUT TO BE LOST OVER IT, RING THE PHONE. Only here: a dead session
    // is normally a fix-it-today problem, and it is already a red admin check and a 07:30
    // pre-flight. It becomes an emergency exactly when a hold is minutes from releasing and
    // only a human can sign in — which is the moment a push and a text are least likely to
    // be seen, because it is early and the phone is asleep.
    if (body.session.live === false) {
      await alarmSessionDead(why).catch((e) => console.error('[rc-holds] alarm failed:', e));
    }
    return NextResponse.json({ ok: true, state: 'session-recorded' });
  }

  // THE NIGHTLY LOGIN REHEARSAL — see migration 054.
  //
  // NOT folded into the `session` branch above, though both are about the RC session, and
  // the difference is the point. `session.live` says whether the CURRENT token is accepted;
  // this says whether we can still MINT one. On 2026-08-11 those were opposite: the session
  // was dead (correctly reported, correctly amber) and the sign-in was broken — and only
  // one of those two facts loses a campsite at 08:00.
  //
  // A SKIP IS RECORDED, NOT DROPPED. `ok: null` with a reason is how "we declined to test
  // tonight" stays distinguishable from "we tested and it passed"; letting a skip write
  // nothing at all would leave the last real result sitting there looking current.
  if (body?.rehearsal && typeof body.rehearsal === 'object') {
    const r = body.rehearsal;
    await recordRehearsal(
      typeof r.ok === 'boolean' ? r.ok : null,
      typeof r.detail === 'string' ? r.detail : null,
      typeof r.skippedWhy === 'string' ? r.skippedWhy : null,
    );
    return NextResponse.json({ ok: true, state: 'rehearsal-recorded' });
  }

  // ── ONE CHROMIUM MEMORY SAMPLE (migration 059) ───────────────────────────────────────
  // The leak that has needed a power cycle is on a profile family nobody has identified,
  // and one of the two candidates exists only in ~30-minute bursts — so it cannot be
  // attributed by a human taking two readings, which is what has been tried three times.
  // This rides a POST the box already makes; see scripts/auto-cart-bot/memory-sample.mjs.
  //
  // It returns before the hold work below deliberately: this is not a hold report and must
  // never be mistaken for one, and at 08:00:00 nothing may go in front of a cart.
  if (body?.memory && typeof body.memory === 'object') {
    await recordMemorySample(
      body.memory,
      typeof body.source === 'string' ? body.source : null,
    );
    return NextResponse.json({ ok: true, state: 'memory-recorded' });
  }

  // ── ONE NATIVE ALLOCATION READING (migration 066) ────────────────────────────────────
  // The sibling of the memory sample above, and it exists for the same reason one level in:
  // the memory series proves a ramp HAPPENED, this says what was allocating while it did.
  //
  // Both were lost on 2026-08-22 and 08-23 — two nine-gigabyte ramps with the sampler
  // running for both — because the sampler's only output is a log `tail-log` truncates to
  // 16,000 characters. `chromium_memory_samples` survived those same events by being in
  // Postgres. This is that fix applied to the other half.
  //
  // Returns before the hold work for the same reason the memory sample does: it is not a
  // hold report, and at 08:00:00 nothing may go in front of a cart.
  if (body?.nativeAlloc && typeof body.nativeAlloc === 'object') {
    await recordNativeAlloc(body.nativeAlloc);
    return NextResponse.json({ ok: true, state: 'native-alloc-recorded' });
  }

  // MAY THIS PROCESS SPAWN THE UPDATER? Claimed at the point of USE, never granted on read.
  //
  // Both feeds carry `updateRequested` so the box stays reachable when the RC runner is dead
  // — but the roster feed is polled every TWO SECONDS, and a box on code older than the
  // control channel ignores the block entirely. Granting on read meant that box consumed the
  // grant instantly and the Windows scheduled task, the only thing that could update a stale
  // checkout, read `false`. The lever disarmed itself on exactly the boxes that needed it.
  //
  // Reading a feed is not intending to act on it. Only the caller knows which it is doing,
  // so only the caller can claim.
  if (typeof body?.updateClaim === 'string') {
    const granted = await claimBotUpdate(body.updateClaim).catch(() => false);
    return NextResponse.json({ ok: true, state: 'update-claim', granted });
  }

  // THE BOX REPORTING AN UPDATE, successful or not. Recorded either way — an update that
  // failed and left the request pending would be retried on every 15s poll, which is a
  // rollback loop on the machine holding the session. Same shape as one auto-login attempt
  // per release.
  if (body?.updateApplied === true || typeof body?.updateApplied === 'string') {
    await markBotUpdateApplied(
      typeof body.updateApplied === 'string' ? body.updateApplied : null,
      typeof body.note === 'string' ? body.note : null,
    );
    return NextResponse.json({ ok: true, state: 'update-recorded' });
  }

  // AN UPDATE THAT WAS ASKED FOR AND DID NOT HAPPEN — the guard refused, and this is why.
  // Deliberately NOT `markBotUpdateApplied`: the request stays pending so the box tries
  // again when the reason clears. Before this, a refusal was indistinguishable from the
  // box never having looked — the two faults have different fixes and were the same
  // silence, exactly as `last_attempt_note` fixed for the holds themselves.
  if (typeof body?.updateAttempt === 'string') {
    await noteBotUpdateAttempt(body.updateAttempt);
    return NextResponse.json({ ok: true, state: 'update-attempt-recorded' });
  }

  // A DIAGNOSTIC ANSWER. Recorded whatever it says, including "that file does not exist" -
  // which is an answer, and was the one that finally located the silent update.
  if (typeof body?.commandId === 'number') {
    await recordBotCommandResult(
      body.commandId,
      typeof body.exitCode === 'number' ? body.exitCode : 0,
      typeof body.output === 'string' ? body.output : null,
      typeof body.error === 'string' ? body.error : null,
    );
    return NextResponse.json({ ok: true, state: 'command-recorded' });
  }

  // A PASS THAT COULD NOT ACT. Records why against the holds it was about to touch and
  // leaves their status alone — they must retry. Marking them failed here would close
  // holds that are still live and fire the missed-hold alert for nothing.
  if (body?.skipped === true) {
    const ids = Array.isArray(body.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
    await noteAttempt(ids, typeof body.reason === 'string' ? body.reason : 'runner skipped');
    return NextResponse.json({ ok: true, state: 'skip-recorded', noted: ids.length });
  }

  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  if (released === true) {
    // TWO different releases, and conflating them loses the only fact worth keeping.
    // `forClaim` means a user asked for it and is about to take it — the handshake
    // working. A bare release is the timeout sweep: nobody came, and the site went back
    // on the market. Recording both as 'failed' would make a successful hand-off
    // indistinguishable from an abandoned hold.
    if (body.forClaim === true) {
      await markReleased(id);
      return NextResponse.json({ ok: true, state: 'released' });
    }
    await markFailed(id, 'released unclaimed — nobody came for it');
    return NextResponse.json({ ok: true, state: 'released' });
  }

  if (ok === true) {
    if (typeof cartKey !== 'string' || !cartKey) {
      return NextResponse.json({ error: 'cartKey required on success' }, { status: 400 });
    }
    const firstTime = await markCarted(id, cartKey, typeof cartEntryKey === 'string' ? cartEntryKey : null);
    // Tell the user ONLY on the transition. The runner re-reads its feed every pass and
    // a hold it already carted must not text them a second time — the same lesson as
    // alerting on the transition rather than the state (migration 039).
    if (firstTime) await notifyHeld(id).catch((e) => console.error('[rc-holds] held alert failed:', e));
    return NextResponse.json({ ok: true, state: 'carted' });
  }

  // NOT `markFailed`. A cart that fails while the release window is still open is an
  // attempt, not an outcome — see reportCartFailure. The feed's 90-second lead means the
  // FIRST attempt is always before the release, so treating it as final guaranteed every
  // hold failed exactly once, too early, forever.
  // The cart key travels even on a failure: a submit that landed and whose read-back did
  // not is the case where the retry must return to the SAME cart. See reportCartFailure.
  const outcome = await reportCartFailure(
    id, typeof error === 'string' ? error : 'unknown error', undefined,
    typeof cartKey === 'string' && cartKey ? cartKey : null,
  );
  // AND TELL THEM. A hold that the runner reports as dead used to be the SILENT path —
  // only `expire-holds`'s sweep notified, and its `WHERE status = 'requested'` can never
  // match a row the runner already failed. So the case where we know exactly what went
  // wrong said nothing, while the case where we infer from silence shouted. On 2026-08-08
  // the only thing the user got was an ordinary "#41 is available", which does not
  // distinguish "we're holding it for you" from "we tried and couldn't" — and they had
  // asked us to hold it the night before.
  if (outcome.state === 'failed' && outcome.hold) {
    await notifyHoldMissed(outcome.hold).catch((e) => console.error('[rc-holds] missed alert failed:', e));
  }
  return NextResponse.json({ ok: true, state: outcome.state });
}

/**
 * The RC session is dead and a hold is about to release. Wake the owner up.
 *
 * `ALARM_LEAD_MIN` is wider than the auto-login's lead deliberately: the auto-login reports
 * its failure at T-30, and a person needs to surface, find a computer and sign in by hand.
 * Anything outside the window is not an emergency and gets the ordinary treatment — a red
 * admin check and the 07:30 pre-flight.
 *
 * `AUTOCART_ALARM_PHONE` overrides the destination. The person who has to fix this is
 * whoever can reach the mini-PC, which is not necessarily the user whose hold it is; today
 * they are the same person, and one day they will not be.
 */
const ALARM_LEAD_MIN = Number(process.env.AUTOCART_ALARM_LEAD_MIN || 45);

/**
 * Below this many minutes to release, the unattended login has had its chance.
 *
 * THE ALARM CRIED WOLF ON ITS FIRST REAL MORNING (2026-08-09) and this is why. It gated on
 * a 45-minute clock, while `maybeAutoLogin` does not even try until T-15 — so the alarm was
 * STRUCTURALLY GUARANTEED to ring before the thing that fixes it, on every hold, not as an
 * edge case. It rang twice, told the owner to go and sign in by hand, and the session was
 * healthy: the bot carted the site two seconds after release using the very session the
 * alarm had called dead.
 *
 * A dead session at T-40 is not an emergency, it is a pending repair. It becomes an
 * emergency when the repair has been attempted and failed, or when there is no longer time
 * for it.
 *
 * IT MUST TRACK `RC_AUTOLOGIN_LEAD_MIN`, and sit JUST inside it. This is the fallback
 * branch — the one that fires when the keep-warm reports nothing at all, because the
 * process is wedged or stopped. (A login that fails and says so rings immediately, on the
 * `auto sign-in failed` branch, at any distance.) Left at 12 when the lead moved from 15
 * to 30 on 2026-08-11, it would still have been "inside the lead" and still passed a test
 * asserting only that — while quietly buying an eighteen-minute silence in the one window
 * where somebody can still act. 25 keeps the grace at five minutes, as 12-against-15 did.
 */
const ALARM_AFTER_MIN = Number(process.env.AUTOCART_ALARM_AFTER_MIN || 25);

/**
 * Is the session verdict itself unusable — and is a hold about to pay for it?
 *
 * Reads the heartbeat rather than waiting to be told. `alarmSessionDead` is called from
 * the POST path, i.e. when the keep-warm reports; this is the case where it never does.
 */
async function alarmIfSessionUnusable(): Promise<void> {
  const [row] = await query<{ session_ok: boolean | null; session_at: string | null; session_detail: string | null }>(
    `SELECT session_ok, session_at, session_detail FROM rc_runner_heartbeat WHERE id = 1`,
  ).catch(() => []);
  const ageMs = row?.session_at ? Date.now() - new Date(row.session_at).getTime() : null;
  const fault = rcSessionFault(row?.session_ok ?? null, ageMs);
  // `dead` is already handled the moment it is reported, and re-alarming here would give
  // it a second budget against the same rate limit. Only the silences belong to this path.
  if (fault !== 'stale' && fault !== 'never-reported') return;
  const mins = ageMs == null ? 'never' : `${Math.round(ageMs / 60_000)}m`;
  await alarmSessionDead(`rc-keepwarm has not reported for ${mins} — the process is wedged or stopped`, 'stale');
}

async function alarmSessionDead(why: string | null, fault: RcSessionFault = 'dead'): Promise<void> {
  const at = await holdAtRisk(ALARM_LEAD_MIN);
  if (!at) return;

  // A STALE VERDICT RINGS IMMEDIATELY — no waiting for a repair that cannot come.
  //
  // The gate below exists because `maybeAutoLogin` fixes a dead session at T-15 and a
  // phone call before that is a call about a problem the machine is about to solve. That
  // reasoning does NOT hold for staleness: `maybeAutoLogin` lives inside rc-keepwarm.mjs,
  // and a stale verdict means rc-keepwarm is not reporting — so the repair mechanism is
  // provably absent, and every minute spent waiting for it is a minute lost.
  //
  // 2026-08-10 is what this costs when it is missing: the keep-warm wedged at 04:48Z
  // holding the Chromium profile, the verdict froze at `ok`, the check showed amber, the
  // phone never rang, and the 08:00 cart failed against a lock nothing could take.
  if (fault !== 'stale') {

  // RING ONLY IF THE REPAIR IS DONE FOR, one of two ways: the keep-warm has reported an
  // auto sign-in that actually failed (definitive — it tried, RC said no), or the login
  // window has closed with the session still dead. Anything earlier is a phone call about
  // a problem the machine is about to solve, and the cost of that is not the noise — it is
  // that the next real one gets skimmed.
    const loginFailed = /auto sign-in failed/i.test(why ?? '');
    if (!loginFailed && at.minutesAway > ALARM_AFTER_MIN) {
      console.log(
        `[rc-holds] session dead, hold ${at.hold.id} is ${Math.round(at.minutesAway)}m away — ` +
        `NOT alarming yet; the auto-login has not had its turn`,
      );
      return;
    }
  }

  const where = at.campground ?? 'a campground';
  const site = at.hold.unit_name ? ` site ${at.hold.unit_name}` : '';
  const time = at.hold.release_at.slice(11, 16);
  // Written to be understood by someone who was asleep four seconds ago: what is wrong,
  // what is at stake, what to do. No jargon, no hold ids, and the instruction LAST so it
  // is the thing still in their ear when the message repeats.
  // Name the ACTUAL fault. "The session is dead" and "the bot has stopped reporting" send
  // someone to different places — the second is a wedged process, and signing in without
  // clearing it just hands the profile back to the thing that is stuck.
  const spoken =
    fault === 'stale'
      ? `CampHawk alert. The Reserve California bot has stopped responding, and ${where}${site} releases at ${time}. ` +
        `Nothing can hold it for you until it is restarted. ` +
        `Go to the mini P C and run R C login dot bat.`
      : `CampHawk alert. The Reserve California session is dead, and ${where}${site} releases at ${time}. ` +
        `Nobody can hold it for you until someone signs in. ` +
        `Go to the mini P C and run R C login dot bat.`;

  const to = process.env.AUTOCART_ALARM_PHONE || at.phone;
  // Keyed on the HOLD, not on this attempt — the keep-warm reports every pass, and a
  // per-attempt key would give each report its own budget and defeat the rate limit
  // entirely, turning one broken session into a call every twenty minutes all night.
  // `after` and not a bare timer: on Vercel the invocation can be frozen the instant it
  // responds, and a dropped repeat call is invisible — the first call still goes out and
  // the log still reads as though the alarm worked.
  const r = await alarmCall(to, spoken, `rc-session:${at.hold.id}`, (task) => after(task));
  console.log(
    `[rc-holds] session-dead alarm for hold ${at.hold.id} (releases ${at.hold.release_at}): ` +
    `${r.placed ? 'calling' : `not called — ${r.error}`}${why ? ` | ${why}` : ''}`,
  );
}

/**
 * "We're holding it — come and get it."
 *
 * Goes out the moment the bot actually has the site, not when we asked it to. The claim
 * URL carries the hold id and the watch's manage token; possession of both is the
 * authorisation, which is what lets the user act from a phone at 8am without signing in.
 *
 * EMAIL AND PUSH ONLY. The link is on camphawk.app and sendSms rejects those — carriers
 * filter them (30007, measured 10 for 10). The SMS still goes, it just says the site is
 * held and to check email, which is better than a text that never arrives.
 */
async function notifyHeld(id: string): Promise<void> {
  const hold = await getHold(id);
  if (!hold) return;
  const [w] = await query<{ start_date: string; end_date: string; name: string; reservations_url: string | null }>(
    `SELECT wt.start_date::text, wt.end_date::text, c.name, c.reservations_url
       FROM watches wt JOIN campgrounds c ON c.id = wt.campground_id WHERE wt.id = $1`,
    [hold.watch_id],
  );
  if (!w) return;
  const token = await manageTokenFor(hold.watch_id);
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
  const claimUrl = token ? `${base}/claim/${hold.id}?t=${token}` : null;

  await dispatchNotifications({
    userId: hold.user_id,
    watchId: hold.watch_id,
    campgroundId: hold.campground_id,
    campgroundName: w.name,
    availableDates: [hold.arrival_date],
    bookingUrl: w.reservations_url ?? 'https://www.reservecalifornia.com/',
    campsiteName: hold.unit_name,
    campsiteId: hold.unit_id,
    startDate: w.start_date,
    endDate: w.end_date,
    kind: 'carted',
    holdUrl: claimUrl,
  });
}
