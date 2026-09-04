# Next session — start here

*Rewritten 2026-08-25; state refreshed **2026-09-04 09:15 PT** (main lane). This is a
HANDOVER, not a permanent doc — `CLAUDE.md` owns every finding.*

> ## READ FIRST — THE MORNING WORKED, AND TWO SESSIONS COLLIDED WRITING IT UP
>
> **1. `#L034` CARTED AT T+1.4s AND WAS HANDED OVER.** Unit 42527, Leo Carrillo, carted
> 15:00:01.4 UTC against a 15:00:00 release and released to the owner at 15:09:41 — status
> `released`, `last_attempt_note` NULL, i.e. the claim-driven hand-off and not a timeout. It
> was the retry of the campsite lost on 09-03 and the cart burst's first real test.
>
> **2. RC RELEASES EARLY — MEASURED, AND ONLY ONE OF THE THREE BRACKETS SAYS SO.** The direct
> instrument ran (582 polls, 0 unreadable, 45 of 47 nights). `rc-583`'s flip lies in
> **(−2.2s, −0.2s], entirely before T**; `rc-539` and `rc-542` straddle it and decide nothing.
> **Quote rc-583, never the +0.5s median** — the median averages one proven-early bracket with
> two undecided ones and reads as "on time". Facilities flip **atomically**, ~1.3s apart. That
> justifies the burst's T−15s lead on evidence rather than on "not excluded", so do not shorten
> it. `#L034`'s own flip is **inferred** from facility-atomicity, not measured — its nights
> were not among the 47.
>
> **2b. THE ROUTINE THAT WAS MEANT TO TAKE IT REPORTED `SUCCEEDED` AND TOOK NOTHING.** A
> 15-minute script against the Bash tool's 600-second ceiling: the fired agent backgrounded it
> and ended its turn, and a fresh-session container is reclaimed with the turn. It was re-run
> by hand with three minutes to spare. **A green Routine run is not a measurement taken.**
>
> **3. TWO MAIN-LANE SESSIONS RAN AT ONCE AND WROTE CONTRADICTORY ACCOUNTS OF ONE INDEX.**
> `docs/LANES.md` divides main from side and had no rule for two of the same lane; it does
> now. One applied migration 074, the other diffed the live index against a day-old checkout,
> called it drift and had the owner revert it (~16 min with the hold button silently dead),
> the first re-applied it and wrote "it was never applied", which the second wrote up as "a
> mysterious revert". **Neither read-back was wrong and both accounts were.** The missing
> command was `git fetch origin master`, and the missing fact was that **`ListAgents` lists
> only sessions on THIS machine — an empty list is not exclusive use of the database.**
> CLAUDE.md → "TWO SESSIONS WROTE CONTRADICTORY ACCOUNTS OF ONE INDEX" and "I READ A STALE
> CHECKOUT AS PRODUCTION DRIFT".
>
> **4. `git fetch origin master` AND `git log --oneline origin/master -10` BEFORE ANYTHING.**
> Three PRs merged on the morning of 09-04 that neither session saw. This is the habit that
> would have prevented item 2 outright, and it costs one command.
>
> ### THE STATE
>
> - **#266 merged** — the `offerHold` gate hoist (it ran once per release below
>   `claimHoldNotification`, so a transient throw lost the hold button for that release for
>   ever) plus one shared `holdOfferDecision` for the primary and extras paths.
> - **Migration 074 is applied**, four columns, read back.
> - **Open PRs:** the side lane's **#258** (acquisition instrumentation, holds migrations
>   072-073). **Migration blocks: main `075-079`, side `080+`.**
> - **The release-window instrument is a daily cron**, `trig_012K7iCrj1J9KspyqGucZSHC`,
>   `56 14 * * *` (07:56 PT), **09-05 through 09-11**, self-disabling on 09-12. Two gaps
>   recorded and neither fixed: the independent disabler (`trig_01FtjDWmMS8PvGQ8z1TSYbHQ`)
>   **stores no MCP connectors and may be inert**, so the self-disable in the prompt is the
>   load-bearing stop; and **nothing persists the readings** — seven ephemeral sessions, stdout
>   only. A `--record` flag plus a small table is the fix and is **not built**.
> - **Health 17/19**, both warns benign — `bot_version` drift with *"no bot-side code in the
>   gap"*, and `rc_login` reporting the rehearsal skipped.
>
> ### AFTER THE MORNING, IN ORDER OF WHAT IT BUYS
>
> **1. The runner has NO wedge watchdog.** On 09-02 it sat alive in its pre-release wait and
> polled nothing, indefinitely — `last_attempt_at` NULL, the 2026-08-07 dead-runner signature
> over a live process. `supervise.ps1` restarts on EXIT only. #255 bounds the ONE call
> identified as the likely hang; the general fix is the keep-warm's 08-17 pattern (a watchdog
> in a timer that bails so the supervisor restarts it) and **it is not built**.
>
> **2. RC's own app tier is the largest un-instrumented risk on this path** — and it is now
> partly instrumented. `never-loaded`/`load-error` have readings, a successful load reports
> its milliseconds (`RC_SLOW_LOAD_MS` = 8s), and `rc-load-stats` aggregates across runs. What
> is missing is a corpus: **the first hand-off after that landed is the first data point.**
>
> **3. The RC session dies within ~2 minutes of every queue — four for four**, then ~11
> minutes to recover. Whether the 08-30 `persistLiveToken` fix is on the box was never
> checked, and it is one `bot-ask git-status` away.
>
> **4. A fresh iOS build.** The iPhone is on **1.0 (21) from 2026-08-09** against Android's
> **1.0 (25)**, so "iOS is the baseline" is a baseline of three-week-old code that predates
> RevenueCat, and **iOS is now the platform with NO corroborated cart run.** Required for
> Apple IAP anyway. Codemagic run, not a code change.
>
> **5. Run the Stripe reconcile** (Admin → "Does our table match Stripe?" → Check, read the
> plan, Apply). The webhook fix is forward-only, so both trials still read `active`. **Do not
> re-derive the "Active 5 · 2 paying" panic** — those tiles read different systems, and a
> refund does not cancel a Stripe subscription.
>
> **6. `keepSignedInReading` is fed the WRONG report and warns on every healthy
> identifier-first sign-in.** `rc-holds-readout.mts` takes `findLast`, and that path emits two
> `keep-signed-in` reports — ticked at the identifier step, then correctly `boxes: 0` at the
> password step where Okta never renders it. So a run that ticked the box prints *"NOT ticked …
> no checkbox on the page at all"*, contradicting the `signInPathReading` line directly above
> it. Verified on `#L034`. **Two lines plus a guard** — prefer the report with `boxes > 0`, fall
> back to the last only when none had one. Fixture must stage BOTH reports or the test is
> vacuous. CLAUDE.md → "AND `findLast` MAKES A TICKED BOX REPORT AS \"NO CHECKBOX AT ALL\"".
>
> **7. The Chromium leak is the owner's standing ask and is still uncured.** Track A's trail
> has never caught a ramp (§2). **Track B is designed and deliberately NOT started** (§6).
>
> ### DECIDED — do not re-raise
>
> - **The six watches the dead-man's switch paused stay paused** (asked and answered 09-04).
> - **Do NOT queue a test hold to force a memory ramp.** Three arrived free in thirty hours
>   and all three were missed; a staged one locks a real campsite.

