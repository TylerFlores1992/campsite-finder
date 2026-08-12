import { twilioAccountSid, twilioAuthToken, twilioFromNumber } from './twilio-env';
/**
 * A PHONE CALL, for the handful of things that must not be slept through.
 *
 * ## Why a call and not a louder push
 *
 * The ask was "a push notification that goes off like an alarm, something that can't be
 * ignored". On iOS that is a specific, gated thing and we cannot have it:
 *
 *  - **Critical Alerts** (ignores the mute switch AND Do Not Disturb, plays at its own
 *    volume) needs the `com.apple.developer.usernotifications.critical-alerts`
 *    entitlement. Apple grants that by individual application, for medical, public-safety
 *    and home-security apps. A campsite alerter does not qualify, and asking would not be
 *    honest.
 *  - **Time Sensitive** (pierces Focus, but is still a normal notification sound and still
 *    obeys the ringer switch) is freely available — but it is an entitlement in the app's
 *    native build. Adding it means a new binary, and the iOS 1.0 currently sitting in
 *    "Waiting for Review" would have to be pulled from the queue to attach one. It is
 *    worth doing at the next natural build; it is not worth losing the queue position for,
 *    and it would not be an alarm anyway.
 *
 * A voice call is louder than either, needs no entitlement, no new build and no review,
 * and rings through the ringer rather than the notification sound. We already pay Twilio.
 *
 * ## The part that makes it pierce Do Not Disturb: it calls TWICE
 *
 * iOS has an "Allow Repeated Calls" setting — **on by default** — that lets a *second*
 * call from the same number within three minutes ring through Do Not Disturb and Focus.
 * One call gets silenced by a sleeping phone; two, sixty seconds apart, do not. So the
 * second call is not a retry, it is the mechanism, and it is placed even when the first
 * was answered. Android's equivalent (Priority/Starred contacts, repeat callers) behaves
 * the same way.
 *
 * For the belt-and-braces version the owner can add the CampHawk number as a contact and
 * turn on **Emergency Bypass**, which rings even on Silent. That is a phone setting we
 * cannot do for them, and it is in the docs.
 *
 * ## Restraint is not optional here
 *
 * This wakes a person up. It is wired to exactly one condition — a hold is about to
 * release and the RC session is dead, i.e. the site is minutes from being lost and only a
 * human can save it — and it is rate-limited so a stuck reporter cannot dial someone all
 * night. Everything else stays a push and a text. The cost of crying wolf is not the
 * noise, it is that the next real one gets ignored.
 */

/**
 * Gap before the repeat call, and how long each one rings.
 *
 * 45s sits inside iOS's three-minute repeated-call window with a wide margin, and is long
 * enough that the first call has stopped ringing before the second arrives — otherwise the
 * second lands as call-waiting on a call that is already ringing, which is not what the
 * repeated-call rule is looking at. Hence the 25-second `Timeout` on each call: Twilio's
 * default is 60s, which would still be ringing.
 */
const REPEAT_GAP_MS = 45_000;
const RING_SECONDS = 25;

/** Twilio's outbound-call price is per minute; these calls are ~20 seconds. */

const ACCOUNT_SID = twilioAccountSid;
const AUTH_TOKEN = twilioAuthToken;
const FROM = twilioFromNumber;

export interface CallResult {
  sid: string | null;
  status: string | null;
  error?: string;
}

/** XML-escape. A campground name with an ampersand would otherwise break the TwiML. */
function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/**
 * Say `message` down the phone, three times.
 *
 * Three because someone woken by it will miss the first pass entirely and the second is
 * where they start listening. `<Pause>` between repeats so it does not run together into
 * one unintelligible sentence.
 *
 * TwiML is passed INLINE rather than hosted at a URL. A hosted TwiML endpoint would be one
 * more thing that has to be up at 07:45 for the alarm to work — and the alarm exists
 * precisely for the mornings when something is already broken.
 */
function twiml(message: string): string {
  const say = `<Say voice="Polly.Joanna">${xml(message)}</Say>`;
  return `<Response>${say}<Pause length="1"/>${say}<Pause length="1"/>${say}</Response>`;
}

