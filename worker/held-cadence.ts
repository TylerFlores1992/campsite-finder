// How often the UseDirect "locked until a scheduled release" check runs.
//
// Separate from poller.ts for the same reason claim.ts, shard.ts and lead-time.ts are:
// importing the poller STARTS it, which is what made the most consequential code in the
// repo untestable.
//
// THE RULE THIS ENCODES. Polling frequency only buys something when the event is
// unpredictable. `findRCOpenUnit` watches for a site becoming bookable — unpredictable,
// gone in minutes, and speed is the only defence, so it stays on the 15s cycle.
// `findRCHeldUnit` watches for a site LOCKED until a published release time; we record
// that time and the cart fires off it. Discovering the lock five minutes later changes
// nothing about when the site gets carted.
//
// The floor that makes a slow cadence safe is `holdIsNewsworthy`, which refuses any
// coming-soon alert with under an hour of lead. A discovery delay only costs us something
// if it eats into that hour, and these releases are typically ~18 hours out.

/** Default gap between held checks. Overridden by `RC_HELD_CHECK_MS`. */
export const RC_HELD_CHECK_DEFAULT_MS = 300_000;

/**
 * Is another held check due?
 *
 * `lastAt = 0` means "never run", which must be due — otherwise a freshly deployed worker
 * would wait a full interval before its first look, and a deploy at 07:55 would miss an
 * 8am release entirely.
 */
export function heldCheckDue(lastAt: number, now: number, intervalMs: number): boolean {
  if (!lastAt) return true;
  // A clock that jumped backwards must not wedge this off for hours. Fly machines resume
  // from snapshots and NTP steps them; treating a future `lastAt` as "due" fails toward
  // checking, which costs one grid fetch.
  if (lastAt > now) return true;
  return now - lastAt >= intervalMs;
}

/**
 * The interval must stay well inside the newsworthiness floor.
 *
 * Exported so the poller's own constant is checked rather than trusted: setting
 * `RC_HELD_CHECK_MS` to an hour would silently mean a lock discovered at T-59min is
 * announced at T-0, i.e. never, because `holdIsNewsworthy` would refuse it. Clamped
 * rather than thrown on — a bad env var must not stop the poller.
 */
export function clampHeldInterval(ms: number, leadFloorMs = 60 * 60_000): number {
  if (!Number.isFinite(ms) || ms <= 0) return RC_HELD_CHECK_DEFAULT_MS;
  // A quarter of the floor leaves three further chances to see a lock before it stops
  // being newsworthy.
  return Math.min(ms, leadFloorMs / 4);
}

/**
 * RC'S RELEASE TIMES ARE ZONE-LESS PACIFIC WALL CLOCK. READ THEM AS SUCH.
 *
 * `availableAt` is UseDirect's `Lock` field verbatim — `2026-08-26T08:00:00`, no zone,
 * meaning eight in the morning **in California**. Every SQL call site already knows this
 * and converts with `AT TIME ZONE 'America/Los_Angeles'`; the one place that did the
 * arithmetic in JavaScript did not.
 *
 * `holdIsNewsworthy` used a bare `new Date(availableAt)`, whose comment argued that
 * treating the string as wall-clock "in the server's zone" was consistent with the
 * formatter downstream. **The formatter only DISPLAYS it**, and a display convention and
 * a time-arithmetic convention are not the same thing: `now` is a real instant, so the
 * comparison silently placed an 08:00 Pacific release at 08:00 UTC — **seven hours early**
 * on a Fly machine, which runs UTC.
 *
 * WHAT THAT COST, MEASURED 2026-08-26. The lead test is "at least an hour out", so with
 * the release believed to be 01:00 PT the offer window shut at **midnight Pacific** — eight
 * hours before the real release, and precisely across the hours when a user is most likely
 * to add a watch for tomorrow morning. Three consecutive offers fit it exactly:
 *
 *     tyler #123      offered 08-25 12:16 PT   computed lead +12h44m   sent
 *     melinda #SC67   offered 08-25 22:47 PT   computed lead  +2h13m   sent
 *     a watch created 08-26 05:08 PT           computed lead  -4h08m   REFUSED
 *
 * and the poller said so in its own words for two and a half hours:
 * `releases 2026-08-26T08:00:00 — too soon to be news, staying quiet`.
 *
 * A ZONE-BEARING STRING IS PASSED STRAIGHT THROUGH. If UseDirect ever starts sending an
 * offset or a `Z`, that string already names an instant and re-interpreting it as Pacific
 * would introduce the very error this fixes. Returning `NaN` there would be worse still —
 * `holdIsNewsworthy` refuses on `NaN`, so a format change would silently switch off every
 * coming-soon alert instead of failing loudly.
 */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** What the Pacific clock reads at a given UTC instant, as an offset in ms (PDT = -7h). */
function pacificOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'),
  );
  return asUtc - utcMs;
}

/**
 * Turn RC's zone-less Pacific wall clock into a real UTC instant.
 *
 * TWO PASSES, because the offset depends on the answer. The first guess uses the offset
 * in force at the naive timestamp; the second re-reads it at that guess, which is what
 * settles the two days a year when the two disagree. A wall-clock time inside the spring
 * gap does not exist and a time inside the autumn overlap happens twice — both resolve to
 * something sane here rather than throwing, because refusing would take the alert with it.
 */
export function pacificWallClockToUtcMs(availableAt: string): number {
  const s = String(availableAt ?? '').trim();
  if (ZONED.test(s)) return Date.parse(s);
  const m = NAIVE.exec(s);
  if (!m) return Number.NaN;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const first = naive - pacificOffsetMs(naive);
  return naive - pacificOffsetMs(first);
}

/**
 * A hold is only NEWS if it releases far enough out to be worth waiting for.
 *
 * Moved here from `poller.ts` on 2026-08-26 so it can be tested at all — importing the
 * poller STARTS it, which is why this function shipped with no test and carried a
 * seven-hour error for three weeks.
 *
 * The reasoning for the floor itself is unchanged and is the 2026-08-06 finding: the owner
 * got two texts a minute apart reading "opens Aug 6, 8:15 AM" and "opens Aug 6, 8:16 AM",
 * i.e. a lock roughly one minute ahead that kept creeping — a cart being extended, not an
 * overnight release. Suppressing those costs nothing, because when a short lock lapses the
 * site becomes free and the ordinary availability alert fires within one cycle. The
 * heads-up exists for the case where that is HOURS away and the user needs an alarm.
 */
export const HOLD_MIN_LEAD_MS = 60 * 60_000;

export function holdIsNewsworthy(availableAt: string, now = new Date()): boolean {
  const at = pacificWallClockToUtcMs(availableAt);
  if (!Number.isFinite(at)) return false;
  return at - now.getTime() >= HOLD_MIN_LEAD_MS;
}