> ## SUPERSEDED HANDOVERS — deleted 2026-09-04, and here is where they went
>
> Roughly 450 lines of 2026-08-29 → 09-04 handover sat here: the Android hand-off
> investigation, the two-phone divergence, the trace analyses, and the queued-hold checklists
> for three mornings that have since happened. **They were lists of ACTIONS, and every one is
> closed** — #248, #249, #250, #252, #255, #262, #263, #264, #265 and #266 are merged, and on
> 2026-09-02 an Android hand-off was confirmed on RC's own cart page by the owner (header,
> badge, reservation), the first human corroboration of `cart read back` on any platform.
>
> **The FINDINGS are all in `CLAUDE.md` under their own headings** — "RC'S SIGN-IN IS TWO
> STEPS", "#249 WAS NECESSARY AND NOT SUFFICIENT", "iOS AND ANDROID DIVERGED ON ONE CAMPSITE
> EACH", "THE ANDROID HAND-OFF IS FIXED, AND A HUMAN FINALLY LOOKED AT THE CART", "WHERE iOS
> AND ANDROID ACTUALLY DIFFER". Nothing was lost; a stale to-do list read as current costs a
> session in a way a stale finding does not, which is the whole reason this file is allowed to
> be deleted and `CLAUDE.md` is not.
>
> **One rule from them is not dated and is kept:** if iOS regresses, revert
> `src/lib/rc-login-script.ts` ALONE — #248 touched the iOS baseline to instrument Android and
> that file is the only one in it that reaches an app; reverting the whole PR takes the parity
> work with it.

