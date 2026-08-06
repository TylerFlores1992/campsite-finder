// Keep an alert text inside ONE SMS segment.
//
// WHY THIS EXISTS (2026-08-05). Twilio's message log showed a perfect split on the
// segment column: every 1-segment message to our subscribers was Delivered, every
// 2-segment message was Undelivered with error 30007 ("message filtered"). Fifty rows,
// one exception, and that one was to a different handset. Our alerts were 2 segments
// (~186 chars: a Book: link AND a Manage: link) while the auto-cart texts that kept
// arriving were 1 segment (~133 chars, one recreation.gov link).
//
// Read that correlation carefully, because it is CONFOUNDED and this module is only
// half a fix: every 2-segment message we send also carries a `camphawk.app` link, and
// every 1-segment one does not. So "carriers filter our long messages" and "carriers
// distrust our link domain" predict the identical fifty rows. Dropping the Manage:
// link is what separates them — it makes the alert 1 segment while KEEPING a
// camphawk.app link. If alerts start arriving, it was length. If they still don't, it
// is the domain, and the answer is registering camphawk.app on the A2P 10DLC campaign,
// not more copy-trimming. Do not delete this note until that question is answered.
//
// Extracted from index.ts so it can be tested without dragging in the DB client and
// the `@/` alias, same reason as twilio-signature.ts.

/**
 * GSM-7 single-segment budget.
 *
 * Characters, not bytes. A message containing any character outside GSM-7 is sent as
 * UCS-2 and the budget COLLAPSES to 70 — which would silently make everything below
 * wrong. We rely on Twilio's Smart Encoding transliterating our em dashes and curly
 * quotes down to GSM-7, which the evidence supports: the delivered cart texts contain
 * an em dash in our source, arrived rendering a hyphen, and Twilio counted them as one
 * segment. **If Smart Encoding is ever turned off on the Messaging Service, this number
 * is a lie and every alert goes back to two segments.**
 */
export const SMS_ONE_SEGMENT = 160;

/** Below this many characters a campground name stops being recognisable, and a text
 *  you cannot identify at a glance is no better than one that never arrived. */
const MIN_NAME = 14;

/**
 * Build a message that fits one segment, shortening the campground name if it doesn't.
 *
 * `build` takes the name and returns the whole body, so the caller keeps ownership of
 * the wording and this only ever decides how much name there is room for. The name is
 * the flexible part by choice: the dates and the booking link are what the reader acts
 * on, while a name is still useful truncated — you know which watch fired.
 *
 * If even a minimal name won't fit, the FULL body is returned rather than a mangled
 * one. Two segments that say something beat one that says nothing; being over budget is
 * a delivery risk, being unreadable is a certainty.
 */
export function fitOneSegment(build: (name: string) => string, name: string): string {
  const full = build(name);
  if (full.length <= SMS_ONE_SEGMENT) return full;

  // STEP 1: drop a trailing parenthetical before cutting anything else.
  //
  // "Leo Carrillo SP - Canyon Campground (sites 1-24, 78-133)" is the real shape, and
  // the bracket is both the longest and least useful part — the alert already names the
  // specific site, so the range in the name tells the reader nothing. Cutting blind
  // through it produced "Leo Carrillo SP - Canyon Campground (si." in a live alert,
  // which looks like a bug even though the message was correct.
  const noParens = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (noParens.length >= MIN_NAME && noParens !== name) {
    const attempt = build(noParens);
    if (attempt.length <= SMS_ONE_SEGMENT) return attempt;
    name = noParens; // still too long, but a better starting point for the cut below
  }

  const overBy = build(name).length - SMS_ONE_SEGMENT;
  const room = name.length - overBy - 1; // -1 for the trailing '.'
  if (room < MIN_NAME) return build(name).length <= SMS_ONE_SEGMENT ? build(name) : full;

  // STEP 2: cut on a WORD BOUNDARY, and never leave a dangling opener.
  //
  // Truncating mid-token is what makes a trimmed name look broken rather than short.
  // Falling back to the hard cut matters for names with no spaces in range.
  let short = name.slice(0, room);
  const lastSpace = short.lastIndexOf(' ');
  if (lastSpace >= MIN_NAME) short = short.slice(0, lastSpace);
  short = short.replace(/[\s(\-–—,;:]+$/, '').trimEnd();
  if (short.length < MIN_NAME) short = name.slice(0, room).trimEnd();

  // A single '.' rather than '…': the ellipsis character is not in GSM-7, so it would
  // either cost three characters after transliteration or tip the whole message into
  // UCS-2 — the exact failure this function exists to avoid.
  const fitted = build(`${short}.`);
  return fitted.length <= SMS_ONE_SEGMENT ? fitted : full;
}
