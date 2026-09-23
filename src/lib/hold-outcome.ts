/**
 * DID THE USER ACTUALLY GET THE CAMPSITE? — and the honest answer is sometimes "we cannot
 * tell", which is the whole reason this exists.
 *
 * ## The bug
 *
 * `scripts/rc-holds-readout.mts` printed a column headed `claimed` whose value was
 * `claimed_at ?? released_at`. For a hold the user never claimed, that shows **the time the
 * bot LET GO** under a heading that says the user took it. Two campsites lost on 2026-09-21
 * rendered as the happy path, in the one readout anybody consults to find out how a release
 * went.
 *
 * That is this repository's most-repeated failure in a single `??`: an absent reading —
 * `claimed_at IS NULL` — rendered as a positive fact.
 *
 * ## Why this is NOT a new database state
 *
 * The obvious repair is a `lost` status and a sweep that writes it. **It would be wrong**,
 * because `released` with no claim is genuinely ambiguous and the readout's own comments
 * already say so: on a plain desktop browser there is no injectable client, the user books
 * by hand, nothing is ever reported back, and **that is a success**. A `lost` state would
 * assert a fact nobody has, which is the same error one step in the other direction — and
 * it would spend main's last migration number to do it.
 *
 * So the outcome is DERIVED, and `unresolved` is a first-class answer rather than a gap.
 *
 * ## The ordering is the design
 *
 * A single run can report several things — the RC SPA navigates after a successful cart, the
 * bundle re-injects, and the second submit is refused with `cart is already added`. That
 * refusal is **proof the cart survived**, so a success anywhere in a run outranks a later
 * failure. Checked in that order, not by taking the last line.
 */

/** What the readout may say happened, in the order the checks apply. */
export type HoldOutcome =
  /** `claimed_at` is set — the user's own session took it. Recorded, never inferred. */
  | 'claimed'
  /** The injected client reported a cart it got. A win we observed rather than were told. */
  | 'client-carted'
  /** The client reported a terminal failure. The one case where a LOSS is established. */
  | 'client-failed'
  /** Released, and nothing settles it. Could be a desktop booking; could be a loss. */
  | 'unresolved'
  /** Never reached a hand-off at all — expired, failed, or still ahead of its release. */
  | 'not-handed-off';

export interface HoldOutcomeInput {
  status: string;
  claimed_at: string | null;
  released_at: string | null;
  client_reports?: ReadonlyArray<{ stage: string; detail?: Record<string, unknown> | null }> | null;
}

/** Every string a report can carry a verdict in, oldest first. */
function saidLines(h: HoldOutcomeInput): string[] {
  return (h.client_reports ?? [])
    .map((r) => String(r.detail?.status ?? r.detail?.message ?? ''))
    .filter(Boolean);
}

export function holdOutcome(h: HoldOutcomeInput): HoldOutcome {
  // 1. THE RECORDED FACT OUTRANKS EVERYTHING. `claimed_at` is written by the claim route
  //    when the user's own session took it; nothing derived can be more certain than that.
  if (h.claimed_at) return 'claimed';

  // 2. NOT HANDED OFF AT ALL. `released_at` is the bot letting go; without it there was no
  //    exposure window and no race to lose. An `expired` hold nobody tapped belongs here,
  //    not in `unresolved` — it is not an unanswered question, it is a different story.
  if (!h.released_at) return 'not-handed-off';

  const said = saidLines(h);

  // 3. A SUCCESS ANYWHERE OUTRANKS A LATER FAILURE, and that ordering was paid for: on both
  //    proven holds the LAST line read `RC declined (200) - cart is already added`, which is
  //    RC refusing a second submit over an entry we already held. Reading the last line
  //    reported the two runs that settled the question as failures.
  if (said.some((s) => s.includes('Added to cart'))) return 'client-carted';
  // `already added` on its own is also RC saying the cart is ours — the same reading the
  // runner's burst gets, and the opposite of what it was logged as for fifteen minutes.
  if (said.some((s) => /already added/i.test(s))) return 'client-carted';

  // 4. AN ESTABLISHED LOSS — the client got far enough to be refused. This is the only
  //    branch entitled to say the site was lost, and it says so because something reported
  //    it, not because nothing did.
  if (said.some((s) => /not available|sign.?in|expired|could not|would not/i.test(s))) {
    return 'client-failed';
  }

  // 5. WE CANNOT TELL, AND THAT IS THE ANSWER. Do not round it to either verdict.
  return 'unresolved';
}

/** How the readout prints it — the label carries the uncertainty rather than hiding it. */
export function describeHoldOutcome(o: HoldOutcome): string {
  switch (o) {
    case 'claimed': return 'claimed by the user';
    case 'client-carted': return 'carted by the user’s own session';
    case 'client-failed': return 'LOST — the client was refused';
    case 'unresolved': return 'UNRESOLVED — released, never confirmed (desktop booking, or lost)';
    case 'not-handed-off': return 'no hand-off';
  }
}
