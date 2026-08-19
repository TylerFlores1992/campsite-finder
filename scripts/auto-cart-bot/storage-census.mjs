/**
 * WHERE IS THE STALE TOKEN HIDING?
 *
 * ── THE PATHOLOGY THIS IS BUILT FOR (2026-08-19) ───────────────────────────────────────────
 * Four consecutive renewals produced the same impossible pair:
 *
 *     ✗ no fresher token (none → -267960s), got as far as: none
 *         cleared 0 storage key(s): (none — nothing was there to drop)
 *
 * BEFORE the renewal there is no token. AFTER it there is one that expired **74 hours ago**.
 * And the negative grows by ~700s per run, which is one fixed ancient expiry receding — the
 * SAME dead token coming back every time.
 *
 * So RC's SPA is restoring a three-day-old token during the navigation, from somewhere
 * `dropStoredToken` cannot see. That is why the session cannot recover: every renewal ends
 * with the app holding a corpse, Okta reporting ALIVE, and nothing minting anything.
 *
 * ── WHAT `dropStoredToken` ACTUALLY COVERS, WHICH IS LESS THAN ITS NAME SUGGESTS ───────────
 * `localStorage` only, and within it only `ssoAccessToken`, `accessToken`, and keys starting
 * `okta-`. It has never touched **sessionStorage**, **IndexedDB**, or any localStorage key
 * under a different name. Cookies are excluded on purpose and must stay that way — losing
 * `DT` makes a sign-in look like a fresh profile, which cost the household IP twelve hours on
 * 2026-08-06.
 *
 * The 2026-08-15 entry already named the remaining candidates — *"IndexedDB, a cookie, or a
 * key name nothing has looked for"* — and then nobody looked. This looks.
 *
 * ── VALUES ARE NEVER REPORTED. NAMES, LENGTHS AND EXPIRIES ONLY ────────────────────────────
 * Every value here is potentially the session itself. This repo has published a credential
 * twice by collecting a field it then had to filter — an OAuth authorization code on
 * 2026-08-09 (`location.href` mid-callback) and a user's password on 08-16 (WebKit quoting the
 * failing expression). So the census carries a key NAME, a character COUNT, and — for values
 * shaped like a JWT — the `exp` claim decoded locally into an age in seconds.
 *
 * An age is the one fact that identifies the corpse, and it cannot be replayed.
 */

/** Cap the report so a profile with hundreds of keys cannot bury the finding. */
export const MAX_KEYS = 40;

/** Key names are echoed into a log; a pathological one must not dominate the line. */
const MAX_KEY_CHARS = 60;

/**
 * The census, as it runs INSIDE the page. Kept as a standalone function so the injected body
 * is reviewable on its own — nothing here closes over anything from this module.
 *
 * Returns `{ local, session }`. Each entry is `{ key, len, exp }` where `exp` is the decoded
 * expiry in epoch seconds, or null when the value is not a JWT.
 */
export function censusInPage(limit) {
  const jwtExp = (v) => {
    // A JWT is three dot-separated base64url segments. Anything else is not decoded at all.
    if (typeof v !== 'string' || !/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v)) return null;
    try {
      const body = v.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(body + '==='.slice((body.length + 3) % 4)));
      return typeof claims.exp === 'number' ? claims.exp : null;
    } catch {
      return null;
    }
  };
  const scan = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length && out.length < limit; i++) {
        const k = store.key(i);
        if (k == null) continue;
        const v = store.getItem(k);
        // NAME, LENGTH, EXPIRY. Never the value — see the header.
        out.push({ key: String(k).slice(0, 60), len: v == null ? 0 : v.length, exp: jwtExp(v) });
      }
    } catch { /* a store that will not enumerate is reported as empty, not as an error */ }
    return out;
  };
  // NO `idb` FIELD. `indexedDB.databases()` is a promise and this body is deliberately
  // synchronous — an async body is one more thing that can hang inside a page already
  // suspected of hanging. An always-empty array would read as "we looked and found none",
  // which is the zero-for-an-absent-reading mistake this repo has made twice. IndexedDB is
  // simply NOT covered yet, and `describeCensus` says so when both stores come back clean.
  return { local: scan(localStorage), session: scan(sessionStorage) };
}

/**
 * Take the census. `page.evaluate` is passed in bound by the caller so this module never
 * imports Playwright — the same shape as the rest of the bot's page helpers.
 *
 * NEVER THROWS. A census that fails is a diagnostic that produced nothing, which must not turn
 * a failed renewal into a crashed keep-warm.
 *
 * @param {(fn: Function, arg: unknown) => Promise<any>} evaluate
 */
export async function takeStorageCensus(evaluate) {
  try {
    const raw = await evaluate(censusInPage, MAX_KEYS);
    // `null` means the read did not happen — which `describeCensus` reports as "no reading",
    // never as an empty profile. A page that will not evaluate and a profile with no keys are
    // different facts and only one of them is a lead.
    return raw && Array.isArray(raw.local) ? raw : null;
  } catch {
    return null;
  }
}

/** Seconds until `exp`, negative once past. `null` in, `null` out. */
function ageOf(exp, nowSec) {
  return typeof exp === 'number' ? Math.round(exp - nowSec) : null;
}

/**
 * One line naming every place a token-shaped value is sitting, and how dead it is.
 *
 * THE INTERESTING ENTRY IS ALWAYS THE ONE `dropStoredToken` DOES NOT COVER, so the line says
 * explicitly which store each key came from and marks the ones that would survive a clear.
 */
export function describeCensus(c, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!c) return 'storage census: could not read the page — no reading, not an empty profile';

  const covered = (key) => key === 'ssoAccessToken' || key === 'accessToken' || key.startsWith('okta-');
  const fmt = (store, entries) => entries.map((e) => {
    const age = ageOf(e.exp, nowSec);
    const dead = age == null ? '' : age < 0 ? ` EXPIRED ${Math.round(-age / 3600)}h ago` : ` alive ${Math.round(age / 60)}m`;
    // `dropStoredToken` only sweeps localStorage, so anything in sessionStorage survives a
    // clear whatever it is called — that is the fact worth flagging, not the key name.
    const survives = store === 'session' || !covered(e.key) ? ' ← SURVIVES the clear' : '';
    return `${store}:${e.key} (${e.len} chars${dead})${survives}`;
  });

  const tokens = [
    ...fmt('local', c.local.filter((e) => e.exp != null)),
    ...fmt('session', c.session.filter((e) => e.exp != null)),
  ];
  const counts = `local ${c.local.length} key(s), session ${c.session.length} key(s)`;
  if (!tokens.length) {
    return `storage census: ${counts} — NO token-shaped value in either store, so the stale `
      + 'token is coming from somewhere else (IndexedDB, a cookie, or the server)';
  }
  return `storage census: ${counts} · ${tokens.join(' · ')}`;
}
