---
name: rc-autocart
description: The ReserveCalifornia auto-hold flow — how a hold moves offered → requested → carted → claiming → released, the fairness line when two users want one campsite, hold capacity, the pre-release cart burst, and the in-app hand-off. Use when working on or diagnosing RC holds, the cart burst, `worker/hold-line.ts`, `worker/hold-claim.ts`, `src/lib/rc-holds.ts`, `scripts/auto-cart-bot/`, ClaimFlow, `cart read back`, or an 08:00 PT release that carted late, carted twice or did not cart.
---

# RC auto-cart — hold, cart, hand over

ReserveCalifornia releases held campsites at a published time (nearly always **08:00 PT**).
A bot on the owner's Windows mini-PC carts the site the instant it frees and holds it until
the user claims it, at which point the bot **releases** and the user's own session takes it.

For "is it healthy right now / will tomorrow's hold cart" use **`/rc-status`** instead —
that skill is the operational check and its reading rules are not repeated here. This one is
for changing the code or explaining why it behaves as it does.

**`worker/hold-line.ts`, `worker/hold-claim.ts`, `worker/cart-burst.mjs` and `worker/claim.ts`
are separate modules because IMPORTING `poller.ts` STARTS THE POLLER.** That is the whole
reason the most consequential decisions in the product live in their own files: inside the
poller they were unreachable from a test, and every bug below shipped because of it. **Never
move one of them back in, and extract rather than inline the next one.**

## The state machine

| status | what it means | who writes it |
| --- | --- | --- |
| `offered` | the poller found a lock and sent the alert with a "Hold it for me" button. **Nobody tapped.** | `offerHold`, from the poller |
| `requested` | the user tapped. The bot will cart at the release. | `requestHold`, from the alert link |
| `carted` | the site is in an RC cart we hold | `markCarted`, from the runner |
| `claiming` | the user pressed "it's mine" and is signing in on RC | `beginClaim` |
| `released` \| `claimed` | the bot let go; the user's own session has it | `markReleased` |
| `failed` | RC refused, and the retry window has closed | `reportCartFailure` |
| `expired` | swept — nobody came for it | `reclaimLapsedHolds` |

**`offered` is not a fault and never was.** Most offers are never tapped. Say so plainly
rather than hunting for a reason.

**`requested` with the release already past is the ONE broken state**, and
`last_attempt_note` tells you which of two different faults it is — *"the runner TRIED 3m
ago"* versus *"NOTHING has tried to act on this hold at all"*. Before 2026-08-08 those were
the same silence, and it cost six hours of guessing.

**A hold whose attempt fails INSIDE its window stays `requested`.** `reportCartFailure` only
marks `failed` once the grace has closed. It used to be terminal, and on 2026-08-08 that made
an 85-seconds-early cart the one and only attempt — guaranteed too early, with no second try.

## The fairness line — two users, one campsite

Two people watching the same facility get two correct offers for one physical site. This is
**ordinary, not an RC data quirk**, so it scales with the product.

> The story that *"RC lists one campsite under more than one facility"* is **FALSE and was
> measured false on 2026-08-25** — zero inventory overlap between Morro Bay's lottery pool and
> Upper Section. The apparent duplicate was our own result-map collision, fixed by
> `worker/watch-key.ts`. It is recorded because it was written into two files as fact and read
> past twice; do not reintroduce it.

`worker/hold-line.ts` orders a LINE — every live hold sharing one `(release_at, unit_id)`:

1. **the rotation ticket** (`users.hold_offer_seq`), lowest first;
2. **`watches.created_at` ASC** — the owner's rule, whoever watched first;
3. **hold id**, so two shards ranking the same line agree.

Plus `users.line_priority` (migration 069), read **ahead of** the ticket — a deliberate thumb
on the scale for one account, decided by the owner, with the losers named in the migration's
own header.

