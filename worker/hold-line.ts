/**
 * Who gets the campsite when two people are promised the same one?
 *
 * EXTRACTED FROM poller.ts SO IT CAN BE TESTED, for exactly the reason `claim.ts` and
 * `hold-claim.ts` were: importing poller.ts STARTS the poller, so a decision this
 * consequential would otherwise be unreachable from a test.
 *
 * THE PROBLEM IS LIVE. On 2026-08-24 unit 43191 ("#96", Morro Bay, arrival 2026-09-04)
 * was offered to two different users for the same 08:00 release. Nothing decided who got
 * it: `dueHolds` had no de-dupe, so had both tapped, the runner would have been handed
 * both rows and asked RC for the same unit twice.
 *
 * WHY THEY COLLIDED — CORRECTED 2026-08-25. This header used to say RC lists one physical
 * campsite under more than one facility, and that the two offers were therefore both
 * correct. **Both halves are false.** RC's September inventory has ZERO overlap between
 * the lottery pool (15 units, 54946…54960) and Upper Section (36 units), and 43191 is in
 * Upper Section alone. The real reason is far more ordinary: **both users watch the same
 * park, and both watches cover Upper Section.** One offer was then MISLABELLED rc-2185 by
 * the result-map collision `worker/watch-key.ts` fixed in the same pull request, which is
 * where the duplicate-facility story came from.
 *
 * That correction makes the line MORE load-bearing, not less. Contention is not an RC data
 * quirk that happens to one park; it is what any two users watching one facility produce,
 * so it scales with the product rather than staying rare.
 *
 * IT RAN FOR REAL ON 2026-08-25, and behaved. melinda (watch created 09:53) ranked 1 and
 * tyler (12:45) ranked 2; melinda never tapped, so `dueHolds` correctly served tyler and
 * he carted at T+2s. The one rough edge is the note below — see `behind`.
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

/**
 * What a hold that is not first in line is told, verbatim.
 *
 * A CONSTANT SO THE GUARD CANNOT TEST A COPY. It is compared against the stored value to
 * decide whether the note still needs writing, so a test that hard-coded the wording would
 * pass while the two drifted apart and the note was rewritten on every cycle for ever.
 *
 * CONDITIONAL WORDING, DELIBERATELY. The line ranks `offered` rows as well as `requested`
 * ones, so rank 1 may never tap — on 2026-08-25 that is exactly what happened and rank 2
 * carted the site at T+2s. A note asserting the hold ahead "is being carted" would have
 * been read backwards by whoever diagnosed the next morning.
 *
 * IT MUST STAY UNDER `noteAttempt`'s 300-CHARACTER TRUNCATION. Past that the stored value
 * can never equal this one, the skip below never matches, and the churn guard silently
 * stops guarding — a fix present and inert, which is the shape this repo has paid for
 * repeatedly. Pinned by a test.
 *
 * IT NO LONGER SAYS WHY (2026-08-28). It used to read "they watched it first", which was
 * true while watch age decided every contest. Migration 069 added `users.line_priority`,
 * so the account ahead may be there because it is flagged — and the old wording would then
 * assert something false to whoever reads this at 08:15 trying to work out what happened.
 * State the POSITION, which is always true, and not the REASON, which is not. Changing the
 * text costs one rewrite per hold already carrying the old note, then it matches and the
 * churn guard skips it as before.
 */
export const BEHIND_NOTE =
  'another watcher is ahead of you in line for this site, ' +
  'so if they also ask for it, theirs is the one we cart';

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
  /**
   * `users.line_priority` — the deliberate override. Higher is ranked first, ahead of
   * everything else here. 0 is the default and means "no override", so a line in which
   * nobody is flagged orders exactly as it did before migration 069.
   */
  priority: number;
}

/**
 * The ordering rule, pure.
 *
 * PRIORITY FIRST, AND IT IS A THUMB ON THE SCALE — see migration 069 for who asked, who
 * loses, and why it is a named column rather than a hand-edited ticket. Everything below
 * it is the fair rule and is unchanged.
 *
 * A ZERO TICKET SORTS FIRST, and that is the whole rotation. A user who has never been
 * given first dibs outranks one who has, however long ago — otherwise a new watcher would
 * start at the back of a queue that has never served them, which is not a queue.
 */
