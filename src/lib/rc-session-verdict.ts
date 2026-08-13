/**
 * What the app's ReserveCalifornia session state actually WAS — computed from the facts the
 * webview reported, never from the webview's own opinion.
 *
 * ## Why the verdict is not in the injected script
 *
 * The script gathers evidence inside RC's page; this decides what the evidence means. Kept
 * apart because the deciding is the part that gets things wrong and the part that has to be
 * testable — a conclusion reached inside a string of injected JavaScript can only ever be
 * checked by running a phone. Same division as `isRenewal` being pulled out of
 * `renewByReload`: the bug there was a wrong answer to one question and nothing else about
 * the reload was wrong.
 *
 * ## The rule this exists to keep
 *
 * **A token that exists is not a session that works.** That conflation produced a false
 * green over a dead session on 2026-08-09 — the hold runner reported health because *a*
 * token was in storage, six minutes after it had expired, and overwrote the keep-warm's
 * correct verdict. So `live` here requires a token caught off RC's OWN requests with an
 * expiry in the future. A stored copy alone is never better than `inconclusive`, which is
 * the same posture `readLiveToken`'s `source` field enforces on the bot.
 *
 * And `unknown` is never rounded to a failure. "We could not tell" and "there is no
 * session" have different fixes, and reporting the first as the second is what sent a human
 * to the box over a session that repaired itself.
 */

/**
 * One observation, as reported. Every field is something measured; nothing is a conclusion.
 * `null` throughout means "not reported", which is distinct from zero.
 */
export interface RcAppSessionFacts {
  /** Did our own marker survive in the webview's storage? */
  marker: 'present' | 'absent' | null;
  /** How many times this webview had opened RC before now. */
  opens: number | null;
  /** Gap since the previous open — the days-long persistence measurement. */
  lastOpenAgoSec: number | null;
  /** Age of the oldest record we have from this data store. */
  firstOpenAgoSec: number | null;
  /**
   * Life left, AT THIS OPEN, in the token recorded at the end of the previous one.
   * Negative means it was already dead when we arrived — so any live token now is new.
   * This is the primary evidence; see the probe's header for why the stored copy is not.
   */
  prevTokenExpiresInSec: number | null;
  /** What was sitting in localStorage at injection time. */
  storedToken: 'none' | 'jwt' | 'opaque' | null;
  storedExpiresInSec: number | null;
  /** A token caught off RC's own request — the only kind that proves the app is authenticated. */
  liveTokenCaptured: boolean;
  liveTokenExpiresInSec: number | null;
  /** Seconds since the live token was minted, from its `iat`. */
  liveTokenAgeSec: number | null;
}

export type RcAppSessionVerdict =
  /** Nothing reported — the script did not run, or its reports never arrived. */
  | 'unknown'
  /** No marker, and this device has never probed before. Says nothing about persistence. */
  | 'first-open'
  /** No marker, but this device HAS probed before: the data store was emptied. */
  | 'purged'
  /** A live token with life left, and we arrived holding a usable one. Renewal untested. */
  | 'live'
  /** A live token with life left, and we arrived with NOTHING usable. Silently re-minted. */
  | 'renewed'
  /** A token exists and is past its expiry. Storage intact, session dead. */
  | 'expired'
  /** Marker intact, no token at all — the SDK cleared them, so silent renewal failed. */
  | 'signed-out'
  /** Something is there, but not enough to call it either way. */
  | 'inconclusive';

/**
 * A renewal claimed on a token minted long before this open would be a replay, not a
 * re-mint. Only applied when `iat` decoded — an unknown age must not veto a verdict the
 * rest of the evidence supports, or every opaque token becomes a false negative.
 */
const RENEWAL_MAX_TOKEN_AGE_SEC = 600;

export interface RcAppSessionReading {
  verdict: RcAppSessionVerdict;
  /** One sentence a human can act on. Names the evidence, not just the conclusion. */
  detail: string;
  /**
   * Did this observation actually answer the renewal question? A `live` reading is a
   * working session that PROVED NOTHING, and the difference matters when counting: ten
   * `live` readings are not ten pieces of evidence that the app renews itself.
   */
  provesRenewal: boolean;
}

