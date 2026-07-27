/**
 * Whether to show the cancellation-likelihood percentages (feature E).
 *
 * OFF by design, not by accident. The signal is still being recorded and the API
 * still returns it — this only controls whether a number reaches a user.
 *
 * Why off: with thin history a real reading rounds to "Opens up on 0% of
 * checks", which reads as "this campground never opens" when it actually means
 * "we don't know yet". That misread is discouraging and wrong, and it's the same
 * reason the original SHOW_LIKELIHOOD in the old detail page is false.
 *
 * Turn on only when the buckets are deep enough that the numbers are worth
 * trusting — verify with `scripts/likelihood-readout.mts` first.
 */
export const SHOW_LIKELIHOOD = false;
