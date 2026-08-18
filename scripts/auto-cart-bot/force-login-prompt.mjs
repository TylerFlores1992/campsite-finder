/**
 * MAKE OKTA SHOW THE PASSWORD FORM, so the login rehearsal can actually test the password.
 *
 * ── WHY (2026-08-18) ───────────────────────────────────────────────────────────────────────
 * `runLoginRehearsal` drops the stored token, reloads, and requires RC to REJECT the session
 * before it will type a password. That much works. What happens next is the problem: the
 * sign-in click starts an authorization-code round trip, and Okta answers it **from the `idx`
 * cookie with no form at all** — so no credential is ever submitted and the run is correctly
 * recorded as `provedNothing` / inconclusive.
 *
 * And that cookie never goes stale, because WE keep it fresh. `checkAndReport` calls
 * `oktaSessionAlive(ctx)` unconditionally on every keepalive tick, and Okta's expiry comes
 * back as exactly the check time plus twelve hours — measured twelve consecutive times across
 * three hours, each one advancing with the clock. So the rehearsal is handed a condition in
 * which there is nothing to prove, more or less permanently, and `autocart.rc_login` sits on
 * "no rehearsal has PASSED in N hours" for ever. A check that is permanently amber is one
 * people stop reading, which is the cry-wolf failure this codebase has already fixed three
 * times.
 *
 * ── WHY THIS APPROACH AND NOT THE COOKIE ───────────────────────────────────────────────────
 * The obvious alternative is to snapshot and delete the `idx` cookie, attempt the password,
 * and restore it on failure. That is certain to work and it is DESTRUCTIVE: a rehearsal that
 * discovers a broken password would do so by ending the session it was testing.
 *
 * `prompt=login` is the OIDC parameter that means "re-authenticate this user even if you
 * already have a session". Nothing is deleted, so a rehearsal that fails costs a live session
 * NOTHING — and if Okta declines to honour it we land back on `provedNothing`, which is
 * exactly where we are today. The downside is bounded by the status quo, which is why it goes
 * first.
 *
 * **`DT` IS NEVER TOUCHED EITHER WAY.** It is the device cookie, and losing it makes a
 * sign-in look like it came from a fresh profile — the shape that cost the household IP twelve
 * hours of block on 2026-08-06.
 *
 * ── WHY RC'S OWN REQUEST IS REWRITTEN RATHER THAN BUILT HERE ───────────────────────────────
 * The authorize URL carries the client id, the redirect URI, the scopes, `state` and a PKCE
 * challenge whose verifier lives inside RC's SPA. Constructing one here would mean owning all
 * of that, and getting any of it wrong produces a failure indistinguishable from a broken
 * password. We add one query parameter to a request RC has already built correctly.
 *
 * ── THE HAZARD, AND IT IS THE WHOLE REASON THIS IS A MODULE ────────────────────────────────
 * The rehearsal runs on the RESIDENT page — the same `page` the keep-warm holds open for
 * hours. A route left installed would rewrite EVERY later authorize on that page, including
 * the silent re-mints that (as of 2026-08-18) appear to be keeping the session alive on their
 * own. Forcing `prompt=login` on those would turn a free background renewal into a login
 * attempt that cannot succeed unattended — so a leaked route would not merely be untidy, it
 * would kill the session hourly and drive real sign-ins from an address that has been blocked
 * before.
 *
 * So it is disarmed TWO independent ways, and neither depends on the other:
 *   1. a `finally` that calls `page.unroute`, and
 *   2. an `armed` flag the handler itself checks, so even if `unroute` throws or the page is
 *      in a state where it does not take effect, the handler passes everything through.
 * The flag is the one that does not depend on Playwright behaving, which is why it exists.
 */

/** Okta's authorization endpoint. Matched on the path, never on the full origin. */
export const AUTHORIZE_PATH = '/oauth2/v1/authorize';

/** The glob Playwright routes on. Kept beside the path so the two cannot drift. */
export const AUTHORIZE_GLOB = `**${AUTHORIZE_PATH}*`;

/**
 * A redirect loop is the one way this could hang a browser, so rewrites are bounded. Three is
 * far more than the one navigation a sign-in needs, and small enough to fail fast.
 */
export const MAX_REWRITES = 3;

/**
 * Add `prompt=login` to an authorize URL. Pure, so the rewrite is testable without a browser.
 *
 * `URL` rather than string surgery: the query already carries a PKCE challenge and a redirect
 * URI, both percent-encoded, and hand-splicing `&prompt=login` onto a URL with a fragment or
 * an empty query is how you corrupt one of those.
 */
export function withPromptLogin(url) {
  const u = new URL(url);
  u.searchParams.set('prompt', 'login');
  return u.toString();
}

/** Does this URL already carry the parameter? Used to stop the handler rewriting its own work. */
export function alreadyForced(url) {
  try {
    return new URL(url).searchParams.get('prompt') === 'login';
  } catch {
    return false;
  }
}

/**
 * Run `fn` with RC's authorize requests rewritten to demand a fresh credential.
 *
 * Returns `{ result, rewrites }`. **`rewrites` is the self-diagnosis**: zero means the
 * interception never fired, which separates "Okta ignored `prompt=login`" from "we never
 * asked" — two different next moves that would otherwise produce the same inconclusive run.
 * That distinction is the whole reason this returns anything but the callback's value.
 *
 * @param {import('playwright').Page} page the RESIDENT page — see the hazard note above
 * @param {() => Promise<any>} fn
 * @param {{ log?: (m: string) => void }} [opts]
 */
export async function withForcedLoginPrompt(page, fn, { log = () => {} } = {}) {
  let armed = true;
  let rewrites = 0;

  const handler = async (route) => {
    const url = route.request().url();
    // DISARMED, OR NOT OURS, OR ALREADY DONE — pass it through untouched. `armed` is checked
    // FIRST and is what makes a leaked route inert.
    if (!armed || !url.includes(AUTHORIZE_PATH) || alreadyForced(url) || rewrites >= MAX_REWRITES) {
      await route.continue().catch(() => {});
      return;
    }
    rewrites += 1;
    // A 302 RATHER THAN `route.continue({ url })`. Overriding the URL of a navigation request
    // has version-dependent semantics in Playwright; a redirect is a thing the browser does
    // every day, and it re-enters this handler with the parameter already present, where the
    // guard above passes it straight through. One well-understood mechanism instead of one
    // that has to be right about the library.
    await route.fulfill({ status: 302, headers: { location: withPromptLogin(url) } })
      .catch(async () => { await route.continue().catch(() => {}); });
  };

  await page.route(AUTHORIZE_GLOB, handler).catch((e) => {
    // Never fatal. A rehearsal that cannot install the route is exactly as informative as one
    // that runs without it, which is to say inconclusive — and that is reported, not thrown.
    log(`  (could not intercept the authorize request: ${e?.message ?? e})`);
  });
  try {
    const result = await fn();
    return { result, rewrites };
  } finally {
    // BOTH, IN THIS ORDER. Disarming first means the handler is already inert no matter what
    // `unroute` does — including throwing, which it can if the page has navigated or closed.
    armed = false;
    await page.unroute(AUTHORIZE_GLOB, handler).catch(() => {});
  }
}