export function orderLine<T extends LineCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    // DESCENDING, unlike every other term here: for the ticket and the watch date lower
    // means earlier, but a priority is a rank and higher wins. Getting this one backwards
    // would silently put the flagged account LAST, which reads as the flag not working.
    if (a.priority !== b.priority) return b.priority - a.priority;
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
    lineRank: number | null; rotatedAt: string | null; frozen: boolean; note: string | null;
  })[];
  try {
    const rows = await query<{
      id: string; user_id: string; status: string;
      live_seq: string | null; line_seq: string | null; watch_created_at: string;
      line_priority: number | null;
      line_rank: number | null; line_rotated_at: string | null; last_attempt_note: string | null;
    }>(
      `SELECT h.id, h.user_id, h.status,
              u.hold_offer_seq AS live_seq, h.line_seq,
              -- READ LIVE, NOT FROZEN ONTO THE HOLD the way line_seq is, and the asymmetry
              -- is deliberate. The ticket is frozen because RANKING ITSELF SPENDS IT: a live
              -- read would sort the winner below the person they just beat on the very next
              -- cycle, flipping ranks under a reader. Nothing here charges a priority, so
              -- that failure cannot arise; it changes only when a human changes it, and
              -- when they do, taking effect on the next cycle is the point of changing it.
              -- Do not "make this consistent" by adding a frozen column — that would pin a
              -- revoked override onto every hold already in flight.
              u.line_priority,
              -- FORCED TO UTC AND ZERO-PADDED, because this is compared as a STRING. An
              -- offset-bearing format sorts by text and would rank two watches created a
              -- minute apart in different offsets backwards.
              to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS watch_created_at,
              h.line_rank, h.line_rotated_at, h.last_attempt_note
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
      // NULL COALESCES TO 0, i.e. no override. A box mid-deploy, or any row predating
      // migration 069, must rank by the fair rule rather than by an absent number.
      priority: Number(r.line_priority ?? 0),
      lineRank: r.line_rank,
      rotatedAt: r.line_rotated_at,
      frozen: r.line_seq != null,
      note: r.last_attempt_note,
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
    //
    // ── AND IT IS WRITTEN ON EVERY RE-RANK, NOT ONLY THE FIRST (fixed 2026-08-28) ──
    //
    // This filtered `ordered.slice(1)` down to rows that were ALREADY `requested` at the
    // one moment the line was ranked — and for the primary held unit that moment happened
    // exactly once, because its `rankHoldLine` call sat inside a block gated by
    // `claimHoldNotification` (once per watch, release and unit). So a rival who tapped
    // AFTER the line was ranked never got the note, and nothing re-ranked to give it to
    // them.
    //
    // That is the ordinary case, not an edge: an offer goes out the evening before and is
    // tapped the next morning. On 2026-08-26 the runner-up tapped fourteen seconds after
    // the line was ranked and their row carried no note at all — leaving a `requested`
    // hold sitting past its release with `last_attempt_note` NULL, which is precisely the
    // 2026-08-07 dead-runner signature this note exists to prevent being reported.
    //
    // The poller now re-ranks before the claim gate, so this runs every cycle. Skipping
    // rows that already carry the note is what keeps that from stamping `last_attempt_at`
    // every fifteen seconds all night — which would leave it permanently reading "0m ago"
    // and destroy the one column that says WHEN the line last changed its mind.
    const behind = ordered.slice(1)
      .filter((c) => c.status === 'requested' && c.note !== BEHIND_NOTE)
      .map((c) => c.id);
    if (behind.length) {
      const { noteAttempt } = await import('../src/lib/rc-holds');
      // CONDITIONAL, BECAUSE RANK 1 MAY NEVER TAP. The line ranks `offered` rows as well as
      // `requested` ones — deliberately, since an untapped rival can still tap before the
      // release — but `dueHolds` serves only the `requested`. On 2026-08-25 rank 1 never
      // answered and rank 2 carted the site at T+2s, with this note already on his row
      // asserting "their hold is the one being carted". It was not. The note is a
      // diagnostic (`last_attempt_note` is read by `rc-holds-readout.mts` and by nothing
      // user-facing), so this cost nobody a campsite — but a readout that states the
      // opposite of what happened is how the next morning gets misdiagnosed.
      await noteAttempt(behind, BEHIND_NOTE).catch(() => {});
    }
  }

  return ordered.map((c, i) => ({ id: c.id, userId: c.userId, status: c.status, rank: i + 1 }));
}
