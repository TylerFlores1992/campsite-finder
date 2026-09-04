/**
 * MAY WE OFFER A HOLD ON THIS HELD UNIT, AND IF NOT, WHY NOT.
 *
 * Extracted from `poller.ts` on 2026-09-04 for the reason `claim.ts`, `hold-claim.ts`,
 * `hold-line.ts` and `held-cadence.ts` were: importing the poller STARTS it, so a decision
 * that lives inline there cannot be tested, and this one governs whether a user is handed
 * a button promising to take a real campsite off the market.
 *
 * ── THE BUG THIS EXISTS FOR (2026-09-04) ────────────────────────────────────────────
 *
 * `offerHold` for the PRIMARY held unit sat BELOW `claimHoldNotification`. That claim is
 * once per (watch, release, unit) and every later cycle `continue`s on it, so the offer got
 * exactly ONE attempt per release — and `offerHold` is wrapped in `.catch(() => null)`, so
 * a transient throw lost the offer for that release for ever, silently, with the alert
 * still going out.
 *
 * Observed in production: a coming-soon for Leo Carrillo #L034 (unit 42527) at
 * 2026-09-04 01:11 UTC returned null from `offerHold`, and the row could not be recreated
 * by any later cycle because the claim was spent. It had to be inserted by hand, ten hours
 * before the release.
 *
 * THE EXTRAS LOOP HAD ALWAYS DONE IT RIGHT — calling `offerHold` unconditionally on every
 * cycle, with a comment explaining that a contest can appear at any time. The primary unit
 * was the one that did not, purely because its call happened to sit behind a gate meant for
 * the NOTIFICATION. That is the 2026-08-28 `rankHoldLine` finding exactly, one call site
 * along, and it is why both paths go through this module now instead of two hand-rolled
 * copies that were already disagreeing.
 *
 * ── AND THE TWO PATHS DISAGREED ABOUT THE GATES, WHICH IS THE SHARPER HALF ───────────
 *
 * The primary was gated on entitlement AND the bot being alive AND room in the cart AND the
 * portal being one the bot has an account for. The extras loop checked ONLY entitlement —
 * so an extra could be offered while the RC runner was dead (the 2026-08-11 case: a tap
 * answered "we'll grab it the moment it opens" with nothing running to do it), past
 * `RC_HOLD_CAPACITY` (the 2026-08-13 case: RC refused the third cart in its own words), or
 * on one of the nine UseDirect portals the bot holds no account for (the 2026-08-17 case,
 * which has never fired only because every live watch is ReserveCalifornia).
 *
 * A rule applied to one consumer and not to its sibling asking the same question is the
 * failure this repo keeps recording — most recently the health route's inline hold counts
 * missing the `REAL_UNIT` filter that `nextHoldRelease` had. One definition, both callers.
 */

/** Everything the decision needs, all of it already fetched by the caller. */
export interface HoldOfferFacts {
  /** A UseDirect `Lock` with no unit id cannot be carted — nothing to precart. */
  hasUnit: boolean;
  /** `lib/auth.hasAutocartEntitlement` — the one definition, six enforcers. */
  entitled: boolean;
  /** `rcBotUsable().ok` — FAILS CLOSED when the heartbeat cannot be read at all. */
  botOk: boolean;
  /** `holdWindowLoad(...) < RC_HOLD_CAPACITY`. */
  roomToHold: boolean;
  /** `supportsRcHold(source)` — narrower than `isUseDirectSource` on purpose. */
  portalOk: boolean;
}

export type HoldOfferBlocker =
  | 'no-unit'
  | 'not-entitled'
  | 'bot-absent'
  | 'no-room'
  | 'portal-unsupported';

export interface HoldOfferDecision {
  mayOffer: boolean;
  /** null exactly when `mayOffer` is true. */
  blockedBy: HoldOfferBlocker | null;
}

/**
 * ORDERED MOST-STRUCTURAL FIRST, because the blocker is what gets LOGGED and a human
 * reading "the RC runner is absent" for an Ohio watch would go and restart a bot that was
 * never the reason. `no-unit` and `portal-unsupported` are properties of the thing itself;
 * `bot-absent` and `no-room` are transient states of ours.
 *
 * EVERY BRANCH WITHHOLDS THE BUTTON AND NOTHING ELSE. The coming-soon alert still goes out
 * in all five cases — "here is what opens tomorrow, book it yourself at 08:00" — which is
 * the honest version of the same message. A missing button costs a convenience; a button
 * that answers "we'll grab it" with nothing behind it costs a campsite AND stops the user
 * watching, which is the rule every claim-screen decision has followed since 2026-08-09.
 */
export function holdOfferDecision(f: HoldOfferFacts): HoldOfferDecision {
  if (!f.hasUnit) return { mayOffer: false, blockedBy: 'no-unit' };
  if (!f.portalOk) return { mayOffer: false, blockedBy: 'portal-unsupported' };
  if (!f.entitled) return { mayOffer: false, blockedBy: 'not-entitled' };
  if (!f.botOk) return { mayOffer: false, blockedBy: 'bot-absent' };
  if (!f.roomToHold) return { mayOffer: false, blockedBy: 'no-room' };
  return { mayOffer: true, blockedBy: null };
}

/**
 * The log line for a blocker, or null for the two that are not worth a line.
 *
 * `not-entitled` is the ordinary state of most users and `no-unit` is the ordinary state of
 * every source that reports a lock without one — printing either every held check would
 * bury the three that mean something. That matters more than it looks: `tail-log` returns
 * the last 16,000 characters, and noise there is how the 2026-08-23 memory attributions
 * were lost.
 */
export function describeHoldBlocker(
  blocker: HoldOfferBlocker,
  ctx: { source: string; botBeatAgeMs: number | null; load: number; capacity: number },
): string | null {
  switch (blocker) {
    case 'portal-unsupported':
      return `NOT offering a hold — ${ctx.source} is UseDirect but the cart bot only holds a ` +
        'ReserveCalifornia account. Coming-soon alert without a hold link.';
    case 'bot-absent':
      return 'NOT offering a hold — the RC runner is absent ' +
        `(${ctx.botBeatAgeMs == null ? 'never beat' : `last beat ${Math.round(ctx.botBeatAgeMs / 1000)}s ago`}). ` +
        'Sending the coming-soon alert without a hold link.';
    case 'no-room':
      return `NOT offering a hold — ${ctx.load} site(s) already spoken for and we can hold ` +
        `${ctx.capacity}. Sending the coming-soon alert without a hold link.`;
    case 'no-unit':
    case 'not-entitled':
      return null;
  }
}