---

## 0. Ground yourself — in this order

### 0a. Can you reach production?

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"        # recentRelayFailures names blocked hosts
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://camphawk.app/
```

**Egress is fully open as of 2026-08-26 12:10 PT** — the owner had the last three hosts added
to the allowlist, and all three now answer: `mcp.sentry.dev` 200, `mcp.vercel.com` 401,
`flyctl-metrics.fly.dev` 404. Those are the SERVERS replying, not the gateway's 403, and the
`flyctl` metrics warning is gone. `recentRelayFailures` should now be empty.

**THE MCP SERVERS ARE STILL NOT USABLE, AND THE REASON HAS CHANGED — it is AUTH, not the
network.** `POST https://mcp.sentry.dev/mcp` answers
`401 {"error":"invalid_token","error_description":"Missing or invalid access token"}`, and no
`mcp__sentry__*` or `mcp__vercel__*` tools appear in the tool list. Both need an OAuth pass in an
INTERACTIVE session (`/mcp` or `claude mcp`); a sandbox session cannot run it. **Do not report
these as blocked hosts** — that reading is stale, and it sends the next person to widen an
allowlist that is already open.

**AND SENTRY WOULD BE EMPTY EVEN THEN.** `NEXT_PUBLIC_SENTRY_DSN` is unset here (0 chars),
`SENTRY_AUTH_TOKEN` too, and the served production HTML carries no Sentry reference — so
`instrumentation.ts`, `instrumentation-client.ts` and `app/error.tsx` all no-op in production.
`mcp.vercel.com` is the one worth authing: it would settle several "Vercel's env is
authoritative and was not readable" items in `CLAUDE.md` (the autocart price ids,
`CAMPFLARE_API_KEY`, and the Sentry DSN itself).

**Egress has been revoked mid-session before** (08-23/08-24). If it
is blocked: **report the hosts and stop.** Do not route around it.

### 0b. `NODE_USE_ENV_PROXY=1` OR NOTHING REACHES SUPABASE — INCLUDING `npm test`

This cost half an hour on 08-25 and it looks exactly like a revoked allowlist:

```
DB query error: Host not in allowlist: mraeprivokvmxbvhwbbj.supabase.co
```

That is **not** a revocation. `npm run verify` does not set the variable, so in this sandbox it
must be run as `NODE_USE_ENV_PROXY=1 npm run verify` or ~150 real-DB tests fail at once, across
files that have nothing to do with each other. CI is unaffected — it is not behind this proxy.

**And do not read an exit code through a pipe.** `npm run verify 2>&1 | tail -25` reports
`tail`'s status, which is always 0, and the tail also cuts every `not ok` line. Redirect to a
file and check `$?`. That is two separate readings of "green" that were neither.

