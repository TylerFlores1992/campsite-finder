# Next session — start here

*Rewritten from scratch **2026-09-10** (main lane). It had reached 1,603 lines of stacked dated
blocks, which is the opposite of a handover.*

**This is a HANDOVER, not a permanent doc. `CLAUDE.md` owns every finding.** Nothing here is the
only copy of anything — the ten items that were, got folded into `CLAUDE.md` before this rewrite
(see "TEN THINGS THAT LIVED ONLY IN THE HANDOVER"). **Keep it this way: when a block here goes
stale, delete it rather than striking it through.** Strikethrough belongs in `CLAUDE.md`, where the
correction is itself the record; here it is just weight.


## 0-pre-pre. 2026-09-26 (written 04:30Z / 21:30 PT on 09-25) — THREE BRANCHES IN FLIGHT, NOTHING MERGED

An orchestrator pass (session "CampHawk Parent") built three things tonight and deliberately
merged NONE of them, because the 09-26 08:00 PT release was ~11h out and two of them need a
box update, which ends the RC session. **Merge them after that release, in this order.**
Findings are in `CLAUDE.md` → *"09-26: OKTA LIVES 24h FROM CREATION"*.

| branch | state | what merging does |
|---|---|---|
| `claude/burst-concurrency-6` (`934b86c`) | **CI green, Fable tier-1 PASS**, no PR yet | `CART_CONCURRENCY` 4→6 + `BURST_RELEASE_RESERVE` 25→18. Its `worker/*.test.mts` edits fire a **worker deploy (poller restart)**; the burst itself changes only when the **box updates**. |
| `claude/rc-rate-probe` (`3ea375f`) | CI was running at handover | Adds `scripts/auto-cart-bot/rc-rate-probe.mjs` + `docs/RC-RATE-MEASUREMENT.md`. No deploy, no runtime effect: an owner-run tool. |
| `claude/okta-evening-signin` | **child v3 pushed its first commits at 04:23Z** (`21b3d6e`, a mutation-found fix) and may still be iterating (session `session_01B6PEJ8wWmGT27hrXyszn3A`) | CAPTCHA paging (on) + evening sign-in and the update-window move (both behind `RC_EVENING_SIGNIN`, default OFF). Adding a `bot_events` kind fires a worker deploy. **Fable-verify it before any PR** — it is the unattended login path. |

**CI CAVEAT FOR TONIGHT'S RUNS:** `claude/rc-rate-probe` (run 1769, started 04:20Z) and
`claude/okta-evening-signin` (run 1770, started 04:23Z) ran `npm test` against production
**at the same time** — a one-slot breach, caused by the orchestrator pushing rc-rate-probe into
what it read as a free slot. A red on either is a named mechanism; re-run it once alone before
reading it as a regression.

**Order after the release:**
1. Fable tier-1 on `claude/okta-evening-signin` once it is on origin (the orchestrator skill's
   worktree recipe). It must be byte-identical with the flag off and must never touch `DT`.
2. Open PRs for all three, one at a time (one CI slot). Merge burst + okta **≥ 6h before the
   next release**; the worker deploy restarts the pollers.
3. **Box update, timed just before an evening sign-in** (~19:00 PT), never between an evening
   sign-in and a release (see CLAUDE.md for why). That is what makes the burst change and the
   okta code live.
4. **The one supervised live test:** set `RC_EVENING_SIGNIN=1` on a night with a hold offered
   for the next morning, with the owner reachable. Pass = the frozen Okta expiry reads ~+24h
   from the evening sign-in, and the 07:30 sign-in is the ~11s cookie-answered kind.
5. Only then fold the burst's **live** numbers (6/18) into CLAUDE.md — its burst sections still
   say 4/25 **on purpose**, because that is what the box runs until step 3.

**Before opening the burst PR, one line to verify and fix:** the burst-numbers research says
holds past the concurrency limit do NOT arrive "~30 s late" — they get a full burst the moment
any hold wins, else one attempt when the pool hits 0 (~T+3.3s at 6/18). The rc-autocart skill
table on that branch still says "~30 s late" for 7+. Read `shouldRetryBurst` + the runner
loop, confirm, and fix the line in the same PR.

**The measurement (`docs/RC-RATE-MEASUREMENT.md`) is the owner's, and it has not run.** Second
mini-PC, throwaway prepaid hotspot (not their phone), one step per sitting, never within 2h of
a release. It measures the CDN edge only; a pass does not prove the household IP safe.

**Children to archive once their replacements land:** `session_01B7LAWppHnaaB8eFzsURm6K`
(burst v1, blocked on the edit-permission wall), `session_01XBTUrZc8sW7VPrn5Fzy1af` (okta v1,
interrupted), `session_01Q9TiWJasesZqpTMAuMyoj9` (okta v2, interrupted because it had been told
to wait for a "push now" this session cannot send). Also older: `session_01FLxM3D3LddskZDRASdXoNa`,
`session_01RzXY3dYKzpdJfjg36kHYiD`, `session_014fHgMYeSzLE79ofCcmHQzb`, and Second Parent's
`session_015XtsxwQceycqn3EfoYgmN4`, all BLOCKED/idle since 09-20 — the owner's call.

**Tonight's 08:00 release (09-26):** at 21:23 PT the only hold (`#M412`) and two others
(`#M411`, `#R314`) were `offered`, not tapped; the RC session was dead with `okta=GONE(404)`,
and the 03:01Z rehearsal had failed on a CAPTCHA. The box was on `39da21b` (docs-only gap to
master). If the owner taps one, the reliable path is a hand sign-in (`rc-login.bat`, NOT
`rc-test-login.bat`) around 06:30–07:15 PT. **Re-read `/api/health/status` and
`rc-holds-readout` before saying anything about it — this paragraph is hours old by then.**

## 0-pre. 2026-09-25 — READ THIS FIRST

- **The 08:00 release:** `#GBOB` (group site) and `#A113` were handed off and reached the owner's
  own cart. `#R367` never carted, because the shared burst budget ran out at T−1.6s. Fixed in
  #413 (`BURST_RELEASE_RESERVE`); `CLAUDE.md` → *"09-25"* has the numbers.
- **`autocart.rc_login` can read `fail` over a live session**, and its remedy names
  `rc-test-login.bat`, which DROPS the token. **Read `autocart.rc_session` before acting on it.**
- **#414 (Second Parent's burst lead 15s → 5s) is merged and on the box too** (`39da21b`). The
  bot was already signed out (`okta=GONE`) when that update ran. The two updates before it
  (09-24 16:45Z, 09-25 17:02Z) each turned an ALIVE Okta session into GONE. The
  only hold for 09-26 08:00 (`#M412`) was merely `offered` when read.
- **Capacity beyond one box: `docs/RC-BOT-SEATS-PLAN.md`** (planned, nothing built). Read its
  fairness-line section before touching `dueHolds`.

## 0. FIRST: WHERE 2026-09-24 LEFT IT

### EVENING (~22:10Z): an orchestrator pass — the child fleet audited, and one fix SCOPED