async function placeOne(to: string, message: string): Promise<CallResult> {
  const sid = ACCOUNT_SID();
  const token = AUTH_TOKEN();
  const from = FROM();
  if (!sid || !token || !from) return { sid: null, status: null, error: 'twilio not configured' };

  const form = new URLSearchParams({
    To: to, From: from, Twiml: twiml(message), Timeout: String(RING_SECONDS),
  });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 21210 / 21215 here means the FROM number is not voice-capable, which is a
      // configuration fact worth seeing in full rather than a generic failure.
      const detail = body?.message ? `${body.code ?? r.status}: ${body.message}` : `HTTP ${r.status}`;
      return { sid: null, status: null, error: detail };
    }
    return { sid: body?.sid ?? null, status: body?.status ?? null };
  } catch (err) {
    return { sid: null, status: null, error: (err as Error).message };
  }
}

/**
 * In-process rate limit, keyed by incident.
 *
 * WHAT IT ACTUALLY GUARANTEES, because it is less than it looks. The map lives in one
 * lambda instance, so a cold start resets it and two concurrent instances do not see each
 * other's calls. It reliably stops a *tight* loop — the runner posting every five seconds
 * while a cart is due lands on a warm instance and is suppressed — and it does NOT
 * guarantee a global one-call-per-15-minutes.
 *
 * The real bound is the TRIGGER, not this map — and the trigger is what was wrong. This
 * comment used to say the arrangement gave "at most two or three calls for a genuine
 * emergency, which is the behaviour we want anyway". Both halves were false on 2026-08-09:
 * the alarm fired on a 45-minute clock while the repair does not run until T-15, so it was
 * not a genuine emergency, and two of the three calls were pure noise. The gate now waits
 * for the unattended login to actually fail (see ALARM_AFTER_MIN in the hold feed), which
 * leaves roughly a twelve-minute window — narrower than the reporting cadence, so one
 * incident is one alarm.
 *
 * Deliberately not in the database: a DB round trip is one more thing that can fail on the
 * path of the alarm, and the failure mode of this design is an extra call rather than a
 * missed one. For this alarm that is the right direction to err.
 */
const lastCallAt = new Map<string, number>();
// LONGER THAN THE REPORTER'S CADENCE, or it suppresses nothing. This was 15 minutes while
// the keep-warm reports session health every 20 — so the gap between two reports was
// ALWAYS wider than the window, every report got through, and the limit was decoration.
// It read like a safeguard in review and was dead code in production. 30 minutes is wider
// than the 20-minute cadence with room for jitter.
const MIN_GAP_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How the repeat call gets run after the response has gone out.
 *
 * IT MUST BE INJECTED, and a bare `setTimeout` is the trap. On Vercel the function can be
 * frozen the moment it responds, so a timer scheduled in a route handler may simply never
 * fire — and the failure is invisible: the first call still goes, the log still says the
 * alarm ran, and the one call that actually pierces Do Not Disturb is the one that quietly
 * did not happen. Route handlers pass Next's `after`, which keeps the invocation alive
 * (and needs a `maxDuration` long enough to cover REPEAT_GAP_MS). The default suits a
 * long-lived process — the Fly worker, a script, a test.
 */
export type Scheduler = (task: () => Promise<void>) => void;
const defaultScheduler: Scheduler = (task) => { void task(); };

/**
 * Ring someone until they wake up. Returns what happened, and never throws — a failed
 * alarm must not take down the request that noticed the problem.
 *
 * `key` scopes the rate limit; use something stable per incident (a hold id), not per
 * attempt, or every retry gets its own budget and the limit does nothing.
 */
export async function alarmCall(
  to: string | null | undefined, message: string, key: string, schedule: Scheduler = defaultScheduler,
): Promise<{ placed: number; error?: string }> {
  if (!to) return { placed: 0, error: 'no phone number' };
  const now = Date.now();
  const prev = lastCallAt.get(key);
  if (prev && now - prev < MIN_GAP_MS) {
    return { placed: 0, error: `rate limited — called ${Math.round((now - prev) / 60_000)}m ago` };
  }
  lastCallAt.set(key, now);

  const first = await placeOne(to, message);
  if (first.error) return { placed: 0, error: first.error };

  // THE SECOND CALL IS THE MECHANISM, NOT A RETRY — see the header. It is placed whether
  // or not the first was answered, because what pierces Do Not Disturb is a repeat caller,
  // and iOS decides that from the call itself, not from whether anyone picked up.
  schedule(async () => {
    await sleep(REPEAT_GAP_MS);
    await placeOne(to, message);
  });

  return { placed: 1 };
}
