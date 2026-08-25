/**
 * Who gets the campsite when two people are promised the same one?
 *
 * EXTRACTED FROM poller.ts SO IT CAN BE TESTED, for exactly the reason `claim.ts` and
 * `hold-claim.ts` were: importing poller.ts STARTS the poller, so a decision this
 * consequential would otherwise be unreachable from a test.
 *
 * THE PROBLEM IS LIVE. On 2026-08-24 unit 43191 ("#96", Morro Bay, arrival 2026-09-04)
 * was offered to two different users for the same 08:00 release — melinda.flores0501
 * through "Morro Lottery sites" and tylerflores1992 through "Upper Section". RC lists one
 * physical campsite under more than one facility, so both offers were correct and there
 * was still only one campsite. Nothing decided who got it: `dueHolds` had no de-dupe, so
 * had both tapped, the runner would have been handed both rows and asked RC for the same
 * unit twice.
 *
 * A LINE is every live hold sharing one `(release_at, unit_id)` — one physical site at one
 * release moment. Ordered by:
 *
 *   1. The rotation ticket, lowest first — 0 means never given first dibs, so those go
 *      ahead of anyone who has, and among people who have, longest-ago first.
 *   2. `watches.created_at` ASC — the owner's rule: whoever watched first gets first dibs.
 *   3. hold id — deterministic, so two shards ranking the same line agree.
 *
 * ROTATION IS SPENT BY WHOEVER LANDS AT RANK 1, NOT BY EVERY PERSON OFFERED. Both rivals
 * are offered the hold (nobody is silently excluded), but only one is given first dibs,
 * and that is the scarce thing. Charging the ticket to rank 1 is what makes "everyone else
 * moves up" literally true, and it charges it whether or not they go on to claim — which
 * is the owner's amendment: rotating on WINS would let a user who never claims sit at the
 * top for ever.
 *
 * THE TICKET IS FROZEN PER LINE, and that is not a detail. Charging the winner raises
 * their `users.hold_offer_seq`, so a live read would sort them BELOW the person they had
 * just beaten on the very next poller cycle — which flips the ranks, charges the runner-up
 * as well, and changes the "you're first in line" a user is reading. The line records the
 * ticket each member was RANKED with (`rc_hold_requests.line_seq`) and orders on that, so
 * the charge lands where it is meant to: on the NEXT contest. Found by a test, not by
 * review.
 *
 * WHAT THIS DOES NOT DO: the expiry cascade (cart for rank 1, and on a lapse re-cart for
 * rank 2) is deliberately absent. It depends on RC's real cart lapse, which is read off
 * RC's own bundle as ~15 minutes and HAS NEVER BEEN OBSERVED, while `reclaimLapsedHolds`
 * waits 180. Between those two numbers we would be re-carting a site RC may already have
 * released to the public and telling a second user we hold something we do not. Measure
 * the lapse first. The line itself does not depend on it.
 */
import { query, mutate } from '../src/lib/db/client';

export interface LineMember {
  id: string;
  userId: string;
  status: string;
  rank: number;
}

/** A hold and the facts the ordering rule reads. Kept separate from the SQL so the rule
 *  itself can be tested without a database — the ordering is the part that has to be
 *  right, and it is three comparisons that are easy to get subtly wrong. */
export interface LineCandidate {
  id: string;
  userId: string;
  status: string;
  /** The rotation ticket this hold is ranked with. 0 = never given first dibs. */
  offerSeq: number;
  /** `watches.created_at`, as an ISO string. */
  watchCreatedAt: string;
}

/**
 * The ordering rule, pure.
 *
 * A ZERO TICKET SORTS FIRST, and that is the whole rotation. A user who has never been
 * given first dibs outranks one who has, however long ago — otherwise a new watcher would
 * start at the back of a queue that has never served them, which is not a queue.
 */
export function orderLine<T extends LineCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (a.offerSeq !== b.offerSeq) return a.offerSeq - b.offerSeq;
    // Both never given first dibs, or both given it at the same moment: the owner's rule.
    if (a.watchCreatedAt !== b.watchCreatedAt) return a.watchCreatedAt < b.watchCreatedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Distinct users in a line. A line with one user is not a contest, whatever its length —
 *  the same person watching one site through two of RC's facilities is not two people. */
export function isContested(candidates: readonly LineCandidate[]): boolean {
  return new Set(candidates.map((c) => c.userId)).size > 1;
}

/**
 * Rank the line for one `(release_at, unit_id)` and persist it.
 *
 * Called after every offer. It is idempotent: re-ranking an unchanged line rewrites the
 * same numbers and spends no ticket, because the ticket is recorded on the hold row.
 *
 * Returns the ordered line, or an empty array if nothing needed ranking or the read
 * failed. A failure is never fatal — an unranked line falls back to today's behaviour,
 * which is what shipped for a year.
 */