**Nothing was dispatched and nothing is in flight.** Master is `b9672aa` (#410). No child holds
the CI slot.

**THE CHILD FLEET, READ OFF `list_sessions` AND THE PR LIST, NOT OFF THE CHILDREN'S SUMMARIES.**
Seven finished children whose work is merged were **archived**: domain-skills (#383),
recgov-login-census (#379), autocart-retry (#402), claude-md-prune (#382),
app-manage-subscription (#370), renewal-backoff-escalation (#371), ios-camera-crash (#378) — each
branch tip checked equal to its PR's merged head. Three children never delivered, and **none needs
rebuilding**:

| child | state | verdict |
| --- | --- | --- |
| `explore-availability-unknown` | BLOCKED, push denied 09-20, work lost | **done by #377** — a clean live search now shows 1 unknown among reservable campgrounds |
| `recgov-login-password-step` | BLOCKED, `77fbcdf` never pushed | **done by #379** — its first commit `d9e041d` is that work, and #379 then fixed the cause |
| `rdr-burst-source` | REVIEW_READY, no branch ever pushed | **not needed as written** — the leak file forbids blocking RC's requests before the cause is named, and records the burst as decoupled from the leak. The owner's call if it is ever wanted. |

Those three and the second parent's `manifest` child are **still live, deliberately** — the owner
did not ask for them to be archived.

### THE SEARCH FAN-OUT — SCOPED, NOT BUILT. This is the whole scope.

**The finding is in `CLAUDE.md` → Open, "EXPLORE'S rec.gov FAN-OUT".** In short: `/api/search`
checks every rec.gov campground at once, and repeated wide searches trip a breaker that then blinds
every search on that Vercel instance for 1-8 minutes. Measured by accident, and the measurement
itself was the outage. **Do not reproduce it against production.**

**Mechanism, read from the code (`src/app/api/search/route.ts`):**
- `limit: limit * 3` — Explore sends no `limit`, so 50 → up to **150** campgrounds fetched. The
  comment says "fetch extra so we can filter by availability", but nothing is ever filtered: all
  150 are annotated and returned.
- `Promise.allSettled(campgrounds.map(...))` — **every** check starts at once. rec.gov costs one
  request per campground **per month the stay spans**, sequentially inside
  `hasAvailabilityInRange`.
- **No cache.** A radius chip, a date change or a filter tick is a full new fan-out for rows it
  fetched seconds earlier.
- The breaker (`src/lib/availability/recgov.ts`) is **process-local**: `RECGOV_BREAKER_TRIP` 3,
  cooldown 60 s doubling to 8 min. On Vercel that means **per warm instance**, shared by every
  request that instance serves.

**The fix, web-side:**
1. **A concurrency cap on the route's rec.gov checks** — N in flight, start ~8, as an env var.
   Nearest first: results are sorted by distance, so the cards on screen resolve first.
2. **Single-flight + a short TTL cache per (campground, month)**, per warm instance, ~60-120 s.
   Two rules copied from `worker/recgov-scheduler.ts`: **an `unknown` is never cached**, and
   **never overwrites** a real reading. A cached `false` must be exactly as fresh as a live one
   would have been.
3. **A deadline on the whole annotation** (~8 s). Anything not checked by then renders `unknown`,
   **never `false`**. Without it, a cap turns a 200-mile search from "blinds the lambda" into
   "takes 40 seconds".

**THE ONE DECISION — IT COSTS A POLLER RESTART.** `hasAvailabilityInRange` calls
`getAvailabilityFromRecGov` internally, so the cache can only be injected with an optional
`fetchMonth` parameter on it, defaulting to today's behaviour. That edits
`src/lib/availability/recgov.ts`, and **`src/lib/availability/**` is in `worker-deploy.yml`'s
`paths:`**, so the merge restarts all three pollers.
- The alternative, duplicating the range logic in a web-only file, keeps the deploy web-only but
  forks the one function whose `null` versus `false` rule this repo paid for. **Recommended: take
  the restart, and land it away from an 08:00 PT release** — not before 09-25 15:00Z.
- **Do NOT put the cache inside `getAvailabilityFromRecGov`.** The poller's scheduler calls it
  with its own `maxAgeMs`, and auto-cart asks for fresh reads; a module cache underneath would
  serve the worker stale data it never asked for.

**Out of scope:** a cross-instance cache (KV or DB); routing rec.gov through the worker (rejected
2026-07-31 — it couples alerting and search into one failure domain); changing the breaker's
thresholds; UI changes; the RC/UseDirect checks in the same fan-out (their client already
coalesces).

**Open question for the owner:** keep `limit * 3`? Dropping it to `limit` cuts the fan-out by
two thirds **and cuts Explore's result count by the same amount**. That is a product change, not
a performance fix, so it is not in the default scope.

**Guards (pure, no database, so they cost no CI-slot hazard beyond the suite itself):** a fake
fetcher that asserts the in-flight maximum never exceeds the cap; single-flight dedupes; an
`unknown` is not cached and does not displace a real reading; the deadline yields `unknown` and
never `false`; nearest checked first. Mutation-test each, and **assert the mutation applied**.

**Verification after deploy, and the trap in it.** The only reproduction is the outage, so do not
repeat the five-search burst. Take one ordinary search and read the unknown count, then a second
identical search within the TTL and confirm it is faster. That shows the cache working. **It does
not prove the cap holds under load, and should not be reported as if it did.**

**Size and band:** one new module or parameter, a route edit, a test file — roughly 300-500
lines. **Opus (`claude-opus-5`)**: the failure is silent, because an over-cautious cap reads as
"rec.gov is flaky" and a cache that stores `unknown` reads as "booked".

Landed 09-24: **#401** (the delivery canary starvation), **#402** (the rec.gov cart ladder),
**#403** (docs), **#404** (the `bot_events` readout, blind since 09-21), **#405** (docs), and
**#406** (the RC hand-off: sign-in loop, the #395 early return, the dead-pid lock wait). The
**mini-PC is on `43be89f`** (#406), read back with `bot-ask git-status`. At ~16:50Z health read
**`ok`**, web and box on the same sha.

### THE HAND-OFF LOST A CARTED SITE ON 09-24, AND #406 IS THE FIX — UNPROVEN IN ANGER

`#R371` was carted at **T−0.94s** and the user never got it. There were three defects, each
fatal alone: the sign-in window closed on RC's `customerId` over a token dead for 23h (a loop);
#395's flush ended in `return`, so ClaimFlow never read the stages it flushed; and the runner
waited 60s on a lock whose pid was dead. Full account: `CLAUDE.md` → *"THE 09-24 HAND-OFF"*.
- **THE NEXT REAL HAND-OFF IS THE PROOF.** Read its `rc_hold_requests.client_reports`. A
  `stale-reset` stage means the loop was hit and broken; after it, look for a token seen alive
  before the window closed.
- **Next release: 2026-09-25 08:00 PT** (one hold `offered` when last read). Compute hours to
  release in SQL, in Pacific.
- **THE BOX UPDATE AT 16:45Z ENDED THE RC SESSION, AS EVERY UPDATE DOES.** By ~17:30Z
  `autocart.rc_session` warned *"no token at all — signed out; okta session GONE (404)"*, forecasting
  the expensive ~12-minute sign-in. **This is the ordinary state after an update, not a fault.** The
  09-23 precedent: the same GONE repaired itself 31 minutes later in 16 s, through the warm-up path,
  with no human. **Before 07:30 PT on 09-25, read `/api/health/status`:** `okta=ALIVE` and a live
  token mean the repair ran. Still GONE after 07:00 PT is the case to raise with the owner. Do NOT
  run `rc-login.bat` over a live session.
  - **SUPERSEDED THE SAME EVENING — IT DID NOT SELF-REPAIR, AND A CAPTCHA IS WHY.** The nightly
    rehearsal at **2026-09-25 03:01Z (20:01 PT)** failed with *"a CAPTCHA appeared during
    sign-in"*, the first failure after PASSes on 09-22/23/24. At 03:43Z the session was still
    `no token at all` with `okta=GONE(404)` **four hours** after the update, where 09-23's repaired
    in 31 min. Hourly `renewal` trips kept running (~69 s each) and none restored it. **So the
    T−30 auto-login at 07:30 PT will very likely meet the same challenge, and an unsolved CAPTCHA
    means no session, no cart, no group site.** The remedy is the documented human step:
    `mini-pc\rc-login.bat`, **safe to run now precisely because there is no live session to
    kill** — the prohibition is about printing it over a LIVE one. The owner was told at 03:45Z.
    One CAPTCHA is an event, not an escalation: no solver, no repeated fresh-profile logins, and
    **never clear cookies** (`DT`).

**READ THE FLEET, DO NOT QUOTE ANY OF THIS.** A reading goes stale faster than the conclusion
drawn from it, and this section has been caught out overnight twice.

**`autocart.bot_version` IS GREEN AGAIN, BUT ONLY BECAUSE #406 UPDATED THE BOX.** It warns on a
docs-only gap and says so in its own detail, so **this docs PR brings the warning back**. The owner
said leave it. `CLAUDE.md` carries the one-line fix (`botVersionLevel`'s `behind` branch) and why it
lands after a release, never before.

### CHECKING OUT ON THE BOX — the owner's plan for the 09-25 group site

The owner will request the group-site hold, and after the bot carts it at 08:00 will **complete
checkout on the mini-PC over RustDesk** instead of the phone hand-off. **That removes the hand-off
entirely**: no release, no ~2.5 s exposure window, no phone sign-in. It is sound because of three
facts, each read from code rather than assumed:

- **The cart is bound to the bot's SESSION**, so a second session reads it as 0 entries (proven
  2026-08-06). So checkout MUST happen in **the bot's own Chromium window**, the one on the
  `rc-profile` user-data-dir. Not the owner's Chrome, and not a fresh browser.
- **That window's RC cart page shows the hold**, because `precartInPage` writes the minted key into
  `localStorage["shoppingCartKey"]` (the "adoption case that works"; a human has confirmed it on
  RC's cart page before). If several holds cart in parallel, only the LAST key is adopted, so the
  page may show a different cart. It is one hold tomorrow.
- **The reservation lands in whichever RC account the box is signed into**, with that account's
  customer name as occupant. That is fine only if it is the owner's own account; the owner knows,
  and no session should assume it.

The steps, and the three ways the bot can get in the way:

1. **Wait for the cart.** `rc-holds-readout.mts` shows `carted`, or the runner console says
   `✓ held`. **Right after the release the RUNNER owns the profile and the keep-warm's window is
   closed** (it yields). Wait until the keep-warm's window is back, then open a **new tab** in it
   and go to RC's cart.
2. **Do NOT tap Claim on the phone.** A claim makes the bot RELEASE the entry to hand it over, and
   then the box's cart no longer has it. Pick one path.
3. **Check out fast.** RC's own cart lapse is ~15 min (bundle read; one observation said 45).
4. **If the window closes mid-checkout, nothing is lost.** Any later runner pass (another user's
   claim or release), a `wedge-recycle` or a `bail:ramp` closes the whole browser. The cart lives
   on RC's side under the session, and the token is on disk in the profile, so reopen RC in the
   relaunched window and carry on.
5. **Tell the session once it is booked.** The row stays `carted`, and `expireStaleHolds(45)` will
   send the runner to release it at `carted_at + 45 min`. What `remove/cartentry` does to a
   completed reservation is **not established**. It is almost certainly a harmless refusal, but do
   not find out. On the owner's word, set that one row to `status = 'claimed'`,
   `claimed_at = NOW()`, and read it back. **Never close it on inference**: a booked grid slice
   after RC's cart lapsed could be a competitor.

**HOW LONG A HOLD LASTS — two clocks, and only one is ours.** The bot lets go of an unclaimed
hold at `carted_at + 45 min` (`expireStaleHolds(45)`). **RC's own cart timer can drop it sooner**
and we cannot extend it: the live figures are a bundle-read ~15 min and a single observation of
45, so **plan on ~15**. On 2026-09-24 the owner was offered two changes and **declined both**:
- exempting their own account from the 45-min release;
- "re-holding" past RC's timer, which is unproven and would need a live experiment on a real
  site.

Do not re-propose either without new evidence about RC's timer.

Two scheduled check-ins carry this: 07:00 PT (session health, hold REQUESTED not merely offered)
and 08:20 PT (the row, and step 5).

### What each 09-24 change now waits on

1. **The delivery canary — nothing.** Fired at 01:28:34Z, three minutes after its deploy, and
   green since. `CLAUDE.md` → *"THE DELIVERY CANARY WAS STARVED BY ITS OWN SCHEDULER"*.
2. **The rec.gov cart ladder — a reading, and the owner has decided to KEEP it.** No job has run
   under it yet (the last `autocart_jobs` row is the 09-23 04:05 incident). History says a
   winnable job arrives about **once every two to four weeks**, so judge it after 5-10 of them,
   not after a quiet week:
   ```
   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts   # -> "rec.gov CART JOBS"
   ```
   `carted-on-retry` is the number. An empty list while `autocart_jobs` has rows over the same
   hours means a box older than the ladder — a reading, not silence.
3. **The readout — nothing, but its past is void.** From **09-21 20:48Z to 09-24** it printed
   "none in this window" for every kind over a table full of rows (a template literal ate the
   backslashes in its `LIKE` filter). **Any conclusion drawn from an empty readout in that window
   is void — re-read the table.** That window is also why nobody saw item 4.

### THE LEAK IS ACTIVE ROUGHLY DAILY, CONTAINED EVERY TIME — and one ramp is on a schedule

Since the page-wedge cure shipped (09-16 21:50Z): **7 cure firings** (`wedge-recycle`, about one a
day, no flapping) and **5 ramps it missed** (`bail:ramp`, 3.2-4.0 GB, free RAM never under
6.3 GB). **Four of the five are the T−30 auto-login on an 08:00 release morning** — 09-17, 09-21,
09-22, 09-23 — seen 96-131 s after 14:30:00Z, before any recorded trip, followed by 4-6 flat
auto-login trips a minute apart. The release still worked each time (09-23 carted at T+1 s).
**Which renderer ramps is NOT established**; `docs/CHROMIUM-LEAK.md` → *"THE 14:30 PREDICTION ABOVE
WAS FALSIFIED"* has the table and the discriminator.

- **THE CHEAPEST READING THAT WOULD SETTLE IT:** `npx tsx scripts/bot-ask.mts tail-log
  rc-keepwarm:400` within ~20 minutes of a 14:30Z T−30 trip. Nobody has pulled one.
- **09-24 DID TEST IT, AND IT RAMPED AGAIN** — the fifth release morning. `ramp-scan` at 14:31:41
  tripped on **`commitUsedMb`** (48,761 of 49,086 MB), then 4 flat auto-login trips followed. The
  box log was **not** pulled in time, so which renderer ramped is still open. Row and detail are
  in `CLAUDE.md`'s T−30 table.

### The 08:00 PT release on 09-24 — what the one instrument run said

- `rc-release-window.mts --record` ran once, as scheduled: **44 of 46 locked nights freed at
  T+0.1s to T+1.4s**, and the 2 that did not were our own `#R371` cart. **No `#L053`-shaped night
  occurred, so `#L053` is still open.** Another run is the owner's call; nothing recurring.
- ~~**Do NOT act on its "lead can be trimmed toward 0".** The burst won at T−0.94s on the box's
  clock. Different clocks, and the early win is exactly what the T−15s lead buys.~~ **STRUCK
  2026-09-25.** The +0.1s bracket belongs to `rc-357`; `#R371` is `rc-360`, whose own bracket
  is `(---, +1.4]`, so no clock skew was ever demonstrated — and 09-24 was the one release with
  a single hold, where the 15 s lead cost nothing. **The lead is 5 s.** `CLAUDE.md` → *"THE
  LEAD IS 5 s NOW"*.

### Still open, unchanged

- **Three instruments from #397 wait on a refusal AFTER a cart** (`#M450`, `findCartEntry`); the
  third (`update-guard`'s `updateRequested`) has answered — `false`, so the skip notes belong to
  the scheduled task and there is still no case of a requested update being refused (measured
  working three times: 23 s, 23 s, 25 s).
- **DELIBERATELY NOT DONE, on the owner's instruction:** nothing about the three paying Auto-Cart
  subscribers; nothing about Google Cloud; nothing about Apple beyond the resubmission.
- **MIGRATION 079 IS STILL FREE** — main's last number.

## 0a. THE RC HOLD BETA IS CLOSED, AND THE HAND-OFF FAILED THE MORNING IT CLOSED

*This section replaced the 09-21 "the burst has now been observed" block, which is answered and
folded into `CLAUDE.md` → "THE CART BURST STOPS WHEN IT WINS". Read that if you touch the burst.*

**Read `CLAUDE.md` → "RC holds — THE BETA IS CLOSED TO AN ALLOWLIST".** On 2026-09-22 the owner
saw `#M421` cart and then lose the site, and closed the beta.

```
#M421   carted 15:00:01Z   ->  released, claimed_at NULL     <- the bot let go, nobody caught it
webview x5  storedToken:'none'  oktaKeys:0  rcLoggedIn:false  <- not expired. EMPTY.
last recorded status: "Sign in above, and we'll add it the moment you're through."
```

Two changes shipped in **#392** (`315b82e`), both live:

1. **`RC_HOLD_BETA_OPEN = false`** in `src/lib/autocart-beta.ts`, two Clerk ids beside it.
   A **second gate**, not a narrowing of `hasAutocartEntitlement` — three people PAY for that
   plan and must keep reading as entitled everywhere else. **ReserveCalifornia holds only;
   Recreation.gov auto-cart is untouched.** Enforced in the poller and in `/new` (promise panel
   *and* upsell); the claim path is deliberately untouched so a carted hold stays claimable.
2. **`rc-retry.explain()`** replaced `"RC declined (401) — see console"` on the customer's
   screen. The status code and RC's own words moved to `data-detail`, which the epilogue
   forwards — the person gets a remedy, the diagnostic keeps the facts.

**TWO THINGS ARE OPEN AND NEITHER HAS A MECHANISM WRITTEN IN — do not supply one:**

- **Why the webview had NO RC session after a sign-in.** The claim screen had reported
  `tokenLife: 'dead'` — a *stored* token past expiry — and the precart webview then reported
  **emptier than that**. One row, no controlled comparison.
- **The `401` the owner photographed is not in our telemetry.** Zero
  `rc_hold_requests.client_reports` rows mention it, **all time**. A terminal hand-off failure
  does not reliably survive the webview closing, so every future post-mortem here is working
  from a screenshot. #395 closed two ways the last report could be DEFERRED — an unbounded
  debounce, and verdict stages queueing behind `token`/`cartkey` chatter — but **nothing has
  yet demonstrated a terminal failure arriving**, so treat the channel as suspect rather than
  repaired until one does.

**AND A BILLING DECISION IS OPEN:** the three paying Auto-Cart subscribers lost the RC hold
offer. Refund, downgrade, tell them, or leave it — the owner's call, deliberately not encoded.

## 0b. THE rec.gov RECONNECT IS FIXED AND LIVE ON BOTH HALVES — nothing is pending

**Read `docs/ARCHIVE-RC-AUTOCART.md` → `"RECONNECT AUTO-CART FOR REC.GOV" WAS ONE
HIDDEN INPUT, AND THE LOOP WAS CLOSED`.** (The heading carries its own inner quotes — grep for
`WAS ONE HIDDEN INPUT`.) Reported from the Android app on 2026-09-18: *"reconnect auto-cart for rec.gov"*, the
reconnect failing with credentials the owner believed correct, and in the manual `/connect`
fallback **the email re-typed into the password field on every keystroke.** Three causes, none of
them the password.

- **THE LOOP.** `openLoginModalAndFill`'s selector list matched rec.gov's **hidden** newsletter
  `input[name="email"]`, which comes first in DOM order — so `.first()` resolved to it and
  `waitFor({state:'visible'})` timed out at 8,000 ms on every attempt, forever, with correct
  credentials. The same helper is `bot.mjs`'s auto-relogin, so a dropped session could never
  repair itself: marker goes → the app says *reconnect* → reconnecting runs the same broken
  function. **From the outside that reads as "my password is wrong."**
- **THE REPLAY.** `/connect`'s stream mode re-sent the whole buffer on any recomposition and never
  cleared it between remote fields — and an email typed straight into a password with no space is
  **one token to Gboard**, so every keystroke recomposed. `src/lib/remote-keys.ts` is an ordinary
  common-prefix diff now.
- **THE REVEAL.** There was no way to see what the phone keyboard had put in the password field,
  which is *why* the first cause was undiagnosable from the app. `type="button"` — a bare
  `<button>` inside a `<form>` defaults to submit and would have sent the credentials.

**BOTH HALVES ARE LIVE.** #363 (`fff3b98`) and #364 (`2e49994`) are merged; **the box applied
`2e49994` on 2026-09-18 at 15:19 UTC in 35 seconds** (`updated and verified`), confirmed with
`bot-ask git-status` and corroborated by `autocart.bot_version` reading *"mini-PC and web are both
on 2e49994"*. `git merge-base --is-ancestor fff3b98 2e49994` holds. No worker deploy fired — none
of the changed paths is in `worker-deploy.yml`'s `paths:`, read rather than inferred.

**TWO PROBES RUN HERE, WITH NO PHONE AND NO BOX**, and each **refuses its verdict unless the
control reproduces the pre-fix failure** — so a green run is worth something:

```bash
node scripts/recgov-login-probe.mjs        # serves rec.gov's shape, drives the REAL helper
npx tsx scripts/connect-keys-probe.mts     # drives Chromium's own IME over CDP
```

**HEADLESS CHROMIUM CANNOT REACH recreation.gov FROM HERE** — `ERR_CERT_AUTHORITY_INVALID` while
`curl` answers 200 in the same second (`~/.pki/nssdb` holds only the schema; `certutil` is absent).
**Disabling TLS verification is forbidden**, which is why both probes are fixtures.

**THE RC SIBLING IS RECORDED, NOT TOUCHED.** `rc-autologin.mjs`, `rc-probe.mjs` and
`src/lib/rc-login-script.ts` carry the same kind of selector list — but each tries selectors one at
a time and asks `isVisible()` on each `.first()`, so a hidden first match moves on instead of
timing out, and `signin.reservecalifornia.com` has no newsletter form ahead of its sign-in. It is
the release-critical path between a queued hold and a missed cart. **Widening a fix past its
evidence is how the 08-22 round was spent.**

> **AFTER AN UPDATE, CHECK THE PAYLOADS CAME BACK.** `bot-ask list-processes` should show ONE
> `node.exe rc-keepwarm.mjs` and ONE `node.exe rc-hold-runner.mjs` — it did, at 15:22 UTC.
> Repeated `starting: node rc-keepwarm.mjs` in `restarts.log` (**Pacific!**) inside ten minutes is
> the crash-loop, and the remedy is a human at the box.

**A MERGE IS A TEST RUN.** Do not merge and then verify locally — CI runs the same suite against
the same production database, and the `claim`/`hold-line` suites fail in ways indistinguishable
from a regression.

---

## 0c. Ground yourself — four commands, in this order

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"                        # blocked hosts, if any
git fetch origin master && git log --oneline -3 origin/master      # what master really is
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status        # what the BOX really runs
curl -s https://camphawk.app/api/health/status | python3 -m json.tool | head -40
```

Three things that will bite in the first ten minutes:

- **`NODE_USE_ENV_PROXY=1` or nothing reaches Supabase — including `npm test`.** Without it ~150
  real-DB tests fail at once with `Host not in allowlist`, which reads exactly like a revoked
  allowlist and is not. The discriminator is one `curl` to the same host. Prefix the WHOLE
  `verify`, not one stage.
- **`git fetch origin master` before calling anything wrong.** A stale local checkout was read as
  production drift on 09-04 and cost a 16-minute hold-button outage.
- **`bot-ask git-status` is the authority on the box's commit, never `autocart.bot_version`** —
  that column COALESCEs and can show a stale sha beside a live heartbeat.

---

## 0d. THE CURE HAS FIRED SEVEN TIMES — read the box with these queries, not with the memory series

**SEVEN FIRINGS AS OF 09-24 03:00Z** — 09-17 09:50, 09-17 17:44, 09-18 15:19, 09-19 09:01,
09-20 09:01, 09-22 03:07, 09-23 04:44 — **about one a day, every recorded one `silent = strikes =
3`.** Plus **five ramps it did not catch**, four of them the T−30 auto-login (§0). The paragraph
below is the 09-18 reading and is kept for its reasoning, not its count: **the first three firings
(09-17 09:50:17, 09-17 17:44:39, 09-18 15:19:36 UTC) were not a rate either, and
all three were the SAME lever** — the last two are box updates, which produce the cold RC home-page
load the burst population needs. `docs/CHROMIUM-LEAK.md` → "IT FIRED", "A SECOND TIME" and "A THIRD TIME" are
the account; this section is how to read the box for the next one.

```sql
SELECT at, detail->>'reason' FROM bot_events
 WHERE detail->>'reason' = 'wedge-recycle' ORDER BY at DESC;   -- 7 rows as of 09-24 03:00 UTC
```

**`silent` AND `strikes` ARE ON THOSE ROWS NOW.** `silent === strikes` (3 and 3, on both firings
that carry the field) is the direct answer to the predicted flapping failure: every silent probe
went into the run of three and no `alive` reading reset the counter. **A non-zero `silent` with no
firing would be the finding**, and the repair there is a decaying strike counter, never a lower
threshold.

**A ~30 s cure fits entirely between two two-minute memory samples, so the SERIES IS THE WRONG
INSTRUMENT** — and a wedge the cure wins produces **no** `bail:ramp`, **no** `ramp-scan` and
**no** `mem-dump phase=ramp`. **So `bot_events` is now the only census of wedges there is, and a
quiet one is not evidence that the box is quiet.** The event is in Postgres and cannot roll out of
a log window; **the log lines that say the cure WORKED can and do** — pull
`tail-log rc-keepwarm:400` within ~20 minutes of a firing.

**IF THE COUNT IS STILL 1, THE SECOND QUERY SAYS WHETHER THE TRIGGER IS EVEN LIVE:**

```sql
SELECT max(at) FROM bot_events WHERE kind = 'tab-close';   -- the last Okta trip
SELECT count(*) FROM bot_events WHERE detail->>'reason' LIKE 'bail:%'
   AND at > now() - interval '6 hours';                    -- 0 means no trip was KILLED
```

Every Okta trip leaves a `tab-close` (the close is in a `finally`); a trip killed by a bail leaves
none. **`tab-close` recent = the trigger is live and the cure is genuinely waiting; `tab-close`
hours old with zero bails = the trigger is OFF and the cure cannot fire at all** — which is what
the healthy self-sustaining regime looks like, because `planRenewal` stands down while the token
is alive and the ESTABLISHED trigger is the Okta navigation.

- **THE FALSE-POSITIVE HALF IS STILL THE MEASURED ONE.** ~2,400 probes across ~20 browser lives
  since 21:50:59 UTC on 09-16 — through renewals, stand-downs, keepalive checks and five forced
  restarts — **with no run of three**, and one genuine firing. Individual `wedged` readings were
  never counted; `silent` counts them, and it is **bot-side, so it is inert until the box
  updates.**
- The detector itself is validated: `detail->>'reason'` resolves on every stored `request-counts`
  row, and the keep-warm emits exactly `snapshot({ reason: 'wedge-recycle' })`.


### FORCING A RAMP IS **DENIED** TO AN UNATTENDED SESSION — no longer the blocker, still true

`restart-rc` is refused by the harness classifier as **"Interfere With Workloads"**. That is a
permission denial, not a technical failure, and it is not to be worked around. `test-login` is
not a substitute (below). **A session with no human present still cannot produce a ramp on
demand** — what changed on 09-17 is that one arrived by itself, so this bounds how fast a SECOND
reading can be obtained rather than whether any can.

- **A HUMAN CAN DO IT IN ONE COMMAND**, and this is the single highest-value thing to ask for:
  `npx tsx scripts/bot-ask.mts restart-rc`, which makes a COLD browser loading RC's home page —
  the young-population shape, **2-for-4** as a deliberate lever. **Pace at ~15 minutes**:
  `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves the RC pair dead. Never
  inside the T−3h warm-up window of a real release.
- **Do not quote the 2-for-4 as today's rate.** The two hits were 09-09 and 09-10, while the
  young/burst population was live. **That population is BACK** — 09-17 09:50 carried 30,631
  answer-less asks on `futurebookingstartsendsdates` in a 44.6 s browser — after 46.5 hours away,
  which was its longest recorded absence. So a forced restart is likelier to land now than it was
  yesterday, and a natural one may arrive without asking.

### THE 14:30 AUTO-LOGIN RAN AND THE CAPTCHA PREDICTION WAS FALSIFIED

**The 09-17 block is settled. Four `auto-login` trips landed 14:34-14:37, `session_live_since`
moved to 14:37:05, and the 15:00 release had a live session.** So the handover's
*"`maybeAutoLogin` meets the same overlay, spends both attempts and rings the phone"* did not
happen. The site was lost to RC, not to the sign-in. **Keep the reasoning below; it is about every
future release.**

**~~THE T−30 AUTO-LOGIN IS A COIN FLIP, 1 OF 3.~~ STALE (09-24): it fired on all four of the latest 08:00 releases (09-17, 09-21, 09-22, 09-23), and ramped every time — §0.** The original reading, kept for its mechanism: Five real releases fall inside the 297-hour
`bot_events` window and exactly ONE pairs with an `auto-login` tab-close (**09-05 14:42 against a
15:00 release**, T−18). **09-09 and 09-15 produced none at all**, because `maybeAutoLogin` stands
down when the token already covers the hold — a renewal mints ~60 minutes and the requirement is
`LEAD + CART_HOLD_MIN + AUTOLOGIN_MARGIN_MIN` = 60. **So whether it fires turns on where the last
renewal happened to land, and a quiet arm at T−30 is the ORDINARY case rather than a fault.**
Check `bot_events` for an `auto-login` `tab-close` before concluding anything ran. (One caveat: a
trip killed by a bail emits no `tab-close`, and 09-15 has a `bail:ramp` sixteen minutes AFTER its
release — its browser age of 6.2 h fits a renewal, so a killed auto-login is unlikely there and is
not excluded.)

**AND THE ATTRIBUTION RULE APPLIES WHENEVER IT DOES FIRE** (`docs/CHROMIUM-LEAK.md` → "THE CURE WATCHES ONE
RENDERER OF TWO"). `maybeAutoLogin` runs in a **throwaway tab** and the cure probes
**`residentPage` only**, so a ramp in the trip's own renderer is invisible to it — and correctly
so, because `closeTabBounded` in the `finally` already reclaims that one. **"The cure did not
fire" is not a verdict on the cure until the ramp is attributed to a renderer.**

**ARM A CAPTURE AS A BACKGROUND BASH TASK, NEVER A `Monitor`.** `timeout_ms` caps at 30 minutes,
so a `Monitor` is guaranteed to lapse; the bash task is what caught the 12:00 CAPTCHA after a
session restart had already killed one.

**THE BOX IS NO LONGER HELD.** Zero live holds, so `restart-rc`, `kill-chrome` and a box update
all cost the RC session and nothing more. **A box update is owed** — §0a.

### TWO WAYS TO MISREAD CI, BOTH MEASURED TODAY

Both produced a wrong answer here, and both are one query away from producing another.

- **`?head_sha=` SILENTLY OMITS RUNS.** It returns **200 with `total_count: 0`** for shas whose
  runs exist — two of three checked hours later, while `?branch=` returned all of them in the
  same second. A watch pinned to it reported nothing for twenty minutes **while that run
  FAILED**. Not lag, not the short-sha trap. **Build on `?branch=<name>` and match the sha in
  the results.**
- **"THE PUSH RUN CARRIES THE VERDICT" IS FALSE.** One push starts a `push` run and a
  `pull_request` run on the same sha; the concurrency group keys on `head_ref || ref_name`,
  identical for both, so they cancel **each other** and the survivor is whichever started
  second — measured in **both directions** on consecutive shas of one branch. **The verdict is
  whichever twin is NOT cancelled**, and **both cancelled is its own reading**: a newer push
  superseded that sha, so it will never get one.

### THE DROUGHT IS THE SELF-SUSTAINING REGIME — waiting is waiting for it to end

**33 hours with no ramp** as of 12:51 UTC on 09-17 (last one 09-16 03:51) against a 2.3-18.6 h
gap range, and hourly peak commit flat at **7,000-7,200 MB** throughout. Four more clean Okta
trips landed on 09-17 (three renewals at 68.6-69.6 s and the 42 s CAPTCHA warm-up) and **not one
ramped** — each printed `this navigation did NOT ramp` with its own RAM delta. The explanation is
read off three instruments:

- **TRIPS FIRED CONSTANTLY, STOPPED FOR SIX HOURS, AND CAME BACK IN THE OLD BAND.** Eleven at
  68.3-69.6 s (09-16 17:39 to 22:43), eight at <=49 s (09-17 00:13 to 04:31), a **340-minute
  hole**, then 10:12, 10:43, 11:15, 11:38, 11:49 and 12:01 at **68.6-69.7 s**. **So the 21-second
  step-down REVERTED with nothing changing on the box** (`HEAD 6fc7292` throughout) — it was a
  ~4-hour episode, not a step, and the open question is "what OSCILLATES?" rather than "what
  changed?", which rules out any code, config or deploy cause. **Even the 69 s band did not
  ramp.**
- **THE SILENCE IS THE SPA RE-MINTING, IN THE KEEP-WARM'S OWN LOG.** `token exp in 2m` at
  05:29:26 then `token exp in 41m` at 05:49:26 with **`renewed=no`**. `planRenewal` stands down
  while a token is alive, so there is no Okta trip to be the trigger. **That regime has been
  measured to run TEN HOURS.**
- **AND THE OLD-BAND WAIT HAS ALREADY BEEN RUN AND LOST.** `request-counts` carries `ageMs` at
  every graceful teardown: **a browser lived 704.2 minutes on 09-16 and produced nothing** — the
  longest life on record, the top of the 52-611 min band. So "let a browser age" is not an
  experiment waiting to run.

### THE SCAN WENT BLIND AND CLEARED — read the three states apart

`chromium_memory_samples.rc_mb` was **NULL from 09-17 04:15:31 and cleared at 09:41:11**, the
sampler naming its own cause on every tick in the `bot` log: *"8 Chromium had an unreadable
command line — this process may not be elevated"*. **The window is SHUT**, so the ramp arm,
`ramp-scan`, the region walk and the baseline dump are all live again (the 11:39:47
`mem-dump (baseline) in 314ms` is that working). Everything below is how to read the next one.

- **`NULL` = we could not look. `0` = we looked and found none of ours. A number = we looked and
  here it is.** The recovery sample reads `rc_mb=0 procs=0` — a REAL reading, because the old
  browser was already gone — so dating the recovery off the first NON-ZERO row puts it three
  quarters of an hour late. That mistake was made here on 09-17 and corrected.
- `commit_used_mb` is `Win32_OperatingSystem` and answered perfectly throughout (**~7,065 MB of
  48,894** at baseline; a ramp charges ~32 GiB in <=34 s and takes it to 35-47 GB).

- **So a ramp check keyed on `rc_mb` cannot see one.** Use `rc_mb >= 1500 OR commit_used_mb >= 15000`.
- **WHILE BLIND IT DISABLES THE WHOLE RAMP ARM, INCLUDING ITS COMMIT BAR.** `readLatestMemory` refuses
  the entire reading on a missing rc figure and both arms gate on `known`. **The cure, `HUNG_MS`
  and the RAM arm are unaffected**, so the protection order is cure, `HUNG_MS`, (ramp arm, dead),
  RAM arm. That made the box briefly the cleanest test bed it will ever be, and **it lasted about
  five hours** — so do not plan around it. Recorded and deliberately NOT fixed: it is the arm that
  exits the process and it needs a box update. (The 09-17 hold that blocked that update has
  since resolved, so the update itself is no longer held — see the box-update block above.)
- **A RESTART IS A CANDIDATE CAUSE, NOT ESTABLISHED.** Blindness resumed five seconds after
  `restart-rc (#428)`; the first run began 13 minutes after the 04:02 restart and cleared on its
  own. **So do not run one to "clear" it** — it is as likely to cause it.

### WHAT IS PROVEN, AND THE ONE THING THAT IS NOT

`node scripts/cure-end-to-end.mjs` measures the three legs on **one page in one run**, through
the shipped exports, with the control arm that matters:

```
healthy  : evaluate answered, probe alive/alive/alive, strikes 0, 0 mappings
wedged   : evaluate SILENT >2000ms, getMetrics answered   <- production's own signature
the cure : 3 strikes -> recycle, 243 -> 0 mappings in 520ms
```

- It **refuses** four ways and the refusal was fired (`CURE_PROBE_MS=1` exits 1) — the healthy
  page must accrue NO strike, which is the defect its own first version had.
- **~2,400 production probes since 09-16 21:50:59, across ~20 browser lives, zero false
  positives.** That is the half that costs an RC page load if it is wrong, measured on
  Windows/149. It says nothing about the true-positive half.
- **Unproven: a single end-to-end firing in production.** Everything else — the mechanism, the
  detector on the production platform, the release path (430 healthy closes, 8-628 ms, none
  hung) — is measured.

### THE BOX UPDATE IS DONE — 24 SECONDS, AND WHAT IT BOUGHT

Requested 17:43:53 UTC, applied **17:44:17** on `637316e`, confirmed by `bot-ask git-status`.
Four things reach the box only on an update and all four are now live: the near-miss logging, the
six wedge event fields, the recycle-budget decay, and **the `cart-burst` event**.

- **THE COST WAS THE SESSION AND NOTHING ELSE.** `stop-all` ends it (~11 minutes to repair
  itself) and resets the browser to age 0. Zero holds were live, so nothing else was at stake.
- **IT WAS ALSO A FORCING LEVER AND IT HAS NOT PAID.** A cold browser on RC's home page is the
  BURST population's shape. Commit stayed flat at ~7,550 MB through 17:46 — **no ramp.** One
  restart is not a trial; the recorded rate for a deliberate `restart-rc` is 2-for-4.
- **THE T-30 AUTO-LOGIN IS THE CHEAP VARIANT AND NOT A LIKELY TRIGGER.** Okta's window reads the
  ROLLING `+12.0000h` signature, so T-30 is answered from the `idx` cookie in ~11 seconds. The
  expensive variant has ramped 3 times in 7; **the cheap one never has.**
- **If the cure fires while the per-process scan is blind it still reports honestly** —
  `memKnown: false`, `memWhy: "memory reading has no rc figure"`, `commitUsedMb: null`. The
  discriminator is carried independently by `chromium_memory_samples.commit_used_mb` at a
  two-minute cadence.

### HOW TO READ THE FIRST FIRING

**Ask this ONE query before anything else. It is the whole state of the proof:**

```sql
SELECT count(*) FROM bot_events WHERE detail->>'reason' = 'wedge-recycle';   -- 0 as of 09-17 06:00
```

A ~30 s cure can fit entirely between two two-minute memory samples, so **the SERIES IS THE WRONG
INSTRUMENT** — that event is in Postgres and cannot roll out of a log window. The detector is
validated (`detail->>'reason'` resolves on 5 of 5 stored `request-counts` rows), so a zero is
about the subject, not the query.

> **PULL `bot-ask tail-log rc-keepwarm:400` FIRST, BEFORE ANYTHING ELSE — AND NOTE THE `:400`.**
> The box emits `requestCounter.snapshot({ reason: 'wedge-recycle' })` and **nothing else** — the
> request counts and the reason. Everything that says what the firing DID is in the log.
>
> **THE WINDOW IS A LINE COUNT, NOT A CHARACTER COUNT, AND THE DEFAULT IS 80.** `tail-log`
> slices `DEFAULT_TAIL = 80` lines and only then applies `MAX_OUTPUT = 16_000`; the argument
> takes `<name>:<n>` up to 400. Measured the same minute: the default returned **38 minutes**,
> `:400` returned **89 minutes** (188 lines). **One colon is 2.4x the evidence and needs no box
> update.** Every "the log rolled at 16,000 characters" line in `CLAUDE.md` has the mechanism
> wrong; the correction is the entry headed *"AND THE WINDOW WAS NEVER 16,000 CHARACTERS"*.
>
> Even at `:400` the signal-to-noise is **5 informative lines in 188** — the rest is the two
> stand-down lines #358 dedupes — so widen the window AND land #358. The capture watcher that
> pulls it within ~90 s **dies with the session that armed it**, and it asks for `:400` now.
>
> **AND A `Monitor` CANNOT CARRY THAT WATCH** — `timeout_ms` caps at 1,800,000 ms, so it lapses
> every 30 minutes by construction and each re-arm leaves a gap. Use a background Bash task with
> a terminating condition; it has no cap and exits once when it has something to say.

In `logs\rc-keepwarm.log`: a recycling line naming the wedge, then `closed the wedged page in
Nms`, then the loop reopening — with **no** `✗ RAMP` and no `✗ WEDGED` beneath it.

**Expect the close to take ~2.5 s regardless of how much it releases.** Measured: 1,877 mappings
in 2,532 ms against 0 mappings in 2,516 ms — **16 ms apart**, so the release is O(1) in the count
and `page.close()` destroying the renderer process is why.

Once the box HAS updated, the event carries these (absent today = the box being old, never the
cure failing):

| field | reads | means |
|---|---|---|
| `closeMs` | 9-628 ms across 430 healthy production closes | a close in minutes, or `hung`, is the close inheriting the hang |
| `tokenKept` | `written` / `already-stored` / `no-token` / `already-stored-stale` / `timeout` | the live token lives in PAGE memory and dies with the close |
| `strikes` | 3 | fewer means `WEDGE_STRIKES` moved |
| `memKnown` / `memWhy` | `false` / `memory reading has no rc figure` while the scan is blind | honest, not a fault |
| `commitUsedMb` | ~7,040 baseline vs 35,000-47,000 for the leak | **the leak-versus-baseline discriminator** |

**THE RECYCLE-LOOP DEFECT IS FIXED AND THE BOX HAS IT** (squash-merged in #360, so `1720e8b`
is not an ancestor of master but its content is — `git show origin/master:scripts/auto-cart-bot/
page-wedge.mjs | grep decayedRecycles`). `WEDGE_MAX_RECYCLES` could never bind — `wedge` was reset
on every reopen and every recycle *produces* a reopen — so `escalate` was dead code and a page
that wedges within 30 s of each fresh load would recycle, reopen and wedge for ever, invisible to
`supervise.ps1` because the process never exits. The fix is `decayedRecycles` (30 m).
**A second `wedge-recycle` within MINUTES is still the shape to look at**; the two on record are
eight hours apart, which is not it.

### If a reading IS wanted at a known moment, in order of cost

1. **`rc-test-hold.mts --in 120`** — the only recipe with a recorded hit rate (**3 in 7**). It
   needs **`okta=GONE` AND a dead token**, opens the T−3h..T−30 warm-up window at once with
   ninety minutes of margin, and the hold is deleted the moment the trip is under way so nothing
   is carted. **It refuses while a real hold is live.**
2. **`restart-rc`** — cheapest by far (no campsite, no password, no Okta precondition), **and
   DENIED to an unattended session.** Ask a human.
   - **A BOX UPDATE IS THE SAME LEVER AND IS NOT DENIED.** `update.bat` runs `stop-all` then
     `start-all`, i.e. exactly the cold generation change `restart-rc` produces — and the
     **17:44:39 `wedge-recycle` fired 22 seconds after the 17:44:17 update**, on the browser it
     created. So an update that is happening anyway is a free shot at the burst population.
     **Do not schedule one FOR this** (it costs the RC session); **do read `bot_events` after
     every one.**
3. **`test-login` — do NOT spend it while Okta is ALIVE.** It forces `prompt=login` by
   interception so it does navigate, but Okta answers from the cookie (09-07: eleven seconds,
   +24 MB) — the cheap cell. Rationed one per 6 h, and it costs a password submission from an
   address that has eaten a twelve-hour block.

**`okta=GONE` cannot be brought forward.** The reported expiry is the ROLLING window our own
`/api/v1/sessions/me` probe refreshes. **The discriminator is one subtraction:**
`okta_expires_at - okta_checked_at`. 12.0000h is rolling and says nothing about the cap; a window
that SHRINKS is the frozen absolute cap, which is the precondition. **Do not "fix" the
unconditional probe to make forcing easier** — it is load-bearing by accident, and the cost is
real logins from a blocked address.

---

## 1. State — re-verified 2026-09-23, 12:58 UTC (05:58 PT)

| | |
|---|---|
| master | `793e788` (**#398**, docs). Code head is `21a0d1b` (**#397**). **Verify against `origin/master`; this line ages.** |
| open issues / PRs | **none.** |
| mini-PC | **`21a0d1b`**, confirmed by `bot-ask git-status`. Behind web by `CLAUDE.md` + `docs/NEXT-SESSION.md` and **nothing else** — proved with a path-scoped `git diff 21a0d1b..793e788 -- worker/ src/ scripts/ .github/ mini-pc/ extension/`, which is empty. |
| health | overall `degraded`, and the **only** non-ok check is `autocart.bot_version` on that docs gap. See §0 — clearing it is the dangerous option, not the safe one. |
| fleet | heartbeat **1s**, **14 watches**; `poller.shards` **3/3 held**; `poller.capacity` **8/12 across 3 machines**. |
| RC session | **`ok` — accepts the session for 7h43m**, `okta=ALIVE` to 2026-09-24T00:40Z, token exp in 30m (`renewed=no`, `src=live` — the SPA re-mints; that is normal). |
| holds | **5 live (`offered`) + 2 `requested`**, all for **2026-09-23 08:00 PT** — **2.01 h** away at the time of reading. |
| rehearsal | real `ok=true` runs on **09-21, 09-22 and 09-23** (03:01Z). Healthy nightly; #397's fix means a skip no longer satisfies the gap. |
| instruments | **three, all unread** — §0. |
| the leak | **DIAGNOSED, CONTAINED, DURATION CURED — still NOT eliminated.** §2. A `ramp-scan` fired 04:44:18Z (`rcMb 1876`, `ramFreeMb 8449`) with no action needed. |
| migrations | highest **`078`**; **`079` is the only number main has left** and the 09-23 batch did not spend it. Side lane `080+`. |
| Google Cloud | **closed — verified as not affecting this project.** Do not re-raise. |

**TWO TRAPS THIS STATE TABLE ITSELF WALKED INTO OVERNIGHT, both worth more than the rows above:**

1. **`release_at` IS ZONE-LESS PACIFIC `text`, AND `Date.parse` IS WRONG BY SEVEN HOURS.**
   Reading `2026-09-23T08:00:00` as UTC reported the release **3.3 h away when it was 10.3 h**.
   This number gates whether you may end the RC session, so **compute it in SQL, in Pacific**,
   the way `src/lib/rc-holds.ts` does.
2. **THE HEALTH CHECK ALONE CANNOT SAY HOW A SESSION WAS RESTORED.** `autocart.rc_login` reads
   the **rehearsal**, so it under-reported freshness by 2h13m and hid a successful auto-login
   entirely. `bot_events` → `tab-close {label:"auto-login"}` is the record.

## 2. The leak — DIAGNOSED, CONTAINED, AND THE DURATION CURED. **IT IS NOT ELIMINATED.** Read before touching anything memory-related.

**`docs/CHROMIUM-LEAK.md` → "THE 32 GiB CEILING IS `base::SharedMemorySecurityPolicy`" and the block directly
beneath it, "THE RESIDUAL IS COMMIT, AND NOTHING WATCHES IT", are the full account.** Everything
here is a pointer to them.

### 2.0 Where it actually stands

**It still happens every few hours. The containment catches every one. What is left is a COMMIT
risk, and nothing anywhere is gated on commit.** Off the box's own series, the 48 hours to
2026-09-11 (1,628 samples):

| | |
|---|---|
| onsets (rc family crossing 1500 MB) | **6** — most recent 10.4h before the reading |
| peak `rc_mb` | **4,661 MB** — it was 8,000-9,400 MB before the bail arm existed |
| peak COMMIT used | **46,807 MB** of a 47,870 MB limit |
| tightest COMMIT headroom | **665 MB** — 09-10 04:26, used 40,175 / 40,840 |
| minimum free RAM | **5,140 MB** — the RAM arm's floor is 2,000, so it *cannot* fire |
| `bail:ramp` fired on | **6 of 6**, ~2 minutes after each onset |

**The private-byte climb is genuinely cut short every time, and that is the containment working —
it is why the peak roughly halved.** The **~32 GiB MAPPING is untouched by any of it**: the burst
completes in **≤34 seconds**, faster than any arm can react to, and Chromium's own ceiling is what
stops it going further. **Do not read "contained" as "cured".**

**Since 2026-09-16 the DURATION is cured and the burst is not — §2.6.** A wedged page used to hold
its 32 GiB until the 120 s ramp arm or the 12-minute `HUNG_MS` arm killed the whole browser; the
page-wedge arm closes the page and releases them in seconds. That is a different claim from the
paragraph above, which stands unchanged.

### 2.1 PROVED — none of it needing a ramp, a box update or a new instrument

- **The ceiling is `base::SharedMemorySecurityPolicy::kTotalMappedSizeLimit`** —
  `32ULL * 1024 * 1024 * 1024`, a per-process atomic budget on total *mapped* shared memory,
  added to stop address-space spraying. `32 GiB / 2 MiB = 16,384` and the check is `>=`, so the
  **maximum pure-2 MiB count is 16,383**, against a measured **16,381-16,383** on six walks — the
  1-3 residual being the renderer's other budget-counted shared mappings (0-6 MiB, the right
  magnitude and the right direction). One grep over the whole checkout, one hit.
- **So the sections are `base::SharedMemoryMapping`s.** Only two callers charge that budget, so
  **stopping at exactly that number is the fingerprint of the code path** — much stronger evidence
  than the 2 MiB size, which this repo already retired as a search key.
- **No peer process holds them.** The walk's own `CHROME` lines, never read until now: 14,721
  handles in the target renderer against **1,224 in the browser** and 180-832 in every other
  process, with 4.015 KB of paged pool per section. **ipcz `NodeLinkMemory`, discardable memory
  and the GPU transfer path are all eliminated by that alone**, because each needs a peer to map.
- **The "middle population" wants no second constraint.** A cap is a ceiling, not a target: an
  event whose driver ran out of work stops below it. (Labelled a candidate; it needs nothing.)

**REPRODUCED, with both single-variable controls flat** — `node scripts/leak-repro.mjs`:

| candidate | 2 MiB shared mappings in the renderer |
|---|---|
| idle, and the pure microtask wedge | **0** |
| fetch with no response (connection refused) | **0** |
| fetch and drain the body | **0-1** |
| **`wedge-and-fetch`** — a microtask loop issuing fetches, never yielding to the task queue | **12 → 800 in 30 s, linear** |

and pushed harder, live: renderer **3,208** (6.3 GiB), network service **6**, browser **0** —
**the production peer asymmetry, exactly.** It reads `/proc/<pid>/maps` from OUTSIDE the process,
which is the property every CDP instrument lacks and the reason three of them got silence.
**Caveat kept deliberately: that is Chromium 141 on Linux (memfd) against the box's 149 on Windows
(pagefile-backed).** It establishes the MECHANISM, not the production event.

**THE CHAIN, read in source:** `URLLoader::ContinueOnResponseStarted` makes a 2 MiB pipe per
RESPONSE — **not per request**, which is why 69,060 answer-less asks cost nothing and why the
burst/leak decoupling is real; `DataPipe::Deserialize` maps the consumer **on the IO thread** the
moment it arrives; the drain is a **posted task**; `deferred_messages_` is unbounded. **A wedged
main thread cannot stop the mapping, only the release.**

### 2.2 THE COMMIT RESIDUAL — A BUILT, B ANSWERED AND OFF, **C BUILT** (§2.6), D standing

**Every arm this repo has built watches free RAM or the rc family's private bytes. The burst
spends neither.** So the one resource that actually runs low during a ramp is the one nothing is
gated on — and commit exhaustion is the **only** failure this box has had that needed a human
(2026-08-12, `supervise.ps1` could not start a shell and the machine was power-cycled by hand;
08-17, both Scheduled Tasks stopped together).

**The box, read 2026-09-11 16:15 UTC with `bot-ask memory`:**

```
RAM       15.7 GB total, 10.4 GB free
COMMIT     7.0 GB used of 46.7 GB limit   (idle)
PAGEFILE  C:\pagefile.sys — 31.0 GB allocated, peak 0.0 GB, SYSTEM MANAGED
```

**`peak 0.0 GB` is the confirmation the 32 GiB is never touched** — 31 GB charged and essentially
nothing ever written to disk. It also means a larger pagefile would cost disk, not I/O.

**FOUR OPTIONS. A is BUILT (#336) and B is ANSWERED AND OFF as of 2026-09-11; C and D stand.**
Full reasoning is in `CLAUDE.md` → "THE RESIDUAL IS COMMIT, AND NOTHING WATCHES IT" and
"THE COMMIT RESIDUAL: THE PAGEFILE TRACKS, AND OPTION B IS OFF". In brief:

- **A — a COMMIT trigger on the bail arm. BUILT 2026-09-11.** `writeLatestMemory` dropped
  `commitUsedMb`/`commitLimitMb`; they now go through the file and `rampBailDecision` carries a
  second bar on condition B, `RAMP_SCAN_COMMIT_MB` **imported** so the two arms cannot disagree
  about which event they see. Backtested over 19 onsets: **earlier on 11 by a median 77 s, never
  later, median 1,984 MB off the peak commit**. **It cannot touch the burst** — at the sample
  where it first fires the commit is already 35,794-48,444 MB. Bot-side; it rides the quiet
  window, so **no forced update and no RC session spent**.
- **B — the pagefile. ANSWERED AND OFF.** The precondition is **TRACKING**: the limit grows on
  essentially every sample and never stalls while used climbs — fastest **+30,902 MB in 33 s**,
  finishing 1,456 MB ahead, against a burst of <=34 s. And **Windows has already done B by
  itself**: the limit has been a constant **47,870 MB since 2026-09-10 12:40 UTC across 913
  samples**, so a burst needs no growth at all and idle headroom is 40,902 MB. **Do not spend a
  reboot.** The settle is not durable — a reboot resets it — which is a reason not to reboot
  rather than a reason to.
- **C — stop the wedge. BUILT 2026-09-16, and it is the PAGE that is recycled, not the browser.**
  That distinction is what defuses the recorded counter-argument: a browser replacement is 8x
  enriched before a ramp, and this replaces no browser — it closes one page and lets the loop's
  existing reopen path rebuild it. Parking the resident page stays refused for its own separate
  reason (it would silence `autocart.rc_session` and the phone alarm). See §2.6.
- **D — do nothing, deliberately.** A real option: 6 for 6 on the bail, free RAM never under
  5.1 GB, the mapping hard-capped, and **no human needed since 2026-08-17.**

### 2.3 A SECOND OPEN ITEM, and it just got a THIRD blindness measured into it

One pipe per response needs ~14,433 responses in that renderer inside the burst, and the resident
page's counter read **20 lifetime requests**. `requestCounter.attach(page)` is on the RESIDENT
page alone and `withNetworkTrace` is equally page-scoped, so **dedicated workers, service workers
and the throwaway tabs are invisible to both**. **Do not read "20 requests" as "20 responses in
that renderer."** The one-line fix is `context.on('request')`, which closes the service-worker and
throwaway-tab halves at once; **dedicated workers are NOT settled**, so do not widen the claim.
Bot-side.

**AND THE COUNTER IS BLIND TO A WEDGED PAGE ENTIRELY — measured 2026-09-16.** With a page wedged
and demonstrably making hundreds of fetches (the mappings climbing 2 MiB at a time is the proof),
**`page.on('request')` AND `ctx.on('request')` both reported ZERO.** Same cause as every CDP
instrument before it: the events route through the page's own target, serviced on the thread that
is wedged. **So `context.on('request')` does NOT close this third half**, and a "quiet" ramp may
be one whose traffic we could not see — which is a **candidate** weakening of the burst/leak
decoupling, measured in-container on a synthetic wedge and **never confirmed against a production
ramp**. Do not rewrite the decoupling entries on it. The `wedge-recycle` `request-counts` event is
what would settle it.

### 2.4 STOP DOING THESE

- **Hunting a 2 MiB constant.** The size grep over the whole checkout is clean; ipcz is the worked
  example of a 2 MiB allocation that is COMPUTED, and a size grep is blind to those.
- **Citing "the sections are NOT base shared memory".** That came from the 09-07 VOID dump of a
  healthy *replacement* browser; all four ramp dumps are `target-silent`, so `shared_memory` has
  never been read for a ramping renderer, and the cap proves it is base shared memory.
- **Spending a ramp on the memory dump.** A wedged renderer contributes ZERO allocator dumps at
  every level — settled off-box by `dump-wedge-probe.mjs`.
- **Forcing a ramp *through the warm-up*.** That route is **3-in-7**, spends the warm-up's one
  turn per Okta lifetime, and costs a password submission from an address that has eaten a
  twelve-hour block. **`restart-rc` is a different lever with different costs and is NOT covered
  by this line** — it is **2-for-4** (the two hits were 09-09 and 09-10, when the young/burst
  population was live; **it is back as of 09-17**), needs no Okta precondition and locks no
  campsite, and §0d is the one thing outstanding that needs a ramp.
- **Lowering `LOW_RAM_MB`, lowering `MEM_DUMP_STALL_MS`, parking the resident page, building
  Track B.** Each is refused for a recorded reason in `CLAUDE.md`.
- **Enlarging the pagefile. The precondition was settled on 2026-09-11 and the answer is
  TRACKING, so this is a flat no again** — for a measured reason rather than the retired one.
  The limit grows on essentially every sample and never stalls while used climbs (+30,902 MB in
  33 s, finishing 1,456 MB ahead, against a ≤34 s burst), and **Windows has already done it by
  itself**: a constant 47,870 MB since 09-10 12:40 UTC across 913 samples. **Do not run
  `fix-pagefile.ps1 -Apply`** — it costs a REBOOT and with it the RC session.

**AND THERE IS NO FIX ON OUR SIDE OF THE ALLOCATION — say it plainly.** The pipe size is
compile-time (512 KiB only on ChromeOS and 32-bit; no Finch flag), the drain is Chromium's, and
the wedge is RC's own promise loop. What changed is that the damage is now known to be hard-capped
by Chromium at 32 GiB of commit, in memory that is never touched — which is exactly why the RAM
arm has sat out fifteen-plus ramps: **it watches the one resource that is not running out.** That
makes an open-ended risk a **bounded** one. **It does not make it a closed one** — §2.2 is the
work that is left.

### 2.5 THE NAMED NEXT PIECE OF WORK — **NOT STARTED, and it wants the owner's word**

**A is aftermath and cannot be anything else.** At the sample where the commit trigger first
fires the commit is already 35,794-48,444 MB — the ~32 GiB is charged in ≤34 s and nothing that
reads a two-minute file can catch it. **What actually decides the exposure is how often we
navigate to Okta**, and that is measured:

```
renewal trips     229 over 164.6h = 33.4/day
gap bands         backoff(30m) 123 · minGap(10m) 69 · alive(~60m) 7 · other 29
failure bands     192 of 228 = 84%
onsets            18 over the same window = 2.62/day
RAMP RATE         18 onsets / 229 trips = 1 in 12.7
```

**229 attempts bought 7 successes**, so a repair costs ~33 attempts, and 12.7 attempts cost one
32 GiB burst — **each successful repair costs about 2.6 ramps.**

**`RENEW_BACKOFF_GAP_MS` is flat at 30 minutes and never escalates**, against a condition the
module's own comment calls persistent (*"when that cookie is gone every attempt will fail
identically until a human signs in"*). Escalating 30 → 60 → 120 → 240 takes failure attempts from
~28/day to **~10/day**, total trips 33.4 → ~15/day, and ramps **2.62 → ~1.2/day**. The release
path is untouched: `maybeAutoLogin` at T−30, the T−3h warm-up, the nightly rehearsal.

- **THE DESIGN WRINKLE THAT MUST BE HANDLED, not discovered later:** a `maybeAutoLogin` success
  does **not** call `recordRenewal`, so `failures` stays high — a fresh lapse would then start at
  the escalated gap instead of at `minGap`. The counter needs resetting when a live token is
  observed, or the escalation quietly delays the first attempt of a new episode.
- **WHY IT IS NOT DONE:** `planRenewal` is bot-side, it is what repairs a session between
  releases, and the SPA's silent re-mint is an OBSERVATION of RC's behaviour rather than a
  guarantee. `CLAUDE.md` says in as many words not to drive-by a change to it. **It wants the
  owner's word.**
- **AND EVEN THIS IS A REDUCTION IN FREQUENCY, NOT A CURE.** Every remaining ramp still charges
  the full 32 GiB. The pipe size is compile-time with no Finch flag, the drain is Chromium's, and
  the wedge is RC's own promise loop. ~~**frequency is the only variable we own.**~~ **CORRECTED
  2026-09-16: DURATION is a second one, and §2.6 now owns it.** Struck rather than deleted — "the
  only variable we own" is exactly the sentence that argues against building anything else. The
  two are complementary: this section reduces how OFTEN a burst happens, §2.6 reduces how long its
  mappings are HELD, and neither touches the ≤34 s burst itself.

### 2.6 THE CURE (2026-09-16) — it cures the DURATION, not the burst

`scripts/auto-cart-bot/page-wedge.mjs` plus one arm in the keep-warm's existing watchdog timer.
**`docs/ARCHIVE-OPEN-BLOCKS.md` → "THE CURE: RECYCLE THE WEDGED PAGE, NOT THE BROWSER" is the full account.**

Probe the resident page with a **bounded** `page.evaluate('1')`; after **3 consecutive**
no-answers at a **10 s** cadence, close the page. A renderer holds its mappings for as long as
its page exists, and a close needs nothing from the thread that is wedged.

| measurement | reading |
|---|---|
| `page.close({runBeforeUnload:false})` on a wedged page | **1,052 mappings (2.06 GiB) released in 86 ms** |
| `page.reload({timeout:8000})` on the same page | **HUNG past its own timeout**, killed at 70 s |
| end to end, on the real reproduction, via the SHIPPED exports | `peak 233 CLIMBING` → `probe=wedged strikes=3 act=recycle` → **`233 -> 0 in 2525ms`** |

- **IT IS FIRST IN THE TIMER because it is the cheap arm.** A page close costs one RC page load;
  `HUNG_MS` and the ramp arm cost the RC session (~11 min). And what it destroys is already dead —
  a wedged page answers no CDP, so `checkAndReport` cannot read it and `readLiveToken` cannot
  reach `window.__camphawkRcToken`. The token is persisted first, bounded at 2 s.
- **THREE STRIKES, NOT ONE, and the renewal is the case it must survive** — it stalls the LOOP for
  46-71 s (133 tab closes) while the resident renderer answers CDP throughout, so a healthy
  renewal produces `alive` readings and never reaches a strike. A REJECTION ("Target closed") is
  `inconclusive`, never a strike: that is a page CHANGING, and counting it would recycle a healthy
  page during an ordinary reopen.
- **`runBeforeUnload: false` AND `close` RATHER THAN `reload` ARE BOTH LOAD-BEARING** — each asks
  the wedged thread to do something, which is how a fix inherits the hang it exists to end.
- **IT DOES NOT ELIMINATE THE LEAK, and §2.0 stands unchanged.** The burst maps 16,384 sections in
  ≤34 s; a detector that must first observe silence acts at ~30 s. What changes is how long a
  wedged page HOLDS them.
- **UNPROVEN IN PRODUCTION.** Container-local Chromium (141/Linux) against a synthetic wedge,
  against a box running 149/Windows — the platform pair that burned the native sampler twice.
  It is **bot-side**, so it is inert until the box takes it. **Confirm with `bot-ask
  git-status`, never `autocart.bot_version`.**

#### How to force the first firing, and what each outcome means

**The lever is `restart-rc`, not a test hold.** A forced restart makes a COLD browser loading
RC's home page, which is the shape the 02:0x cluster turned out to be, and it is **2-for-4**
against a 10% pooled base rate — no campsite, no password submission, no Okta precondition.
**Pace it at ~15 minutes**: `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves
the RC pair dead. n=4, so it is a working lever and not a rate — and the two misses were on
09-17, when the burst population had been absent for 46 hours.

**The predictions are written down BEFORE the run, per the house rule, so they can be falsified:**

| | expected |
|---|---|
| `logs\rc-keepwarm.log` | `♻ no answer in 3 consecutive probes…`, then `token on the way out: …`, then **`closed the wedged page in Nms`** — the container measured 86 ms |
| the arms below it | **NO `✗ RAMP` and NO `✗ WEDGED`.** The arm acts at ~30 s (3 strikes × 10 s); the ramp arm needs 120 s and `HUNG_MS` twelve minutes |
| `bot_events` | a `request-counts` row with `reason: 'wedge-recycle'`, rendered **with the bails** rather than below the teardown baseline |
| `chromium_memory_samples` | **the ~32 GiB commit step still happens** — the burst completes in ≤34 s, faster than any detector — but it should return to baseline within about one sampler tick instead of staying up for ~2 minutes, and the `rc_mb` peak should sit **below the 3,000 MB the bail arm has been capping at**, plausibly below 1,500 |

**A 2-minute sampler can miss a ramp that is cleaned up in 30 seconds entirely**, leaving one
elevated sample or none. So the series is the *corroborating* instrument here and the log and
`bot_events` are the primary ones — do not read a quiet series as the arm not firing.

**THREE WAYS IT CAN STAY SILENT, and they need different responses:**

1. **`✗ RAMP` with no `♻` above it — the probe kept ANSWERING.** That is a real finding rather
   than a broken arm: it would mean the mapping happens while the resident page is still
   responsive to CDP, which contradicts the 09-09 VMTHREAD reading (main thread `Running`, 4
   for 4) and the `alloc trail [resident]: EMPTY` line. **Expected not to happen**, because a
   wedged main thread is per-renderer and same-site pages share it — but it is the interesting
   outcome if it does.
2. **A FLAPPING page never reaches three strikes.** One `alive` reading resets the counter to
   zero by design (`wedgeDecision`: *"a page that answered is the end of the episode"*), so a
   renderer that answers once between two silences can ramp indefinitely without a recycle.
   **The container wedge was total** — `evaluate` answered before and was silent after — so
   flapping was never exercised. If this is what happens, the fix is a decaying counter rather
   than a reset, and it is a deliberate change, not a tweak: resetting is what stops an ordinary
   reopen being read as a wedge.
3. **The arm is SILENT on the healthy path, so "ran and found the page alive" and "never ran"
   write the same nothing.** That is the house shape and it is accepted here, because the
   discriminator costs nothing: the arm runs unconditionally every tick while not bailing, so
   **`bot-ask git-status` showing the new sha is what rules out "never ran"**. What it cannot
   tell apart is `alive` from `inconclusive`. Worth one log line if a second firing is ever
   ambiguous; not worth building before the first one.

## 3. Other things open — all detail is in `CLAUDE.md`

- **THE CANCELLATION BADGE STILL CANNOT SEE THE ONE CANCELLING SUBSCRIBER — NAMED, MEASURED, AND
  NOT STARTED ON THE OWNER'S INSTRUCTION (2026-09-16).** Migration 078 is merged and deployed, the
  owner has run the reconcile, it changed **exactly one row**, and **the data in the database is
  correct**. Every admin surface still shows nothing, because all four gates read
  `cancel_at_period_end` and Stripe reports this one as a **dated** cancellation:
  `cancel_at = 2026-10-08`, flag **false**. Stripe has two independent ways to end a subscription
  and a non-null `cancel_at` does not imply the flag.
  - **IT IS NOT A RECONCILE BUG AND NOT A DATA BUG** — both fields are read off one Stripe object
    in one statement, checked in source. **Do not go looking there.**
  - The repair is `COALESCE(cancel_at_period_end, false) OR cancel_at IS NOT NULL`, and the three
    caveats that make it more than a one-liner (four copies of the predicate, the live-row filter,
    the missing mirror fixture) are in docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → **"THE CANCELLATION BADGE MISSES THE ONLY
    CANCELLING SUBSCRIBER"**.
  - **The Oct 8 deadline is real but not urgent** — three weeks of margin, and the row is right,
    so nothing is lost by taking it deliberately.

- **THE ANDROID "SEP 30" DEADLINE EMAIL IS ANSWERED — REGISTERED, 3 KEYS, ALL VERIFIED. DO NOT
  RE-OPEN IT (2026-09-16).** Google sent a final reminder threatening *"removed from Google Play
  globally"*; the Play Console reads **✓ Registered, `app.camphawk.mobile`, Keys 3, all Verified,
  updated Aug 1** — a month before the reminder. It was auto-registered because the app publishes
  an **AAB** and therefore necessarily uses Play App Signing. **Nothing is owed.**
  - **The email and the docs describe TWO mechanisms sharing one date, and quoting either alone
    misleads.** *Registration* is global and its consequence is removal; *install-time
    enforcement* is BR/ID/SG/TH-only until 2027. **Quote the row, not the date** — docs/ARCHIVE-PRODUCT-AND-PLATFORM.md →
    "ANDROID DEVELOPER VERIFICATION".
  - Open only if the sideload APK ever becomes a real channel: three registered keys is more than
    the app signing key alone, so the `camphawk_upload` key is very likely among them — **Play
    Console → Setup → App integrity** lists both certificates in full and would settle it in one
    look. Not now.

- **One screenshot outstanding, and only the owner can take it.** The Android 16 safe-area fix is
  deployed and web-side, but `env()` is 0 in headless Chromium and this container cannot reach the
  live site, so **nothing has seen it on a phone.** Open `/claim` or `/privacy` on the Pixel; the
  CampHawk mark should clear the clock. Ten seconds.
- **THE RENEWAL HAS FAILED 96% OF THE TIME FOR SIX DAYS, AND `planRenewal` IS DELIBERATELY
  UNTOUCHED.** Of 191 renewal-to-renewal `tab-close` gaps, **163 sit in a failure cadence and 7 in
  the alive band** — chronic, not an episode, so the 08-22 entry's *"20 attempts in a row have
  failed"* is the steady state rather than a moment. (**Filter to `label = 'renewal'`**, and note
  that 89% is a different quantity — the share landing on a named branch at all, which the first
  draft of the entry nearly published as the failure rate.) **It costs the session nothing** (RC's
  SPA re-mints silently) **and it is not free**: ~33 Okta navigations a day, at least ~28
  accomplishing nothing, from the address that has eaten a twelve-hour block — and an Okta navigation is the leak's own established trigger. **Do not
  drive-by a change to it**: it is bot-side, it is what repairs a session between releases, and
  the SPA's re-mint is an observation of RC's behaviour rather than a guarantee. It wants the
  owner's word. **The overnight reading it was waiting on is now IN** and supports the
  stand-down case rather than weakening it.
- **THE OVERNIGHT READING IS TAKEN — see the state table. Ten hours of total silence, then the
  renewal resumed and failed for six straight hours.** It answers the 08-18 question and it is
  the payoff of the gap instrument: one query, no box, no log. **What it does NOT answer is
  whether RC would have accepted the token** — `planRenewal` reads the token's own `exp`, and
  `session_ok` is RC's answer. Do not merge those two.
- **THE APP/STORE SURFACE IS THE SIDE LANE'S AS OF 2026-09-10** (owner's call, recorded in
  `docs/LANES.md`): `docs/APP-STORE.md`, `docs/PLAY-STORE.md`, `docs/STOREKIT-PLAN.md`, both store
  consoles and RevenueCat's. **A main-lane session should not pick these up** — read
  `STOREKIT-PLAN.md`'s "PICKING THIS UP?" block if you need the state, and hand the work over.
  - **`src/lib/**` stays MAIN regardless of topic**, including `native/purchases.ts`,
    `store-plans.ts` and the RevenueCat webhook — a change under `src/lib/auth.ts` or `limits.ts`
    is in `worker-deploy.yml`'s `paths:` and restarts all three pollers.
  - **Still MAIN's, and still open:** HMAC is reported-not-enforced, and out-of-order webhook
    delivery is unhandled (needs a migration, so main's block).
- **THE BILLING CHAIN IS PROVEN END TO END AS OF 2026-09-14 — purchase → RevenueCat → webhook →
  row → `hasAutocartEntitlement` → "Start watching", confirmed in the app by the owner.** It had
  never once run: the webhook 401'd **23 for 23** for a fortnight, then the sandbox guard dropped
  everything that got in, then the write it finally reached raised `42P10` on every row because
  `ON CONFLICT` omitted a partial index's predicate. Three bugs, each hiding the next.
  **ALL THREE ARE NOW PROVEN BY ONE ROW** — an Apple TestFlight purchase on 2026-09-15 03:23 UTC
  wrote the first `provider=apple` row this product has ever had, and a plan change four minutes
  later updated the SAME row (Apple keeps `original_transaction_id` stable inside a subscription
  group). docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "THE APPLE PURCHASE CHAIN IS PROVEN". **What is still unexercised is a REAL
  `PRODUCTION` purchase**, carrying the two known gaps below.
- **iOS — A SIXTH REJECTION LANDED 2026-09-18 (2.1(a), the camera crash). THE FIX IS BUILT,
  SHIPPED TO APP STORE CONNECT AND CONFIRMED ON A DEVICE; THE RESUBMISSION IS THE ONLY THING
  LEFT.** This block said *"nothing outstanding — do not go looking for any"* until 2026-09-22
  and had been wrong for four days; the rejection was recorded in **no doc at all**, only in
  `35bed0d`'s commit message and `codemagic.yaml`'s comments. Corrected rather than struck,
  per this file's own rule.
  - **THE REJECTION.** *"App crashed when we tapped on camera"* — **iPad Air 11-inch (M3),
    iPadOS 27.0**, against submission `e77ec119-c61f-4e2c-87d0-da4f98859958`. There was **no
    `NSCameraUsageDescription` anywhere in the repo**, and iOS terminates a process that
    touches the camera without one: no dialog, no JS error, a crash to the reviewer and filed
    as one.
  - **WE HAVE NO CAMERA CODE AND STILL REACHED THE CAMERA.** No camera plugin, no
    `getUserMedia`, no `type="file"` input in `src/`. Both routes are WKWebView's, inside our
    process: Clerk's "Manage account" → `UserProfile` renders a profile-image file input and
    iOS offers **Take Photo** on it (clerk-js is fetched from Clerk's CDN at runtime, so
    nothing in this repo controls it), and long-pressing a campground photo.
  - **FIXED IN `35bed0d` (#378)**: `codemagic.yaml` writes three purpose strings into
    `Info.plist` at build time, **plus a step that unzips the built IPA and reads the SHIPPED
    `Payload/*.app/Info.plist` back**, failing on any of five missing keys. A build-time write
    nobody reads back is the fix-present-and-inert shape; this one is read back.
  - **BUILT AND DISTRIBUTED.** Codemagic **index 13**, workflow `iOS · TestFlight`, commit
    **`2b47138`** — which **contains** `35bed0d` (verified with `git merge-base --is-ancestor`,
    eight hours later) — finished in 5m 40s, `App.ipa` 12.22 MB, and its post-processing step
    **App Store Connect distribution** ran 3m 40s. Both purpose-string steps are visible in the
    build log and passed.
  - **AND THE OWNER TESTED THE CAMERA ON A DEVICE (2026-09-22): it worked.** Code → build →
    binary assertion → device. That is the full chain for this defect.
  - **ANSWERED FROM THE CONSOLE 2026-09-22 (owner screenshots), AND THE BUILD NUMBER IS `28`.**
    **Not** the Codemagic index — that was **13** — which is the `PROJECT_BUILD_NUMBER` trap
    this file warns about. Matched on **upload date**, and the arithmetic closes:
    ```
    2b47138 committed              2026-09-20 21:56:34 PT
    build 5m40s + post 3m40s        ~14 min
    ASC Upload Date                 Sep 20, 2026 at 10:10 PM   <- lands exactly there
    ```
    Binary State **Validated**, `aps-environment: production`, arm64, iPhone + iPad, min iOS
    15.0. **Build 28 IS attached to version 1.0.**
  - **IT HAS NOT BEEN RESUBMITTED.** The version reads **`1.0 Prepare for Submission`**, not
    *Waiting for Review*, so **`Update Review` is still unpressed** — and that button is a
    ONE-SHOT (*"you can edit items in a submission only once before resubmission"*).
  - **THE PRECHECK IS CLEAN, run 2026-09-22 against the email actually in Sign-In Information**
    (`iamtylerflores12345@yahoo.com`, Clerk `user_3IS7IGizJd6UTZmrUf8xkOGB3F8`):
    `is_beta false`, `subscriptions none`, `hasActiveSubscription false` — the reviewer reaches
    the paywall, so the 08-22 class is not lurking. **Re-run it in the same minute as the
    press**; its entire value is freshness.
  - **TWO THINGS STILL UNKNOWN, AND ONE OF THEM IS A TRAP THIS FILE ALREADY NAMES.**
    1. **`REVENUECAT_SANDBOX_USER_IDS` must contain `user_3IS7IGizJd6UTZmrUf8xkOGB3F8` through
       review**, or the reviewer's SANDBOX purchase succeeds at StoreKit and grants nothing.
       It reads `len=0` in a session — **that is NOT evidence it is unset**, it is a Vercel
       variable, exactly like `FCM_SERVICE_ACCOUNT`. **And nothing in `/api/health/status`
       reports it**, so unlike the FCM case there is no instrument to ask instead: it is
       genuinely unobservable from a session and must be read in Vercel. Clear it once
       APPROVED, never before.
    2. **`App Review` carries a red badge in the console's left nav** and no session can see
       what is behind it. A one-shot button should not be pressed with an unread error on the
       page.
  - **The StoreKit-age check passes:** `@revenuecat/purchases-capacitor` landed `8818544`
    (2026-08-29); build 28 is 09-20, so it is not the no-StoreKit build whose paywall renders
    an `unavailable` fallback that looks identical to a healthy one.
  - **THE `Update Review` TRAP RECURRED AND COST A SECOND SESSION — IT IS IN THE HANDOVER NOW
    FOR THAT REASON.** `Resubmit to App Review` on the SUBMISSION page sits **greyed out** under
    *"Unresolved Issues"* and a banner reading *"Your app version was rejected and no other items
    submitted can be accepted or approved"*, and **nothing on that page enables it.** The version
    has to be pushed back into the submission with **`Update Review`, top right of the VERSION
    page**, beside `Save` — Apple's own help calls that slot *Add for Review*, so **match on
    POSITION, not the label**. Resubmit went live the instant it was pressed, both times.
    - **The full account is `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` → "SAVING THE METADATA DOES
      NOT RESOLVE THE ITEM"**, written 2026-09-15. It was complete and correct and **still cost
      this session**, because a person mid-submission looks at the handover, not at a 4,600-line
      archive. **That is the router's limit, not the archive's failure** — a step you execute
      under time pressure belongs where you will be standing.
  - **CONFIRM THE SUBMISSION NAMES THE BUILD BEFORE PRESSING RESUBMIT.** After `Update Review`
    the six rows read `Ready for Review` and the `iOS App 1.0` row carries **`1.0 (28)`** as a
    link. That row is the check that matters: it is the difference between resubmitting the fix
    and resubmitting the rejected binary, and it is readable in one glance.
  - **STATE AS OF 23:08 UTC 2026-09-22, AND WHAT IS NOT KNOWN.** `Update Review` pressed, six
    items `Ready for Review`, `1.0 (28)` in the submission, `Resubmit to App Review` **live and
    UNPRESSED**. Pre-check run twice (23:06:13, 23:08:50), CLEAN both times. **Whether the owner
    then pressed Resubmit is NOT established** — no session can read App Store Connect, so read
    the console rather than assuming this sentence aged into "submitted".
  - **OWNER DECISIONS, so they are not re-raised as oversights:** the camera was tested on
    **build 28** specifically; the **iPad test was declined** (the reviewer's device was an iPad
    Air 11-inch M3, and the fix is device-independent by mechanism — `Info.plist` is a property
    of the binary and Device Family is `iPhone, iPad` — so the residual is small but it is not
    zero, and a 2.1(a) that comes back on iPad is new information rather than a repeat); and
    `REVENUECAT_SANDBOX_USER_IDS` was set **and redeployed** (an env change does not reach
    already-deployed functions).
  - **THE PRECHECK IS STILL MANDATORY AND IS STILL THE THING THAT BITES.** Run
    `scripts/app-review-precheck.mts <sign-in-email>` **in the same minute as the
    resubmission** — the demo account has silently become a subscriber twice, and a subscriber
    sees no paywall, which IS the 08-22 rejection.
  - **THE COUNT IS SIX NOW, AND TWO PLACES STILL SAY FIVE** — `CLAUDE.md`'s router entry (fixed
    2026-09-22) and `.claude/skills/store-release/SKILL.md`, whose `description:` is the whole
    matching surface. `docs/APP-STORE.md` carries no account of this rejection at all. All
    three of those are the **SIDE lane's** surface; named here rather than edited.
  - **The 3.1.2 rejection this block used to describe (2026-09-15, no Terms of Use link) is
    resolved** — two lines in one field, `src/lib/store-listing.test.mts` guards it — and the
    mechanics below still apply to any resubmission.
  - **ONE UNREAD SIGNAL QUALIFIES THAT SENTENCE, AND ONLY THE OWNER CAN SETTLE IT.** An Apple email
    dated **Sep 15**, *"There's an issue with your CampHawk: Campsite Alerts (iOS) submission"*,
    sits against a build submitted **Sep 14 21:35 PT**. On the dates it is most likely the 3.1.2
    rejection already described above arriving by mail — but it could equally be newer, and
    **nobody in a session can open App Store Connect to tell the two apart.** One look at the
    submission's state answers it. Recorded rather than resolved; do not guess a verdict into the
    docs. (The store consoles are the SIDE lane's surface.)
  - **THE STEP THAT IS NOT OBVIOUS, AND WHICH §2e PREDICTED WRONG: saving the Description does NOT
    enable `Resubmit to App Review`.** The version has to be pushed back into the submission with
    **`Update Review`** (top right of the version page; Apple's help calls that slot *Add for
    Review* — **match on POSITION, not the label**). Resubmit went live the instant it was pressed.
    docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "SAVING THE METADATA DOES NOT RESOLVE THE ITEM".
  - **`Update Review` IS A ONE-SHOT** (*"you can edit items in a submission only once before
    resubmission"*) and **Remove is irreversible** (*"removed items cannot be added back to the same
    submission"*). Both are Apple's own words; the second would make the 09-14 draft trap permanent.
  - **The Description counter reads REMAINING**: 3,714 pasted shows as **286**, which looks exactly
    like a truncated paste and is not one.
  - **`www.apple.com` IS PROXY-BLOCKED** — the EULA URL cannot be verified from a session; take it
    from the letter's own hyperlink. (`developer.apple.com` IS reachable and settled the resubmit
    question in two calls — **but serves its "Page Not Found" with HTTP 200**, so grep the body.)
  - **The plausible NEXT rejection is the in-app disclosure**, deliberately not touched: 3.1.2 also
    wants title, length, price and Privacy/Terms links in the BINARY, and `StorePaywall` plus the
    `(app)` footer put all five on screen **by layout rather than by design**, guarded by nothing.
    It is `1.0 (27)`'s web layer, so a push fixes it with no rebuild.
  - **WHAT IS STILL UNVERIFIED AND MATTERS IF IT PASSES:** build 27 has **zero installs**, so
    nobody has walked the paywall on the binary the reviewer gets. Worth doing while it queues.
  Standing facts, unchanged — and read docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "THE SUBMISSION STATE, WRITTEN DOWN BECAUSE IT
  LIVED ONLY IN A CHAT" before touching anything: **SBP approved at 15%** (no price change needed
  — the four products were already on the 15% column), **§4e is 7-of-7** while that file still
  says `GATED ON SBP`, and **Sign-In Information points at the clean account**.
  - **`NODE_USE_ENV_PROXY=1 npx tsx scripts/app-review-precheck.mts iamtylerflores12345@yahoo.com`
    reads CLEAN.** Run it before any submission; the default argument is the OLD account and reads
    NOT CLEAN by design, because it is a live grandfathered Stripe subscriber that must not be
    deleted to pass a check.
  - **EVERY STEP OF THAT LIST IS DONE.** The chain was proven by a real TestFlight purchase, the
    row it wrote was deleted, the replacement review notes were pasted, the Resolution Center reply
    was posted (Messages 11, 2026-09-15 04:11 UTC), and the six-item submission went in 24 minutes
    later. **After APPROVAL, not submission:** clear `REVENUECAT_SANDBOX_USER_IDS` and delete the
    row the reviewer's own purchase writes.
  - **THE SUBMISSION WENT IN ONCE WITH ONE ITEM AND HAD TO BE CANCELLED AND REDONE.** The four
    subscriptions were in a separate draft that ASC refuses to submit without an app version, and
    resubmitting the version from the rejection page did not pick them up. **`Items Submitted (1)`
    is the tell.** Full account, including why `Cancel Submission` is safe and where the control
    hides, in CLAUDE.md under the heading above.
  - **THE REVIEW NOTES IN `docs/APP-STORE.md` §2d ARE THE 08-22 BLOCK AND MUST NOT BE PASTED.**
    They never mention In-App Purchase, lead with the external purchase link, and describe the
    demo account as subscribed — all three are now false and the last rejection was 3.1.1 IAP.
    The replacement leads with numbered steps to the StoreKit sheet; it was handed to the owner
    on 2026-09-15 and is not in the repo (it carries no secrets, but §2d is the side lane's file).
  - **A SUCCESSFUL TEST PURCHASE RE-CREATES THE 08-22 REJECTION.** It makes the demo account a
    subscriber, and a subscriber sees no paywall. Let the store subscription lapse (TestFlight
    renews at most six times, so ~30 minutes), THEN delete the row — deleting earlier is futile
    because the next renewal writes it back.
  - **Signing out does NOT reveal the paywall any more.** `/pricing` needs signed in AND not
    subscribed. `docs/APP-STORE.md` §2d's sign-out steps and §5's "the demo account has an active
    subscription" are both now reasons to be rejected — side lane's file, named not edited.
  - **Do NOT clear `REVENUECAT_SANDBOX_USER_IDS` before APPROVAL.** App Review buys in SANDBOX, so
    a cleared allowlist means the reviewer's purchase unlocks nothing.
  - **The attached BUILD must be dated 2026-08-29 or later** (`8818544`). **Match on upload DATE,
    never on build number** — ASC's number is `PROJECT_BUILD_NUMBER`, project-wide across both
    workflows, so "TestFlight #12" (a Codemagic run number) is not ASC build 12.
  - **`api.clerk.com` is `connect_rejected` at the proxy**, so §2a's password check is no longer
    available from a session. The owner signs in at camphawk.app with the exact ASC string.
- **Play production release 25 was IN REVIEW as of 2026-09-01, and nobody in a session can read
  the Play console — treat that as a date, not as current state.** Ask the owner before acting on
  it.
- **The release-window Routine self-disables 2026-09-12**, ~2 firings left.
- **A NUMERIC TEST FIXTURE IS VISIBLE TO PRODUCTION, AND ONE HALF OF IT HAS A NARROW SAFE FIX.**
  `REAL = '0'` passes `REAL_UNIT`, so for the length of any `npm test` run both `nextHoldRelease`
  and `holdAtRisk` return a phantom `carted` hold — which reddens `autocart.rc_session`, can spend
  a `maybeAutoLogin` turn, and in `hold-fixture-invisibility` (which borrows
  `SELECT id FROM users LIMIT 1`) returns **a real account's phone**. The safe repair is to give
  that suite its own inserted user with no phone, as `health-hold-counts` already does — it
  touches neither the assertion nor the release timing. **Do NOT instead push the fixture's
  `release_at` out**; the near release is load-bearing and moving it makes the guard flaky in the
  direction that reads green. It is `worker/**`, so verifying restarts all three pollers.
- **`hold-line.test.mts` FAILS 4-11 TESTS AGAINST PRODUCTION AND THE DIFF IS USUALLY INNOCENT
  (2026-09-16).** A docs-only branch came back `# fail 4`; the same suite alone gave **8 on
  master, then 0 on the very next run**, with different test NAMES each time. The failing names
  are all `dueHolds` and `rankHoldLine` — **both of which run in production against the same
  table** (`rankHoldLine` every poller cycle, `dueHolds` every 15s from the box), so this is the
  `reclaimLapsedHolds` test-versus-production class and serializing the lanes cannot prevent it.
  - **I NEARLY FILED #343 AS THE CAUSE and the evidence was excellent** — the commit before it
    passed 28/28 while master failed 8, and #343 touches `auth.ts`, `poller.ts` and adds a
    migration. **Master then passed 28/28 on the next run.** One extra command separated a
    regression from timing. Re-run before believing a pairing.
  - **Do NOT loosen the assertions.** They cover the 08-26 double-cart, where the bot carted one
    campsite twice for two different users. Why it got heavier is **not established** — the
    obvious candidate is live hold rows, and nobody looked.

- **Recorded, not fixed — do not drive-by any of these:** neither containment arm can fire during
  a ramp; the RDR request burst (69,060 asks, zero answers of any kind); the fixed-sentinel test
  fixtures in `sync-claim`/`ridb-photos`/the hold suites; a pre-migration-070 watch silently
  covering less of a park than its name suggests; `autocart.bot_version` armed by a comment.

---

## 4. Serial rules — one production database, one box

From `docs/LANES.md`. Announce and wait before: `npm test`, `scripts/rc-test-hold.mts`, anything
that restarts the box, `sms-link-test.mts --send`.

- **A merge IS a test run**, and so is a second push.
- **One push starts TWO runs** (`push` + `pull_request`) which overlap for **3-301 seconds**,
  measured. Nothing a lane can do prevents it. A red run whose job started within that window of a
  push has a named cause: re-run in a clean window rather than hunting.
- **A third writer no lane starts:** the Nightly RIDB Sync writes the catalog for ~38 minutes and
  is started by nobody. Check `actions_list` before reading a red CI as a regression.
- **AND THE TWO LANES' CI RUNS OVERLAP FOR THE FULL SUITE — MEASURED 2026-09-16, 9m09s.**
  Different branches are different concurrency groups, so **nothing cancels either**: a side-lane
  run (16:22:07→16:33:07) and a main-lane run (16:21:54→16:31:16) both ran `npm test` against the
  production DB start to finish, and mine came back `# fail 1` of 2207 on a **one-Markdown-file
  diff**. The same tree passed **2207/2207 locally in a clean window**, and the re-run was green.
  - **This is the branch-vs-branch case**, not the push-vs-pull_request one above and not the
    Nightly Sync — check `actions/runs?per_page=12` for the OTHER lane's window before blaming
    either. **Both lanes being active is the normal state**, so this is not an edge case.
  - **The failing NAME was below `get_job_logs`' cap** (the visible window opened at `ok 2160`),
    so the name is unreachable through CI and `npm test > log 2>&1` locally is the only route —
    which doubles as the clean-window evidence a legitimate re-run needs.
- **Two sessions can be the SAME lane** — the branch name does not distinguish them and
  `ListAgents` cannot see a sibling elsewhere. An empty list is not exclusive use of the database.

---

## 5. Traps that have actually fired

- **Never read an exit code through a pipe** — `| tail` reports `tail`'s status and cuts every
  `not ok` line. Two false greens from one command.
- **Read the instrument before reasoning about the code.** The failures here are overwhelmingly
  instruments that were running and unread.
- **Check a Sentry issue's TIMESTAMP before reading it as live.** CAMPHAWK-N (*"no unique or
  exclusion constraint matching the ON CONFLICT specification"* on `/api/webhooks/revenuecat`) is
  dated **Sep 14 — before #340 added the partial-index predicate that fixes it.** CAMPHAWK-M and
  CAMPHAWK-K are Server Action staleness, the ordinary consequence of a deploy. **`sentry` is an
  unauthorized MCP server here** — it needs an interactive `/mcp` authorization, so those readings
  came from the web UI and cannot be re-taken in a session.
- **Compute elapsed time in SQL**, never by subtracting a rendered label from a clock read
  elsewhere. This produced a wrong "1h50m" against a true 6.09h on 09-10.
- **`GITHUB_TOKEN` is a 14-character placeholder and `/user` returns 200** — a false positive.
  Public `/repos/` **reads** work unauthenticated; anything scoped or written goes through MCP.
- **A red CI's failing test name can be unreachable** — `get_job_logs` caps at ~5,000 lines and
  `not ok` can appear zero times over a job reporting `# fail 1`. Reproduce locally with
  `npm test > log 2>&1` and grep `^not ok`.
- **RC's `Lock`/`release_at` is a zone-less PACIFIC wall clock.** Use `pacificWallClockToUtcMs`
  (`worker/held-cadence.ts`) in JS, `AT TIME ZONE 'America/Los_Angeles'` in SQL.
- **A guard can pass vacuously and a mutation can fail to apply.** Grep for the mutation as well
  as running the suite. This has caught ~28 guards anchored on the wrong thing.
- **`git checkout -- <file>` reverts to HEAD**, so during mutation testing it deletes the
  uncommitted fix under test. Commit before mutating.
- **`git rebase --onto origin/master <old-tip>`** for a branch cut from a squash-merged branch.
- **A column aliased `t` makes `query()` return scalars, not row objects** — it collides with
  `exec_select`'s own wrapper subquery alias, so `json_agg(t)` resolves to that COLUMN. Every
  field reads `undefined` with a plausible row count. **`AS` is irrelevant in both directions;
  the alias being `t` is everything.** Hit again on 09-17, the day it was recorded.
- **`sqlit` interpolates, it does not bind**, and throws on a plain object — stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
