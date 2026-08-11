/**
 * When may the bot try a saved rec.gov login again?
 *
 * ── THE BUG THIS EXISTS TO FIX (found in nightly ops review, 2026-08-11) ───────────────
 * `keepSessionsWarm` skipped any profile without a `.camphawk-ready` marker. On a failed
 * auto-relogin it deleted that marker — including on the CAPTCHA branch, three lines after
 * logging "keeping the saved login, will retry next cycle". The promise and the code
 * disagreed: the very pass that announced a retry switched off the gate the retry needed.
 * One failure, twelve days ago, and the automatic repair never ran again.
 *
 * It also read as a live CAPTCHA holding the account hostage, which it was not. Nothing was
 * standing in the way; nothing was trying.
 *
 * ── WHY A SEPARATE STATE AND NOT JUST "DON'T DELETE THE MARKER" ────────────────────────
 * `.camphawk-ready` means TWO things that came apart when auto-relogin was added: "this
 * profile has a live session" (which `processJob` must honour — carting on a dead session
 * fails) and "this profile is eligible for a keepalive pass". After a CAPTCHA the first is
 * false and the second is true. Keeping the marker to preserve the retry would tell the
 * cart path it has a session it does not have — the `notifications.status = 'sent'` family
 * of lie. So the session flag stays honest and the retry gets its own state.
 *
 * ── AND WHY IT IS BOUNDED ──────────────────────────────────────────────────────────────
 * Every attempt opens a headful browser and posts credentials from the household IP. An
 * unbounded 30-minute retry is a busy loop wearing a service's clothes — the same shape the
 * supervisor's crash-loop ceiling exists to stop, and on the RC side repeated logins from
 * this address cost 12 hours of IP block on 2026-08-06. So: back off, and give up loudly
 * into the manual reconnect path rather than retrying forever.
 *
 * Pure functions, no fs and no clock of their own, because this is the part that can lose a
 * cart. See worker/relogin-retry.test.mts.
 */

/** First retry one keepalive cycle later; then 1h, 2h, 4h, capped. */
export const RETRY_BASE_MS = 30 * 60_000;
export const RETRY_MAX_MS = 6 * 60 * 60_000;

/**
 * A CAPTCHA gets many attempts and a bad password gets two, because THEY MEAN DIFFERENT
 * THINGS. rec.gov throws reCAPTCHA at this browser for its own reasons and the challenge
 * lifts on its own, so retrying is the correct response and the only question is pacing.
 * A password rec.gov keeps rejecting will never fix itself, and hammering it risks a real
 * lockout — that is what the existing two-strike rule was for, and it was unreachable
 * because the retry never ran at all.
 *
 * Six attempts with this backoff spans roughly 13 hours: long enough to cross a challenge
 * that lifts overnight, short enough that a genuinely stuck account surfaces the same day.
 */
export const CAPTCHA_MAX_ATTEMPTS = 6;
export const BAD_PASSWORD_MAX_ATTEMPTS = 2;

export function retryBackoffMs(attempts) {
  const n = Math.max(1, attempts);
  return Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
}

const ceilingFor = (kind) => (kind === 'captcha' ? CAPTCHA_MAX_ATTEMPTS : BAD_PASSWORD_MAX_ATTEMPTS);

/**
 * Decide what happens after one failed auto-relogin.
 *
 * `kind` is 'captcha' or 'credentials'. `attempts` is how many have already failed.
 * Returns either `{giveUp: true, kind, attempts, why}` or `{giveUp: false, kind, attempts,
 * nextAt, why}` — `nextAt` being an epoch ms the caller stores and honours.
 */
export function planRetry({ kind, attempts = 0, now = 0 }) {
  const n = attempts + 1;
  const ceiling = ceilingFor(kind);
  if (n >= ceiling) {
    return {
      giveUp: true, kind, attempts: n,
      why: kind === 'captcha'
        ? `rec.gov kept showing a CAPTCHA across ${n} attempts`
        : `the saved password was rejected ${n}x`,
    };
  }
  const wait = retryBackoffMs(n);
  return {
    giveUp: false, kind, attempts: n, nextAt: now + wait,
    why: `retrying in ${Math.round(wait / 60_000)}m (attempt ${n + 1} of ${ceiling})`,
  };
}

/**
 * Is a stored retry due?
 *
 * A MISSING OR MALFORMED `nextAt` READS AS DUE, not as never. The failure this guards
 * against is silence — a profile that quietly stops being retried is exactly the bug — so
 * an unreadable state costs one extra attempt rather than the whole repair.
 */
export function retryDue(state, now) {
  if (!state) return false;
  const at = Number(state.nextAt);
  return !Number.isFinite(at) || now >= at;
}