export async function rankHoldLine(releaseAt: string, unitId: string): Promise<LineMember[]> {
  let candidates: (LineCandidate & {
    lineRank: number | null; rotatedAt: string | null; frozen: boolean;
  })[];
  try {
    const rows = await query<{
      id: string; user_id: string; status: string;
      live_seq: string | null; line_seq: string | null; watch_created_at: string;
      line_rank: number | null; line_rotated_at: string | null;
    }>(
      `SELECT h.id, h.user_id, h.status,
              u.hold_offer_seq AS live_seq, h.line_seq,
              -- FORCED TO UTC AND ZERO-PADDED, because this is compared as a STRING. An
              -- offset-bearing format sorts by text and would rank two watches created a
              -- minute apart in different offsets backwards.
              to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS watch_created_at,
              h.line_rank, h.line_rotated_at
         FROM rc_hold_requests h
         JOIN watches w ON w.id = h.watch_id
         JOIN users   u ON u.id = h.user_id
        WHERE h.release_at = $1 AND h.unit_id = $2
          AND h.status IN ('offered', 'requested')`,
      [releaseAt, unitId],
    );
    candidates = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      status: r.status,
      // The FROZEN ticket wins over the live one. A member joining a line that is already
      // ranked has none yet and is ranked on their live value, then frozen with everyone
      // else on the next pass.
      offerSeq: r.line_seq != null ? Number(r.line_seq) : Number(r.live_seq ?? 0),
      watchCreatedAt: r.watch_created_at,
      lineRank: r.line_rank,
      rotatedAt: r.line_rotated_at,
      frozen: r.line_seq != null,
    }));
  } catch (err) {
    console.error('[hold-line] read failed:', (err as Error).message);
    return [];
  }
  if (!candidates.length) return [];

  const ordered = orderLine(candidates);

  // WRITE THE RANKS BEFORE SPENDING THE TICKET. Spending it first would change the very
  // `hold_offer_seq` this ordering was computed from, so a re-rank in the same cycle — two
  // shards, or a second offer for the same unit — would see a different line and hand out
  // different numbers. Order first, persist, then charge.
  const changed = ordered
    .map((c, i) => ({ id: c.id, rank: i + 1, was: c.lineRank }))
    .filter((c) => c.was !== c.rank);
  if (changed.length) {
    await mutate(
      `UPDATE rc_hold_requests AS h SET line_rank = v.rank
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS rank) AS v
        WHERE h.id = v.id`,
      [changed.map((c) => c.id), changed.map((c) => String(c.rank))],
    ).catch((e) => console.error('[hold-line] rank write failed:', e.message));
  }

  // ONLY A GENUINE CONTEST ROTATES ANYBODY. Charging a ticket for an uncontested offer
  // would push a user down the queue for a site nobody else wanted, which costs them their
  // place in a future contest they have not yet had. The measured case is the contest.
  if (isContested(candidates)) {
    // FREEZE BEFORE CHARGING. The charge below raises the winner's live ticket, and
    // without a frozen copy the next re-rank of this same line would sort them below the
    // person they just beat. Only members that have never been frozen are written, so a
    // line that has already settled is never re-cut.
    const toFreeze = ordered.filter((c) => !c.frozen);
    if (toFreeze.length) {
      await mutate(
        `UPDATE rc_hold_requests AS h SET line_seq = v.seq
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::bigint[]) AS seq) AS v
          WHERE h.id = v.id`,
        [toFreeze.map((c) => c.id), toFreeze.map((c) => String(c.offerSeq))],
      ).catch((e) => console.error('[hold-line] freeze failed:', e.message));
    }
    const first = ordered[0];
    if (first && !first.rotatedAt) {
      await mutate(
        `UPDATE users SET hold_offer_seq = nextval('hold_offer_seq_counter') WHERE id = $1`,
        [first.userId],
      ).catch((e) => console.error('[hold-line] rotate failed:', e.message));
      // Stamped on the HOLD, so the contest charges this user once however many poller
      // cycles re-rank it. On the user it could only record "was rotated at all".
      await mutate(
        `UPDATE rc_hold_requests SET line_rotated_at = NOW() WHERE id = $1`,
        [first.id],
      ).catch((e) => console.error('[hold-line] rotate stamp failed:', e.message));
    }
    // SAY WHY NOTHING IS HAPPENING TO THE OTHERS. A `requested` hold sitting past its
    // release with `last_attempt_note` NULL is what this project's readout calls "NOTHING
    // has tried to act on this hold at all" — the signature of the 2026-08-07 runner
    // outage. Suppressing a hold at the cart without recording why would manufacture that
    // false alarm on every contested morning. `noteAttempt`'s contract is exactly this:
    // it records that something looked at the hold and did nothing, and deliberately moves
    // neither `status` nor `updated_at`.
    const behind = ordered.slice(1).filter((c) => c.status === 'requested').map((c) => c.id);
    if (behind.length) {
      const { noteAttempt } = await import('../src/lib/rc-holds');
      await noteAttempt(
        behind,
        'another watcher is ahead of you in line for this site — they watched it first, ' +
        'so their hold is the one being carted',
      ).catch(() => {});
    }
  }

  return ordered.map((c, i) => ({ id: c.id, userId: c.userId, status: c.status, rank: i + 1 }));
}
