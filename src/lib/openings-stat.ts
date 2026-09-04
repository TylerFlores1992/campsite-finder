/**
 * THE ONE NUMBER ABOUT CANCELLATIONS THAT IS OURS, measured 2026-09-04.
 *
 * Every competitor's marketing says cancellations happen. None of them says how often,
 * because saying so requires having watched sold-out campgrounds around the clock and
 * counted. We have: `availability_observations` (migration 020) holds the frozen Feature E
 * roster — 502 campgrounds seeded as high-demand, probed hourly between 2026-07-22 and
 * 2026-09-04 — and the figures below are transitions out of it.
 *
 * A TRANSITION, NOT A LEVEL, and the distinction is the whole point. `had_opening` alone
 * counts a stay that was never sold out in the first place, which is availability and not a
 * cancellation. These count only an observation whose PREDECESSOR for the same
 * (campground, arrival, nights) was fully booked — i.e. something that was gone came back.
 *
 * WHAT IT DOES NOT SAY. It is not "your campground has a 0.9% chance"; it is a rate across a
 * population of famously hard-to-book places, and any single park will differ. It is also NOT
 * evidence for a lead-time cliff — see `lib/watch-outlook`, where the same query is run by
 * lead time and shows a booked-out stay 6-8 weeks out opening on MORE checks than one 2-3
 * weeks out, which is the opposite of the folk wisdom.
 *
 * Re-derive rather than trusting: the query is in `lib/watch-outlook`'s header and the table
 * is still being written by the poller's recorder.
 */
export const OPENINGS_STAT = {
  campgrounds: 502,
  checks: 125_118,
  openings: 1_100,
  from: '2026-07-22',
  to: '2026-09-04',
} as const;

/**
 * openings / checks, DERIVED rather than typed out beside them. A hand-written "0.9%"
 * next to the counts is two statements of one fact that can disagree, and the one a
 * reader believes is the one nobody re-checks.
 */
export const OPENINGS_PERCENT = `${((100 * OPENINGS_STAT.openings) / OPENINGS_STAT.checks).toFixed(1)}%`;
