import { NextRequest, NextResponse, after } from 'next/server';
import { dueHolds, markCarted, markFailed, markReleased, expireStaleHolds, pendingClaims, getHold, noteAttempt, recordSessionHealth, reportCartFailure, nextHoldRelease, holdAtRisk, type HoldRequest } from '@/lib/rc-holds';
import { alarmCall } from '@/lib/notifications/voice';
import { rcSessionFault, type RcSessionFault } from '@/lib/health-thresholds';
import { query, mutate } from '@/lib/db/client';
import { notifyHoldMissed } from '@/lib/rc-holds-notify';
import { manageTokenFor } from '@/lib/notifications/actions';
import { dispatchNotifications } from '@/lib/notifications';

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
  mutate(`UPDATE rc_runner_heartbeat SET beat_at = NOW() WHERE id = 1`).catch(() => {});

  // Lead time on purpose: the bot should be mid-request when the site frees, not
  // starting to think about it a second late. RC releases on the exact minute.
  const lead = Math.min(600, Math.max(0, Number(req.nextUrl.searchParams.get('leadSeconds') ?? 90)));
  const [cart, stale, claims, nextRelease] = await Promise.all([
    dueHolds(lead), expireStaleHolds(), pendingClaims(),
    // For the keep-warm, not the runner: it signs in shortly before this, because RC
    // issues no renewable session and a token only lasts an hour. See rc-autologin.mjs.
    nextHoldRelease(),
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

  return NextResponse.json({
    claim: claims.map(forBot),
    cart: cart.map(forBot),
    release: stale.toRelease.map(forBot),
    expired: stale.expired,
    pollMs: claims.length ? 1000 : cart.length ? 5000 : null,
    nextRelease,
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
    await recordSessionHealth(
      body.session.live,
      why,
      typeof body.source === 'string' ? body.source : 'unknown',
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
  const outcome = await reportCartFailure(id, typeof error === 'string' ? error : 'unknown error');
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
 * `ALARM_LEAD_MIN` is wider than the auto-login's 15-minute lead deliberately: the
 * auto-login reports its failure at T-15, and a person needs longer than that to surface,
 * find a computer and sign in by hand. Anything outside the window is not an emergency and
 * gets the ordinary treatment — a red admin check and the 07:30 pre-flight.
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
 * for it. 12 is just inside RC_AUTOLOGIN_LEAD_MIN (15), so the window has demonstrably
 * opened and passed without success.
 */
const ALARM_AFTER_MIN = Number(process.env.AUTOCART_ALARM_AFTER_MIN || 12);

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