export function classifyRcAppSession(
  facts: RcAppSessionFacts | null,
  opts: { priorProbes: number },
): RcAppSessionReading {
  if (!facts || facts.marker === null) {
    return {
      verdict: 'unknown',
      detail: 'The webview reported nothing about the session — the script did not run, or its reports never arrived.',
      provesRenewal: false,
    };
  }

  const live = facts.liveTokenCaptured;
  const liveLeft = facts.liveTokenExpiresInSec;
  // A live capture whose expiry would not decode still proves RC is making authenticated
  // calls. Treated as usable rather than discarded — refusing it would report a working
  // session as `inconclusive` the day Okta stops issuing JWTs.
  const liveUsable = live && (liveLeft === null || liveLeft > 0);

  if (facts.marker === 'absent') {
    // THE DEVICE CANNOT TELL THESE APART AND THE SERVER CAN. A wipe takes the marker with
    // it, so from inside the webview a purge and a first-ever run look identical; only the
    // record of previous probes from this same device separates them.
    if (opts.priorProbes > 0) {
      return {
        verdict: 'purged',
        detail: `This webview has probed RC ${opts.priorProbes} time(s) before and our marker is gone, so its storage was emptied — an iOS ITP purge (about 7 days without interaction) or a manual clear. Renewing cannot fix this; the user signs in again.`,
        provesRenewal: false,
      };
    }
    return {
      verdict: 'first-open',
      detail: 'No marker and no earlier probe from this device — this is the first observation, so it says nothing yet about how long a session survives.',
      provesRenewal: false,
    };
  }

  // Arrived with nothing usable? The marker is the evidence that counts; the stored copy is
  // only consulted when the marker never recorded a token (a previous open that was itself
  // signed out). See the probe header for why a fresh stored token proves nothing.
  const arrivedDead =
    facts.prevTokenExpiresInSec !== null
      ? facts.prevTokenExpiresInSec <= 0
      : facts.storedToken === 'none';

  if (liveUsable) {
    const ageKnown = facts.liveTokenAgeSec !== null;
    const freshlyMinted = !ageKnown || facts.liveTokenAgeSec! <= RENEWAL_MAX_TOKEN_AGE_SEC;
    if (arrivedDead && freshlyMinted) {
      const gap = facts.lastOpenAgoSec !== null ? ` after ${hours(facts.lastOpenAgoSec)} away` : '';
      return {
        verdict: 'renewed',
        detail: `Arrived with no usable token${gap} and RC minted a live one anyway — the Okta session cookie survived and the SPA re-authenticated silently, with no credential typed.`,
        provesRenewal: true,
      };
    }
    if (arrivedDead && !freshlyMinted) {
      // Contradictory evidence: the marker says dead, the token says it was minted long ago.
      // Do not claim a renewal the `iat` will not support — over-claiming here is what put
      // "the keep-warm renews the session" in the docs for three days.
      return {
        verdict: 'live',
        detail: `A live token is in use, but it was minted ${hours(facts.liveTokenAgeSec!)} ago, so this is not evidence of a silent renewal even though our marker recorded an expired one.`,
        provesRenewal: false,
      };
    }
    return {
      verdict: 'live',
      detail: `The session was already working on arrival${
        facts.liveTokenExpiresInSec !== null ? ` (${Math.round(facts.liveTokenExpiresInSec / 60)} min left on the token)` : ''
      } — so this open proves the session persisted, and proves nothing about renewal.`,
      provesRenewal: false,
    };
  }

  // A live token past its expiry: RC is sending a credential it will itself reject. Distinct
  // from having none, because storage is intact and the SDK has not given up yet.
  if (live && liveLeft !== null && liveLeft <= 0) {
    return {
      verdict: 'expired',
      detail: `The app is still holding a token that expired ${hours(-liveLeft)} ago. Storage survived; the session did not.`,
      provesRenewal: false,
    };
  }

  if (facts.storedToken === 'none') {
    return {
      verdict: 'signed-out',
      detail: `Storage survived (${facts.opens ?? 0} previous opens) but holds no token at all — okta-auth-js clears them when its silent renew fails, so the Okta session is gone or the exchange is being refused. A credential is needed.`,
      provesRenewal: false,
    };
  }

  return {
    verdict: 'inconclusive',
    detail: 'A stored token is present but RC made no authenticated call we could catch, so whether the session works is unproven — the stored copy has misreported this before and is not accepted as evidence.',
    provesRenewal: false,
  };
}

/**
 * Pull the facts out of a run's reports.
 *
 * THE FIRST `session` REPORT, NOT THE LAST. A run may navigate inside the webview and
 * re-report; only the first describes the state we ARRIVED in, which is the entire
 * measurement. Later ones compare against a marker this same run has already written.
 *
 * The token facts come from the first `token` report carrying them — the probe deliberately
 * puts the timings only on the first sighting of each distinct token, so later reports are
 * presence-only repeats.
 */
export function factsFromReports(
  reports: Array<{ n?: number; stage: string; detail?: Record<string, unknown> | null }>,
): RcAppSessionFacts | null {
  const session = reports.find((r) => r.stage === 'session');
  if (!session) return null;
  const d = session.detail ?? {};
  const token = reports.find(
    (r) => r.stage === 'token' && (r.detail as { captured?: boolean } | null)?.captured === true,
  );
  const timed = reports.find(
    (r) => r.stage === 'token' && typeof (r.detail as { decodable?: unknown } | null)?.decodable === 'boolean',
  );
  const t = (timed?.detail ?? {}) as Record<string, unknown>;

  return {
    marker: d.marker === 'present' || d.marker === 'absent' ? d.marker : null,
    opens: num(d.opens),
    lastOpenAgoSec: num(d.lastOpenAgoSec),
    firstOpenAgoSec: num(d.firstOpenAgoSec),
    prevTokenExpiresInSec: num(d.prevTokenExpiresInSec),
    storedToken:
      d.storedToken === 'none' || d.storedToken === 'jwt' || d.storedToken === 'opaque'
        ? d.storedToken
        : null,
    storedExpiresInSec: num(d.storedExpiresInSec),
    liveTokenCaptured: Boolean(token),
    liveTokenExpiresInSec: num(t.expiresInSec),
    liveTokenAgeSec: num(t.ageSec),
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "3h 20m" / "45m" / "12s" — a duration a human reads without arithmetic. */
function hours(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return rem ? `${h}h ${rem}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
