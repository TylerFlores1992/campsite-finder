# Next session — start here

*Rewritten 2026-08-25 evening; state refreshed **2026-08-30 13:30 PT**.*

> ### READ THIS FIRST — 2026-08-30 SUPERSEDES ITEM 0 BELOW
>
> **The 08-29 release is long past and there are ZERO live holds and zero offers.** Item 0 and
> the older State rows describe 08-28. They are kept for the reasoning, not the state.
>
> **THE SERIAL RULES ARE OFF.** `npm test`, a test hold, and a box update are all fine — the
> 6h release gate is open because nothing is queued. The 08-28 table said the opposite and
> would have stopped you for no reason.
>
> **Master and the mini-PC are both `65f5583`.** Six fixes landed 08-30 (#230, #234, #235) from
> four defects, **two of them caused by the earlier fixes of the same day**. Full write-up:
> CLAUDE.md → "A CAMPSITE WAS LOST TO A TWO-SECOND MARGIN".
>
> **The open question is the Android hand-off, and it is NOT the bot.** The bot carts and
> releases correctly. The user's own session re-carts, RC returns `entries: 1` — and RC's UI
> still says "Please login", with no name in the corner. `keySource: "localStorage"` **kills
> the cart-key theory** that the 08-29 entry was written around. No mechanism is named; three
> were guessed on 08-30 and each cost a test. The next instrument is a storage census in the
> app (key NAMES only), which does not exist. See CLAUDE.md → "`keySource` ANSWERED IT".
>
> **`ListAgents` cannot see the side lane** — it lists only sessions on THIS machine. An empty
> list is not exclusive use of the production database; a side-lane merge cost a CI run on
> 08-30. Announce before merging, as `docs/LANES.md` requires.

> ## NOTHING IS ASSIGNED. A REAL HOLD IS QUEUED FOR THE MORNING, AND THE READING IS STILL WAITING.
>
> **0. THE 08-29 08:00 PT RELEASE IS LIVE AND THE OWNER WANTS THE SITE.** Unit `43189`
> (`#94`, Morro Bay SP — Upper Section, arrival 2026-09-04), tapped 2026-08-28 11:46 PT by
> `tylerflores1992@gmail.com`. **Nothing further is needed from anyone.** The box needs no
> update (#214 was worker- and web-side only) and `maybeAutoLogin` restores the session at
> T−30, i.e. 07:30 PT.
>
> The line, as the production poller wrote it after #214 deployed:
>
> ```
> rank 1  tylerflores1992@gmail.com      offered
> rank 2  tylerflores1992@gmail.com      requested   <- the tapped row, and what dueHolds serves
> rank 3  melinda.flores0501@yahoo.com   offered
> rank 4  iamtylerflores12345@yahoo.com  offered
> ```
>
> **If a rival taps overnight, expect ONE cart and the other rows left `requested` and
> uncarted. That is the line working, not a dead runner** — read `last_attempt_note` first;
> it now carries "another watcher is ahead of you". That would also be **#201's
> one-live-hold-per-unit rule's first live exercise**, which is still untested in anger.
>
> **1. THE OWNER RANKS FIRST BY DESIGN NOW (migration 069, #214).** `users.line_priority` is
> read ahead of the rotation ticket and watch age; `tylerflores1992@gmail.com` is the only
> flagged account. **This is a deliberate thumb on the scale, not a bug** — it was asked for
> and reaffirmed after the cost was shown. `melinda.flores0501` (a paying subscriber) is
> family, which settled it; `suziegrieve03` and `cam1234123` are NOT family and also lose to
> it, which was raised and accepted. Full entry in `CLAUDE.md`; the reasoning is in migration
> 069's own header so it reads as a decision rather than something to "fix".
>
> **Do not "make priority consistent" with `line_seq` by freezing it onto the hold** — that
> would pin a revoked override onto every hold in flight, and the asymmetry is documented at
> the read site.
>
> **THE MAIN LANE'S MIGRATION BLOCK IS FULL.** 069 took the last of 060-069 and the side lane
> holds 070. **Claim a new block out loud before taking a number** — `071` is what both lanes
> would reach for, and a duplicate is a collision git merges cleanly and Postgres does not.
>
> **2. THE RAMP (§2) — THE NEXT ONE ANSWERS A QUESTION NOW.** The trail has produced no
> reading across **four** ramps (08-25 20:22, 08-26 21:24 at 9,112 MB / 100% COMMIT, 08-28
> 02:01 at 8,981 MB, 08-28 08:13→08:23 at **8,987 MB**). The "segment never ends" theory is **ruled
> out** — on 08-28 02:01 `max_pid` went 14596 → 7812 at 02:15, so the teardown ran and
> `final: true` does include the open segment. **#210 shipped the discriminator and the box
> has it (`5e399b3`, applied 08-28 08:44).** After the next ramp, read the teardown line in
> `logs\rc-keepwarm.log`:
>
> - `EMPTY — that renderer answered no CDP call at all` → the trail needs a different
>   **transport**, not a different trigger.
> - segments present, growth under 400 MB → **the sampling profiler cannot see these bytes**,
>   Track A is measuring a quantity that excludes the leak, and Track B stops being optional.
> - a `trail-*` row in `native_alloc_readings` → the bar was crossed and it finally worked.
>
> **STILL NOTHING SINCE THE BOX UPDATED at 08:44 PT — re-checked 2026-08-28 12:00 PT**:
> 110 samples since the update, peak **469 MB**, newest 12:01. The three ramps inside the
> last 40h (08-26 21:24 at 9,112 MB, 08-28 02:01 at 8,981 MB, 08-28 08:13 at 8,987 MB) are
> all the ALREADY-RECORDED ones and all predate the update; the 08:13 one ended ~08:25,
> nineteen minutes before it. **Quote the "since 08:23" qualifier if you quote the count** —
> without it "zero over 1,200 MB in 26h" is false, because that window contains two 9 GB
> ramps. The
> diagnostic has never run, so an empty `native_alloc_readings` is expected and is NOT a fifth
> miss. Ramp cadence is **11 onsets in 6 days, gaps 5-28h** (the last two were 02:01 and 08:13,
> ~6h apart), so expect an answer within a day.
> **Do NOT try to stage one**; §2b has the measurement that retires the obvious plan.
>
> **3. WHAT IS OPEN RIGHT NOW: NOTHING.** Master is **`ba0753d`**, the mini-PC is on
> **`5e399b3`**, **every GitHub issue is closed and no PR is open.** One tapped hold and three
> untapped offers for 08-29 08:00 PT (§0). Health is 17/19 at 15:50 and **both warns are the
> documented benign cases**: `autocart.rc_session` (no token, `okta=ALIVE` — the token lives
> ~1h and is legitimately dead between releases, and a repair would be the cheap
> cookie-answered one), and `autocart.bot_version` (box `5e399b3` vs web `ba0753d`, **"No
> bot-side code in the gap"** — the case this file records as not worth acting on).
>
> **`detect:ridb` FLIPS TO A THIRD WARN INTERMITTENTLY** — *"recgov: backing off — our
> throttle breaker is open"*. It read `ok` and `warn` in two samples sixty seconds apart on
> 08-28. That is the breaker doing its job, not a new fault; do not chase it unless it sticks.
>
> **DO NOT RUN `npm run verify` WHILE CI IS RUNNING — INCLUDING WHILE WAITING FOR IT.** Both
> hit the production DB. On 08-28 a docs-only PR failed on `rc-client-reports.test.mts`
> because a local verify started at 09:38:05 overlapped a CI run at 09:37:21-09:40:41, and
> both delete the same fixed `SENTINEL`. **#203 does not cover this** — it fixed `LIKE` prefix
> sweeps in the hold suites; a suite with one fixed sentinel deleted by exact id is still
> mutually destructive between two runs of itself, as are `sync-claim` and `ridb-photos`.
> Recorded, not fixed. A re-run is the right response when the diff cannot touch the code, the
> suite passes alone, and the overlap is named.
>
> **AND DO NOT PUSH AGAIN WHILE YOUR OWN CI IS STILL RUNNING — A SECOND PUSH IS A SECOND RUN.**
> The same PR failed a second time with no local verify anywhere near it: a push 7.5 minutes
> after the previous one triggered cancel-on-push, which killed a run **mid-suite**. A killed
> run runs no cleanup, and its rows are seconds old — which is exactly the age #203's
> `offered_at < NOW() - interval '10 minutes'` gate deliberately spares, so the next run
> inherits them. **Do not lower that interval**; it is what stops a starting run wiping a
> running one (issue #76). Re-running locally on the same sha with no CI in flight gave
> 1381/1381, which is how litter was told from a regression.
>
> **`worker/**` IS A WORKER-DEPLOY TRIGGER PATH.** "Only test files" is NOT an exemption — that
> was asserted twice on 08-27 and was wrong both times. Read `paths:` in `worker-deploy.yml`
> before claiming a merge is deploy-free.
>
> **4. MERGING #180 MEANS THE NEXT ANDROID BUILD FAILS, ON PURPOSE.** Already merged.
> `codemagic.yaml` asserts `com.android.vending.BILLING` reaches the merged manifest, and
> `@revenuecat/purchases-capacitor` is not a dependency yet — so it exits 1 until RevenueCat
> lands. Play's Subscriptions page has no create button without that permission, so the gate is
> the point; it does block an Android hotfix meanwhile.
>
> **5. THE REAL WORK LEFT, in the order it is worth doing.**
> - **Track B (§6)** — replay the Okta trip over `ctx.request`, no renderer. Designed,
>   deliberately not started, **needs the owner's explicit go-ahead.** It is surgery on the
>   one path between a queued hold and a missed cart.
> - **The trail's TRIGGER** (§2). Two ramps missed. The next move is the trigger, not the
>   sampler — and the owner has said they do not want more aftermath instrumentation, so
>   ask before building.
> - ~~**`rankHoldLine`'s note never reaches a row tapped after ranking.**~~ **FIXED
>   2026-08-28.** The cause was not in `hold-line.ts` at all: the primary held unit's
>   `rankHoldLine` call sat inside the block gated by `claimHoldNotification`, so the line
>   was ranked exactly ONCE per offer and no later tap was ever seen. It re-ranks above the
>   gate now, like the extras loop always has.
> - **`reclaimLapsedHolds` marks a hold `expired` while KEEPING `cart_key`**, so it never
>   releases on RC. The premise that blocked it — "RC's cart lapse is unmeasured" — is
>   **retired**: on 08-25 `expireStaleHolds(45)` released an unclaimed hold at exactly 45
>   minutes, HTTP 200, with the entry key. The moment a site returns to the market is one we
>   choose and already know.
> - **`cart read back` is unproven on ANDROID.** Needs a human with the app on a real hold.
> - **A watch created before migration 070 covers less of a park than its name suggests** —
>   see the entry in CLAUDE.md. Backfill or say so on the card; both are decisions.

*Delete this file once the trail has captured a real ramp AND the App Store version has a
decision. It is a handover, not a permanent doc, and a stale one reads like current state.*

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

## 1. THE DOUBLE-CART BUG — ~~the top item, and it is not built~~ **FIXED IN #201**

> **THIS HEADING SAID "it is not built" FOR TWO DAYS AFTER THE FIX LANDED.** Struck
> rather than deleted: a "NOT built" on the top item is exactly the sentence a later
> reader quotes as current state, which is the cost this handover exists to prevent.
> Everything below is the ORIGINAL write-up, kept because its timestamps and its
> account of why the old test could not catch it are still the record. **There is no
> work in it.** `dueHolds` carries the temporal `NOT EXISTS` and `hold-line.test.mts`
> calls it twice with a status change in between.

The 08-26 contest ran and **the line failed at the one thing it exists for.** Both rivals'
holds carted, from the box's own log:

```
15:00:02  ✓ held #123 (2026-09-04) — entry ae877ae5-9ee1-479b-bec9-4d9f610ae718
15:00:13  0 to hand over, 1 to cart, 0 to release      <- the NEXT poll
15:00:17  ✓ held #123 (2026-09-04) — entry 6f0863e0-78d7-4cd2-9ec6-22ffc02f1351
```

**`DISTINCT ON (release_at, unit_id)` de-dupes within ONE query.** The runner polls every 15s,
so the moment rank 1 left `requested`, rank 2 became the top row for that unit.

**The fix:** `dueHolds` must exclude any `(release_at, unit_id)` that already has a **live**
hold (`carted` or `claiming`) — *one live hold per unit*, not *one served per call*.

**Why the existing test could not catch it:** `hold-line.test.mts` calls `dueHolds` ONCE and
asserts one row comes back. That is true and always was. **The new test must call it twice
with a status change in between.**

This is the most release-critical query in the product. Not a drive-by.

### 1a. ~~The rank-2 row carried no note~~ — FIXED 2026-08-28
`rankHoldLine` wrote "another watcher is ahead of you" only to rows already `requested`. The
runner-up was `offered` when the line was ranked and was tapped fourteen seconds later; nothing
re-ranked afterwards. **So a contest that went wrong read as two successful carts.**

**The cause was the CALL SITE, not the function.** For the primary held unit `rankHoldLine` sat
inside the block gated by `claimHoldNotification` — once per (watch, release, unit) — so the
line was ranked a single time in the life of an offer. The extras loop has always re-ranked
every cycle. It now re-ranks above the gate, and rows already carrying the note are skipped so
a per-cycle rank cannot restamp `last_attempt_at` every 15s all night.

**Measured, not assumed: the behavioural test does not catch this.** It passes against
master's `hold-line.ts`; only the structural guard (`rankHoldLine` before
`claimHoldNotification(w.id` in stripped source) fails against the real defect.

### 1b. A dead session strands a carted site — the 08-13 leak, recurring
Both carted rows sat `carted` for **78 minutes** with `released_at` NULL and
`last_attempt_note = "RC session is dead — needs a human sign-in"`. The release loop lives
inside `withRC`, so a dead session skips it; `reclaimLapsedHolds` only marks the row `expired`
at 180 min and **keeps `cart_key`, never releasing on RC.**

**`test-login` is the remote lever and it works**: queued 09:18:30 → session `ok` 09:20:24 →
both released by 09:22:29. Rationed one per 6h on the box's clock, refuses within 6h of a
release. It is the ONLY remote way to restore a dead session, because the renewal cannot when
Okta is GONE.

### 1c. THE TWO TEST HOLDS RAN — and answered half of what they were for

Queued 09:36 PT 08-26, one per account, on **different** units so the double-cart was not
re-triggered. Morro Bay Lower Section, unit 43106 (`tylerflores1992`) and 43112
(`iamtylerflores12345`), arrival 2026-12-08.

**What they proved.** Both carted within seconds, and **both released cleanly at 45 minutes**
(`released unclaimed — nobody came for it`) with the session healthy. That is
`expireStaleHolds(45)` working end to end — the contrast with §1b, where a dead session left
two rows stranded for 78 minutes, is the whole point.

**What they did NOT prove.** Neither claim link was opened in the app, so the hand-off was not
exercised. ~~**`cart read back` is still proven on iOS only; Android has never been run.**~~
**ANSWERED 2026-08-29 AND 08-30, AND THE ANSWER RETIRES THE INSTRUMENT RATHER THAN EXTENDING
IT.** Android ran it four times and reported `cart read back: 1 entry` — while the owner,
holding the phone, was shown an empty cart and a sign-in prompt. So the reading is RC's answer
to OUR question asked with OUR key, and says nothing about whether RC's own page can see the
cart. **It has never once been corroborated by a human on any platform**, iOS included: the
only visually-confirmed run (08-13) predates both the read-back and the cart navigation. See
`CLAUDE.md` → "`cart read back` NEVER PROVED THE OWNER COULD REACH THE CART".
**The live open question is the one under it:** RC returns `entries: 1` for our key while its
UI treats the session as signed out — with `keySource: "localStorage"` (so the SPA had the key)
and a live 939-char token (so there is a session). **Both leading theories are dead and no
mechanism is named.** It still needs a human with the app.

To repeat the setup: `scripts/rc-test-hold.mts --find` for real unit ids (never invent one),
then `--watch <id> --unit <n> --arrival <date> --in <min>`. Use the watch whose REPRESENTATIVE
campground contains the unit, or the hold row is labelled with the wrong facility. **A live hold
blocks `npm test`, box restarts and the update window.**

---

## OLD — the contest write-up, kept for its timestamps

The fairness line's first real test. One physical site, two users, **both tapped**:

    unit 43086 "#123", rc-583 (Morro Bay Upper Section), release 2026-08-26 08:00 PT

    tylerflores1992      watch 08-24 12:45:30   ticket 0 -> 297   RANK 1   requested 05:02:40
    iamtylerflores12345  watch 08-26 05:07:46   ticket 0          RANK 2   requested 05:51:09

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
```

**What SHOULD have happened.** `dueHolds` serves one row per (release, unit) — the lowest
`line_rank` among the `requested` ones — so the main account carts at ~T+2s and the rank-2 row
stays `requested` and **uncarted**.

**THAT IS THE LINE WORKING, AND IT LOOKS EXACTLY LIKE AN OUTAGE.** A `requested` hold sitting
past its release is otherwise the signature of a dead runner (2026-08-07). The discriminator is
`last_attempt_note` — and see the gap below, because on this particular row it may be empty.

**THE ROTATION IS THE HALF WORTH READING.** `hold_offer_seq` on the winner went 0 → 297 while
the runner-up stayed at 0, so the next contest between them inverts. Until now the "they go to
the bottom of the list" rule had only ever been asserted by a test.

**A REAL GAP, FOUND WHILE SETTING THIS UP — FIXED 2026-08-28, see §1a.** `rankHoldLine` wrote
the "another watcher is ahead of you" note only to rows already `requested`. At 05:50:55 the
runner-up's row was still `offered`; it was tapped fourteen seconds later, and nothing re-ranked
the line unless another offer for that unit arrived. **So the rank-2 row could carry no note at
all** — which is the one state the readout uses to tell a queue from an outage.

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

*Refreshed **2026-08-28 22:15 PT**, against production. This table has twice been left
describing a state the repo had left behind, and one of those rows was **"Holds: none live"
while a real hold was queued** — which reads as permission to run `npm test` and restart the
box. **Re-read it rather than trusting it, and re-date it when you do.***

| | |
|---|---|
| Master | **`65f5583`** (#235), 2026-08-30. Recent: #230 seconds-based coverage + headroom + crash handlers, #234 `persistLiveToken` + stand-off resize, #235 no destructive repair near a release + `nextHoldRelease` grace window. Side lane: #236 Play IAP paywall route. |
| Mini-PC | **`65f5583`**, applied 12:47 PT 08-30 in ~22 seconds, confirmed by `bot-ask git-status` (never `autocart.bot_version` — COALESCEd, can sit stale beside a live heartbeat). **Level with master.** |
| Fly worker | redeployed on every `worker/**` merge since #204; both shards beating. |
| Open PRs | **#238** (docs: the `keySource` correction) and this audit's PR. |
| Open issues | **none — every issue is closed** |
| Migrations | highest applied **070**. **The main lane's block 060-069 is FULL** — `069_line_priority.sql` took the last number. The next main-lane migration must **claim a new block out loud** before taking a number; two lanes both reaching for `071` is a collision git merges cleanly and Postgres does not. |
| Holds | **NONE. Zero live holds, zero offers** (checked 13:30 PT 08-30). The 08-29 release passed; four test holds were run and deleted on 08-30 and **no campsite was ever locked by them**. Two sites ARE locked in the owner's own phone cart from the hand-off tests — unreleasable by design (we never store the phone's key) and they lapse on RC's schedule, as both 08-29 sites did within a day. |
| RC session | **Healthy at 22:13 PT** — `OK for 2h12m`, token 59m, `okta=ALIVE` to 17:01Z. The rehearsal PASSED at 03:01 on both 08-28 and 08-29. `maybeAutoLogin` covers the release at T−30 (07:30 PT). |
| Memory | **No ramp since 08:23 PT 08-28 — ~14 hours quiet**, the longest stretch yet (1,011 samples in 30h, zero over 1,200 MB, newest 277 MB). Within the recorded 5-28h gap range, so it is not evidence of a cure. **Track A still has zero `trail-*` readings**; the discriminator has never run. |

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
