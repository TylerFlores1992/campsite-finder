/**
 * WHERE A SIGNUP CAME FROM -- the one place that decides what "where" means.
 *
 * Written 2026-09-03, because nothing recorded it. 38 real accounts and not one carries a
 * referrer, a campaign or even the page it landed on, so "which of the outreach emails,
 * directory listings or SEO pages produced a user?" has been unanswerable and every growth
 * decision so far was taken without it. Vercel Analytics is mounted in the root layout and
 * cannot answer it either: it is anonymous and page-level, so it can say a page was viewed
 * and never that the view became an account.
 *
 * THE WHOLE CHAIN, so the pieces are not read in isolation:
 *
 *   1. `AcquisitionCapture` (root layout, client) runs on the FIRST pageview and writes the
 *      value of `captureSource()` into the `ch_src` cookie -- once, never overwriting.
 *   2. `Welcome` (where Clerk lands every new account) POSTs to /api/user/signup-source.
 *   3. That route reads the cookie SERVER-side, runs it back through `parseSignupSource`,
 *      and writes `users.signup_source` under `WHERE signup_source IS NULL`.
 *
 * WHY CAPTURE AT LANDING AND NOT AT SIGNUP. `document.referrer` exists on the page they
 * arrive at and is GONE by the time they reach /welcome -- by then the referrer is our own
 * sign-up page. Capturing at the moment of signup would therefore record, for every single
 * account, that it came from camphawk.app. The cookie is what carries the fact across the
 * Clerk round trip, which stays on our own origin.
 *
 * FIRST TOUCH, NOT LAST. Both the cookie write and the database write refuse to overwrite.
 * Someone finds us on Reddit, thinks about it, and signs up a week later from a Google
 * search: last-touch credits Google, Reddit looks dead, and the channel that actually worked
 * gets cut. The value is a fact about an event that already happened.
 *
 * NEVER THE FULL URL -- ORIGIN AND PATHNAME ONLY, NEVER THE QUERY STRING (beyond the five
 * utm keys allow-listed below). A query string is where a session token, an email address or
 * an OAuth code ends up, and this repo has published a credential twice by collecting a field
 * it then had to filter: an OAuth authorization code on 2026-08-09 (a diagnostic reporting
 * `location.href` mid-Okta-flow) and a real password on 2026-08-16. Do not collect a field you
 * would then have to filter. Origin plus pathname carries the entire diagnostic value.
 *
 * IT IS CLIENT-SUPPLIED, THEREFORE UNTRUSTED. The referrer and the landing URL come from the
 * browser and ride a cookie anyone can set to anything. That is acceptable for a diagnostic
 * nothing gates on -- and it is exactly why `parseSignupSource` re-validates server-side
 * instead of trusting what the client sends. Read it as evidence about a population, never as
 * a fact about one account.
 */

/** First-party cookie carrying the first-touch value between landing and signup. */
export const SIGNUP_SOURCE_COOKIE = 'ch_src';

/**
 * Long enough to outlast a think-about-it gap (the Reddit case above), short enough that a
 * referrer from months ago cannot be credited with a signup it had nothing to do with.
 */
export const SIGNUP_SOURCE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

/**
 * Caps, applied on the way OUT (capture) and again on the way IN (parse). Both, deliberately:
 * the cookie can be hand-edited between the two, so capping only at capture caps nothing.
 */
const MAX_REF = 200;
const MAX_PATH = 300;
const MAX_UTM = 100;

/**
 * The five standard UTM keys and nothing else. Explicitly NOT `gclid`/`fbclid`/`msclkid`:
 * those are per-CLICK identifiers rather than campaign labels -- they identify a person's
 * click, we run no ads that would produce one, and storing an identifier we have no use for
 * is the collect-then-filter mistake this module exists to avoid.
 */
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

export interface SignupSource {
  /** Referrer ORIGIN, e.g. "https://www.reddit.com". Absent for direct traffic. */
  ref?: string;
  /** Landing PATHNAME, e.g. "/camping/cabins/california". Never the query string. */
  path?: string;
  /** Allow-listed utm_* parameters, without the `utm_` prefix. */
  utm?: Partial<Record<UtmKey, string>>;
  /** When the first touch happened, ISO-8601. */
  at?: string;
}

