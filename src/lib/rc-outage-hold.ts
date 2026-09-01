/**
 * SHOULD WE KEEP HOLDING THIS SITE BECAUSE RESERVECALIFORNIA IS DOWN?
 *
 * ## The loss this prevents
 *
 * `expireStaleHolds(45)` releases a carted-but-unclaimed hold on a timer, and that is right
 * almost always: sitting on a site nobody came for is the inventory-grabbing this whole
 * design exists to prevent.
 *
 * It is exactly wrong in one case. **RC's WEB tier fails while its DATA API stays healthy**,
 * and when it does the user physically cannot complete the hand-off — so we hand the campsite
 * back to the open market at the precise moment they are unable to take it.
 *
 * That is not hypothetical and it is not inferred. Twice measured, 2026-08-30 and 2026-09-01:
 * `www.reservecalifornia.com` answered 200 in ~0.38s from our infrastructure and
 * `detect:reservecalifornia` was green — reading live availability — while the owner could not
 * load RC on a phone, on a PC, or through a VPN. **The bot's own session is unaffected by this
 * class of outage**, which is what makes holding through it possible at all.
 *
 * ## The signal, and why it is per-user rather than a health check
 *
 * A health check cannot see this: RC's edge serves the SPA shell with a clean 200 whether or
 * not the app behind it boots, which is why `curl` looks perfect throughout. The failure is
 * client-side.
 *
 * So the evidence is the CLIENT's own: since the load watchdog shipped, a hand-off that could
 * not reach RC reports `close` with reason `never-loaded` or `load-error`. That is direct
 * evidence RC failed **for this person, on this hold** — not an inference from somewhere else.
 *
 * ## THREE RULES, AND EACH ONE IS A WAY THIS COULD DO HARM
 *
 * 1. **BOUNDED.** One extension of `RC_OUTAGE_GRACE_MIN`, never an open-ended hold. An
 *    unbounded version parks a real campsite in our cart indefinitely on the strength of one
 *    failed page load — the 2026-08-13 leak with a justification attached.
 *
 * 2. **THE EVIDENCE MUST BE FRESH.** A failure reported forty minutes ago says nothing about
 *    now; RC may well be back. Holding on stale evidence is precisely "holding a site nobody
 *    is coming for", which is the thing the sweep exists to stop.
 *
 * 3. **UNKNOWN RELEASES.** No reports, unreadable reports, a missing timestamp — all release
 *    on the normal schedule. We cannot tell "RC was down" from "the user closed the window and
 *    went to work", and only one of those deserves the campsite. The failure direction is
 *    always the status quo, which is the rule `hasAvailabilityInRange` and `mayCloseOnToken`
 *    already follow.
 *
 * ## WHAT IS STILL UNMEASURED, and why the bound is conservative
 *
 * **Nobody knows how long RC lets us hold a cart.** `RC_CART_HOLD_MINUTES = 15` is read off
 * RC's own bundle and has already been measured wrong once — on 2026-08-25 RC was still
 * holding at **45 minutes**, when our own sweep released it. `rc-probe.mjs --cart-lapse` is
 * built to settle this and has never been run.
 *
 * So 30 minutes is chosen to keep the total (45 + 30 = 75) near the only figure anyone has
 * actually observed RC honouring, rather than derived from a number we trust. **Raise it only
 * once the lapse is measured** — past RC's real limit the extension buys nothing, because RC
 * has already let the site go and we are holding an empty cart while telling a user otherwise.
 */

/** One extension, in minutes. See rule 1 and the unmeasured-lapse note above. */
export const RC_OUTAGE_GRACE_MIN = 30;

/** The close reasons that mean RC's web tier, not the user, ended the hand-off. */
const OUTAGE_REASONS = new Set(['never-loaded', 'load-error']);

export interface OutageHoldInput {
  /** `client_reports`, as stored. Unknown because it is jsonb from another context. */
  reports: unknown;
  /** When the client last reported. Null for a hold nobody ever opened. */
  clientReportedAt: string | Date | null | undefined;
  /** When the bot carted. Null is unknown and therefore releases. */
  cartedAt: string | Date | null | undefined;
  /** The normal sweep window, so the bound is computed from the same number the caller used. */
  holdMinutes: number;
  now: Date;
}

function asDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @returns a reason to keep holding, or `null` to release on the normal schedule.
 *
 * A STRING RATHER THAN A BOOLEAN, so the caller can put it in `last_attempt_note` and the
 * readout can say WHY a hold outlived its window. "Still carted at 70 minutes" with no
 * explanation is the dead-runner signature, and manufacturing one of those is how a
 * diagnostic feature creates the incident it was meant to clarify.
 */
export function rcOutageHoldReason(input: OutageHoldInput): string | null {
  const { reports, clientReportedAt, cartedAt, holdMinutes, now } = input;

  // Rule 3: unknown releases. Every early return here is that rule.
  if (!Array.isArray(reports) || reports.length === 0) return null;
  const carted = asDate(cartedAt);
  const reported = asDate(clientReportedAt);
  if (!carted || !reported) return null;

  const failed = reports.some((r) => {
    const rep = r as { stage?: unknown; detail?: unknown } | null;
    if (!rep || rep.stage !== 'close') return false;
    const reason = (rep.detail as { reason?: unknown } | null)?.reason;
    return typeof reason === 'string' && OUTAGE_REASONS.has(reason);
  });
  if (!failed) return null;

  const graceMs = RC_OUTAGE_GRACE_MIN * 60_000;

  // Rule 2: the evidence must be fresh. Measured from the last CLIENT report rather than from
  // the hold, because the question is "is RC down NOW", not "was it down at some point".
  if (now.getTime() - reported.getTime() > graceMs) return null;

  // Rule 1: bounded. One grace period past the normal window and no more, whatever the client
  // keeps reporting — otherwise a phone retrying every minute holds the site for ever.
  const deadline = carted.getTime() + holdMinutes * 60_000 + graceMs;
  if (now.getTime() >= deadline) return null;

  // A STABLE SENTENCE, NOT A COUNTDOWN. The obvious version says "holding N more minutes",
  // and it is wrong the moment it is stored: `last_attempt_note` is a column, not a live
  // reading, and a stale number there reads as fact. This repo has already been misled by a
  // stored value presented as current (`bot_commit` beside a live heartbeat). The rule is
  // durable; `last_attempt_at` carries the freshness.
  return RC_OUTAGE_HOLD_NOTE;
}

/**
 * EXPORTED so no test can pin a copy of the wording, and so the readout can match on it
 * rather than on a substring somebody retypes. Same reason `BEHIND_NOTE` is exported.
 */
export const RC_OUTAGE_HOLD_NOTE =
  "ReserveCalifornia's web app failed for this user, so releasing now would hand the site " +
  `back when they cannot take it — holding for up to ${RC_OUTAGE_GRACE_MIN} more min. ` +
  "RC's data API is healthy, so the bot's own cart is unaffected.";
