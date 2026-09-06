# Next session — start here

*Rewritten 2026-08-25; state refreshed **2026-09-06** (main lane). This is a
HANDOVER, not a permanent doc — `CLAUDE.md` owns every finding.*

> ## THE OWNER QUESTION IS INSTRUMENTED, IT IS ON THE BOX — WAIT FOR A RAMP (2026-09-06)
>
> **The walk said WHAT the 32 GB is; nothing on the Windows side can say WHO ASKED FOR IT** —
> a pagefile-backed anonymous section records no creator. So the next reading asks Chromium:
> `Tracing.requestMemoryDump` at `detailed` level, folded to per-process allocator roots, a
> size histogram of `shared_memory` mappings **in the walk's own buckets**, and the OWNER of
> each mapping off the dump's ownership graph. Full entry: CLAUDE.md → **"THE WALK CANNOT NAME
> AN OWNER, SO ASK CHROMIUM"**. Do not re-derive it.
>
> **BOTH BRANCHES ARE ANSWERS.** `shared_memory` ≈ 32 GB with ~16k dumps in `2-4M` ⇒ the
> sections ARE base shared memory and the owner column names the subsystem. Tens of MB, beside
> a process the walk says holds 32 GB of `commit/mapped` ⇒ they are **not**, which eliminates
> discardable, mojo and the GPU transfer path **together**. The readout prints both.
>
> **MERGED (#285, `5399000`), ON THE BOX, AND ITS FIRST READING IS IN.** The fleet came back
> 3/3 shards with a 2s heartbeat; the mini-PC took the sha at 07:56 PT (`bot-ask git-status`,
> not `autocart.bot_version`); and the first baseline landed at **07:59:33 — 332 ms, 8
> processes, `gpu/transfer_memory — 5 MB across 13`.**
>
> **THAT CLOSES THE WINDOWS HALF OF THE VALIDATION CAVEAT.** The probe could only show the
> instrument reads a real trace on Linux; this shows the dump arrives on the box, the folding
> works and **the ownership edges resolve to a named subsystem there too**. On a healthy box
> the lead is the GPU process rather than a renderer, which is the expected shape, and the
> `2-4M` bucket already holds one 2 MB mapping — so that size is ordinary in small numbers and
> it is the COUNT that will matter.
>
> **SO THE ONLY STEP LEFT IS TO WAIT FOR A RAMP.**
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`, MEMORY DUMPS section; `--all`
> for the per-process roots, histogram and owners. **Do NOT queue a test hold to force one** —
> three arrived free in thirty hours once and all three were missed, and a staged one locks a
> real campsite.
>
> **AND THE READOUT COUNTED ZERO BAILS UNTIL 2026-09-06 — fixed, and worth knowing because the
> output changes.** The arms name themselves (`bail:ramp`) and the classifier tested `=== 'bail'`,
> so every bail fell into `other`: the summary said `0 at a bail` over two real ones and printed
> them LAST, below the teardowns this file calls the baseline. Read literally, "read the `bail`
> rows first" against a summary saying zero says **the arm never fired**. It now reads `2 at a
> bail` and renders them first. Full entry: CLAUDE.md → **"AND NAMING THE ARM MADE THE READOUT
> COUNT ZERO BAILS"**. Nothing about the box or the data changed — only what the readout said
> about it.
>
> **THE INSTRUMENT IS ARMED AND ITS CADENCE IS CONFIRMED (checked 2026-09-06 ~11:50 PT).** The
> box updated at 14:56 UTC, `max_pid` moved to the current browser in the same minute, and the
> single `baseline` dump landed at 14:59:33 — **three minutes into the one browser life there
> has been since.** So one baseline and no ramp row is the instrument working, not a miss.
>
> **HOW TO READ IT.** `discardable/segment` at ~32 GB is the answer this investigation has been
> reaching for. `(no ownership edge)` at ~32 GB is a third finding and a new question — base
> shared memory holds them and nothing in Chromium claims them. A small total is the second
> branch above. **Check the lead pid against the ramp-scan's walk for the same event**: a dump
> of a healthy renderer says nothing, and the pid is the join key. A `baseline` row from the
> same browser is the control; 32 GB is a difference.
>
> **AND EXPECT A BASELINE BEFORE ANY RAMP.** One fires ~3 minutes into every browser life, so
> the table filling with `baseline` rows and no `ramp` row is the instrument working on a quiet
> box, not a miss. An empty table after a ramp IS a miss — read the box log for the named
> refusal (`memory dump (ramp) did not run: …`).
>
> ### WHAT THE BOX WAS DOING WHILE THIS WAS BUILT
>
> - **NO RAMP FOR ~11 HOURS** (09-05 20:29 PT → 09-06 07:30, hourly peaks 347-503 MB, commit
>   back to ~7.4/17 GB). The observed spread is 5-28 h, so that is neither a cure nor a fault
>   — and every "not reproduced this session" reading in this file was a window that missed
>   one. **There is exactly ONE walk**, the 09-05 20:29 one; a second is free corroboration
>   whenever the next ramp lands.
> - **The box is on `6fdd1de`, not `2ecaca8`** — newer than the last handover said, and both
>   contain the walk. Read `git-status`, not a doc.
> - **Health 16/19, three warns, all documented-benign**: `rc_session` (dead between releases,
>   the token lives ~1h), `bot_version` (box vs web, *"No bot-side code in the gap"*),
>   `rc_login` (a stand-down inside its once-per-20h gate, not a failure).
> - **`bot_events` fixture rows** were inserted under source `__mdfixture` to render the new
>   readout section and **deleted immediately** (4 → 0, verified). Nothing else reads that
>   table.

> ## THE WALK ANSWERED — 16,387 MAPPED SECTIONS OF 2 MB (read 2026-09-06)
>
> **The committed-region walk fired on its first ramp and named the class of the 32 GB.** The
> assignment that stood here is DONE; what follows is the reading and what it leaves open.
>
> ```
> NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts
> ```
>
> ```
> TARGET  pid=16004 renderer privateMB=4587  regions=81143  capped=False
>   committed 37680 MB across 49056 region(s) — image 310 · mapped 32852 · private 4518
>   2-4M      32779 MB across 16387 region(s)   <- 87% of the committed bytes
>   handles=19002   pagedPoolKB=66586
> CONTROL pid=8712  renderer privateMB=16    regions=898
>   committed   403 MB — image 310 · mapped 84 · private 9    handles=213
> EXCESS 37277 MB      OS commit step in the same scan ~40 GB
> PAGEFILE allocatedMB=33992 currentMB=0 peakMB=0
> ```
>
> **WHAT IS NOW SETTLED.**
> - **It is `commit/mapped`** — 16,549 mapped regions / 32,852 MB against the control's 74 / 84.
>   Pagefile-backed shared-memory SECTIONS, charged and **never written** (`currentMB=0`), which
>   is why private bytes, free RAM, the JS heap and the CDP sampling profiler were all
>   structurally blind. Five instruments, one reason.
> - **A SWARM, not one mapping.** That fork is closed. 32,779 MB / 16,387 ≈ **2.0 MB each**, and
>   the `~16,700 excess handles × 2 MB` figure carried for two days as "arithmetic, not a
>   measurement" is now a measurement — handles 19,002 against 213, two independent counts
>   agreeing.
> - **The private half is the smaller half.** `commit/private` 4,518 MB is the ~450 MB/min of
>   pages being touched — all the memory series ever saw. The 32.8 GB arrives in one step at the
>   onset and shows up only as a commit jump.
>
> **WHAT IS OPEN, AND IT IS NOW THE WHOLE QUESTION: what creates ~16.4k live 2 MB sections and
> never releases them.** Untested candidates — Chromium discardable shared memory (allocates in
> segments, exactly this shape), shared-image/GPU transfer buffers, mojo data pipes. RC's home
> page renders a WebGL ArcGIS map and that candidate is unchanged, neither strengthened nor
> ruled out. **Three mechanisms have been guessed on this leak and each cost a session — do not
> write one in.**
>
> **A SECOND WALK IS FREE CORROBORATION.** Ramps arrive ~5 hours apart in the day and about
> twelve overnight; nothing needs building and nothing needs staging. **Do NOT queue a test hold
> to force one** — three arrived free in thirty hours once and all three were missed, and a
> staged one locks a real campsite.
>
> **AN EMPTY REGION LIST IS A REFUSAL, NEVER AN ANSWER.** A 32-bit host, a failed `Add-Type`, a
> refused `OpenProcess` and a caught throw each print themselves by name, and the readout
> distinguishes *this scan predates the walk* from *the walk refused*. **Read the reason.**
>
> **ONE READING CAVEAT.** The CONTROL prints its own verdict line (*"70% … 3 region(s): ONE
> mapping"*) — that is the 60% share gate describing an ordinary renderer's normal reservations,
> not a finding about the control. **The EXCESS line carries the comparison.**
>
> **THE RDR REQUEST LOOP IS NOT THIS LEAK'S CAUSE — now confirmed from a third direction.** This
> ramp's counter was **flat** (`0 in 120s / 109 lifetime`, browser 125m old) and carried the
> identical 32,779 MB, while the 12:14 PT ramp ran **18,392 requests** on
> `rdapi.reservecalifornia.com/api/webaccessfacility/futurebookingstartsendsdates` and carried
> the same signature. Same mapping, opposite traffic. The loop is still real and still worth
> fixing on its own merits — it is our residential IP, which has eaten a 12-hour block once —
> but it is a **separate problem with a separate fix.**
>
> **THE RAMP ARM ENDED IT AGAIN**: `bail:ramp`, peak **4,915 MB** against 8-9 GB before the arm
> existed, and the twelve-minute wedge did not fire.
>
> **STILL FORBIDDEN, each for a recorded reason:** do not build **Track B** (it replaces the
> renewal's Okta trip, measured flat at `-4 MB over 640s`, and is now weakened three ways); do
> not **park the resident page** (refused by `checkAndReport`'s localStorage rule — it would
> silence `autocart.rc_session` and the phone alarm permanently); do not lower **`LOW_RAM_MB`**
> (that change killed a working repair on 08-19, and untouched commit never moves free RAM,
> which is why the RAM arm has sat out sixteen consecutive ramps).
>
> ### STATE AT 2026-09-06, 18:00 UTC (end of session)
>
> | | |
> |---|---|
> | master | `2233420` |
> | mini-PC | `5399000` — **the gap to master is docs plus one web-side file, so no box update is needed** (read the two commits; `autocart.bot_version` COALESCEs and can show a stale sha beside a live heartbeat) |
> | open PRs | **none** once this handover merges |
> | fleet | **16 of 19** checks ok, three warns, all documented-benign |
> | holds | none queued, so the 6h update gate is open |
> | migrations | highest **076**; main's block is **077-079**, side's is **080+** |
>
> - **#281 (`2ecaca8`) the walk · #282 (`aebaf13`) the trigger id · #283 (`6fdd1de`) handover ·
>   #285 (`5399000`) the memory dump · #286 (`a93829e`) it fired on the box · #287 (`2233420`)
>   the RC-load floor.** Only #285 is bot-side.
> - **The three warns:** `rc_session` (RC rejects the token — the ordinary between-releases
>   state, the token lives ~1h and `maybeAutoLogin` restores it at T−30), `bot_version` (box vs
>   web, *"No bot-side code in the gap"*), `rc_login` (a stand-down inside its once-per-20h
>   gate). **A stand-down is not a failure**; do not chase any of the three, and in particular
>   **do not act on `rc_session`'s printed remedy** — `rc-login.bat` force-kills the Chromium
>   the token lives in.
>
> ### THE LEAK IS WAITING ON A RAMP — one command, nothing to build
>
> **No ramp since 09-05 20:29 PT (~14 hours), flat at ~330 MB, commit 41-42%.** The observed
> spread is **5-28 hours**, so that is neither a cure nor a fault. The memory dump is on the box
> and has **one `baseline` row (07:59:33 PT) and no `ramp` row** — the expected state on a quiet
> box, not a miss.
>
> ```
> NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts     # MEMORY DUMPS; --all for owners
> ```
>
> **Join on the pid**: check the dump's lead pid against the ramp-scan's walk TARGET for the same
> event. A dump of a healthy renderer says nothing, and on a quiet box the lead is the GPU
> process rather than a renderer.
>
> ### THE RELEASE-WINDOW TRIGGER ID CHANGED — read `list_triggers`, never a doc
>
> `trig_012K7iCrj1J9KspyqGucZSHC` is **dead**: it fired into a fresh session with **no
> repository attached**, so it could not run the script at all. The live one is
> **`trig_01MDTcr2WFDqX6dCsi7gVDPG`** (`54 14 * * *`, 07:54 PT, self-disabling on 09-12).
> `update_trigger` cannot change `persistent_session_id`, so delete-and-recreate was the only
> path — the second time in two weeks an id written into these files went stale within days.
>
> ~~**So `rc_release_readings` holding ZERO rows on 09-05 is the EXPECTED state.** The first
> recorded firing is **09-06 07:56 PT**.~~ **09-06 WAS LOST TOO, AND THE TABLE IS STILL EMPTY.**
> It fired on time (`last_fired_at 14:56:29Z`) into a session that was **mid-turn on other
> work**, so the message queued and the window passed. Two firings, two different failures —
> 09-05 a fresh session with no repo, 09-06 a busy bound session.
>
> **MOVED 2026-09-06: the Routine now fires 07:54 PT (`54 14 * * *`) with `--after=120`.**
> Drain time from fire to the window opening was only ~1.75 minutes; it is ~3.75 now. **Moving
> the fire earlier spends ceiling budget ONE FOR ONE** — the script sleeps in-process until the
> window opens, and the run must finish inside the Bash tool's 600s — so halving `--after` is
> what pays for it. The run stays ~480s, exactly the margin that has always worked. **It costs
> nothing observed**: on 09-04 every flip landed inside T+1.1s and the fastest re-lock was
> 61.5s, both far inside 120. The reasoning is in the Routine's own prompt so nobody
> "restores" 240. **Do not go earlier still** — the remaining 120s of slack is what stops a
> cut-off run, which is the failure that reports SUCCEEDED while measuring nothing.
>
> **First recorded firing is now 09-07 07:54 PT**, and five days of the week remain.

> ## THEN: THE 09-04 MORNING WORKED, AND TWO SESSIONS COLLIDED WRITING IT UP
>
> *(This was the READ FIRST block until 09-05. It is still current and still worth reading —
> the walk above simply outranks it. Items 3 and 4 are habits, not history.)*
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
> - **NO OPEN PRs and one open ISSUE (#243, the worker deploy going red over a healthy fleet)**,
>   checked 2026-09-04 22:25 UTC. #258 is MERGED (`15ecb23`) — the line that said it was open
>   outlived its own merge by three commits. **Migration blocks: main `077-079`, side `080+`**
>   (`docs/LANES.md` is the authority; main took 075 and 076 on the evening of 09-04).
> - **THE POST-CREATE OUTLOOK NOTE SHIPPED (#270) AND HAS NEVER BEEN SEEN IN PRODUCTION.** It
>   explains the quiet stretch after somebody watches a stay that is already booked solid, and
>   says most cancellations land in the last week or two. **Three conditions, all required, or
>   it is silent by design:** lead **> 14 days**, **every** site booked, and availability we
>   could actually read. To test: create a watch for a booked-out campground starting ~40 days
>   out (that renders "about 6 weeks away"), which lands you on `/watches?new=<id>` where the
>   note is. Faster: visit `/watches?new=<any owned watch id>` — the component does not care
>   that the watch is old. **To see WHY it is silent, open `/api/watches/<id>/outlook` in the
>   signed-in browser** (Clerk-authed, so a browser and not curl): `silent` names the rule —
>   `arriving-soon`, `already-available`, or `availability-unknown`. **A blank screen is the
>   designed default, not a render failure**; `availability-unknown` in particular means the
>   portal read failed, and telling somebody to settle in for a long wait about a stay they
>   could book in thirty seconds is the failure the silence prevents.
> - **The release-window instrument is a daily cron**, **`trig_01MDTcr2WFDqX6dCsi7gVDPG`**,
>   `54 14 * * *` (07:54 PT — moved from 07:56 on 09-06), self-disabling on 09-12. **THE ID CHANGED ON 09-05** — the
>   original (`trig_012K7iCrj1J9KspyqGucZSHC`) fired into a fresh session with **no repository
>   attached**, so it could not run the script; it was replaced with one bound to a session that
>   has the checkout. **Read `list_triggers` before acting on any id written down here.** Two gaps
>   recorded and neither fixed: the independent disabler (`trig_01FtjDWmMS8PvGQ8z1TSYbHQ`)
>   **stores no MCP connectors and may be inert**, so the self-disable in the prompt is the
>   load-bearing stop; and ~~nothing persists the readings~~ — **that half is BUILT and merged
>   in #273**: `--record`, migration 076 `rc_release_readings`, `scripts/rc-release-readout.mts`,
>   and the Routine's prompt passes the flag. **First recorded run is 09-07 07:54 PT**, under the new id (09-05 and 09-06 were both lost);
>   09-05's fired under the dead one and recorded nothing, so `rc-release-readout.mts` reading
>   zero rows on 09-05 is the expected state and not the `--record` path being broken. The
>   inert-disabler gap is the one still open.
> - **Health 18/19 at 22:30 UTC** — the `bot_version` warn cleared when the box took `1e947ee`.
>   The one remaining warn is `rc_login`: *"no rehearsal has PASSED in 19h09m — last night was
>   skipped"*. **A skip is a stand-down, not a failure** (it refuses when the session is live,
>   because a pass that proved nothing is worse than none), and it last PASSED on 09-04.
> - **THE MINI-PC IS ON `1e947ee` — THE SAME SHA AS MASTER — SO #273's LEAK INSTRUMENTS ARE
>   LIVE, NOT INERT** (22:30 UTC 09-04; `autocart.bot_version` reads *"mini-PC and web are both
>   on 1e947ee"*). `tab-close.mjs`, `ramp-scan.mjs`, the keep-warm's three bounded closes and
>   `bot.mjs`'s ramp sampler are all running, alongside the wedge watchdog, `persistLiveToken`,
>   `describeIfEmpty` and the cart burst. **So the next ramp should store its own `ramp-scan`
>   row and every trip a `tab-close` row** — `NODE_USE_ENV_PROXY=1 npx tsx
>   scripts/bot-events-readout.mts` is the first thing worth reading next session, and an empty
>   table after a ramp is itself a finding.
> - **`autocart.bot_version` IS TRUSTWORTHY IN THIS ONE DIRECTION AND THE USUAL WARNING STILL
>   HOLDS.** It COALESCEs, so it can preserve an OLD sha beside a live heartbeat — but it
>   cannot invent master's newest one, so *"both on `1e947ee`"* can only have come from the box
>   reporting it. **A sha that lags still needs `bot-ask git-status` to settle.**
> - **`api.codemagic.io` IS 403 AT THE AGENT PROXY** (policy denial to CONNECT, confirmed
>   09-04), so **no session can trigger or inspect an iOS build from here** even though
>   `CODEMAGIC_API_TOKEN` is set and is a plausible 43-character token. Presence is not
>   reachability. The iOS build is an owner action, or the host must allowlist that host.
>
> ### AFTER THE MORNING, IN ORDER OF WHAT IT BUYS
>
> **1. THE LEAK — THE ONSET IS A 35 GB COMMIT STEP, AND THE INSTRUMENTS FOR IT ARE BUILT
> (09-04 evening).** Every ramp's first sample shows commit jumping ~7.5 → ~40-46 GB inside one
> two-minute tick with ~3.5 GB of it in chrome.exe private bytes; the renewal tab gets its OWN
> renderer (procs +1..+3 at every renewal — the shared-renderer hypothesis is out); and the
> three `await tab.close()` calls were unbounded. Built: `bot_events` (075), `closeTabBounded`
> (30s, reports `tripMs`/`closeMs`/`hung` on every close, asks for a recycle on a hang) and
> `ramp-scan.mjs` (the full `memory` scan once per ramp at 3 GB, with kernel pool and
> all-process private bytes). **ON THE BOX since 22:19 UTC 09-04, and both fired within two
> minutes** — read CLAUDE.md → "THE INSTRUMENTS FIRED WITHIN TWO MINUTES". The short version:
> the close is 16 ms; the ramp is the RESIDENT renderer, not the tab's (#142 is aimed at the
> wrong renderer); a ramp ends when the 12-minute wedge bail kills the process stalled in
> `checkAndReport`; the 35 GB is committed-but-untouched non-private memory in a renderer with
> 18,705 handles (shared sections, class unnamed); trigger candidate is the SPA's OWN
> `prompt=none` autoRenew. ~~**Next: count the resident page's requests and bail at ~2 min —
> BOTH ARE DESIGNED AND NOT BUILT.**~~ **BOTH SHIPPED IN #277 (`04c613b`) AND HAVE BEEN ON THE
> BOX SINCE 2026-09-05 03:26 UTC, AND BOTH HAVE ANSWERED.** Struck rather than deleted: read as
> current it sends the next session to build what is already running, which is the cost this
> file exists to prevent — and it read that way for a day. **The request counter came back
> FLAT** (`0 in 120s / 109 lifetime` on a browser eleven hours old, carrying the identical
> 32,779 MB signature as a ramp that ran 18,392 hits on one RDR path), which retires the
> request-loop candidate this file asserted three times. **The bail fired** — peak 3,702 MB
> against 8,879 MB twelve hours earlier, two minutes against twelve. And **the committed-region
> walk (#281) then named the class**: 16,387 mapped sections of 2 MB, 32,779 MB, 87% of the
> renderer's committed bytes. See CLAUDE.md → "THE WALK ANSWERED". The original design notes,
> with every anchor checked in source, are still at CLAUDE.md → "THE NEXT TWO ARE DESIGNED AND
> NOT BUILT" (itself struck): the counter attaches
> where `residentPage = page` is set and keys on `origin + pathname` via `okta-net-trace.mjs`'s
> normaliser; the bail is a THIRD timer arm between WEDGE and RAM, on "resident renderer silent
> ≥120s" (the `heapTrail` going stale) AND "rc family > 3 GB" read from a FILE `bot.mjs`'s
> sampler writes — never a spawn in the timer, never `os.freemem()`, never a lower `LOW_RAM_MB`.
> Both bot-side. Track B may be the wrong lever and still needs the owner's word either way.**
>
> *(Earlier reading, still true:)* The #210
> discriminator was read on 09-04 and it is the **profiler** branch: the trail prints segments
> of 1-74 MB (so CDP works and the transport was never the problem), and four return-path
> readings covering ramping windows attribute **5-17 MB against 690-801 MB of free RAM lost in
> the same window**. `Memory.startSampling` cannot see this allocation. **Ramps are also back to
> nine in 52 hours** — the 08-22 "one in thirty hours" is stale — with the RAM arm sitting out
> all nine (closest approach 240 MB), and **commit going 7.6 GB → 47.3 GB with ~30 GB of it
> unattributed**, which is unresolved and is either the most urgent thing here or a WMI proxy
> artifact. **One `bot-ask memory` during a ramp settles that**, and ramps arrive every 5-6
> hours, so nothing has to be staged. CLAUDE.md → "THE TRAIL ANSWERED, AND IT IS THE PROFILER".
> **Track B still needs the owner's explicit word.**
>
> ~~**The runner has NO wedge watchdog.**~~ **It has had one since 2026-09-03 (`96aee1e`) and
> the box runs it** (`d341139`, confirmed by `git-status`). Struck rather than deleted: this
> stood at the top of this list for a day after it shipped, which is the cost this file exists
> to prevent.
>
> **1a. THE RDR REQUEST BURST — real, unrelated to the leak, and the next actual bug.** RC's
> SPA on the resident page fires ~19,000 requests at
> `rdapi.reservecalifornia.com/api/webaccessfacility/futurebookingstartsendsdates` **in the
> first 15-26 seconds of a browser's life — 738 and 848 requests per second**, from the
> residential IP that has eaten a 12-hour block once. **It is a load-time BURST, not the
> ~153/s poll the first write-up implied** — that figure averaged the burst with the quiet
> after it. Two events in 113 over fourteen days, and the ~100 browser lives in the 09-05
> 15:1x preemption window did NOT burst, so **it is conditional and what gates it is not
> established.** Confirmed twice not to be the leak (a ramp with 4 lifetime requests on its
> busiest path carried the identical 32,779 MB signature).
> **THE MISSING FIELD IS THE STATUS**: `page.on('request')` never sees the answer, so a retry
> loop against a 401 — a candidate carried since 2026-08-17 and never tested — and an SPA
> asking 19,000 times on purpose are the same reading, and they need opposite fixes. **Count
> by (path, STATUS) off `page.on('response')`; a status code is not a credential. NOT BUILT.**
> **Do not reach for blocking the requests first** — intercepting RC's own traffic on the page
> an 08:00 cart depends on, to stop traffic whose cause is unknown, trades a rate-limit risk
> for a missed cart. CLAUDE.md → "THE RDR LOOP IS A LOAD-TIME BURST".

> **2. RC's own app tier is the largest un-instrumented risk on this path** — and it is now
> partly instrumented. `never-loaded`/`load-error` have readings, a successful load reports
> its milliseconds (`RC_SLOW_LOAD_MS` = 8s), and `rc-load-stats` aggregates across runs.
> ~~What is missing is a corpus: the first hand-off after that landed is the first data
> point.~~ **THE FIRST DATA POINTS ARE IN**: the 09-04 hand-off reports *"RC LOAD: 2 timing(s)
> across 1 of 1 hand-off(s) — median 0.2s, slowest 0.6s"* and *"No hand-off failed to render RC
> in this window."* **Two timings is not a corpus and 0.6s is not the risk** — the failure this
> instrument exists for is the three-attempts-and-five-minutes case seen by hand on 08-30 and
> 08-31, which needs a bad morning to appear. What has changed is that the next one will be a
> number instead of an anecdote.
>
> **SIZED ON 2026-09-06, AND IT IS THINNER THAN THAT READS.** Run over THIRTY days rather than
> the 24h default (`--hours=720`): **11 hand-offs, 7 of them TEST fixtures, exactly ONE carrying
> a timing, zero failures.** The timing instrument landed 09-03, after nearly every hand-off
> that has ever happened, so the corpus is one hand-off deep and grows at ~1 real hand-off every
> few days. **The line quoted above was ALSO printing "No hand-off failed to render RC in this
> window" over all eleven** — an all-clear from a sample of one, gated on `samples > 0` with no
> floor, in the module whose own header says the denominator is the point. Fixed:
> `RC_LOAD_MIN_TIMED_RUNS = 5`, one-directional (an observed failure still reports at ANY
> count), denominator `runsTimed` not `handoffs`. CLAUDE.md → "AND THE ALL-CLEAR HAD NO FLOOR".
> **Nothing further to build here — it needs hand-offs, or the proxy sampler noted there
> (the keep-warm loads RC's app ~48x a day and throws every reading away; it measures a desktop
> on a home connection, so it can never replace the phone corpus, only tell "RC was down for
> everyone" from "RC was slow for this phone").**
>
> **Seen in the same readout, and already recorded:** #271's `pickKeepSignedInReport` fix reads
> correctly on `#L034` — *"'Keep me signed in' was ticked on the email step"* beside *"sign-in
> path: IDENTIFIER-FIRST"*, the two lines agreeing where they used to contradict each other.
> CLAUDE.md carries it under "VERIFIED ON THE REAL ROW". **Nothing to do; noted so a second
> session does not re-verify it.**
>
> **3. The RC session dies within ~2 minutes of every queue — four for four**, then ~11
> minutes to recover. **The 08-30 `persistLiveToken` fix IS on the box** (checked 09-04:
> `d341139`, three occurrences), so the remaining question is whether it helps, not whether it
> is deployed — and the 09-04 log shows the yield reporting *"storage already held the token —
> nothing to write"*, i.e. it ran and found nothing to do. That is the fix behaving correctly on
> a healthy session and says nothing about the failing case.
>
> **CHECKED IN SOURCE 2026-09-06: THE INSTRUMENT IS COMPLETE AND THERE IS NOTHING TO BUILD.**
> Every outcome of the yield speaks as of 09-03, including a fourth the four deaths predate —
> `already-stored-stale`, meaning storage holds an OLDER token than the live one, i.e. **this
> fix's own defect surviving inside it**, reported and deliberately not acted on. **No failing
> queue has happened since**, so the question is unanswerable without one. **And what is killing
> the session today is a DIFFERENT mechanism — do not read one as the other:** on 09-06 the box
> is dead 2h+ with **no hold queued at all**, `okta=GONE(404)`, seven consecutive failed
> renewals, backoff at 30m. That is the ordinary between-releases state (token ~1h,
> `maybeAutoLogin` restores it at T−30) and **the printed remedy `rc-login.bat` force-kills the
> Chromium the token lives in** — the 08-16 07:33 cry-wolf shape. No human errand is warranted.
>
> **4. ~~A fresh iOS build~~ — THE BUILD EXISTS; THE PHONE HAS NOT INSTALLED IT.** `iOS ·
> TestFlight` #12 built 2026-08-29 with RevenueCat compiled in (STOREKIT-PLAN.md), the same day
> as Android 25. The 09-01 trace's `1.0 (21)` is what the iPhone is RUNNING, not the newest
> binary — and nothing native-side changed after 08-29 (#231, #248 predate the build). **Install
> TestFlight #12 on the iPhone; read the build number in the next hand-off trace.** No Codemagic
> run is needed. (`api.codemagic.io` is still 403 at the proxy, which only matters if one is.)
>
> **5. Run the Stripe reconcile** (Admin → "Does our table match Stripe?" → Check, read the
> plan, Apply). The webhook fix is forward-only, so both trials still read `active`. **Do not
> re-derive the "Active 5 · 2 paying" panic** — those tiles read different systems, and a
> refund does not cancel a Stripe subscription.
>
> **6. ~~`keepSignedInReading` is fed the WRONG report~~ — FIXED IN #271, 2026-09-04.**
> `pickKeepSignedInReport` prefers the report where the box existed; the readout calls it;
> four mutations verified. Confirmed against the real `#L034` row, where the two lines now
> agree instead of contradicting each other. Struck rather than deleted — this list is where a
> shipped fix goes on reading as a task.
>
> **7. ~~The Chromium leak~~ — moved to item 1**, because the discriminator was read and the
> answer changes what is worth building. Still uncured; still the owner's standing ask.
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

## 2. ~~THE ASSIGNMENT — read the next ramp~~ — SUPERSEDED; Track A is RETIRED

> **READ THE TOP BLOCK INSTEAD.** This section is the 2026-08-25 assignment and its subject —
> the CDP sampling profiler — was **retired on 2026-09-04**: it reports 1-74 MB of segments
> against 690-801 MB of free RAM lost in the same window, four for four, so it is measuring a
> quantity that structurally excludes this leak. `NATIVE_ALLOC_RAMP_MB` is 400, which is why
> `trail-*` rows have never appeared and never could. **The instrument is not silent — it was
> never going to answer.**
>
> Kept rather than deleted because it is the fullest write-up of how the trail works and of the
> three ways it can look silent, and because "the trail has not yet seen a ramp" is exactly the
> sentence a later reader would quote as a live task. **The live assignment is the committed-
> region walk at the top of this file.**

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

> **SUPERSEDED BY THE TABLE IN THE TOP BLOCK, refreshed 2026-09-06 18:00 UTC.** The reading
> below is 09-05 19:40 PT: master was `aebaf13`, the mini-PC `2ecaca8`, **no open PRs and no
> holds queued**, migrations unchanged (highest **076**; main's block `077-079`), health 18/19
> with only `rc_login` warning. The rows below are the 09-04 reading and are kept for the detail in them
> — **re-read production rather than either table.**

*Refreshed **2026-09-04 15:30 PT**, against production. This table has twice been left
describing a state the repo had left behind, and one of those rows was **"Holds: none live"
while a real hold was queued** — which reads as permission to run `npm test` and restart the
box. **Re-read it rather than trusting it, and re-date it when you do — and `git fetch` first,
because on 09-04 a whole incident came out of trusting a day-old checkout.***

| | |
|---|---|
| Master | **`1e947ee`** (#273: leak instruments, migrations 075/076, `--record`). Earlier 09-04: #262 `SHARD_COUNT` 2 -> 3, #263, #264, #265, #266, #269, #271, #272. Previously: 09-04 landed a lot: #262 `SHARD_COUNT` 2 -> 3, #263 re-offer holds per release (migration 074) + holds in the watch card + the dead-man's switch removed, #264 the RC release-window measurement, #265 docs, #266 the `offerHold` gate hoist. |
| Mini-PC | **`1e947ee`, level with master** (22:30 UTC 09-04) — so #273's leak instruments are LIVE. A LAGGING sha still needs `bot-ask git-status`, because `autocart.bot_version` COALESCEs; a sha equal to master's newest cannot be a stale reading. |
| Fly worker | both shards beating, `poller.shards` ok. `SHARD_COUNT` is **3** now. Redeploys on every `worker/**` merge. |
| Open PRs | **none** (checked 22:25 UTC 09-04). #258 merged as `15ecb23`. |
| Open issues | **#243** — worker-deploy goes red when Fly REPLACES a machine rather than updating it. Cosmetic-but-corrosive: it is the cry-wolf shape, and the fix must not weaken the heartbeat check. |
| Migrations | highest is **076** (`075_bot_events`, `076_rc_release_readings`, both applied and read back 09-04 evening; 074 applied 05:00 UTC 09-04 — read the correction in its own header: it was applied, reverted by the other lane, then re-applied. **Main's block is now `077-079`; the side lane's is `080+`.** |
| Holds | **No holds DUE and one offer unanswered** (readout, 15:29 PT). Nobody tapped it, which is not a fault. `#L034` carted T+1.4s at the 08:00 release and was released at 08:09; its hand-off reads `cart read back: 1 entry`, `customerId PRESENT`, `close: session`. |
| RC session | Healthy (`okta=ALIVE` to 09-05 10:09, token 17m, `src=live`). The rehearsal was **skipped** last night (`rc_login` warns at 12h) — a stand-down, not a failure; it PASSED on 09-04 03:01. `maybeAutoLogin` covers a release at T-30. |
| Health | **18/19** at 22:30 UTC; only `rc_login` warns. `poller.shards` 3/3, `poller.capacity` 7/12, heartbeat 9s, 18 watches. |
| Memory | **Track A is retired.** `ramp-scan` + `tab-close` are LIVE on the box and have each reported once (22:21 / 22:2x UTC 09-04): the ramp is the RESIDENT renderer, the close is 16 ms, the 35 GB is untouched non-private commit (18.7k handles), a ramp ends at the 12-min wedge bail. `scripts/bot-events-readout.mts`. |
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