**ROTATION IS CHARGED TO WHOEVER LANDS AT RANK 1, NOT TO WHOEVER WINS.** Both rivals are
offered the hold; only one gets first dibs, and that is the scarce thing. Charging on WINS
would let a user who never claims sit at the top for ever.

**THE TICKET IS FROZEN PER LINE AND `line_priority` IS READ LIVE — the asymmetry is
deliberate.** Charging the winner raises their ticket, so a live read would sort them BELOW
the person they just beat on the very next cycle: ranks flip, the runner-up is charged too,
and "you're first in line" changes under the reader. `rc_hold_requests.line_seq` records the
ticket each member was ranked with. **Nothing charges a priority**, so that failure cannot
arise there and taking effect next cycle is the point of changing it. **Do not "make this
consistent" by adding a frozen priority column** — that pins a revoked override onto every
hold already in flight.

**`BEHIND_NOTE` states the POSITION, never the REASON.** It used to say "they watched it
first", which became false the day `line_priority` existed. It must stay under `noteAttempt`'s
**300-character truncation** or the stored value can never equal the constant, the skip never
matches, and the churn guard silently stops guarding.

**`rankHoldLine` runs ABOVE the `claimHoldNotification` gate (fixed 2026-08-28).** Below it,
the line was ranked exactly once in the life of an offer — at the moment the alert went out —
so every overnight tap left a `requested` row with `last_attempt_note` NULL, which reads as the
2026-08-07 dead-runner signature on every contested morning.

**THE EXPIRY CASCADE (re-cart for rank 2 when rank 1 lapses) IS A DELIBERATE NON-FEATURE.**
It depends on RC's real cart lapse, read off RC's bundle as ~15 minutes and **never observed**,
while `reclaimLapsedHolds` waits 180. Between those two numbers we would re-cart a site RC may
already have released and tell a second user we hold something we do not. **Measure the lapse
first** (`rc-probe.mjs --cart-lapse`, built 2026-08-27, never run).

## `dueHolds` serves ONE LIVE hold per unit

`DISTINCT ON (release_at, unit_id)` de-dupes within one query — **and the runner polls every
15 seconds**, so on 2026-08-26 the first two-tapped contest served BOTH rivals fourteen
seconds apart and **RC accepted both**: two cart entries for one campsite, two users each told
their site was held, the loser finding out at checkout.

The fix is a `NOT EXISTS` over `('carted','claiming','released','claimed')`, which makes the
rule **temporal rather than per-call**. Deliberately NOT `failed` or `expired` — a cart RC
refused never took the site, and blocking on it would deny a retry to somebody who could still
get it. `requested` is excluded for the same reason.

Its guard in `worker/hold-line.test.mts` calls `dueHolds` **twice with a status change in
between**; a single-call test is true and always was, and is what let this ship.

## Capacity — `src/lib/limits.ts` IS THE AUTHORITY

```
RC_HOLD_CAPACITY = RC_SITES_PER_CART (2) × RC_MAX_CARTS (10) = 20
```

- **`RC_SITES_PER_CART = 2` is RC's, and measured**: a third add came back *"the maximum
  number of reservations allowed in the cart is '2'"* (2026-08-13).
- **`RC_MAX_CARTS = 10` is OURS**, measured by `rc-probe.mjs --cart-ladder` on 2026-08-17: ten
  distinct cart keys holding **twenty reservations at once** on one session and one account,
  every rung controlled by a third add refused in RC's own words, all twenty released HTTP 200.
  **The ladder stopped because it ran out of campsites, not because RC objected** — twenty is a
  FLOOR and the per-account ceiling is unknown.

**Every "the ceiling is 2" line in older notes is HISTORICAL.** It was 1, then 2 (2026-08-15),
then 10. Quoting a morning where "two tapped holds is exactly capacity" as current is a mistake
already made once. **Read the constant.**

**The old ceiling of 2 was never RC's** — it was the runner reusing
`localStorage["shoppingCartKey"]` for every hold. Each hold mints its own cart now, which is
also why a stuck row occupies only its own cart.