### 0c. The four readings

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts    # Track A — THE ONE THAT MATTERS
NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts # did a ramp happen at all?
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts        # the 8am flow
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status      # what the box is running
```

---

## 1. ~~The double-cart bug~~ — FIXED IN #201; the write-up is in CLAUDE.md

`dueHolds` carries a temporal `NOT EXISTS` over the live statuses, so the rule is *one live
hold per unit* rather than *one served per call*, and `hold-line.test.mts` calls `dueHolds`
twice with a status change in between. **There is no work here.** The full account — including
why the old test structurally could not catch it — is in CLAUDE.md under "THE FAIRNESS LINE
SERVED BOTH RIVALS".

> This heading said *"it is not built"* for two days after the fix landed. That is the cost
> this handover exists to prevent: a "NOT built" on the top item is exactly the sentence a
> later reader quotes as current state.

---

## 2. THE ASSIGNMENT — read the next ramp

`scripts/auto-cart-bot/rc-alloc-trail.mjs` samples the allocation profile **on the watchdog
tick**, keeps a 20-minute window, and reports a segment's peak when it ends (plus a flush at
teardown and in the runaway bail). Four renderers: `resident`, `renewal`, `auto-login`,
`warmup`, each under its own context.

### 2a. THE TRAIL WAS ARMED AT 13:26:42 PT ON 2026-08-25 — READ EVERYTHING AGAINST THAT

**The box moved to `64f9f92` at 13:26:42 PT** (`bot_update_requests.applied_at`, confirmed by
`bot-ask git-status` → `HEAD 64f9f92 on master`). Everything before that instant was the OLD
return-path instrument.

**THE TRAP, AND IT IS ALREADY ON THE BOARD.** The series carries a ramp at **13:0x PT — peak
9,113 MB, 99% COMMIT** — and `native_alloc_readings` has no `trail-*` row for it. The table
below says that combination means *"the trigger is wrong."* **Here it does not.** That ramp ran
about twenty minutes BEFORE the update; the trail was not on the box yet. What it did leave is a
`renewal` **return-path** reading at 13:10:26 PT (−468 MB, renderer 13 MB) — the old instrument,
doing the old thing, one last time.

**So the trail has been live and has not yet seen a ramp.** As of 15:00:51 PT the box is flat at
273 MB. There is nothing to read, and that is the expected state, not a fault.

| ramp (PT) | peak `rc` | free | COMMIT | instrument |
|---|---|---|---|---|
| 08-24 19:37 | 7,250 MB | 2,217 | 95% | return-path (missed it) |
| 08-25 02:30 | 8,312 MB | 2,473 | 99% | return-path (missed it) |
| 08-25 07:31 | 7,471 MB | 2,144 | 99% | return-path (missed it) |
| 08-25 13:0x | **9,113 MB** | 4,690 | **99%** | return-path — **20 min before the trail landed** |
| next | — | — | — | **the trail. This is the reading.** |

**CADENCE, STATED SO IT CAN BE FALSIFIED:** those four are ~7h, ~5h, ~5.5h apart, so the next is
due roughly **18:00–19:00 PT on 08-25**. That is a prediction from four points, not a law — the
08-22 handover made a prediction on comparable reasoning and was falsified the next morning.
**Check `chromium_memory_samples` for the ramp FIRST, then look for its trail row.** A trail row
with no ramp beside it means something different from a ramp with no trail row.

**AND `applied_note` DOES NOT DESCRIBE THE UPDATE THAT LANDED.** The row reads
`SKIP - outside the quiet window (15:00 PT…)` plus a libuv `UV_HANDLE_CLOSING` assertion — that
is a LATER scheduled run writing its own verdict beside the new sha, the documented
`appliedNote`/`appliedSha` trap, and the assertion is the known-harmless one (`auto-update.ps1`
reads the verdict LINE, never the exit code). **`applied_sha` and `git-status` both say
`64f9f92`. The update landed.**

### What to look for, and what each answer means

| reading | what it says |
|---|---|
| `trail-resident` carries the gigabytes | **The allocation is on the resident page.** PR #142's throwaway-tab cure is aimed at the wrong renderer, which explains why ramps continued after it shipped. The cure is a different change. |
| `trail-renewal` / `trail-warmup` carries them | The cure is aimed correctly and something else keeps the memory. Track B becomes the question. |
| a ramp in `chromium_memory_samples`, nothing in `native_alloc_readings` | **Still a reading.** The trigger is wrong, and the next move is the trigger, not the sampler. |
| `net::` frames or a SYSTEM dll (`ws2_32`, `winhttp`, `mswsock`) | the buffering candidate, asserted three times and never shown, finally confirmed. |

**The renderer share is NOT the whole ramp.** `Memory.startSampling` is absent on the
browser-process target — verified — and on 08-24 the browser process held 779 MB of 9,338. So
~90% is the ceiling of what any of this can attribute, and the rendered line says so.

### DO NOT queue a test hold to force a ramp

Three arrived free of charge in thirty hours and the old instrument missed all three. A staged
one locks a real campsite and would be missed identically if the trigger is wrong. **Wait.**

---

## 3. What was corrected on 2026-08-25, so it is not re-derived

### 2a. THE PROFILE-RESET STORY IS WRONG ABOUT RC — and it was written in as fact first

The obvious explanation for the renewal tab reporting **17 MB** against an **8,052 MB** family
is that CDP's all-time profile is reset by the navigation. It IS reset — by a navigation that
swaps the **renderer** — and RC's does not. Measured:

```
a.probe2     -> b.probe2        (different SITE)   192 ->   1 MB   RENDERER SWAPPED
www.rc.probe -> signin.rc.probe (SUBDOMAIN)        216 -> 217 MB   same renderer
```

**Chromium isolates by SITE — scheme + eTLD+1 — not by origin.** `www.reservecalifornia.com` ->
`signin.reservecalifornia.com` is a subdomain hop and keeps its renderer.

It was asserted in three files for about an hour, on the strength of a first experiment using
`a.test`/`b.test` — two genuinely different sites, and not the navigation this product makes.
**Only `alloc-trail-probe.mjs` refusing a verdict caught it.** Reproduce it in one command:
`node scripts/auto-cart-bot/alloc-trail-probe.mjs` prints that table every run.

### 2b. The all-time total is NOT strictly monotonic

A real run stepped **955.4 -> 955.2 MB** between consecutive reads. Under a strict "any decrease
is a renderer swap" rule that cut a 1,271 MB ramp into 954 and 319 and reported the larger half
as the whole event. It splits on a **collapse** (under half) now. Do not "tidy" that back to a
strict comparison — an instrument that halves the number it exists to report is worse than none.

### 2c. The instrument was nearly part of the disease

`getAllTimeSamplingProfile`'s response grows **linearly with bytes ever allocated** (~1.7 KB per
MB, measured). The resident page is read every 20s for the life of the browser, so at 9 GB each
read would ask a dying renderer to serialize ~16 MB, repeatedly, at the peak. The long-lived
target samples at **8 MB** resolution (`LONG_LIVED_INTERVAL`); the trip tabs keep 1 MB. Pinned,
because reverting it looks like a tidy-up.

---

## 4. State

*Refreshed **2026-09-04 09:15 PT**, against production. This table has twice been left
describing a state the repo had left behind, and one of those rows was **"Holds: none live"
while a real hold was queued** — which reads as permission to run `npm test` and restart the
box. **Re-read it rather than trusting it, and re-date it when you do — and `git fetch` first,
because on 09-04 a whole incident came out of trusting a day-old checkout.***

| | |
|---|---|
| Master | **`6b5c10a`** plus **#266**. 09-04 landed a lot: #262 `SHARD_COUNT` 2 -> 3, #263 re-offer holds per release (migration 074) + holds in the watch card + the dead-man's switch removed, #264 the RC release-window measurement, #265 docs, #266 the `offerHold` gate hoist. |
| Mini-PC | **`d341139`** against web `6b5c10a`; `bot_version` warns with *"No bot-side code in the gap"*, the documented not-worth-acting-on case. Confirm with `bot-ask git-status`, **never** `autocart.bot_version` — it is COALESCEd and can sit stale beside a live heartbeat. |
| Fly worker | both shards beating, `poller.shards` ok. `SHARD_COUNT` is **3** now. Redeploys on every `worker/**` merge. |
| Open PRs | **#258** (side lane: acquisition instrumentation, holds migrations 072-073). |
| Open issues | **none** |
| Migrations | highest is **074**, applied and read back 05:00 UTC 09-04 — read the correction in its own header: it was applied, reverted by the other lane, then re-applied. **Main's block is `075-079`; the side lane's is `080+`.** |
| Holds | **NONE live** (checked 08:25 PT). `#L034` carted T+1.4s at the 08:00 release and was released to the owner at 08:09. No fixture rows in `rc_hold_requests`. |
| RC session | Healthy. The rehearsal was **skipped** last night (`rc_login` warns at 12h) — a stand-down, not a failure. `maybeAutoLogin` covers a release at T-30. |
| Memory | **Track A still has zero `trail-*` readings.** The discriminator has never run; §2 is how to read the next ramp. |
| CI | **Two runs on 09-04 failed on fixture litter, not on the diff.** `rc-holds.test.mts` -> *"once the window has closed, a cart failure IS final"*, `already-failed` where `failed` was expected. Both times the same tree passed locally with no CI in flight. A force-push produced two runs and GitHub cancelled the first mid-suite; a killed run leaves its `__trh` rows, and #203's 10-minute age gate deliberately spares them. **Wait ten minutes, then re-run — do not lower that gate.** |

**Two check-ins are scheduled and enabled — do not create duplicates.**
`trig_01NdJC1SvSDwxZZroAooVKnU` fires **07:40 PT** into a fresh session;
`trig_01CzPKmDUz5MC3tbYFGMTS4a` fires **08:15 PT** with the outcome readout.

---

## 5. Serial rules — and the one I broke

From `docs/LANES.md`: no `npm test`, no second test hold, and nothing that restarts the box,
while a hold is live.

**TWO MORE COLLISIONS ON 08-28, BOTH MINE, AND THE SECOND IS A NEW RULE.** (a) A local
`npm run verify` started at 09:38:05 while CI ran 09:37:21-09:40:41 — *while waiting for that
exact run* — and both delete `rc-client-reports`' fixed `SENTINEL`. (b) Later the same morning
I **pushed again 7.5 minutes after the previous push**, and cancel-on-push killed a run
mid-suite; a killed run executes no cleanup, and its rows are seconds old, which is exactly the
age #203's 10-minute gate spares. **A second push IS a second test run.** Do not lower that
interval — it is what stops a starting run wiping a running one.

**AND DO NOT RUN `npm run verify` LOCALLY WHILE CI IS RUNNING.** I did, on 08-25, and CI failed
one test — `rc-holds.test.mts`, *"a carted hold records how to RELEASE it"*, `Cannot read
properties of null`. That suite sweeps `unit_id LIKE '__t%'`, i.e. **every** suite's fixtures,
so my local run deleted CI's live row. It is issue **#76** and it is entirely self-inflicted:
merging or pushing IS starting a test run. A re-run was legitimate here only because the diff
cannot touch that file, the suite passed alone, and the mechanism is named — any one of those
missing and it is a regression being waved through.

---

## 6. Track B — designed, NOT started, needs its own go-ahead

Replay the Okta round trip over `ctx.request` following redirects and exchange the code
ourselves: no page load, no renderer, no gigabytes. Three pieces already exist
(`force-login-prompt.mjs` intercepts `/authorize`, `rc-token.mjs:108` reads `code_verifier`,
okta-auth-js's `okta-transaction-storage` is known to the code).

**Still deliberately unstarted.** It is surgery on the one path between a queued hold and a
missed cart, and the renderer-only sampler cannot see the browser-process share. **§1's reading
is what makes it decidable** — if the growth is on the resident page, `ctx.request` may be the
wrong lever entirely. Building it blind is how a repair gets credited to the wrong mechanism,
which has happened three times.

---

## 7. Recorded, not fixed — do not drive-by these

- **NEITHER CONTAINMENT ARM CAN FIRE DURING A RAMP, and 08-25 established why.** The size arm
  (`RC_MAX_FAMILY_MB = 1500`) sits in the LOOP BODY, and the ramp happens inside `renewSession`
  which the loop is awaiting — so for the ten minutes that matter, control is past the check.
  The RAM arm is exactly one condition short: the stall half is amply true, the **RAM** half
  never trips (troughs 2,144-3,328 MB against a 2,000 floor, six ramps, closest 144 MB). The
  size arm fires on the NEXT iteration once the renewal returns, which is the **leading
  candidate** for the browser replacement that ends every ramp.
  **Still a QUESTION, not a patch.** Moving the size scan into the timer would spawn PowerShell
  there, and spawning is what fails first at 99% COMMIT; lowering the RAM floor is what killed a
  working repair on 08-19 (`keepwarm-recycle.test.mts` bounds it 1500-3000 with the reasoning).
  **The trail's reading is what should decide it** — and note the trail already reports from
  exactly the moment the size arm breaks the loop, because the teardown flush takes the OPEN
  segment.
- ~~**A CI run can turn `autocart.rc_session` RED.**~~ **FIXED 2026-08-27 in PR #202** — the
  five inline counts now go through `holdsAhead`/`holdsDueWithin`, which carry `REAL_UNIT` in
  their own bodies. One definition, as the note asked for. **And the fix's own test shipped a
  `requested` fixture on unit `999000111` — a numeric id in the one status `dueHolds` serves,
  i.e. the 2026-08-15 incident recreated inside the fix for its sibling, with
  `hold-fixture-safety.test.mts` green on it.** It survived on timing (the feed's lead is 90s;
  the row sat 300s out). That guard is widened in three places — the file selector missed six
  suites that INSERT with raw SQL, the line filter missed a bare `const` declaration, and the
  helper names were a fixed list rather than derived per file. CLAUDE.md carries both entries.
- ~~**Three test suites sweep each other's fixtures**~~ **FIXED 2026-08-27 in PR #203, closing
  #76.** Each suite has its own prefix now (`__trh`, `__teh`, `__tfi`, `__tcap` beside
  `__tln`/`__tdc`) AND an age gate on `offered_at`; both halves are needed, because a prefix
  stops one suite wiping another and does nothing about two runs of the SAME suite.
  `hold-line` and `hold-decline` already had prefixes and no gate — the new guard found them.
  **§4 above is history now, not a live hazard**: treat an unrelated red as a regression.
- **A watch created before migration 070 silently covers less of a park than its name
  suggests.** `9f9f87df` (Morro Bay, 09-04 → 09-07) has NO `watch_campgrounds` rows, so it
  watches `rc-582` alone while the park watches beside it cover `rc-582` + `rc-583`. That is
  why it got no offer for `#92` while the 4-6 watch did. Nothing on the watches screen tells
  the two apart. The honest remedies are a backfill (which widens what people are alerted
  about without asking them) or saying "Lower Section only" on the card — both decisions.
- **The rec.gov `carted` SMS body overflows one segment for 19 campgrounds.**
- **A token rebroadcast can clear an `expired` verdict** in the claim gate.
- **The live manage token `EQO2oXcQ`** — unrotated, in git history. One DELETE. **Owner's call.**

---

## 8. Traps that have actually fired

- **`NODE_USE_ENV_PROXY=1`, and never read an exit code through a pipe.** See §0b — both cost
  real time on 08-25 and both produced confident wrong readings.
- **`GITHUB_TOKEN` is a 14-character placeholder and `/user` returns 200.** A false positive;
  anything repo-scoped 403s. Use the MCP tools.
- **Verify a push against the remote**, not local HEAD:
  `git fetch origin <branch> && git rev-parse origin/<branch>`.
- **A branch cut from another feature branch conflicts after that branch is SQUASH-merged.**
  Master carries one commit where the branch carries two, so a plain rebase replays both and
  conflicts. `git rebase --onto origin/master <old-tip>` replays only your own work.
- **Read the readout's `site` column.** `TEST · ` in `unit_name` is the one unambiguous fixture
  marker.
- **A guard can pass vacuously, and a mutation can fail to apply.** Grep for the mutation as
  well as running the suite. Two of this session's guards were wrong at baseline: one anchored
  on a comment line (and `code` strips comments), and one gave a ramp two samples so pruning
  left one — proving the segment became unreportable rather than that the key was stable.
- **RC's `Lock` / `release_at` is a ZONE-LESS PACIFIC WALL CLOCK.** Never `new Date()` it for
  arithmetic — the server is UTC and that is seven hours early. Use
  `pacificWallClockToUtcMs` (`worker/held-cadence.ts`) in JS, `AT TIME ZONE
  'America/Los_Angeles'` in SQL. This shut the coming-soon offer window at midnight Pacific
  for three weeks (#196, 2026-08-26). **A display convention and a time-arithmetic
  convention are not the same thing** — the comment defending the bug cited the formatter,
  which only displays it.
- **THE POLLER'S OWN LOG HAD THE ANSWER FOR TWO AND A HALF HOURS.** `flyctl logs -a
  campsite-finder-worker --no-tail` printed `too soon to be news, staying quiet` on every
  pass. Read the instrument before reasoning about the code; it cost twenty minutes to fix
  and one command to find.
- **`sqlit` interpolates, it does not bind**, and throws on a plain object. Stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
