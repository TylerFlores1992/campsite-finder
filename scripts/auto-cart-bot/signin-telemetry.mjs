/**
 * WHAT A SIGN-IN ACTUALLY DID — pure, so the words stored in `bot_events` kind `rc-signin`
 * have one definition and a test.
 *
 * `attemptLogin` answers `{ ok, reason }`, and `reason` is a sentence for a person at 07:45.
 * Whether a sign-in met a CAPTCHA, typed the password, or was answered from the Okta `idx`
 * cookie with nothing typed is the question the evening-sign-in work turns on (a password
 * sign-in may draw a CAPTCHA; a cookie-answered one cannot), and it was recorded nowhere but
 * a console that rolls in ~89 minutes. So each attempt now carries flags, and this maps them
 * to ONE outcome word:
 *
 *   captcha           a challenge was on screen — a human has to act
 *   password-form     the password was typed and a session came back
 *   cookie-answered   a session came back with nothing typed (Okta answered from `idx`)
 *   already-live      the session was already acceptable; no sign-in happened at all
 *   failed-after-password   the password was submitted and no session came back
 *   inconclusive      RC could not be asked (its app did not load, etc.)
 *   failed            it failed before any credential was submitted
 *
 * NEVER A VALUE. The `idx` cookie is the session; only its presence, whether it is
 * persistent, and minutes to expiry are read — `authCookieSummary` already drops values.
 */

/** @param {{ ok?: boolean, captcha?: boolean, passwordSubmitted?: boolean, alreadyLive?: boolean, provedNothing?: boolean }|null} r */
export function classifySignin(r) {
  if (!r) return 'failed';
  if (r.captcha) return 'captcha';
  if (r.ok) {
    if (r.passwordSubmitted) return 'password-form';
    if (r.alreadyLive) return 'already-live';
    return 'cookie-answered';
  }
  if (r.passwordSubmitted) return 'failed-after-password';
  if (r.provedNothing) return 'inconclusive';
  return 'failed';
}

/**
 * The `idx` cookie's shape out of `authCookieSummary`'s rows, or `{ present: false }`.
 * `persistent` false is a browser-session cookie — it dies with the browser.
 */
export function idxFacts(cookies) {
  const idx = (Array.isArray(cookies) ? cookies : []).find((c) => c && c.name === 'idx');
  if (!idx) return { present: false, persistent: null, expiresInMin: null };
  return { present: true, persistent: idx.persistent === true, expiresInMin: idx.expiresInMin ?? null };
}

/**
 * The `detail` object for one `rc-signin` event. Small, structured, no credential in it.
 * @param {{ label: string, result: any, cookies?: any[] | null, okta?: any }} args
 */
export function signinEventDetail({ label, result, cookies = null, okta = null }) {
  return {
    label: String(label || 'unknown').slice(0, 40),
    outcome: classifySignin(result),
    ok: result?.ok === true,
    idx: cookies == null ? null : idxFacts(cookies),
    okta: okta
      ? { alive: okta.alive ?? null, createdAt: okta.createdAt ?? null, expiresAt: okta.expiresAt ?? null }
      : null,
    reason: typeof result?.reason === 'string' ? result.reason.slice(0, 200) : null,
  };
}
