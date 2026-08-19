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
  // NO `idb` FIELD IN THIS BODY. `indexedDB.databases()` is a promise and this one is
  // deliberately synchronous. IndexedDB is covered by `idbCensusInPage` below, through a
  // SEPARATE evaluate, so a store that will not enumerate cannot take the web-store reading
  // down with it — and the web-store reading is the one that has already produced a finding.
  return { local: scan(localStorage), session: scan(sessionStorage) };
}

/**
 * THE PLACE THE WEB-STORE CENSUS POINTED AT (2026-08-19).
 *
 * Its first live reading was `local 6 key(s), session 1 key(s) — NO token-shaped value in
 * either store`, taken on a renewal that had just handed back a token three days dead. So the
 * corpse is not in either web store, and the module then named IndexedDB as a candidate and
 * declined to look at it. This looks.
 *
 * ── NAMES AND COUNTS ONLY. NO VALUE IS EVER FETCHED ────────────────────────────────────────
 * `getAll()` would pull every row into the page — on a renderer already suspected of
 * allocating gigabytes that is the cure arriving as part of the disease, the same mistake as
 * `response.body()` in the network trace and as writing a multi-GB heap snapshot at the moment
 * the box cannot spawn a process. `count()` answers the only question that has to be answered
 * here: **which store is holding something.** That is enough to extend `dropStoredToken` to
 * reach it, which is the actual cure.
 *
 * It also means no value can be published, which is the standing rule after an OAuth code on
 * 2026-08-09 and a password on 08-16.
 *
 * ── `null` MEANS WE COULD NOT LOOK, AND NEVER "THERE IS NOTHING" ────────────────────────────
 * An unsupported `databases()`, a rejected enumeration and a budget overrun all return `null`.
 * An empty ARRAY means we enumerated and there were genuinely no databases. Those are
 * different facts and only one of them redirects the hunt onward.
 */
export function idbCensusInPage(limit) {
  // SELF-BOUNDED, INSIDE the caller's bound. `evaluateWithin` already caps the whole evaluate,
  // but a single `open()` that never fires an event would spend that entire budget and return
  // nothing at all — this way a hung database costs one database.
  const BUDGET_MS = 8000;
  const deadline = Date.now() + BUDGET_MS;
  const race = (p) => Promise.race([
    Promise.resolve(p).catch(() => null),
    new Promise((r) => { setTimeout(() => r(null), Math.max(0, deadline - Date.now())); }),
  ]);
  const req = (make) => race(new Promise((resolve) => {
    let r;
    try { r = make(); } catch { resolve(null); return; }
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
    // A blocked open is another connection holding the database — an answer, not a hang.
    r.onblocked = () => resolve(null);
  }));

  return (async () => {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null;
    const names = await race(indexedDB.databases());
    if (!Array.isArray(names)) return null;

    const out = [];
    for (const info of names.slice(0, limit)) {
      if (Date.now() > deadline) break;
      // `open` WITH NO VERSION. That cannot upgrade an existing database, and every name here
      // came from `databases()`, so nothing can be created by asking.
      const db = await req(() => indexedDB.open(info.name));
      if (!db) { out.push({ db: String(info.name).slice(0, MAX_KEY_CHARS), store: null, rows: null }); continue; }
      let stores = [];
      try { stores = Array.from(db.objectStoreNames); } catch { /* reported as no stores */ }
      if (!stores.length) out.push({ db: String(info.name).slice(0, MAX_KEY_CHARS), store: null, rows: 0 });
      for (const s of stores.slice(0, limit)) {
        if (Date.now() > deadline) break;
        let rows = null;
        try {
          rows = await req(() => db.transaction(s, 'readonly').objectStore(s).count());
        } catch { rows = null; }
        out.push({
          db: String(info.name).slice(0, MAX_KEY_CHARS),
          store: String(s).slice(0, MAX_KEY_CHARS),
          rows: typeof rows === 'number' ? rows : null,
        });
      }
      try { db.close(); } catch { /* best effort */ }
    }
    return out;
  })();
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

/**
 * Take the IndexedDB census. A SEPARATE evaluate from the web-store one on purpose: this body
 * is async and talks to a subsystem that can block, and the web-store reading has already
 * produced a finding. One must not be able to destroy the other.
 *
 * NEVER THROWS, and `null` means "we could not look" — never "there is nothing there".
 *
 * @param {(fn: Function, arg: unknown) => Promise<any>} evaluate
 */
export async function takeIdbCensus(evaluate) {
  try {
    const raw = await evaluate(idbCensusInPage, MAX_KEYS);
    return Array.isArray(raw) ? raw : null;
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
export function describeCensus(c, { nowSec = Math.floor(Date.now() / 1000), idb } = {}) {
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
      + `token is coming from somewhere else. ${describeIdb(idb)}`;
  }
  return `storage census: ${counts} · ${tokens.join(' · ')}`;
}

/**
 * What IndexedDB holds — or, just as usefully, that we could not find out.
 *
 * `undefined` means the caller did not ask. `null` means it asked and the page could not
 * answer, which is NOT the same as an empty array — and keeping those apart is the whole
 * reason this reading exists at all, since the web-store census produced its finding by
 * being able to say "nothing here" honestly.
 */
export function describeIdb(idb) {
  if (idb === undefined) return 'IndexedDB was not checked.';
  if (idb === null) {
    return 'IndexedDB could NOT be read (unsupported, blocked, or out of budget) — '
      + 'no reading, so it is not ruled out.';
  }
  if (!idb.length) {
    return 'IndexedDB: no databases at all, so the remaining candidates are a cookie or the server.';
  }
  // A store holding rows is the lead: it is somewhere `dropStoredToken` has never reached.
  const filled = idb.filter((e) => typeof e.rows === 'number' && e.rows > 0);
  const list = (filled.length ? filled : idb)
    .map((e) => `${e.db}${e.store ? `/${e.store}` : ''}=${e.rows == null ? 'unreadable' : e.rows}`)
    .slice(0, 12).join(', ');
  return filled.length
    ? `IndexedDB HOLDS DATA in ${filled.length} store(s): ${list} ← the clear has never reached these`
    : `IndexedDB: ${idb.length} store(s), all empty or unreadable: ${list}`;
}