**WHY A CAP AT ALL:** offering a third hold for a release we can only take two of is a promise
that cannot be kept, and the cost is not the failed cart — **it is that a user who believes the
site is handled STOPS WATCHING** and loses a morning they could have won with an alarm clock.
That sentence governs every copy decision on this path.

Enforced in two places, on purpose: the poller withholds the **button** when the window is
full, and the `hold` action checks again, because a link outlives the alert that carried it.
`offered` rows count — the button is in an email we cannot retract.

**Unmeasured:** twenty holds due in ONE pass go through a single Chromium. n=2 is all anyone
has watched, six seconds apart, so they never contended. `scripts/rc-holds-readout.mts` prints
the lag as `T+s` — if tail-end holds start landing late, that is this decision showing up, and
**the answer is to parallelise the precart, not to shrink the number back.**

## The cart burst — and RC releases EARLY

`scripts/auto-cart-bot/cart-burst.mjs`. Constants, all env-overridable:

| | |
| --- | --- |
| `BURST_LEAD_MS` | **5,000** — opens BEFORE the predicted release (was 15,000 until 2026-09-25) |
| `BURST_WINDOW_MS` | **30,000** after it |
| `BURST_GAP_MS` | **500** |
| `BURST_BUDGET` | **40**, **shared across the whole release group** |
| `BURST_RELEASE_RESERVE` | **25** — the part of the pool only T onwards may spend (2026-09-25) |

**THE BUDGET IS SHARED, NOT PER-HOLD.** Carts run `CART_CONCURRENCY` at a time, so a per-hold
budget multiplies: four holds × twenty attempts is eighty POSTs in thirty seconds from a
residential IP that **has eaten a 12-hour WAF block from RC before**.

**THE LEAD IS DERIVED FROM THE MEASURED FLIP, and it was SHORTENED 15 s -> 5 s on 2026-09-25.**
It used to come from the poller's sampling floor — a flip up to 15 s before T is invisible to a
15-second sampler, so 15 s was exactly the uncertainty. That uncertainty has been measured away
(the brackets below): the deepest "still locked" reading on record is **T-4.2 s**, so 5 s starts
one poll before the earliest instant RC has ever been seen still holding.

**AND AN EARLY ASK IS NOT FREE — the half that was wrong.** The old reasoning was that an early
attempt costs one refusal, which the slow lane already absorbs. True at one or two holds; **false
at three**, because the budget is shared. On 2026-09-25 three tapped holds spent **43 attempts,
every one before T** (`#GBOB` 14 ending T-1.0 s, `#R367` 14 ending T-1.6 s, `#A113` 15 and won at
T-0.5 s only because RC let go early) and the lane never reached the moment the sites opened.

**THE FIX IS THE LEAD, NOT THE BUDGET.** 40 is what keeps thirty seconds of POSTs from looking
like an attack; raising it is the trade that constant exists to refuse.

**AND THE RESERVE IS THE OTHER HALF OF THE SAME FIX** (`BURST_RELEASE_RESERVE`, landed the same
day). Before T the lane may not spend below it: a hold that reaches it **waits for T** rather than
dropping to the slow lane. So the pool can no longer be exhausted before the release — what a
long lead produces instead is **SILENCE**, every hold asleep until T. At the old 15 s lead that
silence runs ~T-9.8 s to T, and **two of this lane's six wins sit inside it.**

**THE TWO CONSTANTS ARE SIZED TOGETHER AND THE MARGIN IS 225 ms.** The discretionary share is
`40 - 25` = 15, plus one uncharged first attempt per slot, so a full group gets 19 attempts =
`(4 + 15) / 4 × 1.1 s` = **5.2 s of asking against the 5.0 s lead**. At the 5 s lead the reserve
is therefore never reached before T at any group size. **Raising `CART_CONCURRENCY` to 6, or the
reserve to 30, drops the cover to 3.9 s and re-opens that silence** — take either with a lower
lead or a lower reserve in the same change, and read the guard, which fails on the bump alone.