function trim(value: string, max: number): string | undefined {
  const s = value.trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The referrer's ORIGIN, or undefined when it is not worth recording.
 *
 * SAME-ORIGIN IS DROPPED, AND THIS IS THE RULE THAT MAKES THE COLUMN MEAN ANYTHING. People
 * browse before they sign up, so on any page but the first the referrer is camphawk.app.
 * Without this, nearly every row would read "came from camphawk.app" -- true, useless, and
 * indistinguishable from direct traffic having been recorded correctly.
 *
 * http/https only. Other schemes do occur (`android-app://com.google.android.gm` is a real
 * Gmail-app referrer) and are dropped rather than parsed: `new URL()` does not agree with
 * itself across engines about what `.origin` is for a non-special scheme, so the value would
 * be inconsistent between the browser that captured it and the server that re-validates it.
 * The cost is losing app-referral signal; the alternative is a field whose meaning depends on
 * the reader, which is worse than an absent one.
 */
function referrerOrigin(referrer: string, selfOrigin: string | undefined): string | undefined {
  if (!referrer) return undefined;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (selfOrigin && url.origin === selfOrigin) return undefined;
  return trim(url.origin, MAX_REF);
}

/**
 * Build the first-touch record from a landing page.
 *
 * Returns null only when `href` will not parse -- there is nothing to record without a
 * landing page. Direct traffic with no referrer and no campaign still returns a value: the
 * PATH is itself the finding (a signup that landed on /camping/cabins/california says
 * something a signup that landed on / does not).
 */
export function captureSource(input: {
  href: string;
  referrer?: string;
  now?: Date;
}): SignupSource | null {
  let url: URL;
  try {
    url = new URL(input.href);
  } catch {
    return null;
  }

  const out: SignupSource = {};

  const ref = referrerOrigin(input.referrer ?? '', url.origin);
  if (ref) out.ref = ref;

  const path = trim(url.pathname, MAX_PATH);
  if (path) out.path = path;

  const utm: Partial<Record<UtmKey, string>> = {};
  for (const key of UTM_KEYS) {
    const raw = url.searchParams.get(`utm_${key}`);
    const value = raw ? trim(raw, MAX_UTM) : undefined;
    if (value) utm[key] = value;
  }
  if (Object.keys(utm).length > 0) out.utm = utm;

  out.at = (input.now ?? new Date()).toISOString();

  return out;
}

/**
 * Re-validate a cookie value server-side.
 *
 * THIS IS NOT A FORMALITY. The cookie is written by the client and can be edited freely
 * between capture and the POST, so every cap and every key restriction applied in
 * `captureSource` has to be applied AGAIN here or it was never applied at all. Unknown keys
 * are dropped rather than rejected: this is a diagnostic, and refusing the whole record over
 * one stray field would lose the four good ones with it.
 *
 * Returns null for anything that yields no usable field, so the route can tell "nothing to
 * record" from "recorded an empty object" -- which are different facts, and the second one
 * would make a direct signup indistinguishable from a lost cookie.
 */
export function parseSignupSource(raw: string | undefined | null): SignupSource | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const src = parsed as Record<string, unknown>;
  const out: SignupSource = {};

  if (typeof src.ref === 'string') {
    // Back through the same origin parse: a hand-edited cookie can carry a full URL with a
    // query string, which is precisely the thing this module refuses to store.
    const ref = referrerOrigin(src.ref, undefined);
    if (ref) out.ref = ref;
  }

  if (typeof src.path === 'string') {
    // A path only -- a hand-edited cookie can carry "/x?token=..." and the query has to go.
    const path = trim(src.path.split('?')[0].split('#')[0], MAX_PATH);
    if (path && path.startsWith('/')) out.path = path;
  }

  if (src.utm && typeof src.utm === 'object' && !Array.isArray(src.utm)) {
    const raw_utm = src.utm as Record<string, unknown>;
    const utm: Partial<Record<UtmKey, string>> = {};
    for (const key of UTM_KEYS) {
      const value = raw_utm[key];
      if (typeof value !== 'string') continue;
      const clean = trim(value, MAX_UTM);
      if (clean) utm[key] = clean;
    }
    if (Object.keys(utm).length > 0) out.utm = utm;
  }

  if (typeof src.at === 'string') {
    const t = Date.parse(src.at);
    // An unparseable or absent timestamp is dropped, never defaulted to NOW(): "when the
    // first touch happened" and "when the row was written" are different facts, and a
    // fabricated one would silently turn a month-old cookie into a same-day arrival.
    if (Number.isFinite(t)) out.at = new Date(t).toISOString();
  }

  return Object.keys(out).length > 0 ? out : null;
}