**HOW MANY HOLDS THE LANE ACTUALLY SERVES — measured, then derived.** A hold's own attempt cycle
is **1.0-1.3 s** across all ten bursts on record and is independent of group size, because holds
burst in parallel under `pMap(holds, CART_CONCURRENCY)`. With the reserve in place what matters is
reach PAST T: `25 / (min(N, 4) / 1.1 s)`.

| holds | reach past T | covers the measured flip (T-4.2 -> T+1.4)? | note |
|---|---|---|---|
| 1 | ~28 s | yes, 26 s spare | the lane's first four releases — which is why this was invisible |
| 2 | ~14 s | yes | |
| 3 | ~9 s | yes | at lead 15 s and no reserve this ended at **T-1 s**, observed |
| 4 | ~7 s | yes | |
| 5+ | one unguarded attempt, ~30 s late | **no** | `CART_CONCURRENCY` caps the slots |

**So the burst serves about FOUR holds well, against an `RC_HOLD_CAPACITY` of 20.** That gap is
the growth ceiling, and it is `CART_CONCURRENCY` × the reserve, not the cart ceiling — a hold that
only gets a slot after the first four finish starts with its 30 s window already expired, because
`releaseMoment` is group-wide and fixed before the sleep. `worker/cart-burst.test.mts` pins both
arithmetics and fails against the old lead.

**AND RC DOES RELEASE EARLY — MEASURED TWICE, and this retires the old "never early" reading.**
`scripts/rc-release-window.mts` polls RC's grid at 2-second resolution across a release:

```
2026-09-04   rc-583  locked -2.2s -> free -0.2s   (8 nights)   <- the whole bracket is NEGATIVE
2026-09-10   rc-583  locked -4.2s -> free -2.2s   rc-539 -3.5 -> -1.5   rc-542 -2.9 -> -0.9
             15 of 15 nights free BEFORE the predicted release
2026-09-24   rc-357  (-1.9, +0.1]   rc-359  (-1.2, +0.8]   rc-360  (---, +1.4]
```

Eight facility brackets over three mornings, and **this lane's own six wins agree**: T-0.9,
T-0.5, T+0.1, T+0.5, T+0.5, T+0.9. So the flip is within about four seconds of T on every
measurement there is — deepest "still locked" **T-4.2 s**, latest "first free" **T+1.4 s**.
(`rc-360`'s lower bound reads +241.2 s, above its own upper bound, so it is an artifact of a
night whose lock named a different release. Quote the seven clean brackets.)

- **Quote the negative BRACKET, never the median.** On 09-04 two of three facilities straddled
  T, so a median of +0.5 s reads as "on time" when the finding is the opposite.
- **Facilities flip ATOMICALLY**, ~1 s apart from each other — every night in a facility shares
  one bracket. That is why one grid poll per facility measures every releasing unit at once.
- **A re-lock inside the window is NOT evidence of contention.** From the grid our own cart and
  a competitor's are identical.
- The earlier "every sighting is at or after T" reading was the **poller's 15-second resolution
  swallowing the question**, corrected on the owner's challenge. RC's edge clock is within one
  second of ours (5 round trips), so skew is ruled out.

**`isNotAvailable` is conservative by construction: anything not positively recognised stops
the burst.** The dangerous direction is retrying fast into a fault that fast retries make worse
— a WAF 403, a rate limit, a dead session, a wedged browser. `already added` is deliberately
excluded (the site is in a cart we hold), and so is `maximum reservations` (retrying cannot
change a capacity refusal).

**`waitedForRelease` is the single most important input.** Without it the runner would fire a
fresh burst on every feed poll for the whole 20-minute grace — roughly a hundred bursts, which
is not a fast lane but a denial-of-service against the site we are trying to book from.

**A page that would not answer (`timedOut`) is OURS, not RC's, and never bursts.**

## Reading a `cart-burst` event — the three outcomes

The burst had **no durable record at all** until 2026-09-17: on a loss the summary rode in
`error` and ~110 later retries each overwrote it; on a win it was never reported. So "did the
burst fire?" was unanswerable, on the one path that either gets somebody a campsite or does not.

One `cart-burst` bot event per hold per release pass, **gated on `waitedForRelease`** (ungated,
the ~110 ordinary retries each emit a row and an absent row then means nothing).
`NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` prints **CART BURSTS first**.

| what the row says | what happened | whose fault |
| --- | --- | --- |
| **many attempts** | RACED and lost, or the lock never lapsed | **nobody** — the burst works |
| **exactly one attempt** | the lane ARMED and declined to retry | **OURS** — a dead session, a wedged page, a WAF refusal. The `reason` names it |
| **no row at all**, for a tapped hold whose release has passed | the runner never arrived before T | **OURS** — the burst did not run |

**ONE ATTEMPT IS NOT A RACE**, and reporting it as one sends the next reader to RC's side of a
fault that is ours. **NO ROW is the feared case** and is the only one that cannot be found by
adding detail to an existing record.

`firstOffsetMs` is MEASURED (`laneOpenedAt − releaseMoment`), never `−BURST_LEAD_MS` — only a
measurement shows the sleep overshooting. Offsets are **signed**; `T−14.0s` is the finding.

## The hand-off — and what `cart read back` does NOT prove

The bot holds the site; the user claims it; the bot releases; the user's own session re-carts.
Path B, validated 2026-08-07: `remove/cartentry` returns in ~97 ms and a different session
re-carted 2,544 ms later. **~2.5 s is the whole exposure window**, dominated by the two precart
round trips, not the release.

On mobile the claim link opens an **InAppBrowser** (`cordova-plugin-inappbrowser` v7 — the only
one of three with `executeScript`) and `/api/rc-precart` serves a bundle that carts inside the
user's own webview. **That bundle is web-side: it reaches already-installed apps on a push, no
rebuild, no review.**

**`cart read back: 1 entry` IS RC'S ANSWER TO *OUR* QUESTION, WITH *OUR* KEY.** It POSTs
`webaccesscustomer/load/shoppingcart` with a `shoppingCartKey` we supply, so it means RC holds
something under that key. **It says nothing about whether RC's own SPA can show the user the
cart** — which reads `localStorage["shoppingCartKey"]` to decide which cart it is displaying.
On 2026-08-29 it read `1 entry` while the owner, holding the phone, saw an empty cart and a
sign-in prompt. The readout was calling it *"stronger still: RC's own answer"*; half right, and
the wrong half was load-bearing.

**THE ONLY PROOF OF REACHABILITY IS A HUMAN LOOKING AT RC'S CART PAGE.** Ask for it on every
hand-off test. The `keySource` and `attached` fields the readout prints are the instrument
built for this: `keySource: 'marker'` means RC's page cannot see the cart; `attached: false`
means `CustomerId: 0`; **`null` is "RC did not tell us", never `false`.**

**THE COST OF GETTING THIS WRONG IS THE WORST SHAPE THIS PRODUCT HAS**: a site locked, and the
user told it is theirs. Strictly worse than failing — it takes the campsite off the market AND
makes them stop watching.

### The sign-in is two steps, and we used to close between them

RC's Okta callback fires `ProcessSSOLogin`, which writes `ssoAccessToken` with
`isLoggedIn: false`, then **awaits `GET WebAccessCustomer/SSO/GetSSOLoggedInUser`**. Only that
response writes **`customerId`** and sets `isLoggedIn: true`. On boot RC reads
`isLoggedIn: !!localStorage.getItem("customerId")`.

Our token capture fires on RC's first authenticated call — **which IS step two's request** — so
`closeOnToken` was killing the webview mid-exchange. Android's `closeDialog` navigates to
`about:blank` and kills it; iOS's `close` only dismisses the view controller, so the request
finished. **That is the whole platform difference; it is the plugin, not our code.**

~~**Close on `customerId`, never on a token, and never on a timer.**~~ **HALF WRONG, AND IT LOST
A CARTED SITE (2026-09-24, #406).** `customerId` outlives the token by weeks, so a webview holding a
token dead for 23h closed the moment RC said "signed in", the claim gate still read `dead`, and the
user looped back to sign-in until the site was gone. **The rule now:** wait for `customerId` (step
two must finish, which is why we stopped closing on the token capture), **and then** close only on
a token seen ALIVE, or on an unknown token once the `session` census has spoken. **A dead reading
is sticky.** `foldSignInFacts` accumulates this for the whole window. When RC draws signed in over
a dead token with no control to press, `rc-login-script.ts` clears the session **localStorage keys
(never cookies)** once per window and reloads, so a real sign-in is offered.

**Never close on a timer.** No timer closes a sign-in window any more — **the backstop WAS the
defect**. `rcCloseAction` (`src/lib/rc-token-liveness.ts`)
is a pure function for the same reason as everything else here: inline in a native `message`
handler it was reachable only from a real device, which is how `closeOnToken` shipped wrong.

Every close names its reason — `token` / `settled` / `timeout` / `session` — because *a fix
that never fired* and *a fix that worked* otherwise produce the identical report.

## Capacity, and more than one bot seat

One seat = 20 holds per release, 4 with the full fast burst. Adding capacity means adding
seats (account + IP), NOT raising `CART_CONCURRENCY`/`BURST_BUDGET`. The plan, and why
`dueHolds`' `DISTINCT ON` must pick winners across all seats before filtering per seat:
`docs/RC-BOT-SEATS-PLAN.md`.

## Diagnosing

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts     # per-hold state + hand-off trace
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts   # CART BURSTS first, then memory
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-release-readout.mts   # measured flip brackets
```

The readout windows on **`release_at`**, not `offered_at` — an offer made more than a day
before its release used to drop off the list, which is precisely the row it exists to surface.

**`scripts/rc-test-hold.mts` queues a REAL hold and locks a REAL campsite.** It is on
`docs/LANES.md`'s SERIAL list: announce first. Get the unit id from `--find`; **never invent
one** — a fabricated id can collide with a real site (six were locked that way once). It blocks
the box's 02:00–05:00 PT update window for the 6 h before the release, and **the other lane's
refusal will look exactly like an update deadlock and will not be one.**

## Prohibitions

- **Never widen `supportsRcHold` past ReserveCalifornia.** `findRCHeldUnits` reads UseDirect's
  generic `Lock` field, so the coming-soon path covers all ten portals — while the bot signs in
  to ONE RC account. An Ohio watch could be offered a hold **nothing on earth can perform**.
  Two enforcers: the poller withholds the button and `/new` does not advertise it.
- **Never put beta wording in the SMS.** The coming-soon offer is 154 chars against a 160
  one-segment budget *after* `fitOneSegment` trims the name. Any addition tips it into two
  segments — the shape that was Undelivered/30007 thirteen times. **A label nobody receives, on
  an alert nobody receives, is strictly worse than no label.**
- **Never add a standing auto-hold toggle to `/new`.** An RC hold is offered per release and
  only a tap authorises it; a switch would imply a consent this product deliberately does not
  take. `supportsAutoCart` is `source === 'ridb'` — that toggle is the **rec.gov** lane.
- **Never promise a cart in the claim copy beyond what a real hold has reported.** The promise
  was earned only once `✓ Added to cart` came back from a live hand-off, and it is guarded.
- **Never release with `empty/shoppingcart`.** Release is driven by the cart's CONTENTS
  (`listCartEntries`), because a cart this run minted with `NO_CART` holds only what this run
  put there — a guarantee about how the cart was CREATED, which cannot rot the way a matcher
  can. **RC's cart entries carry NO unit field**; a matcher looking for one has reported an
  empty cart for a full one three times, and once left six real campsites locked.
