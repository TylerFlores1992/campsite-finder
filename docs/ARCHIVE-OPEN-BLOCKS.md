# Archived "Open / next session" handover blocks

*Extracted verbatim from `CLAUDE.md` on 2026-09-21. This file is the AUTHORITATIVE RECORD
for the dated handover blocks that accumulated under `## Open / next session` between
2026-09-01 and 2026-09-11.*

These are **superseded state snapshots**, newest first, exactly as they stood in the file —
each one written as "here is where things are right now", each one overtaken by the next.
They are kept because several of them carry a reading that exists nowhere else, and because
a superseded snapshot is still evidence about what was believed on a given day.

**Read them as history, not as state.** Anything still live was carried forward into
`CLAUDE.md`'s current `## Open / next session` section or into one of the topic archives.


**One caveat, and it is the cost of splitting one file into four.** `CLAUDE.md` interleaved
these subjects chronologically, so a cross-reference inside a block — *"the entry above"*,
*"see directly below"* — may now point at text that landed in a **different** archive. The
blocks themselves are intact and in their original relative order; only their neighbours
changed. `docs/PRUNE-LEDGER.md` maps every block to its original `CLAUDE.md` line range, so a
reference that has lost its target can be located there in one lookup.
---

> ### 2026-09-11 — THE LEAK IS DIAGNOSED AND CONTAINED. IT IS **NOT FIXED**.
>
> **STATUS IN ONE LINE: it still happens every few hours, the containment catches every one, and
> what is left is a COMMIT risk rather than a RAM one.** Measured off the box's own series on
> 2026-09-11, over the preceding 48 hours (1,628 samples):
> ```
> onsets (rc family crossing 1500 MB)   6        most recent 10.4h before the reading
> peak rc_mb                        4,661 MB     8,000-9,400 MB before the bail arm existed
> peak COMMIT used                 46,807 MB     of a 47,870 MB limit
> tightest COMMIT headroom            665 MB     09-10 04:26, used 40,175 / 40,840
> minimum free RAM                  5,140 MB     the RAM arm's floor is 2,000 — it cannot fire
> bail:ramp fired on                  6 of 6     ~2 minutes after each onset
> ```
> **THE PRIVATE-BYTE CLIMB IS GENUINELY CUT SHORT, EVERY TIME** — that is the containment working
> and it is why the peak roughly halved. **The ~32 GiB MAPPING is untouched by any of it**: it
> arrives in ≤34 seconds, faster than any arm can react to, and Chromium's own ceiling is what
> stops it going further. **Do not read "contained" as "cured".**
>
> **Read `CLAUDE.md` → "THE 32 GiB CEILING IS `base::SharedMemorySecurityPolicy`" before doing
> anything memory-related. Every open leak question above it is either answered or superseded.**
>
> #### AND SINCE 2026-09-16 THERE IS A CURE FOR THE *DURATION*, WHICH IS A DIFFERENT CLAIM
> **Read "THE CURE: RECYCLE THE WEDGED PAGE, NOT THE BROWSER" for the measurements.** In one
> line: probe the resident page with a **bounded** `page.evaluate`, and after three consecutive
> no-answers close the page — measured at **1,052 mappings released in 86 ms**, and validated end
> to end against the reproduction at `233 -> 0`. It is first in the watchdog timer because it is
> the cheap arm: a page close costs one RC page load where both arms below it cost the session.
> - **IT DOES NOT MAKE "CONTAINED" INTO "CURED", AND THE PARAGRAPH ABOVE STANDS UNCHANGED.** The
>   burst still maps 16,384 sections in ≤34 s and a detector that must first observe silence acts
>   at ~30 s. What it changes is how long a wedged page HOLDS them: seconds, instead of the 120 s
>   ramp arm or the 12-minute `HUNG_MS` arm killing the whole browser.
> - **UNPROVEN IN PRODUCTION, AND VERIFYING IT IS THE NEXT ACTION.** Container-local Chromium
>   (141/Linux) against a synthetic wedge, against a box running 149/Windows — the platform pair
>   that burned the native sampler twice. It is **bot-side**, so it is inert until the box takes
>   it, and **`autocart.bot_version` now genuinely reads "MISSING bot-side changes"**: that warn is
>   real for the first time in a fortnight and is worth acting on. **Update the box, confirm with
>   `bot-ask git-status`, then force a ramp with `restart-rc`** (2-for-2, no campsite, no password
>   submission), and read the log. The predicted readings and the two predicted failure modes are
>   written down in the cure's own section so they can be falsified.
> - **`page.reload()` IS NOT THE LEVER** — on the same wedged page it hung past its own timeout and
>   had to be killed at 70 s. Close, not navigate.
>
> **THREE THINGS ARE PROVED, and none of them needed a ramp, a box update or an instrument.**
> 1. **The 32 GiB ceiling is `base::SharedMemorySecurityPolicy::kTotalMappedSizeLimit`** — a
>    per-process budget on total mapped shared memory, `>=` so the maximum pure-2 MiB count is
>    **16,383**, against a measured 16,381-16,383 on six walks with the 1-3 residual explained to
>    within 0-6 MiB. One grep, one hit in the whole checkout.
> 2. **Therefore the sections are `base::SharedMemoryMapping`s** — only two callers charge that
>    budget, so stopping at exactly that number IS the fingerprint of the code path. Far stronger
>    than the 2 MiB coincidence, which this file already retired as a search key.
> 3. **No peer process holds them** — the walk's own `CHROME` lines, which nobody had read:
>    14,721 handles in the target renderer, **1,224 in the browser**, 180-832 everywhere else,
>    and 4.015 KB of paged pool per section. That eliminates ipcz, discardable and the GPU path.
>
> **AND IT IS REPRODUCED, WITH BOTH CONTROLS FLAT.** `node scripts/leak-repro.mjs wedge-and-fetch
> 30` — a microtask loop that issues fetches and never yields to the task queue — climbs 12 → 800
> 2 MiB shared mappings in thirty seconds, with the network service at **6** and the browser at
> **0**, which is the production peer asymmetry exactly. Wedging alone: **0**. Fetching and
> draining: **0**. Only the two together. **First reproduction this leak has ever had.**
>
> **THE CHAIN, READ IN SOURCE:** `URLLoader::ContinueOnResponseStarted` makes a 2 MiB pipe per
> RESPONSE (not per request — which is why 69,060 answer-less asks cost nothing and why the
> burst/leak decoupling is real); `DataPipe::Deserialize` maps the consumer **on the IO thread**
> the moment it arrives; the drain is a **posted task**. So a wedged main thread cannot stop the
> mapping, only the release — and `deferred_messages_` has no bound.
>
> **WHAT IS STILL OPEN ON THE DIAGNOSIS, AND IT IS AN INSTRUMENT GAP RATHER THAN A DOUBT.** One
> pipe per response needs ~14,433 responses in that renderer inside the burst; the resident page's
> counter read **20 lifetime requests**. `requestCounter.attach(page)` is on the RESIDENT page
> alone and `withNetworkTrace` is equally page-scoped, so **dedicated workers, service workers and
> the throwaway tabs are invisible to both**. **Do not read "20 requests" as "20 responses in that
> renderer."**
>
> **THINGS TO STOP DOING.** Stop hunting a 2 MiB constant (the size grep is clean; ipcz proves a
> 2 MiB allocation can be COMPUTED). Stop citing *"the sections are NOT base shared memory"* —
> that came from the 09-07 VOID dump of a healthy replacement browser, and all four ramp dumps
> are `target-silent`. Stop spending ramps on the memory dump: a wedged renderer contributes zero
> allocator dumps at every level, measured off-box.
>
> **AND THERE IS NO FIX ON OUR SIDE OF THE ALLOCATION, WHICH IS WORTH SAYING PLAINLY.** The pipe
> size is compile-time (512 KiB only on ChromeOS and 32-bit — no Finch flag), the drain is
> Chromium's, and the wedge is RC's own promise loop. What changed is that the damage is now known
> to be hard-capped by Chromium at 32 GiB of commit, in memory that is never touched — which is
> exactly why the RAM arm has sat out fifteen-plus ramps: **it watches the one resource that is
> not running out.** That makes this a **bounded** risk rather than an open-ended one. **It does
> not make it a closed one** — see directly below.
>
> #### THE RESIDUAL IS COMMIT, AND NOTHING WATCHES IT (2026-09-11) — the next piece of work
>
> Every arm this repo has built watches **free RAM** or the **rc family's private bytes**. The
> burst spends neither: it charges ~32 GiB of commit that is never written. So the one resource
> that actually runs low during a ramp is the one nothing is gated on.
>
> **THE BOX, READ 2026-09-11 16:15 UTC via `bot-ask memory`:**
> ```
> RAM       15.7 GB total, 10.4 GB free
> COMMIT     7.0 GB used of 46.7 GB limit   (idle)
> PAGEFILE  C:\pagefile.sys — 31.0 GB allocated, peak 0.0 GB, SYSTEM MANAGED
> ```
> **`peak 0.0 GB` is the confirmation that the 32 GiB is never touched** — 31 GB of pagefile
> charged and essentially nothing ever written to disk. It also means a larger pagefile costs
> disk, not I/O.
>
> **WHY IT MATTERS:** commit exhaustion is the only failure this box has had that needed a human.
> On 2026-08-12 `supervise.ps1` could not start a shell ("the paging file is too small"), taking
> every remote lever with it, and the machine was power-cycled by hand; on 08-17 both Scheduled
> Tasks stopped together. **The bail arm does not help there, because the burst is complete
> before it can fire.**
>
> **FOUR OPTIONS. None is taken; three of them are decisions rather than tidy-ups.**
>
> **A — GIVE THE BAIL ARM A COMMIT TRIGGER.** ~~Cheapest, and the plumbing is one field
> short.~~ **BUILT 2026-09-11 — see "THE BAIL ARM HAS A COMMIT TRIGGER NOW" above for the
> backtest (earlier on 11 of 19 onsets, median 77 s, median 1,984 MB off the peak) and for
> what it CANNOT do (the mapping is already complete at the sample where it first fires).**
> The original reasoning, which still stands:
> `memory-sample.mjs` ALREADY computes `commitUsedMb` and `commitLimitMb`; `writeLatestMemory`
> (`ramp-bail.mjs`) **drops them**, persisting only `at`, `rcMb`, `maxPid`, `maxType` — so the
> bail's timer, which must never spawn PowerShell, has no commit figure to read.
> - **PREDICTED READING, STATED BEFORE BUILDING (the house rule):** it is **not** a no-op. On
>   09-10 19:16 commit read **44,354 MB while `rc_mb` was 1,869** — under `RAMP_MB_DEFAULT`
>   (3000) — so a commit arm would have fired a full sampler tick EARLIER than the rc bar did on
>   at least one of the six events.
> - **WHAT IT CANNOT DO: prevent the mapping.** The burst is over in ≤34s. This shortens the
>   window the box spends near its limit; it does not remove it.
> - Testable off-box in seconds with `ramp-arm-probe.mjs` — three of the arm's four inputs are
>   forgeable, which is why the trigger path no longer needs a ramp to exercise.
> - **BOT-SIDE**, so it arms `CH_BOT_CODE_AT` → the `autocart.bot_version` warn → a box update,
>   **which ends the RC session.** Land it with something else bot-side, or accept that cost.
> - **BOTH-CONDITIONS STILL APPLIES.** A commit-only arm would fire on the owner using their own
>   desktop. Pair it with the stall the way the rc arm is paired, or it is the cry-wolf failure
>   this file has fixed three times.
>
> **~~B — STOP THE PAGEFILE HAVING TO GROW DURING THE BURST.~~ ANSWERED AND OFF, 2026-09-11.**
> **The precondition below is settled and it is TRACKING**: the limit grows on essentially
> every sample and never stalls while used climbs, the fastest being **+30,902 MB in 33
> seconds** finishing 1,456 MB ahead — against a burst of <=34 s. And **Windows has already
> done B by itself**: the limit has been a constant 47,870 MB since 2026-09-10 12:40 UTC
> across 913 samples, so a burst now needs no growth at all. **Do not spend a reboot on
> it.** The one thing that survives: the settle is NOT durable — a reboot resets it. Full
> account in "THE COMMIT RESIDUAL: THE PAGEFILE TRACKS, AND OPTION B IS OFF" above. The
> original entry follows, kept because its reasoning about the precondition is how the
> question got asked:
>
> **B (original).** `mini-pc\fix-pagefile.ps1` exists,
> reports by default, writes only with `-Apply`, turns automatic management off FIRST and reads
> the setting back. **The change is not live until a REBOOT, which ends the RC session.**
> - **CLAUDE.md CURRENTLY SAYS DO NOT** — *"a bigger pagefile buys a bigger burst up to 32 GiB and
>   no further, which is more commit taken and nothing gained."* **That objection predates the
>   ceiling finding by one day, and its premise is now measured**: the burst is capped by Chromium
>   at 32 GiB **independently of the pagefile**, so a larger limit cannot buy a larger burst. What
>   it buys is headroom for everything else on the box while one is in flight.
> - **THE QUESTION THAT MUST BE SETTLED FIRST, AND IT IS NOT SETTLED: is 665 MB of spare PRESSURE
>   or TRACKING?** Every observed spare sits **665-1,072 MB** ahead of used, across four different
>   limits (36.7 / 39.8 / 45.5 / 47.9 GB). That is the signature of a system-managed pagefile
>   growing exactly as much as it needs — i.e. Windows keeping up — **not** of a box about to run
>   out. **If it is tracking, the objection stands and this option buys nothing.** If growth ever
>   fails to keep pace with a 34-second burst, that IS the 08-12 failure, and a pre-allocated
>   fixed pagefile removes the race. **Do not act on this without separating the two.**
> - The absolute figures are the ones to read. **Every COMMIT PERCENTAGE in this file from 08-22
>   to 08-28 is an artifact** of the limit chasing the used figure; the ratio pins near 100% all
>   the way up and back down and is not measuring pressure.
>
> **C — STOP THE WEDGE. The only option that addresses the cause rather than the aftermath.**
> The mapping needs a main thread that never returns to its message loop, which is RC's own
> promise-rejection storm in the resident page. A resident browser recycled BEFORE it wedges
> never bursts at all.
> - **THE RECORDED COUNTER-ARGUMENT IS STRONG AND MUST NOT BE SKIPPED:** a browser REPLACEMENT is
>   **8x enriched** before a ramp (11 of 26 onsets within 6 minutes of one, against 1.4 expected),
>   and the 02:0x cluster turned out to be the update window restarting the browser. **Recycling
>   more often may make this WORSE, not better**, and `restart-rc` is 2 for 2 as a deliberate
>   forcing lever. Direction of causation is NOT established.
> - **PARKING THE RESIDENT PAGE IS ALREADY REFUSED**, for a different and still-valid reason:
>   `checkAndReport`'s localStorage rule would make the session verdict permanently INCONCLUSIVE,
>   silencing `autocart.rc_session`, the 07:40 pre-flight and `holdAtRisk`'s phone alarm.
> - What is genuinely unexplored is a **leading indicator** of the wedge — something that changes
>   before the microtask queue stops draining. Nothing has looked.
>
> **D — DO NOTHING, DELIBERATELY.** Named as an option because it is a real one and should be
> rejected on evidence rather than by momentum: the bail arm is 6 for 6, free RAM has not been
> below 5.1 GB in 48 hours, the mapping is hard-capped by Chromium, and **the box has not needed
> a human since 2026-08-17.** The cost of A and B is a box update or a reboot, each of which ends
> the RC session; the cost of C is possibly making the thing worse.
> ### 2026-09-10 — THE TRIAL RAN AND THE COMMAND-BUFFER CANDIDATE IS REFUTED
>
> **Read `CLAUDE.md` → "AND IT RAMPED ON TRIAL ONE" before touching anything GPU-related. The
> experiment is FINISHED and its answer was negative — do not re-run it to "confirm".**
>
> **State: master `38cf6be` (#312-#318 merged); the mini-PC is on `7875a6f`, confirmed by its
> own `git rev-parse HEAD` through `bot-ask git-status` — NEVER `autocart.bot_version`, which
> COALESCEs and can show a stale sha beside a live heartbeat.** 3/3 shards, 0 live holds,
> health 17 of 19 with both warns documented-benign.
> **The box has `code-bytes` (#315), has the GPU-flag revert, and does NOT need an update** —
> checked by diffing rather than by reading the warn: `git diff 7875a6f..origin/master --
> scripts/auto-cart-bot/ mini-pc/` is **one hunk, and it is a comment**. `autocart.bot_version`
> nonetheless reads *"MISSING bot-side changes"*, because it compares a path timestamp and
> cannot see that the change was prose — see "A COMMENT ARMS IT" under that check. **Do not
> spend a box update on that warn**; an update ends the RC session.
>
> **UPDATED THE SAME EVENING: the box is on `7333940` (#325) and that bot-side diff is now
> EMPTY.** `git diff 7333940..origin/master -- scripts/auto-cart-bot/ mini-pc/` returns nothing at
> all, so the comment-armed case above has CLEARED and `autocart.bot_version` warns only on the
> ordinary web-ahead-of-box gap — its own detail says so in as many words (*"No bot-side code in
> the gap"*). **The conclusion is unchanged and now rests on nothing subtle: no box update is
> owed.** The `7875a6f` above is the sha that was measured then; read the box with
> `bot-ask git-status`, never from a line in this file.
>
> **WHAT HAPPENED.** The flags went live at 05:21:50Z (confirmed independently: `gpu-process` fell
> to 20-22 MB against a three-day minimum of 78, and back to 99-130 on the revert). `restart-rc`
> replaced the browser at 05:49:51Z. **It ramped at 05:51:53Z** — ~35 GB of commit inside one
> two-minute tick, a renderer that did not exist a minute earlier, and the walk on it reading
> **32,774 MB across 16,385 regions of 2 MiB, one allocation base each, all anonymous, all
> READWRITE**, with the same native spin at `chrome.dll+0x18096c6` / `+0x180968b`. **The GPU
> process never moved: 20 MB throughout.**
>
> **SO THE ~20-TRIAL BAR WAS NEVER REACHED AND DID NOT NEED TO BE.** That bar exists to stop a
> CURE being credited on silence; silence is not what arrived. One counterexample refutes, and
> this one came with the whole walk attached.
>
> **THE FLAGS ARE OFF AGAIN — default flipped, module KEPT for the evidence.** Their justification
> was the candidate; without it only the fingerprint hazard is left (a browser reporting no WebGL
> is itself a bot signal, and the recorded cost of getting that wrong on this address is twelve
> hours of IP block). `RC_KEEPWARM_DISABLE_GPU=1` re-runs it with no deploy if a reason appears.
> **This needs a box update to take effect** — until then the box is still running with the flags
> on, which is measured-useless rather than measured-harmful, and no canary has failed.
>
> **WHAT THE REFUTATION DOES *NOT* SAY, because the over-claim is the failure mode here.**
> `--disable-gpu` leaves a GPU process running, so a *different* command-buffer client is not
> excluded by arithmetic alone. What is established is that **removing the WebGL context does not
> stop the leak**, so `MappedMemoryManager` serving RC's ArcGIS map cannot be the mechanism. **The
> 2 MiB unit is now MORE interesting: something maps 16k two-megabyte shared sections in a
> renderer with no GPU context.**
>
> **THE NEXT READING IS SYMBOLIZATION, AND IT IS THE ONLY LEAD LEFT** — VMSTACK has the loop in
> native code at fixed offsets in a known build, and naming what it DOES is what turns "something
> maps 32 GiB" into a mechanism. Everything else this investigation could measure from outside the
> process has been measured.
>
> **AND THE ROUTE IS BUILT: `code-bytes`.** The proxy blocks every Playwright CDN host, so the
> binary cannot be fetched — but **the box has the exact file**, and the command reads it FROM
> DISK (never a process, so the `ReadProcessMemory` ban is untouched). Its argument is an RVA and
> can never become a path; `chrome.dll` is derived on the box from Playwright's own
> `executablePath()`. See "THE BOX HAS THE BINARY" above.
> - **BOT-SIDE, so it needs a box update first**, then two calls:
>   `npx tsx scripts/bot-ask.mts code-bytes 18096c6` and `... 180968b`.
> - **Disassemble the hex HERE** — `objdump -D -b binary -m i386:x86-64 -M intel` is in the
>   container and verified working. The window starts 64 bytes early on purpose: x86 is
>   variable-length, so try alignments until the instruction stream is sane.
> - ~~It also returns the **PDB GUID + age**, which is the symbol-server key for this exact build —
>   the thing a later session WITH egress needs, obtained now so the answer does not wait on the
>   proxy twice.~~ **STALE TWICE OVER, AND EGRESS WAS NEVER THE BLOCKER.** The GUID did not
>   survive the trip — `scrub()` redacted it as `[hex]`, a 32-character hex run being
>   indistinguishable from a token — and the symbol server, which IS reachable, **does not hold
>   this build** (measured with a control; see directly below). So a later session with egress and
>   the GUID in hand would still get `NoSuchKey`. Struck rather than deleted: read as current it
>   promises that one missing field is all that stands between here and a function name.
>
> **`restart-rc` IS 2 FOR 2 AS A FORCING LEVER** (09-09 21:26 and this one), against a pooled 10%
> base rate. n=2, so not a rate — but a forced restart makes a COLD browser loading RC's home
> page, which is the shape the 02:0x cluster turned out to be, so it is plausibly much higher than
> the pooled figure. **Pace forced restarts at ~15 minutes**: `supervise.ps1` stops LOUDLY after
> 5 exits in 10 minutes and leaves the RC pair dead.
>
> #### SYMBOLIZATION IS STILL BLOCKED, AND THE LOCAL COPY IS A TRAP FOR TWO REASONS
>
> The build identity is exact and needs no more work: **`scripts/auto-cart-bot/package-lock.json`
> has its OWN lockfile pinning playwright 1.61.1** (the web app's pins 1.56.1 — starting from the
> repo-root lockfile is what made `chrome.dll 149.0.7827.55` look impossible), which gives
> chromium revision **1228 -> 149.0.7827.55**, an exact match for the box.
> - **All four Playwright CDN hosts return 000 at the proxy**, re-checked 2026-09-10.
> - **THIS CONTAINER'S OWN CHROMIUM IS NOT A SUBSTITUTE, AND IT LOOKS LIKE ONE.**
>   `/opt/pw-browsers/chromium-1194` is **141.0.7390.37** — a different revision, and **a LINUX
>   build**. Even at a matching revision the offsets would not transfer, because the box runs
>   `chrome.dll` on Windows. Two independent reasons, and the second survives a version match —
>   which is exactly the "validated on the wrong platform" trap that burned the native sampler.
> - **Two routes out:** allowlist `cdn.playwright.dev` and fetch
>   `builds/chromium/1228/chromium-win64.zip`, or add a **NAMED** read-only bot command dumping
>   the bytes at RVA `0x180968b` from `chrome.dll` **ON DISK** — the shipped binary, not process
>   memory, so it touches neither the `ReadProcessMemory` ban nor any session material.
>
> ##### THE SYMBOL SERVER ANSWERS, AND IT DOES NOT HAVE THIS BUILD (2026-09-10)
>
> The two routes above do not mention the one host that is reachable.
> **`chromium-browser-symsrv.commondatastorage.googleapis.com` returns 200 at the proxy**, while
> `msdl.microsoft.com`, `chromium.googlesource.com` and `source.chromium.org` are all **000**
> alongside the four Playwright CDN hosts. So it is worth trying, it was tried, and the answer is
> no: **our key 404s `NoSuchKey`.** The layout is
> `chrome.dll/<TimeDateStamp %08X><SizeOfImage %x>/chrome.dll`, i.e. exactly the
> `6A18CF41112d9000` that `code-bytes` already derived off the box — confirmed against real keys
> in the bucket listing, so the 404 is not a malformed request.
>
> **IT IS A CONTROLLED NEGATIVE, WHICH IS THE ONLY KIND WORTH RECORDING.** A server that 404s
> everything and a server that lacks this one build read identically without a control:
> a key the listing says exists **range-fetches 206**, so fetching works; the bucket is **still
> fed** (keys under the `6A` prefix modified 2026-05-10), so it is not an abandoned archive; and
> it covers **our exact TimeDateStamp**.
>
> **THAT LAST ONE IS THE TRAP, AND IT IS A NEAR-MATCH RATHER THAN A MISMATCH.** `6A18CF41` is
> present — three Chrome variants of it, and not one is ours:
> ```
> chrome.dll/6A18CF4111110000/chrome.dll     SizeOfImage 0x11110000
> chrome.dll/6A18CF41e7e4000/chrome.dll                  0x0e7e4000
> chrome.dll/6A18CF41fedf000/chrome.dll                  0x0fedf000
> ours       6A18CF41112d9000                            0x112d9000   <- ABSENT
> ```
> **A different `SizeOfImage` is a different binary, so its PDB names different functions at the
> same RVA.** Pulling `…11110000`'s symbols and reading `+0x18096c6` out of them returns a
> confident function name **for the wrong image** — the "validated on the wrong platform" failure
> this file has paid for three times, arriving as a 1.8 MB size difference behind a matching
> timestamp instead of as an obvious mismatch. **Do not do it**, and do not read "our timestamp is
> in the bucket" as "our build is in the bucket".
>
> **WHY it is absent is NOT established and does not need to be** — the likeliest reason is that
> this bucket holds Google **Chrome** while the box runs Playwright's **Chromium**, which would
> account for a same-second timestamp over a different image. Either way the symbolization route
> is closed by measurement rather than by assumption, and the route that stayed open is the one
> already taken: `code-bytes` off the shipped binary, disassembled by hand.
>
> **AND THE OTHER ROUTE IS REACHABLE, WHICH IS THE HALF WORTH ACTING ON.**
> `chromium.googlesource.com` and `source.chromium.org` are 000, but **`raw.githubusercontent.com`
> is 200** — controlled against a file in this repo, 200 with a real body, not a bare-root
> redirect. So Chromium source is fetchable BY PATH through the GitHub mirror, and the remaining
> lead this file already names — matching the disassembled fingerprint against real code — needs
> no ramp, no box update and no symbols. **State it precisely or the search is for the wrong
> struct:** the flag byte is on the ELEMENT (`elem+0x5c`), while the two non-zero checks are on
> its POINTEE (`(*elem)+0x10` and `(*elem)+0x1c`), and the sampled comparison is
> `**(elem+0x20)` against `*(*elem)`. `rsi` holds two containers — the scan reads its count at
> `+0x24` and data at `+0x18`, the erase decrements `+0x14` and reads `+0x8`.
> ~~**NOT TAKEN HERE, DELIBERATELY.** It is a source-reading job, it reads a repository outside this
> session's scope, and this file records three mechanisms guessed and each costing a session — so
> it wants the owner's word, not an idle afternoon. What is recorded is only that the door opens.~~
> **IT WAS TAKEN AND FINISHED FIVE HOURS LATER THE SAME MORNING (struck 2026-09-10 evening).** See
> "IT IS `blink::RejectedPromises::HandlerAdded` — NAMED FROM THE BINARY, CONFIRMED IN SOURCE"
> above. This block landed in `52d6e74` at **00:52 PT** and the fingerprint was matched in `ff4b829`
> at **05:42 PT** — settled with `git merge-base --is-ancestor`, not by reading two dates that both
> say "2026-09-10". **Every offset the deferral insists on is mapped there:** `elem+0x5c` is
> `collected_`, the two pointee checks are `script_state_->ContextIsValid()` inlined, and the
> compare is `promise_ == data.GetPromise()` — with `rdx` the second ARGUMENT rather than a member,
> which is the part the deferral's own transcription could not make sense of.
> - **AND ITS "state it precisely" CAVEAT IS SUPERSEDED, WHICH IS THE SHARPER HALF.** The precise
>   statement it hands you includes the two-containers-on-`rsi` premise, recorded in `fdd99c1` at
>   23:44 PT the night before and **struck in `ff4b829` as a splice of two loops** — so this block
>   sits between a premise and its refutation and carries the premise forward. A session obeying it
>   to the letter would go hunting a structure that does not exist, guided by the sentence warning
>   it not to. The strike says so in its own words: the premise *"was about to become the premise of
>   a search for a bookkeeping structure that does not exist"* — which is exactly what this block
>   still instructs.
> - **THE OPEN BLOCK IS WHAT A FRESH SESSION READS FIRST, so leaving this standing costs a whole
>   session** — either asking the owner to authorise work already done, or doing it and re-deriving
>   `HandlerAdded` from scratch. That is the Feature E fold-in failure arriving inside the block
>   whose only job is to say what is left, and the third time this file has recorded containing its
>   own refutation and being read past (unit 45719, the duplicate-facility story).
> - **THE RULE: strike a deferral when the thing it defers is done.** A newer entry further down is
>   not a correction, because nothing makes a reader of the older one aware of it. **What is still
>   open is the FORWARD hunt** — name what maps the 2 MiB sections — and that one genuinely has no
>   answer yet.
>
> #### AND CI CAUGHT A REAL REGRESSION FROM THE EXTRACTION — THE ~28th INSTANCE
>
> `keepwarm-recycle.test.mts` pinned `'--hide-crash-restore-bubble'` in `rc-keepwarm.mjs`'s OWN
> source and the move took the literal with it. Behaviour was unchanged. **Re-anchored rather
> than relaxed, and the extraction WIDENS what the guard must cover**: pointing the assertion at
> the new file would have left the three banned throttling flags scanned in only one of the two
> places they can now be reinstated. `launchCode` is the UNION. **The mutation that matters is a
> throttling flag added to the NEW module** — it passes against a naive re-point and fails now.
>
> **AND THE FAILING TEST NAME WAS UNREACHABLE THROUGH CI, AGAIN.** `not ok` appears **zero**
> times in everything `get_job_logs` returns over a job reporting `# fail 1`; the `ok`-number
> technique bounded it to **12..1229** and no further. **`npm test > log 2>&1` locally, then
> `grep '^not ok'`, is still the only route to the name** — it took one run and named it exactly.


> ### 2026-09-10 — TWO PHONE-REPORTED DEFECTS, BOTH FIXED; THE RDR BURST IS STILL OPEN
>
> **Read "ANDROID 16 IGNORES `overlaysWebView: false`" directly above before touching anything
> native.** Eighteen screens outside the `(app)` route group drew under the status bar on a
> current Pixel and took no taps at the top — including **`/claim`, the 08:00 hand-off**. Fixed
> with `env(safe-area-inset-top)`, the pattern `V2Nav`/`/admin`/`/auto-cart` have used since
> August. **Web-side: it reaches installed apps on a push, no rebuild, no review.**
> **THE ONE THING OUTSTANDING IS A SCREENSHOT** — `env()` is 0 in headless Chromium and the
> container cannot reach the live site, so nothing here has SEEN it on a phone. Open `/claim` or
> `/privacy` on the Pixel after the deploy; the CampHawk mark should clear the clock.
>
> **DO NOT reach for `capacitor.config.ts` or `NativeBridge.tsx` for this.** Both already set
> `overlaysWebView: false`; Android 16 ignores it, the plugin's own source says so, and there is
> no config that turns edge-to-edge off. They stay because they still work on Android ≤14 and iOS.
>
> **AND "FAVORITES IS SPELT WRONG" WAS ALSO RIGHT — see the entry of that name above.** The
> admin user page rendered `label="Favourites"`, and a sweep found **five more British
> spellings in copy a person reads** (`honour`, `authorise`/`authorised`, `organised`,
> `normalised`, `enrolment`). All six fixed, and `src/lib/us-spelling.test.mts` is the gate,
> because every one of them was invisible to `tsc`, to `next build` and to the whole suite.
> **DO NOT add `cancelled` to that word list** — a test asserts it stays out, and the reason is
> the A2P registered samples, not taste. **DO NOT americanise `'centre'` in `geocode.ts`** —
> it is DATA that matches real place names, and it is allow-listed saying so. **And do not
> "tidy" the comments**: they are British on purpose and the guard strips them, which is the
> only reason it produces one finding rather than four hundred.
>
> **THE RDR REQUEST BURST HAS NOT BEEN FIXED, and that was confirmed by grep rather than
> memory: `futurebookingstartsendsdates` appears NOWHERE in this repo.** Nothing throttles it,
> nothing blocks it, the only `page.route` in the bot is `force-login-prompt.mjs` on Okta's
> `/authorize`. What HAS shipped is instrumentation (#292's `(path, status)` counter), and its
> first reading is the finding: **69,060 asks and not one answer of any kind** — a fourth branch
> outside the three predicted reading rules. The labelled candidate is requests queued in the
> renderer faster than the connection pool drains; **untested.** And the burst/leak decoupling is
> settled five times over in both directions, so **do not re-link them**, and **do not reach for
> blocking the requests before the cause is named** — that trades a rate-limit risk for a missed
> cart on the resident page an 08:00 hold depends on.

> ### 2026-09-09 (evening) — THE GPU CENSUS ANSWERED, AND THE SPIN IS SAMPLED NOW
>
> **THE READING THE LAST THREE BLOCKS WERE WAITING FOR IS IN.** A natural ramp arrived at
> **10:19:40 PT, three minutes after the box took `2f006b7`**, and the GPU census fired on it:
> the renderer's main thread at **100% of a core**, the control renderer at **0%**, and the
> **GPU process at 0 ms across 21 threads** — the predicted BLOCKED branch, i.e. the
> client-allocates-service-never-drains shape. **Quote it as the verdict does: CONSISTENT WITH,
> NOT PROOF.** An idle service is also what you see if nothing was ever sent to it; what it did
> was fail to refute. Free corroboration in the same scan's baseline dump: a HEALTHY browser's
> biggest shared-memory owner is **`gpu/command_buffer_memory — 2 MB across 2 mappings`**, the
> same allocator and the same 2 MB unit the ramping renderer holds 13,320 of.
>
> **`#310` WAS COMMITTED AT 10:47 PT SAYING "only a ramp is outstanding" — 28 MINUTES AFTER THE
> RAMP THAT ANSWERED IT.** Read the corpus before trusting either doc's state line.
>
> **WHAT IS NEW AND WHAT IT NEEDS: `VMSTACK` (this branch) samples the spinning thread's
> INSTRUCTION POINTER from outside the process.** The census named the symptom; this names the
> cause, and its two answers live in opposite halves of the system:
> - **inside a loaded module** -> a NATIVE loop; `chrome.dll+0xOFFSET` is fixed for a build and
>   the scan reports chrome.dll's version beside it, so it symbolizes offline and names the
>   function. The fix is then Chromium-level.
> - **executable but in no loaded image** -> JIT-compiled code, i.e. **RC's own page script** is
>   the loop, and the fix is on our side of the page with no Chromium change.
>
> **AND IT REFUSES BEFORE IT NAMES EITHER.** `Rip` is byte 248 of the x64 CONTEXT (six debug
> registers, not eight); a wrong offset returns a stack pointer, which belongs to no module and
> would render as JIT — a plausible answer for the wrong reason. Every address is asked whether
> its page is executable, on an axis independent of the module check, and a non-executable
> majority is REFUSED. `src/lib/leak-capture.test.mts`, 21 mutations, each verified to apply and
> caught. **Guards under `src/` and `scripts/`, in neither `worker-deploy.yml` `paths:` list —
> read, not remembered — so this fires NO worker deploy.**
>
> **THE GATING ITEM IS THE BOX UPDATE, NOT A RAMP.** It is bot-side and inert until the mini-PC
> takes it; confirm with `npx tsx scripts/bot-ask.mts git-status`, **never
> `autocart.bot_version`** (it COALESCEs). There are **no live holds**, so the 6 h release gate
> is open and an "Update now" lifts the quiet window.
>
> ### RAMP GAPS ARE 2.3h TO 18.6h — AND BOTH EARLIER FIGURES WERE WINDOWS
>
> **CORRECTED 2026-09-10 by a four-day recount.** Nine natural gaps: 18.6 / 5.4 / 5.7 / 13.9 /
> 4.3 / 2.5 / 2.3 / 3.5 / 11.1 h, median ~5.4. The "2.3-4.2 h" below is the 09-09 cluster and has
> the same defect it accused "5-28 h" of having. **Quote the range.** The five timestamps below
> are a correct reading of that day and are left as written; **the two forward-looking clauses in
> them are not** — see the strikes.
>
> Five in 12.5 h off `bot_events`: **04:45, 08:59, 11:30, 13:47, 17:19 UTC**. `bail:ramp` fired
> on all five, 3-35 s after the scan. ~~**So the next reading is hours away, not days** — and
> every entry quoting 5-28 h describes a quieter regime.~~ **Both struck 2026-09-10**: over four
> days the gaps reach 18.6 h, so "hours away, not days" is true about half the time; and the
> 5-28 h entries were describing the same distribution from the other end rather than a different
> regime.
>
> **"No ramp dump" on any of them is ARITHMETIC, not a regression:** the renewal trips read
> **46.7-59.1 s** in `TAB CLOSES` against `MEM_DUMP_STALL_MS` of 90 s, so the stall trigger
> correctly never fired. Read the trip durations first, and do not lower the threshold — a
> wedged renderer contributes zero allocator dumps anyway.
>
> ### WHEN A RAMP COULD BE FORCED — 22:33:36 PT TONIGHT, AND IT SHOULD NOT BE
>
> The recipe needs **Okta GONE and the RC token dead**. The token is already dead; Okta is the
> binding half, and its ABSOLUTE cap is **FROZEN — measured, not inferred**: across a real
> 20-minute probe the CHECK advanced (18:55:27 -> 19:15:28 UTC) and `okta_expires_at` did not
> move from `2026-09-10T05:33:36Z`. A rolling window prints exactly `+12.0000h` from the check
> (12 for 12); this read `+10.64h` then `+10.30h`, shrinking by the elapsed time.
>
> So the window opens at **22:33:36 PT**, plus up to an hour for the token to lapse behind it.
> **Four or five natural ramps arrive before then.** Forcing is 3-in-6, spends the warm-up's one
> turn per Okta lifetime, and costs a password submission from an address that has eaten a
> twelve-hour block. **Do not.**
>
> ### STILL FORBIDDEN, each for a recorded reason
>
> The memory dump as a route to the owner (a wedged renderer contributes ZERO allocator dumps at
> every level, measured off-box); **Track B** (the renewal's Okta trip is measured flat, -4 MB);
> **parking the resident page** (refused by `checkAndReport`'s localStorage rule, which would
> silence `autocart.rc_session` and the phone alarm); **lowering `LOW_RAM_MB`** (killed a working
> repair on 08-19); **lowering `MEM_DUMP_STALL_MS`**; narrowing `verify.yml`'s triggers;
> `ReadProcessMemory`/minidumps; and forcing a ramp out of impatience.
>
> ### AND DO NOT REBUILD THESE — each was measured blind for a knowable reason
>
> The heap trail (`JSHeapUsedSize` excludes external memory) · Track A / the sampling profiler
> (1-74 MB against 8-9 GB) · the RAM arm (untouched commit never lowers free RAM; 16+ consecutive
> ramps) · the memory dump's ownership graph for a wedged renderer.

> ### 2026-09-09 (later) — VMTHREAD ANSWERED: THE MAIN THREAD IS SPINNING
>
> **Read `CLAUDE.md` → "VMTHREAD ANSWERED ON ITS FIRST RAMP" before anything else. The
> outstanding reading of the last four sessions is TAKEN.**
>
> **State: master `45019ec` (#306 merged), the mini-PC on `45019ec` TOO — so both new
> instruments are LIVE and have already fired.** 3/3 shards, health **19 of 19 ok**, no holds
> queued, highest migration 076, main's block **077-079**. One open PR (**#307**) and it is the
> **side lane's**, not ours.
>
> **THE FINDING.** The ramping renderer's **main thread burns 100% of a core** (tid 7876, 1,203
> ms of a 1,200 ms window, `state=Running`) against a CONTROL renderer at **0% on
> `EventPairLow`**. The main thread is where CDP is serviced — **so three instruments failing on
> three different calls was never three reasons, it was one, and it is now named.** "Fire
> earlier" is closed from the other side too: the resident trail read `EMPTY` for a whole 165 s
> browser life, so it is quiet from birth. **There is no window in which that renderer both
> holds the sections and answers.**
>
> **VMSPAN answered as well: SCATTERED, 16,383 regions over a 132,797,914 MB span (4053x)** —
> not carved from one reservation, so the cage/pool/sandbox branch is out. **Read `VMMAP2M`
> (16,383 regions / 16,382 allocation bases), not the adjective**: the `SCATTERED` verdict fires
> on the 4-region control too and does not discriminate.
>
> **THE NEXT MOVE IS ONE LINE AND NEEDS NO NEW INSTRUMENT: run VMTHREAD on the GPU PROCESS of
> the same family.** It runs on TARGET and CONTROL today. **Renderer spinning + GPU process idle
> is the client-allocates-service-never-drains shape**, which confirms the `MappedMemoryManager`
> candidate from outside without asking Chromium anything; a busy GPU process is a different
> investigation. The same scan's `CHROME` lines already lean that way (`gpu-process privateMB=82
> handles=609` against the target's `3325 / 18119`) and are **not** a thread census.
>
> **THE CANDIDATE IS SHARPER AND IS STILL A CANDIDATE — do not write it in.**
> `mapped_memory_chunk_size` is 2,097,152 bytes against 32,778 MB / 16,387 = 2.0000 MB; one
> shared region per chunk, in the renderer, anonymous, READWRITE; JS heap flat at 8-11 MB; RC
> runs a WebGL map whose command-buffer client lives on the main thread; and `FreeUnused()`
> reclaims only blocks whose **tokens have passed**, which a thread that never returns to its
> message loop cannot advance. Fits everything. Tested by nothing.
>
> **ALL THREE OF TODAY'S RAMPS WERE TOO SHORT TO ATTEMPT A DUMP, AND THAT IS ARITHMETIC.**
> 01:57, 04:27 and 06:46 PT, ~2-4 minutes each, peaking **3.9-4.0 GB** against 8-9 GB all week.
> The renewal trips completed in **46.9 s and 47.5 s** against `MEM_DUMP_STALL_MS` of 90 s, so
> the trigger correctly never fired. **Do not read "no ramp dump" as a regression** — read the
> trip durations in `TAB CLOSES` first. **And do not lower the threshold**: it would fire on
> more ramps and every one would return an empty dump, spending the discrimination 90 s was
> measured for.
>
> **THE PEAK BEING DOWN IS NOT A CURE AND IS CREDITABLE TO NOTHING.** Three ramps is not a
> regime; every "not reproduced this session" reading in this file was a window that missed one.
>
> **STILL FORBIDDEN, each for a recorded reason:** the memory dump as a route to the owner (a
> wedged renderer contributes ZERO allocator dumps at every level), Track B (the renewal's Okta
> trip is measured flat, −4 MB), parking the resident page (refused by `checkAndReport`'s
> localStorage rule), lowering `LOW_RAM_MB` (killed a working repair on 08-19), narrowing
> `verify.yml`'s triggers, `ReadProcessMemory`/minidumps, and **forcing a ramp out of
> impatience** (3-in-6 odds, one attempt per Okta lifetime, spends a password submission from an
> address that has eaten a twelve-hour block).
>
> ### AND THE RELEASE-WINDOW ROUTINE FINALLY RECORDED (2026-09-09 07:56 PT)
>
> **`rc_release_readings` is non-empty for the first time after four lost firings** (09-05
> fresh session with no repo; 09-06 and 09-07 a bound session mid-turn; 09-08). Today it ran in
> the window: **15 nights, 279 polls, 0 unreadable, 15 of 15 flipped**, `recorded 2 facility
> row(s)`.
> - `rc-583` locked **−1.6s** → free **+0.4s** (13 nights) · `rc-539` locked **−0.9s** → free
>   **+1.1s** (2 nights) · `rc-542` had no locked nights for this release.
> - **BOTH BRACKETS STRADDLE T, SO NEITHER CONFIRMS NOR CONTRADICTS THE 09-04 FINDING.** That
>   reading rests on rc-583's `−2.2 → −0.2`, entirely before T, and is untouched. **Quote the
>   negative bracket, never the `+0.4s` median.**
> - **ONE CLEAN CONTENTION OBSERVATION, WHICH IS RARE.** `#L015 @2026-09-11` was re-taken by
>   **+74.3s** — and the hold for that unit was **offered and never tapped**, so we demonstrably
>   did not cart it. The standing caveat ("our own carts look identical to a competitor's") does
>   not apply here.
> - The Routine self-disables on any Pacific date ≥ 2026-09-12, so **~2 firings remain**. The
>   recorded remedy for a missed one is still to run it by hand before 07:58:30 PT, **not**
>   another schedule tweak.

> ### 2026-09-09 — THE SUBSCRIBER READ (#307). THE LEAK ENTRY BELOW IS THE STANDING PRIORITY.
>
> **Two main-lane sessions ran today.** This block is the billing/acquisition side; the leak
> blocks either side of it are the other lane's live thread and outrank this for attention.
> Neither touches the other's files. **`git fetch origin master` before trusting either.**
>
> **#307 IS MERGED-OR-OPEN — CHECK, DO NOT ASSUME.** Three commits, CI green on all three,
> `npm run verify` 2022/2022 locally. Full write-up: CLAUDE.md → "THE TWO NEW SUBSCRIBERS PAID
> FOR THREE FINDINGS".
>
> **NOTHING IN IT NEEDS A BOX UPDATE OR A DEPLOY BEYOND VERCEL.** No `worker/` runtime code and
> no `scripts/auto-cart-bot/` change; the one `worker/*.test.mts` touched is a re-anchor, which
> does fire a worker deploy and restarts the pollers — expected, check `poller.shards` after.
>
> **THREE THINGS ARE NOW TRUE THAT WERE NOT:**
> - `users.sms_consent_at` is written by the save that captures it. **Ten accounts remain
>   without one and are NOT backfilled** — the honest date does not exist. If a carrier ever
>   asks about those ten, that is the answer.
> - `/new` no longer promises auto-cart, or an 8am RC hold, to a reader with no entitlement.
> - `watches.notify_sms/notify_email/notify_push` are documented as dead by a guard rather
>   than by a comment nobody reads.
>
> **THE ACQUISITION INSTRUMENT HAS ITS FIRST INTERESTING READING AND IT IS `chatgpt.com`** —
> landing to paid in **3.5 minutes**, first watch on the exact campground page they landed on.
> **n=1 and client-supplied.** Worth watching, not yet worth acting on:
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/funnel-readout.mts`. **37 accounts still carry no
> source, so the source table is not a share of anything yet.**
>
> **ONE CHURN RISK, UNACTIONED BY CHOICE.** An Auto-Cart subscriber ($10/mo, trial converted
> 09-08) has **zero active watches** — his Tahoe watches closed themselves when the trip
> passed, which is correct. A re-engagement note is **drafted in Gmail and deliberately
> unsent** (owner's instruction, 09-09). He set `email_alerts_opt_in = false`, which is an
> ALERT preference rather than a blanket unsubscribe — that distinction is the owner's call,
> not an agent's.
>
> **STILL OPEN, AND NOT TO BE DONE IN PASSING:** the fixed-sentinel fixture class is fixed for
> `sms-consent` only. `sync-claim`, `ridb-photos` and the hold suites still have it.
>
> **TWO TRAPS THIS SESSION PAID FOR:** the GitHub API's `head_sha` needs the **full 40
> characters** — a short sha returns zero runs and reads as "CI never started"; and
> `git checkout -- <file>` during mutation testing reverts to HEAD, so **commit before
> mutating** or the fix under test is what gets deleted.

> ### 2026-09-09 (later) — THE DUMP IS RETIRED; THE READING MOVED OUTSIDE THE PROCESS
>
> **SUPERSEDED BY THE BLOCK ABOVE FOR ITS ONE ACTION ITEM — the two instruments it says to
> wait for have BOTH ANSWERED. Everything else here stands.** Read it for why the dump is
> retired and why the four probe runs before it were artifacts; do not read its "wait for a
> ramp" as outstanding.
>
> **Read `CLAUDE.md` → "THE DUMP CAN NEVER ANSWER — A WEDGED RENDERER IS *PRESENT AND EMPTY*"
> first. Do not spend another ramp on the memory dump.**
>
> **MEASURED OFF-BOX IN UNDER A MINUTE (`node scripts/auto-cart-bot/dump-wedge-probe.mjs`):**
> a wedged renderer contributes **ZERO allocator dumps at `detailed`, `background` AND
> `light`.** Chromium's own coordinator gives up on it at **~15,050 ms**, returns
> `success: false`, and emits an **empty** process dump while its healthy peers contribute
> normally. So it was never missing — it was present and empty, and our fold dropped it. **A
> longer timeout buys an empty dump sooner; a cheaper level buys the same empty dump.** And the
> box's own `alloc trail [resident]: EMPTY — that renderer answered no CDP call at all` (09-09
> 11:30, a whole 165 s browser life) closes "ask it earlier" too: it is quiet from birth.
>
> **FOUR EARLIER RUNS OF THAT PROBE WERE ARTIFACTS AND EACH WAS ONE SENTENCE FROM BEING
> WRITTEN UP** — three said "no level answers" because a previous arm had left tracing started
> so nothing ever asked, one said "background works" because a timed-out `detailed` arm's late
> data was counted as its own. One arm per browser now, and the score is the allocator COUNT,
> because presence is exactly what an empty dump has.
>
> **WHAT SHIPPED INSTEAD — two additions to the region walk, the one instrument that needs
> nothing from the renderer. Both are BOT-SIDE and inert until the box updates**
> (`npx tsx scripts/bot-ask.mts git-status`, never `autocart.bot_version`):
> - **`VMTHREAD` — SPINNING or BLOCKED, which nothing has ever measured.** Two CPU snapshots
>   1.2 s apart per thread, main thread identified by `StartTime`. One thread holding the
>   window is a spin (and `main=True` says it is Blink/JS/the command-buffer client, which is
>   also *why* it answers no CDP call); **no thread burning CPU means BLOCKED, not looping**,
>   and `wait=` names what on — a different investigation with a different fix.
> - **`VMSPAN` — where the 2-4M population sits.** Packed ⇒ consecutive sub-allocations of ONE
>   reservation (`VMTOP` in the same scan names which); orders larger ⇒ 16k independent
>   mappings, i.e. ordinary shared memory. Free from a field the walk already reads.
>
> **THE NEXT RAMP ANSWERS BOTH AND NEEDS NOTHING BUILT.** They arrive every 5-28 h; the last
> three were 09-09 04:45, 09:00 and 11:30 UTC. Read
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` — the new lines render as
> **absences** ("the box predates VMTHREAD") until the box updates, which is correct and is not
> a miss.
>
> **THREE FREE READINGS CAME OUT OF DATA ALREADY IN THE DATABASE:**
> - **No peer holds the 32 GB.** The 09-08 dump's seven answering processes join to the same
>   generation as the walk; the GPU process holds **2 MB / 601 handles** against the target's
>   **32,849 MB / 17,306 handles**. **Do NOT promote that to "the GPU candidate is refuted"** —
>   the same hypothesis's failure mode predicts it. The reading is "mapped in exactly one
>   process".
> - **The 32 GiB is a CEILING, not a runaway.** Eight walks: 15,499 / 15,663 / 16,219 / 16,385
>   / 16,386 / 16,386 / 16,387 / 16,387 regions. **16,384 × 2 MiB = 32 GiB exactly.** "What has
>   a 32 GiB budget?" is a sharper question than "what leaks?".
> - **Two populations of ramp** — young browser + 17k-75k burst (×7), 85-125 min browser + no
>   burst (×2) — both reaching the same signature, so **the recorded burst/leak decoupling
>   holds**. It also kills "the ramp is always on a young browser", which was about to be the
>   premise of an early dump trail.
>
> **THREE DEFECTS IN THE DUMP ITSELF, ALL FIXED, ALL FOUND BY RUNNING SOMETHING.**
> `Tracing.end` does not stop tracing (the browser is done at `tracingComplete`) — that is the
> mini-PC's `Tracing was stopped before start has been completed` at **11:29:54, which cost
> that ramp its dump**; `started_tracing` went up after the send, so a start whose reply was
> lost left tracing running with the `finally` believing there was nothing to stop; and the
> fold dropped the empty process. **The first version of the tracing fix awaited the send bare
> and was caught by this module's own pre-existing hung-teardown guard.**
>
> **STILL FORBIDDEN, each for a recorded reason:** Track B (the renewal's Okta trip is measured
> flat, −4 MB), parking the resident page (refused by `checkAndReport`'s localStorage rule),
> lowering `LOW_RAM_MB` (killed a working repair on 08-19), narrowing `verify.yml`'s triggers,
> `ReadProcessMemory`/minidumps, and **forcing a ramp out of impatience** (3-in-6 odds, one
> attempt per Okta lifetime, spends a password submission from an address that has eaten a
> 12-hour block).
>
> **AND `rc_release_readings` IS STILL ZERO AFTER FOUR FIRINGS.** Self-disables 09-12, ~3
> chances left; the recorded remedy is to run it by hand before 07:58:30 PT, not another
> schedule tweak.

> ### 2026-09-09 — THE CAPTURE CHAIN IS FINISHED; THE RENDERER IS WHAT WILL NOT ANSWER
>
> **Master `6de1bca` (#305) and the mini-PC `6de1bca` too — the box took it in the quiet
> window, so box and web agree for once; read with `bot-ask git-status`, NEVER
> `autocart.bot_version`. 3/3 shards, no holds queued, highest migration 076, main's block
> 077-079. Health **19 of 19**, which is the `bot_version` warn clearing BECAUSE the shas met —
> do not read a later warn there as a regression, it is the ordinary state for most of a day.
> Nothing bot-side moved: #305 is `src/lib/bot-events.ts` plus the readout, so the box's
> BEHAVIOUR is unchanged from `c0b222c`.**
>
> **#305 FIRED NO WORKER DEPLOY, AND THAT WAS READ RATHER THAN ASSUMED.** `src/lib/bot-events.ts`
> and `scripts/**` appear in NEITHER list in `worker-deploy.yml`'s `paths:`; the newest run is
> still #302's from 09-08 20:49. **A merge-scope claim is not evidence — read `paths:`.**
>
> **THE TRIGGER QUESTION IS CLOSED.** #302's stall trigger caught the 21:43 PT natural ramp, ran
> the dump ~90 s into the stall — **85 seconds ahead of the bail**, reading no file — and four
> consecutive missed ramps end there. The grace, the threshold and the join all did their jobs.
>
> **WHAT IS LEFT IS ONE FACT AND IT IS NOT A PLUMBING FACT: A RAMPING RENDERER ANSWERS NO CDP
> CALL.** pid 7644 held 4,366 MB and 17,306 handles, was the walk's TARGET, was present in the
> dump's own generation, and spent the full 20,000 ms budget in silence against a **194 ms**
> baseline on the healthy replacement. Third instrument, third CDP call, same silence
> (`newCDPSession` 08-18, `Performance.getMetrics` 08-18/19, `Tracing.requestMemoryDump` now).
> **So Chromium's ownership graph — the only thing that can name the creator of an anonymous
> section — is unreachable exactly when it would say something.**
>
> **DO NOT REACH FOR THE TWO OBVIOUS FIXES WITHOUT PAYING THEIR PRICE.** *Fire earlier*: 90 s was
> measured against 133 tab-closes whose longest trip is 71,552 ms, and the series says the window
> is not there anyway — at 21:40:54 the browser did not exist, and by 21:42:54 its renderer held
> 2,297 MB with the ~35 GB commit step already complete. *Raise the timeout*: 20,000 ms is
> already the budget, and 2026-08-18 closed this once — *"the reading cannot be taken at the trip
> at all, and no timeout worth spending changes it."* **The honest shapes are a reading that does
> not need the renderer's cooperation, or one taken BEFORE it goes quiet — the trail move that
> retired the heap trail's own silence.**
>
> **THE FALSIFIABLE CANDIDATE NEEDS NO INSTRUMENT AND NO RAMP TO STATE:**
> `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is **2,097,152 bytes**, and the walk's
> 32,773 MB / 16,385 regions is 2.0000 MB exactly, one allocation base each, anonymous,
> READWRITE, in the renderer. **`gpu/mapped_memory` at ~32 GB in a ramp dump confirms it;
> absent-or-small does not and is its own finding.** Discardable is already weakened on the same
> evidence (4 MB segments, not 2).
>
> **THE WALK IS FOUR FOR FOUR AND NEEDS NO REPEATING.** So does the burst: still independent of
> the leak in both directions, five sightings now.
>
> **DO NOT FORCE A RAMP OUT OF IMPATIENCE.** Three ordered attempts, three in six overall for the
> `okta=GONE` cell, and a successful warm-up leaves Okta ALIVE — so the real budget is **one
> forced attempt per Okta lifetime**, spending a password submission from an address that has
> eaten a twelve-hour block. Natural ramps arrive every 5-28 h and the trigger is live for all of
> them. The recipe, for when a reading IS wanted at a known moment, is in `docs/NEXT-SESSION.md`.
>
> **STILL FORBIDDEN, each for a recorded reason:** Track B (the renewal's trip is measured flat),
> parking the resident page (refused by `checkAndReport`'s localStorage rule), lowering
> `LOW_RAM_MB` (killed a working repair on 08-19), and narrowing `verify.yml`'s triggers.
>
> **AND `rc_release_readings` IS STILL ZERO AFTER FOUR FIRINGS** (09-05/06/07/08). The Routine
> self-disables 09-12, so ~3 chances remain, and the recorded remedy is **not** another schedule
> tweak — run it by hand before 07:58:30 PT.

> ### 2026-09-08 (evening) — THE ORDERED RAMP FIRED AND MISSED, AND ONE CLAIM IS CORRECTED
>
> **Master `6eee69f`, mini-PC `c0b222c` (`bot-ask git-status`), 3/3 shards, no holds queued,
> highest migration 076, main's block 077-079. Health 16/19 — `rc_session` (dead between
> releases), `bot_version` (box vs web, and the check itself says *"No bot-side code in the
> gap"*), `rc_login` (rehearsal stand-down). All documented-benign.**
>
> **THE CORRECTION FIRST, BECAUSE IT IS THE OPTIMISTIC HALF.** *"The stall trigger fires on the
> next stall over 90 seconds, which is far more often than a ramp"* is **WRONG**: across **133
> tab-closes the longest trip is 71,552 ms and not one exceeds 90,000.** A stall over 90s has
> never happened outside a ramp. The trigger is precisely discriminating — no healthy trip can
> spend the ramp's slot — and it **still needs a ramp to be exercised**. Only the trigger PATH
> got cheaper to test, not the reading.
>
> **NO RAMP FOR 12 HOURS.** Last one 09-08 07:47 PT, *before* the box took the stall trigger at
> 13:57, so the new code has never seen one. Hourly peaks since: 307-500 MB. The spread is
> 5-28 h, so this is **neither a cure nor a fault** — every "not reproduced this session"
> reading in this file was a window that missed one.
>
> **SO ONE WAS ORDERED — `trig_01DbvqTrehodKTp1Axq52rzM`, 2026-09-09 05:30Z (22:30 PT) — AND IT
> RAN, AND IT MISSED.** Both preconditions were READ and both were dead (`okta_alive false`,
> `okta_expires_at null`, `session_ok false`, checked 3.5 min earlier), the hold went in on unit
> 4756 (Carpinteria SB — Santa Rosa #R306), the warm-up fired 20 seconds later and completed the
> full password form in **16 seconds for a 587 MB peak** — no ramp, no bail, no dump. The hold
> was deleted immediately and 0 live holds remain. **The one-shot has disabled itself and will
> not refire.** Full account: **"A THIRD ORDERED ATTEMPT, AND THE MEMORY SERIES IS WHAT
> CONFIRMED THE MISS"**.
> - **THE TIMING IS THE WHOLE DESIGN.** At arming, BOTH preconditions failed — token alive 60m,
>   Okta alive to 21:49 PT. Okta's **absolute cap** lapses then and cannot be pushed out by our
>   probing (measured not to reset across a sign-in on 08-16, 08-21 and 09-07); the token dies
>   ~21:01 and the renewal will likely mint one more good to ~22:05. 22:30 sits just past both.
> - **IF EITHER IS STILL ALIVE, THE FIRED SESSION DOES NOTHING AND RE-ARMS.** A live token makes
>   `attemptLogin` short-circuit in 4.5s and **spends the warm-up's only turn** — the #296 trap.
>   **An unspent turn is worth more than a wasted attempt.**
> - **NO CAMPSITE IS LOCKED.** `--in 120` opens the T-3h..T-30 window at once with 90 minutes of
>   margin, and the hold is deleted the moment the trip is under way.
> - **3 IN 6 NOW, ONE ATTEMPT PER OKTA LIFETIME.** A successful warm-up leaves Okta ALIVE and
>   shuts the window until it lapses again. **A miss — a fast clean sign-in, no ramp — is a
>   NORMAL outcome at these odds and was reported as one, not hunted as a fault.**
> - **DO NOT RE-ARM ON A MISS.** The next GONE window is ~12h out, natural ramps arrive every
>   5-28h, and the stall trigger is live for all of them — so waiting costs nothing, while each
>   forced attempt spends a password submission from the address that has eaten a twelve-hour
>   block. Forcing is for when a reading is wanted at a known moment, not for impatience.
>
> **SO WHAT IT WAS MEANT TO BUY IS STILL OUTSTANDING: the first ramp the stall trigger has ever
> seen.** It fires at 90s reading no file, three ticks ahead of the bail, with the dump's full
> 20s behind it and the grace holding while it is in flight. If a dump lands, the readout joins
> its `MDPROC` pids against the walk's TARGET and prints `VOID` on a mismatch — then
> **`gpu/mapped_memory` at ~32 GB confirms the `mapped_memory_chunk_size` candidate and
> absent-or-small does not.** Nothing needs building; it needs a ramp.
>
> **AND `rc_release_readings` IS STILL ZERO ROWS AFTER FOUR FIRINGS** (09-05, 06, 07, 08). The
> Routine self-disables 09-12, so ~3 chances remain. The recorded remedy is **not** another
> schedule tweak — it is running it by hand before 07:58:30 PT.
>
> ### 2026-09-08 (latest) — THE METHOD CHANGED; THE TRIGGER NO LONGER NEEDS A RAMP TO TEST
>
> **Master and mini-PC both `c0b222c` (`bot-ask git-status`, never `autocart.bot_version`);
> 3/3 shards; no holds queued; highest migration 076; main's block 077-079. Health 17 of 19,
> the two warns being `rc_session` (dead between releases — the update killed the browser) and
> `rc_login` (standing down inside the quiet window after a restart), both documented-benign.**
>
> **ASKED WHY WE KEEP MISSING THINGS. THE ANSWER IS COUNTABLE: all four missed ramps were in
> the dump's TRIGGER, never in the dump.** It has never failed when it was allowed to run — six
> baselines, 209-332 ms, ownership edges resolving on Linux and Windows. Four ramps, 5-28 hours
> apart, went on the plumbing, because nothing anywhere exercised the trigger off-box.
> CLAUDE.md → **"THE METHOD WAS THE PROBLEM, NOT THE LEAK"**. Do not re-derive it.
>
> **THE TWO CHANGES THAT MATTER.** The dump is now triggered by **the loop's own stall**
> (`MEM_DUMP_STALL_MS`, 90s, before every arm, reading NO file) — which retires all four
> failure modes at once, because none can reach a trigger that consults nothing. And
> **`ramp-arm-probe.mjs` drives the trigger path against a real Chromium in seconds**: three of
> the arm's four inputs are forgeable, so the 09-08 conditions reproduce with no ramp.
> **Verified to FAIL against both bugs it exists for.**
>
> **90s IS MEASURED**: the longest renewal in forty tab-closes is 71.5s and the bail needs 120s.
> The budget is **per stall episode**, so a slow healthy trip cannot spend the slot the real
> ramp needs. The threshold and the grace are both KEPT — each wins a case this does not.
>
> **AND THE PROBE ANSWERED AN ASSUMPTION FROM THE FIX AN HOUR EARLIER**: `inFlight` really is
> still set when the reporting callback resolves, so the hold really does cover the POST. That
> was reasoned, not measured, until now. A real dump takes ~390 ms; a dump against a closed
> browser returns in 1-2 ms and cannot strand the flag.
>
> **THE LEADING CANDIDATE IS NAMED FROM CHROMIUM'S SOURCE, AND IT IS FALSIFIABLE IN ONE LINE.**
> `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is **2,097,152 bytes** — the same number
> as the walk's 32,778 MB / 16,387 — with **one shared region per chunk**, in the renderer, and
> `FreeUnused()` reclaiming only **when the command-buffer token advances**, `max_allocated_bytes`
> defaulting to `kNoLimit`. A ramp is a renderer whose loop stopped advancing. **`gpu/mapped_memory`
> at ~32 GB in the next ramp dump confirms it; absent or small does not.** Discardable is
> weakened on the same evidence — it allocates **4 MB** segments, not 2.
>
> **`mapped-memory-repro.mjs` DID NOT REPRODUCE IT off-box across three load shapes, and that is
> NOT a refutation** — SwiftShader, a different GPU stack and a synthetic load. It did establish
> that `gpu/mapped_memory` is a name the dump emits, and that a healthy WebGL renderer under
> load holds tens of MB.
>
> **STILL OUTSTANDING, UNCHANGED: one `mem-dump` with `phase: ramp` whose `MDPROC` pids contain
> the walk's TARGET.** The readout does the join and prints `VOID` when they disagree.
>
> ### 2026-09-08 (later) — THE FOURTH MISS: THE GRACE WAITED FOR NOTHING
>
> **Master and mini-PC both `9641e14` (`bot-ask git-status`, never `autocart.bot_version`),
> 3/3 shards, no holds queued, highest migration 076, main's block 077-079.**
>
> **THE GRACE REACHED THE BOX AT 07:45:50 PT AND A NATURAL RAMP ARRIVED AT 07:47:50 — 120
> SECONDS LATER. IT FIRED, IT HELD, AND THERE IS STILL NO `ramp` DUMP.** The log has the
> `* holding the bail up to 15s` line and then neither a `memory dump (ramp) …` nor a
> `did not run` line. Cause, and it is arithmetic twice over: `rampDumpGrace` took a single
> `dumpTaken` which the caller set **when the dump STARTS**, so the next tick took the
> `already under way` branch **above** the deadline check and bailed **ten seconds in**; and
> the deadline would not have been enough either, because `MEM_DUMP_TIMEOUT_MS` is **20s**
> against a **15s** grace — **two constants with no stated relationship, ordered the wrong way
> round.** The old guard bounded the grace against the TICK and nothing compared it with the
> dump's own timeout. CLAUDE.md → **"THE FOURTH MISS: THE GRACE WAS A PERMISSION SLIP, NOT A
> WAIT"**. Do not re-derive it.
>
> **FIXED: the hold runs WHILE THE DUMP IS IN FLIGHT, to a deadline DERIVED from the dump's own
> timeout.** `inFlight` clears in the dump's `.finally`, and `.finally` waits for the `.then`
> chain, so the hold covers the POST as well as the dump. It can delay the bail (~20-30s
> worst case) and still cannot prevent it; the three-tick ceiling is kept and nothing was
> relaxed. **ON THE BOX as `9641e14` (2026-09-08 16:2x UTC, `bot-ask git-status`); fleet 3/3
> shards, health 17/19 with the two documented-benign warns. It needs only a RAMP.**
>
> **HOW TO READ THE NEXT ONE.** `* holding the bail up to 20s` is the grace being granted; then
> either `memory dump (ramp) in Nms`, or one of two named expiries — `still in flight` (a
> browser too slow to answer inside its own budget) versus `without a dump` (nothing could
> start). Those are different findings and used to print as silence. Then
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`, MEMORY DUMPS; the readout does
> the pid join and prints `VOID` when the dump and the walk disagree.
>
> **THE SAME RAMP GAVE TWO THINGS FREE, AND NEITHER NEEDS REPEATING.** The walk is
> **three-for-three** (16,387 regions / 16,382 bases / 32,778 MB, all anonymous, control's
> file-backed positive control present), with EXCESS 36,223 MB against an OS commit gap of
> 39,736 MB. And the burst's fourth sighting is its **second with statuses**: 18,953 asks,
> `no answer recorded`, zero of every code — the fourth branch, twice. **Still do not re-link
> the burst to the leak**: this ramp carried both, 09-07 20:42 carried the same 32 GB with a
> flat counter.
>
> ### 2026-09-08 — THE DUMP MISSED A THIRD TIME, AND THE THIRD MECHANISM IS THE SAMPLER'S CADENCE
>
> **Master `6843973`, mini-PC `6843973` (read by `git-status`, not `autocart.bot_version`),
> 3/3 shards, no holds queued, highest migration 076, main's block 077-079.** Health 17 of 19;
> `detect:ridb` read **fail** at the start of this session (*"0 campsites across 15 campgrounds
> — API likely down"*) and was **ok** an hour later with `consecutive_failures: 0`. Transient,
> and the reading-goes-stale-faster-than-a-conclusion rule applied — not an incident.
>
> **A NATURAL RAMP ARRIVED AT 02:03 PT WITH #296 LIVE, AND THERE IS STILL NO `ramp` DUMP.** One
> in the whole table and it is the VOID one from 09-07. The memory series is the diagnosis and
> it takes three rows: **238 MB → 3,423 MB → 205 MB across two two-minute samples.** The onset,
> peak and bail all fit inside ONE sampler interval, so **no sample landed between the dump's
> 1500 and the arm's 3000**, the single reading was over both, and the arm returned before the
> dump was called — exactly as on 09-07. **The head start is measured in megabytes and paid in
> SAMPLER TICKS**, and no threshold separation can guarantee one. Full account and the fix:
> **"THE THIRD MISS: THE HEAD START IS MEASURED IN MEGABYTES AND PAID IN SAMPLER TICKS"**.
>
> **FIXED BY GRANTING THE TICK: the bail now HOLDS for the dump, bounded, once per browser
> life** (`rampDumpGrace`). **BOT-SIDE — it needs a box update before it means anything**, and
> then a ramp. The threshold is kept: it still wins the ~half of ramps where a sample does land
> in the gap (09-07 20:40 read 2,811 MB, which would have been caught).
>
> **THE SECOND WALK CORROBORATES THE FIRST**: 16,213 regions / 16,212 allocation bases /
> 32,443 MB in `2-4M`, all READWRITE, all anonymous, with the control's file-backed entry
> present both times as the census's own positive control. N separate `MapViewOfFile` calls,
> twice, two days apart. **The walk needs no repeating.**
>
> **AND THE STATUS COUNTER ANSWERED ON ITS FIRST BURST — with a fourth branch nobody had.**
> **69,060 asks on `futurebookingstartsendsdates` and not one answer of any kind**: no 2xx, no
> 401, no `failed`, while every other path in the same snapshot carries a code. So the three
> recorded reading rules all miss. Candidate, labelled as one: requests issued faster than the
> connection pool can drain. **Do not re-link it to the leak** — the same ramp carried both and
> 09-07 20:42 carried the same 32 GB with a flat counter. Full entry: **"IT ANSWERED ON ITS
> FIRST BURST, AND THE ANSWER IS NONE OF THE THREE"**.
>
> ### 2026-09-07 — THE RAMP CAME, THE DUMP FIRED, AND IT MEASURED THE WRONG BROWSER
>
> **Master `3867988` (#291 + #292 merged), no holds queued, migrations still highest 076 with
> main's block 077-079.** Health: `rc_session` and `bot_version` were **ok**, not the warns the
> previous block predicted.
>
> **THE BOX NEEDS AN UPDATE AND BOTH OF THIS DAY'S FIXES ARE BOT-SIDE.** It was on `6a76677`,
> which predates the `notBefore` gate (#291) and the status counter (#292). Until it updates,
> a `ramp` dump can still fire against a fresh browser after a bail, and the readout will keep
> printing `statuses not reported`. **Confirm with `npx tsx scripts/bot-ask.mts git-status`,
> never `autocart.bot_version`.**
>
> **THE 22-HOUR DROUGHT BROKE AT 09-07 02:03 PT and the memory dump fired its `ramp` phase for
> the first time. THE READING IS VOID — do not quote it.** The join the readout tells you to
> make answers no: the region walk names the ramping renderer **pid 9912** (browser process
> 3836); the dump reports **7316, 2960, 6376, 13324, 10176, 7660, 14400** and its lead 7316 is
> the same lead the BASELINE reports three minutes later. A `bail:ramp` at 02:03:46 killed that
> generation and the supervisor brought up a new browser, which is what got dumped. **Full
> account and the fix: "IT FIRED ON A RAMP AND MEASURED THE WRONG BROWSER".**
>
> **SO THE SMALL-READING VERDICT IS NOT AN ANSWER.** *"2 MB … the sections are NOT base shared
> memory, which eliminates discardable, mojo and the GPU transfer path together"* is rendered
> over a healthy fresh browser. **The open question is exactly where it was**: whether the
> ramping renderer's 16.4k sections appear in `shared_memory` at all. Both branches still answer.
>
> **FIXED, AND THE BOX HAS IT: it updated to `15f791c` at 09-07 09:08 PT, in 33 seconds.**
> `readLatestMemory` gained `notBefore` (the browser-life start), so a sample taken before this
> browser existed is UNKNOWN and **both arms stand down**. The bail arm had the same exposure and
> a worse outcome — it would have exited the process over a dead browser. **Join on the pid
> anyway** — and as of 09-08 the readout does it for you (below).
>
> **THE NEXT RAMP ANSWERS BOTH BRANCHES, NOT ONE (2026-09-08).** The owner's criticism — that we
> add one check at a time and pay a 5-28h round trip for each — produced the one-shot capture:
> the readout JOINS the dump against the walk and suppresses the verdict when they disagree
> (verified against the real 09-07 rows, which now print `VOID`), and the walk adds
> `VMMAP2M`/`VMPROT`/`VMNAME` — distinct `AllocationBase` count (free, from a field it already
> read) and a bounded mapped-FILE-name census. **A named file ends this outright; all-anonymous
> hands it to the dump's owner column, which is now guaranteed to be about the right browser.**
> Full entry: "ONE CAPTURE THAT ENDS ON EITHER BRANCH". **Bot-side for the walk half — it needs a
> box update after merge.**
>
>
> **AND IT IS ON THE BOX — `aae25bd`, applied 2026-09-07 19:01 PT, confirmed by `git-status`.**
>
> **TWO RAMPS WERE FORCED ON 09-07; THE FIRST HIT AND THE SECOND MISSED.** As of that evening
> the `okta=GONE` password form stood at three ramps in five, and **duration and cost tracked
> each other five for five** — the two misses completed in 32 s and 15.6 s for nothing, the hits
> took 11-12 minutes and 9 GB. **(A third forced attempt on 09-08 22:33 missed too, so the count
> is three in SIX and the pairing six for six — see the table above; these figures are as-of
> 09-07.)** **So the trigger is a trip that STRUGGLES, not the password path**, and the next
> cheap reading is comparing `recaptcha__en.js` fetch counts between a ramping trip and a clean
> one (the clean side has since read `x7` twice; nobody has the ramping figure, because those
> traces bail and `tail-log` rolls). **A successful warm-up leaves Okta ALIVE and spends its
> turn, so the real budget is one forced attempt per Okta lifetime.**
>
> **THE FIRST ONE ANSWERED BOTH THE WALK'S BRANCHES:
> 15,493 separate anonymous READWRITE sections, one allocation base each, 31,005 MB — N
> separate `MapViewOfFile` calls, not a few large mappings carved into views.** The name census
> found no file behind them, so the owner column is what names the creator. **The mem-dump was
> RACED AWAY by the bail arm on the same tick and did not run** — fixed here with
> `MEM_DUMP_RAMP_MB` (1500, strictly below the bail's 3000), **bot-side, so it needs a box
> update before the next ramp can answer.** Full account: "THE RAMP WAS FORCED TO ORDER".
>
> **THE RECIPE, so it is not re-derived: `rc-test-hold.mts --in 120` with Okta GONE *and* the
> RC token DEAD.** Okta alone is what `warmupPlan` checks and it is NOT enough — a live token
> makes `attemptLogin` short-circuit, which no-ops in 4.5s and spends the warm-up's only turn
> (fixed here too). Delete the hold once the trip is under way; nothing is ever carted.
>
> **A FIRST FORCING ATTEMPT, EARLIER THE SAME EVENING, LANDED IN THE WRONG CELL.** `test-login` signed in with a
> real password in **eleven seconds for zero memory** — but the health line beside it reads
> `okta session STILL ALIVE`, so Okta answered from the cookie and that is the CHEAP variant.
> It is not a reading about the expensive one and it does not pair with 08-26. **Do not re-fire
> it hoping for a ramp** — while Okta lives it can only ever be answered from the cookie, and
> it is rationed to one per 6h anyway.
> **THE ONE RECIPE THAT HAS EVER FORCED A RAMP IS A TEST HOLD** — the T−3h warm-up fires a full
> password sign-in, but only when Okta is GONE, and that cell has ramped **two times in three**
> (08-20 9.4 GB, 08-24 9.3 GB, 08-26 nothing). **It locks a real campsite and shuts the box's
> update window for 6h, so it is the owner's call and not a lever to reach for.** Full entry:
> "FORCING IS A COIN FLIP". **Otherwise the capture is armed and waiting on a natural ramp** —
> last one 09-07 02:03 PT, cadence 5-28h.
>
> **THE RDR BURST GOT BIGGER AND IT IS STILL THE NEXT REAL BUG.** The 09-07 bail carried
> **49,237 hits in 120s / 75,195 lifetime** on `futurebookingstartsendsdates`, on a browser three
> minutes old — against 18,392 and 19,008 before. Still measured independent of the leak in both
> directions (that same 09-07 ramp is the one WITH a loop; 09-05 20:29 ramped with a flat
> counter). **The `(path, status)` counter IS built and IS on the box** (#292) — an older reading
> printing `statuses not reported` is a pre-update row, not a gap. The next burst says whether it
> is a retry loop against a rejection or an SPA being served, and **still do not reach for
> blocking the requests first.**
>
> **THE RELEASE-WINDOW ROUTINE FIRED AT 07:54 PT AND WAS LOST — the third in a row, and it does
> NOT fire into its own session.** It is bound to the MAIN session, so it needs that session's
> turn; this one was inside a single tool call waiting on `npm run verify`, no
> "notifications pending" notice ever surfaced, and the run started nine seconds after the
> window closed. `rc_release_readings` is still empty after three firings. **Do not tweak the
> schedule — the recorded remedy is to run it by hand before 07:58:30 PT.** Full account:
> "THREE FIRINGS, THREE LOSSES".
>
> ### 2026-09-06 EVENING — NOTHING IS ASSIGNED; THE LEAK IS WAITING ON A RAMP
>
> **Master `bf294bd`, mini-PC `5399000`, no open PRs, no holds queued (so the 6h update gate is
> open), migrations highest 076 with main's block 077-079.** Health 16/19: `rc_session` (dead
> between releases — the token lives ~1h), `bot_version` (box vs web) and `rc_login` (a
> stand-down inside its once-per-20h gate) are all documented-benign. **The gap between box and
> web is docs, one web-side file and the readout, so the box needs no update** — checked by
> reading the commits, not by trusting `autocart.bot_version`.
>
> **THE PACIFIC DATE LAGS UTC BY SEVEN HOURS AND THE ROUTINES ARE PACIFIC.** At 01:45 UTC on
> 09-07 it is still 18:45 PT on 09-06, so a 07:54 PT Routine is thirteen hours out rather than
> missed. Read the Pacific clock before calling a scheduled firing lost.
>
> **THE LEAK: everything that can be built IS built, and the next move is to read, not to
> write.** The walk named the class (16,387 mapped 2 MB sections, 32,779 MB); ~~the memory dump
> that can name the OWNER is on the box with one baseline and **no ramp row yet**~~ **— A RAMP
> ARRIVED 09-07 02:03 PT AND THE DUMP FIRED ON IT AND MEASURED THE WRONG BROWSER; see the 09-07
> block above** — and the box
> had been flat at ~310 MB for **~22 hours** (last ramp 09-05 20:29 PT), with a 16-hour peak of
> 647 MB against the 3,000 MB trigger. The observed spread is **5-28 hours**, so this sits at the
> top of the range and is still neither a cure nor a fault — every "not reproduced this session"
> reading in this file was a window that missed one. **Do NOT queue a test hold to force one.**
>
> ~~**ONE BASELINE AND NO RAMP ROW IS THE INSTRUMENT WORKING**~~ **— TRUE OF THE QUIET BOX IT
> DESCRIBED, AND NOT OF WHAT CAME NEXT: the ramp row that arrived is VOID.** The cadence
> reasoning below still stands and is why the drought was real: The box updated at 14:56 UTC and the baseline landed at 14:59:33, three
> minutes in; and there have been **zero `request-counts` events in sixteen hours** — those fire
> at every teardown and a teardown happens on every browser reopen, so the resident browser has
> had ONE continuous life and one baseline is exactly right. The 34 `tab-close` rows in that
> window are throwaway renewal tabs, which do not tear the browser down. One command reads it:
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` (MEMORY DUMPS section; `--all`
> for per-process roots, histogram and owners). **Join on the pid** — check the dump's lead pid
> against the ramp-scan's walk TARGET for the same event, or a dump of a healthy renderer reads
> as a finding.
>
> **THE READOUT COUNTED ZERO BAILS UNTIL 2026-09-06 — fixed (see "AND NAMING THE ARM MADE THE
> READOUT COUNT ZERO BAILS").** The arms post `bail:ramp` and the classifier tested `=== 'bail'`,
> so the summary said `0 at a bail` over two real ones and printed them LAST, under the
> teardowns. It reads `2 at a bail` and renders them first now. **An older transcript showing
> `0 at a bail` is that bug, not a quiet box.**
>
> **THE RDR BURST IS THE NEXT REAL BUG, AND IT IS NOT THE LEAK.** ~19,000 requests to one RDR
> path in the first **15-26 seconds** of a browser's life — **738 and 848 req/s**, from the
> residential IP that has eaten a 12-hour block once. Conditional (two events in 113 over
> fourteen days; ~100 browser lives in one preemption window did not burst) and what gates it is
> **not established**. **The missing field is the STATUS**: `page.on('request')` never sees the
> answer, so a retry loop against a 401 and an SPA asking on purpose are the same reading and
> need opposite fixes. Count by `(path, status)` off `page.on('response')` — **NOT BUILT** — and
> **do not reach for blocking the requests first.**
>
> **THE RELEASE-WINDOW ROUTINE MOVED TO 07:54 PT WITH `--after=120`** (`trig_01MDTcr2WFDqX6dCsi7gVDPG`,
> self-disabling 09-12). Both prior firings were lost — 09-05 to a fresh session with no repo,
> 09-06 to a busy bound session — so drain time went ~1.75 → ~3.75 min, paid for by halving the
> polling window, because **moving the fire earlier spends the 600s Bash ceiling ONE FOR ONE**
> (the script sleeps in-process until the window opens). It costs nothing observed: every 09-04
> flip landed inside T+1.1s. **First recorded firing is 09-07 07:54 PT**, and
> `rc_release_readings` reading zero rows before then is the expected state.
>
> **STILL FORBIDDEN, each for a recorded reason:** Track B, parking the resident page, lowering
> `LOW_RAM_MB`, and staging a ramp.

> ### 2026-09-06 — THE WALK ANSWERED: 16,387 MAPPED SECTIONS OF 2 MB
>
> **The committed-region walk fired on its first ramp (09-05 20:29 PT) and named the class.**
> The ramping renderer holds **16,387 committed regions in the 2-4M bucket totalling
> 32,779 MB — 87% of its committed bytes — and they are `commit/mapped`**, i.e. pagefile-backed
> shared-memory SECTIONS. Control renderer in the same scan: 403 MB committed, 74 mapped
> regions, 213 handles. Excess **37,277 MB** against an OS commit step of ~40 GB, and the
> pagefile read **34 GB charged, `currentMB=0, peakMB=0`** — charged and never written, which
> is why private bytes, free RAM, the JS heap and the sampling profiler were all blind to it.
> **A SWARM, not one mapping** — that fork is closed, and the `~16,700 handles x 2 MB` figure
> this file carried as arithmetic is now a measurement (handles 19,002 vs 213).
> **Read "IT ANSWERED ON ITS FIRST RAMP" above before doing anything.**
>
> **WHAT CREATES THEM IS STILL NOT ESTABLISHED, AND THAT IS THE WHOLE REMAINING QUESTION.**
> Something in that renderer holds ~16.4k live 2 MB pagefile-backed sections and never releases
> them. Untested candidates: Chromium discardable shared memory (allocates in segments — this
> exact shape), shared-image/GPU transfer buffers, mojo data pipes. RC's home page renders a
> WebGL ArcGIS map and that candidate is unchanged. **Three mechanisms have been guessed on this
> leak and each cost a session — do not write one in.**
>
> **AND THE INSTRUMENT THAT CAN ANSWER IT IS BUILT (2026-09-06) — see "THE WALK CANNOT NAME AN
> OWNER, SO ASK CHROMIUM".** No Windows API records the creator of an anonymous section, so the
> dump asks Chromium: `Tracing.requestMemoryDump` at `detailed`, folded to allocator roots, a
> `shared_memory` histogram **in the walk's own buckets**, and the OWNER of each mapping off the
> ownership graph. **Both branches are answers** — a ~32 GB `shared_memory` total names the
> subsystem, and a small one retires discardable, mojo and the GPU transfer path together.
> **IT IS ON THE BOX (`5399000`, 07:56 PT) AND ITS FIRST BASELINE LANDED AT 07:59:33** — 332 ms,
> 8 processes, `gpu/transfer_memory — 5 MB across 13`, i.e. the dump arrives on Windows, the
> folding works and the ownership edges resolve to a named subsystem there too. **Only a ramp is
> left.** As of 09-06 18:00 UTC there is **one `baseline` row and no `ramp` row**, which is it
> working on a quiet box — a `baseline` per browser life with no `ramp` is the expected state,
> and an empty table AFTER a ramp is a miss with a named reason in the box log.
>
> **THE PRIOR EVENING'S FRAMING, STILL ACCURATE AND NOW SUPERSEDED IN ITS HEADLINE:**
>
> **The RAMP arm fired within two and a half minutes of the box reaching `0029c22`** — peak
> **3,702 MB against 8,879 MB** that morning, two minutes against twelve, `reason: 'bail:ramp'`,
> and the wedge did not fire. **First containment in this investigation to act on a ramp.**
>
> **The finding is in the `ramp-scan` rows, not the request counts.** Four ramps, four for four:
> the ramping renderer's `virtualMB` is **3,727,55x** against a healthy renderer's **3,694,7xx**
> — a fixed **32,780 MB ± 7 MB** — with paged pool ~66.5 MB and ~17-19k handles, while every
> healthy renderer in the same scan reads ~770 KB and ~250 handles. The ~35-40 GB commit step
> that appears in one two-minute tick IS that mapping, and the pagefile shows **40 GB charged
> with under 200 MB ever written**. Private bytes then climb at ~450 MB/min as the pages are
> touched. **Read "THE 32 GB IS ONE FIXED MAPPING" above before doing anything.**
>
> **THE REQUEST LOOP IS NOT THE CAUSE, and I nearly wrote that it was.** The first bail named
> 18,392 hits on `futurebookingstartsendsdates` in two minutes; the ramp twelve hours earlier
> carried **197 requests in eleven hours** and the identical 32 GB signature. The readout's
> verdict line said "the trigger is named" and now refuses the causal claim, guarded. **The loop
> is still real and still worth fixing on its own** — 18k requests in two minutes from the
> residential IP that has eaten a 12-hour block — but it is a different problem.
>
> **THE COMMITTED-REGION WALK IS LIVE ON THE BOX AND HAS NOW BEEN READ. ONE COMMAND READS
> IT:** `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` (#281, merged as
> `2ecaca8`; applied to the mini-PC 2026-09-06 01:10 UTC in 22 seconds and confirmed by
> `bot-ask git-status`, not by `autocart.bot_version`). `VirtualQueryEx` over the ramping
> renderer's whole address space, off the existing 3 GB trigger, with an ordinary renderer
> walked beside it as a CONTROL — see "THE WALK IS BUILT" above for how to read the first one.
> It showed **~16k of 2 MB, mapped** — see the 09-06 block at the top of this section. Ramps
> arrive **~5 hours apart in the day** and twelve overnight, so a second walk is cheap
> corroboration and needs nothing built.
>
> **AN EMPTY REGION LIST WOULD BE A REFUSAL, NEVER AN ANSWER.** A 32-bit host, a failed
> `Add-Type`, a refused `OpenProcess` and a caught throw each print themselves. If the readout
> says the walk did not run, read the reason — do not read it as "no 32 GB mapping was found".
> The last of those four was a defect fixed after the walk was written and before it shipped:
> the catch named the failure and the four emissions below it ran anyway, so a walk that threw
> printed `status=error` and then `status=ok regions=` with empty totals — which the readout
> counts as a completed walk that found nothing. `$ok` gates them now.
>
> **THE FLEET IS HEALTHY AFTER THE MERGE'S WORKER DEPLOY: 3/3 shards held, heartbeat 4s, 18 of
> 19 checks ok.** The one warn is `rc_login`, standing down inside its once-per-20h gate having
> passed on 09-05 — a stand-down, not a failure.
>
> **STATE AT 2026-09-05 19:40 PT (superseded — see the 09-06 block above):** master `aebaf13`, mini-PC `2ecaca8`, **no open PRs**, **no
> holds queued** (so the 6h update gate is open), migrations highest **076** with main's block
> `077-079`. The box is flat at ~278 MB with commit 7.1/17.1 GB — the pre-ramp baseline. Last
> ramp **12:14 PT**; cadence is ~5-6 h in the day and about twelve overnight, with an observed
> spread of **5-28 h**, so a quiet evening is neither a cure nor a fault. **Do NOT queue a test
> hold to force one** — three arrived free in thirty hours once and all three were missed, and a
> staged one locks a real campsite.
>
> **Still: do not build Track B, and do not park the resident page.**
>
> ### 2026-09-05 — THE BAIL ARM WAS INERT, THE REQUEST COUNTER ANSWERED, AND A BAIL COST THE SESSION
>
> Read "IT FIRED, AND THE THIRD OF THOSE THREE IS WHAT HAPPENED" and the three sections after
> it. In short: the request counter's first reading is **flat** (0 in 120s, 197 in eleven
> hours, eleven Okta authorize calls in eleven hours), so the request-loop candidate this file
> asserted three times is **tested and dead**. The two-minute arm did **not** fire — twelve
> minutes is `HUNG_MS` to the minute — because its condition A was CDP silence and the renderer
> kept answering all the way to 8,879 MB; it now reads the loop's own stall. And **every bail
> was spending the RC session**, because `bail()` never wrote the live token down; it does now,
> first and bounded, which is what makes a two-minute bail safe to want. **Bot-side: none of it
> is live until the box updates** — confirm with `bot-ask git-status`, never
> `autocart.bot_version`. **Parking the resident page off the SPA was revisited with the new
> evidence the old prohibition asked for, and REFUSED by `checkAndReport`'s localStorage rule**
> — it would silence `autocart.rc_session` and the phone alarm for ever. The only instrument
> still worth building is a committed-region walk of the ramping renderer; **do not build
> Track B.**
>
> ### 2026-09-04 EVENING — THE LEAK INSTRUMENTS ARE BUILT AND WAIT ON A BOX UPDATE
>
> Read "THE ONSET IS A 35 GB COMMIT STEP" and its sub-section "THE INSTRUMENTS FIRED" directly
> above. **Merged (#273) and ON THE BOX (`1e947ee`, 22:19:47 UTC).** Within two minutes both
> instruments reported: the tab close is **16 ms** (not the problem); the ramp is the **RESIDENT
> page's renderer**, not the tab's, so #142 is aimed at the wrong renderer; what ends a ramp is
> the **12-minute wedge bail** stalled in `checkAndReport` on the unresponsive resident page;
> and the 35 GB is **committed, untouched, non-private memory** (pagefile 7 MB in use, kernel
> pools <750 MB) in a renderer holding **18,705 handles** — shared sections, class not named.
> Trigger candidate: the SPA's OWN `prompt=none` autoRenew in the resident page (token went
> live → none in the 63s before the ramp); our click-through trip twelve minutes later did not
> ramp. ~~**Next, in order: count the resident page's requests … bail at ~2 min instead of 12 …
> BOTH DESIGNED, NOT BUILT**~~ — **BOTH BUILT 2026-09-05 (this session), see "BOTH ARE BUILT" under
> "THE ONSET IS A 35 GB COMMIT STEP"**: `rc-request-count.mjs` attached to the resident page and
> a third watchdog arm reading the heap trail's age and `.memory-latest.json`, which `bot.mjs`
> writes every sample. **Bot-side — needs a box update, confirmed by `git-status`.** The first
> `✗ RAMP` line and its `request-counts` event are the reading; the readout says which way it
> went. No new ramp had arrived by 02:30 UTC 09-05 (the readout still
> shows one scan, one close). `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`. **The daily
> release-window Routine records now** (`--record`; `scripts/rc-release-readout.mts`); **first
> recorded run is 09-06 07:56 PT under a NEW trigger id — 09-05's fired under the old one, into
> a session with no repository attached, and recorded nothing.** **Track B still needs the owner's word.** `POLL_MS` (§27, folded
> above) is the cheapest open lever and needs a bot restart, not a deploy. **The iOS build
> exists (TestFlight #12, 08-29); the iPhone needs to install it.**
>
> ### THE 09-04 08:00 RELEASE CARTED AND WAS HANDED OVER — `#L034`, T+1.4s
>
> **Unit 42527, Leo Carrillo, `campground_id` `rc-542` read off the row.** Carted
> **15:00:01.4 UTC** against a 15:00:00 release and **released to the owner at 15:09:41** —
> status `released`, `last_attempt_note` NULL, i.e. the claim-driven hand-off and not a
> timeout. It was the retry of the campsite lost on 09-03, and the cart burst was on the box
> (`d341139`), so it is also the burst's first real test on the case it was built for.
>
> **The offer it ran on had to be inserted BY HAND ten hours earlier**, which is what the two
> entries below are about.
>
> ### TWO SESSIONS WROTE CONTRADICTORY ACCOUNTS OF ONE INDEX INTO THIS FILE, ON THE SAME DAY
>
> **This is the finding, and it outranks either account.** On 2026-09-04 two MAIN-LANE
> sessions ran concurrently — `docs/LANES.md` divides main from side and says nothing about
> two of the same lane — and each wrote a confident, first-person, mutually exclusive story
> about `rc_hold_requests_unique` into the Open block. Neither knew the other existed:
> `ListAgents` lists only sessions on THIS machine, so an empty list is not exclusive use of
> the database and never was.
>
> **The other lane's account is the better-supported one and it supersedes mine.** See "I READ
> A STALE CHECKOUT AS PRODUCTION DRIFT" below: they diffed production against a day-old
> working tree, called the live FOUR-column index drift, had the owner `DROP`/`CREATE` it back
> to three, and the hold button was silently dead for sixteen minutes. **Postgres then refused
> their second attempt naming `#L034`'s duplicate key** — direct, unarguable evidence, and the
> thing my account has no equivalent of.
>
> ### ~~MIGRATION 074 WAS NOT APPLIED WHEN I SAID IT WAS~~ — I WAS READING THE OTHER LANE'S REVERT
>
> ~~EVERY SENTENCE OF THAT WAS FALSE … `pg_indexes` read `rc_hold_requests_unique` as the
> three-column index the whole time. A migration is applied when you have read the index back,
> and I wrote the read-back sentence without doing the read.~~
>
> **THE PREMISE IS WRONG. 074 *WAS* APPLIED, THEN REVERTED BY THE OTHER LANE, AND MY READ SAW
> THE POST-REVERT STATE.** "The three-column index the whole time" is a claim about a window I
> could not see the start of. What I actually did at 05:00 UTC was **re-apply** it — which the
> other lane then observed and wrote up as *"the mysterious revert"*, i.e. they and I were each
> narrating the other's edit as an anomaly.
>
> **SO THE LESSON I DREW WAS THE WRONG ONE, AND THE RIGHT ONE IS CHEAPER.** I wrote "a
> migration is applied when you have read the index back" — true, and I did read it back, and
> it still produced a false account. **The reading that was missing was `git fetch origin
> master`**, which is the rule the other lane's entry lands on independently. A read-back
> proves the state at that instant; it says nothing about who else is writing.
>
> **WHAT SURVIVES UNCHANGED:** the index is four columns now, duplicate-checked (0 rows under
> the four-column key — widening a unique key cannot fail on data a narrower one already held)
> and read back at 2026-09-04 05:00 UTC.
>
> ### AND `#L034`'s 01:11 MISS NOW HAS TWO CANDIDATES, NOT ONE — do not write either in
>
> A `coming_soon` for `#L034` went out 2026-09-04 01:11 UTC **with no hold button**, because
> `offerHold` returned null. I recorded that as the ORIGINAL three-column-key defect reproduced
> live. **That reading assumed a three-column index, which the correction above says was
> probably four at 01:11.** The two candidates:
>
> 1. **The documented fail-closed gap** — index already widened by the original apply, code
>    still three-column (#263 merged 04:49 UTC), so `ON CONFLICT` matched no index and threw.
> 2. **The original defect** — the `expired` row from the 09-03 08:00 release occupying
>    `(watch, 42527, 2026-09-04)` so `DO UPDATE ... WHERE status = 'offered'` refused.
>
> **Which one is NOT ESTABLISHED**, because nobody recorded when the original apply ran and
> Postgres keeps no DDL history. Candidate 1 is the leading one on the other lane's evidence.
> **Both are fixed** — 074 for the second, and the code/index pair now agreeing for the first.
> The recovery is unaffected either way: `offerHold` re-run by hand with the poller's own
> arguments created the offer, the owner tapped it 88 seconds later, and it carted at T+1.4s.
>
> **~~STILL OPEN~~ — ONE `offerHold` ATTEMPT PER RELEASE, AND A THROW LOSES IT FOR EVER.** The
> call for the PRIMARY held unit sits **below** `claimHoldNotification` in `poller.ts`
> (~1247 gates, ~1315 offers), so it runs once per (watch, release, unit) and a transient
> failure is permanent for that release — which is why 01:11 could not self-heal even after
> the index was fixed. **The extras loop already does the right thing**, calling `offerHold`
> unconditionally every cycle (~1200). This is the 2026-08-28 `rankHoldLine` finding
> exactly, one call site along, and the fix is the same: hoist it above the gate. **BUILT IN #266** — it runs above the
> gate now, and both paths share one `holdOfferDecision` (`worker/hold-offer.ts`), which
> also closed a drift where an extra could be offered with the RC runner dead, past
> `RC_HOLD_CAPACITY`, or on a portal the bot holds no account for.
>
> **THE MEASUREMENT RAN AND RC RELEASES EARLY.** The 07:50 one-shot reported `SUCCEEDED` and
> measured nothing (a 15-minute script against the Bash tool's 600s ceiling, backgrounded, and
> the container reclaimed with the turn); it was re-run by hand in time. `rc-583`'s flip
> bracket is **(−2.2s, −0.2s] — entirely before the release**, and facilities flip atomically.
> **Quote that bracket, never the +0.5s median.** The same trigger is now a **daily cron at
> 07:56 PT, 09-05 through 09-11**, self-disabling on 09-12. Two gaps are recorded with it and
> neither is fixed: the independent disabler Routine **stores no MCP connectors and may be
> inert**, and **nothing persists the readings** — seven runs print to stdout in seven
> ephemeral sessions, so day 1 cannot be put beside day 7 without opening seven transcripts.
> The LIMIT recorded with the instrument still binds: it measures when RC lets go, not how
> long a site survives.
>
> ### READ THIS BEFORE CALLING PRODUCTION WRONG ABOUT ANYTHING
>
> `git fetch origin master` first. This session diffed the live `rc_hold_requests_unique`
> against a day-old working tree, called the four-column index drift, and had the owner run a
> `DROP`/`CREATE` that **broke the hold button for sixteen minutes.** Master already carried
> migration 074's four-column key. One fetch would have shown it. Full write-up above.
>
> ### SIX WATCHES THE DEAD-MAN'S SWITCH SWITCHED OFF ARE STILL OFF — the owner's call
>
> Nothing distinguishes a row it auto-paused from one where the user tapped "No, stop" —
> `cancel` never cleared `deadman_prompted_at`. The list is `SELECT id, campground_id,
> end_date FROM watches WHERE active = false AND deadman_prompted_at IS NOT NULL`; four have
> end dates still in the future. **Resuming them is a decision, not a tidy-up.**
>
> **MIGRATION BLOCKS: main `075-079`, side `080+`** — the side lane took 072 and 073 out of
> main's block (#258) and main holds 074. `docs/LANES.md` is the authority.

> ### ~~THEN: MERGE #255.~~ **#255 MERGED 2026-09-03** — THE ANDROID HAND-OFF IS FIXED AND HUMAN-VERIFIED.
>
> **Struck rather than deleted: it sat at the top of this block as an action for a day after
> it landed**, which is the same shape as the "the fix is designed and NOT built" line that
> outlived #201 by two days. **`git fetch origin master` and check the PR state before
> treating a line here as a task.** The bot-side half (the 60s cart bound) is only live if the
> box moved after the merge — `git-status` through `bot_commands` answers that, never
> `autocart.bot_version`.
>
> **`claude/rc-captcha-resume`, two commits, local verify 1618/1618.** Two independent fixes:
> a CAPTCHA between the email and the password no longer abandons the sign-in (web-side —
> reaches installed apps on a push), and the runner's cart `page.evaluate` is bounded at 60s
> (**bot-side — inert until the mini-PC updates**, so ask for an update after merging and
> confirm with `git-status` through `bot_commands`, never `autocart.bot_version`).
> It carries a `worker/*.test.mts`, so **merging it deploys the worker and restarts both
> pollers** — expected; check `poller.shards` after.
>
> **The 08-29 Android defect is CLOSED** — #249 + #250 + #252, and on 2026-09-02 an Android
> hand-off was confirmed on RC's own cart page by the owner (header, badge, reservation).
> That is the first human corroboration of `cart read back` on any platform.
>
> **Then, in order:** ~~the runner has NO wedge watchdog~~ — **it has had one since 09-03
> (`96aee1e`) and the box runs it**; struck rather than deleted, because it stood at the top of
> two files' to-do lists for a day after it shipped ·
> **RC's own app tier failing to render is the largest un-instrumented risk on this path** and
> loses a site at 08:00 by itself · the RC session dies within ~2 min of every queue, four for
> four, ~11 minutes to recover · "open the window and close it at once when already signed in"
> (11s vs 12min, measured 08-21, not built) · ~~**a fresh iOS build** — the iPhone is on 1.0 (21)
> from 08-09, so iOS is now the platform with NO corroborated cart run.~~ **THE BUILD EXISTS —
> TestFlight #12, 2026-08-29, RevenueCat compiled in; the iPhone has not INSTALLED it** (owner,
> 09-04). Install it and read the build number in the next hand-off trace.
> `docs/NEXT-SESSION.md`'s read-first block is the ordered version of this.

> ### ALSO OPEN: RUN THE RECONCILE. `trialing` STILL READS 0 AND THAT IS EXPECTED.
>
> The webhook fix (#251) is **forward-only** — it corrected what gets WRITTEN, not the rows
> already stamped wrong. Both trials still read `active` and will only self-correct if and
> when Stripe sends an `updated` event for each.
>
> **Admin -> "Does our table match Stripe?" -> `Check against Stripe`, read the plan, then
> `Apply`.** Preview is a separate press on purpose. It never writes `grandfathered`, never
> treats absence from Stripe as cancellation, and never creates a row.
>
> **DO NOT re-derive the "Active 5 · 2 paying" panic.** Those two tiles read DIFFERENT
> SYSTEMS — the status counts come from our database, MRR reads Stripe live via a list that
> **excludes trialing**. Two correct numbers, one wrong column. And **a refund does not cancel
> a Stripe subscription**, so "the refund didn't update MRR" is Stripe behaving normally.
>
> **`api.stripe.com` IS 403 AT THE AGENT PROXY**, which is why the reconcile is a route and
> not a script: no session can reach Stripe, Vercel can.
>
> ### `#L080` RELEASED 2026-09-02 08:00 PT AND EXPIRED UNTAPPED — not a fault
>
> Nobody tapped it, so nothing was owed and nothing was carted. The overnight `TEST · 42546`
> hand-off in the same window was clean: `close: session` and
> `GetSSOLoggedInUser → HTTP 200 · RC Response 1` — the exact two lines #249/#250 predict.
>
> ### ~~A HOLD-SUITE TEST FAILS WHENEVER A HOLD IS LIVE~~ — FIXED 2026-09-02
>
> `hold-fixture-invisibility` asserted `nextHoldRelease() === null`, a GLOBAL read, so it
> failed deterministically for as long as any hold was live — including on unmodified
> `origin/master`. It is a **delta** against a baseline now, and its two sibling assertions
> (which passed VACUOUSLY on a live hold, the more dangerous direction) compare against the
> fixture's own release. Mutation-verified; full write-up above.
>
> ### ANOTHER SESSION IS ACTIVE ON THIS REPO AND ON THE MINI-PC
>
> It merged #250/#252 and ran `scripts/rc-test-hold.mts` twice during this session, which locks
> a real campsite AND changes what every hold-reading test sees. `autocart.rc_runner` went
> **fail** ("1 hold(s) due — these will be MISSED") for several minutes around 05:45 PT on that
> session's `TEST · 42546`, then **recovered on its own** — `no holds due`, beat 13s, by 06:50.
> **Recorded as transient and self-resolved, not as an incident.** The worker deploy was not
> the cause: that restarts the FLY pollers, and the hold runner is on the mini-PC.
>
> **Announce before touching the box or running the hold script** — `docs/LANES.md`'s SERIAL
> list exists for exactly this, and two lanes were live simultaneously.
>
> ### PLAY: RELEASE 25 IS IN REVIEW (submitted 2026-09-01). NOTHING TO DO BUT WAIT.
>
> Everything actionable on the Play path is finished — US-only targeting applied, merchant
> account and 15% enrolment done, bank verified, four products live, offering current, Data
> safety **answered** (RevenueCat is a service provider under Google's own exemption list, so
> nothing on that form changed).
>
> **READ `Publishing overview` FOR "HAS THIS SHIPPED?"**, not the Dashboard, the app list, or
> `Production -> Track summary` — the last of those said `Active · Latest release: 25` over an
> UNSUBMITTED release and produced a confident, wrong "we are live".
>
> **WHAT TO WATCH IS THE FIRST REAL PURCHASE, NOT THE STORE.** `event -> subscriptions row ->
> hasAutocartEntitlement` has never executed, because `ignoreReason` correctly drops every
> sandbox event. Two gaps ride with it: **HMAC is reported, not enforced**, and **out-of-order
> delivery is unhandled** (needs a migration; main's claimed block is 072-079).
>
> **APPLE IS GATED ON THE SMALL BUSINESS PROGRAM ALONE** — submitted 2026-08-30 17:55 UTC, only
> an acknowledgement in the inbox. Check cheaply: `from:apple.com newer_than:3d`, expect
> `developer@email.apple.com`. `docs/STOREKIT-PLAN.md` §4e is the ordered sequence for when it
> lands; §8 says do not create the products before then.




> **START AT `docs/NEXT-SESSION.md`. NOTHING IS ASSIGNED; THE TOP ITEM IS A READING.**
>
> **-3. #250 IS THE SECOND HALF — #249 held the window open and RC STILL signed out.** The
> sign-in script was clicking "Log in" on `/login/callback` mid-exchange. Fixed and
> instrumented; see "#249 WAS NECESSARY AND NOT SUFFICIENT". **The keep-signed-in candidate
> is refuted** (ticked, header empty). Next Android run: expect NO `signin-open` on the
> callback, ONE callback document, `rc-api GetSSOLoggedInUser → HTTP 200 · RC Response 1`,
> then `rc-session loggedIn:true` and `close: session`. If `rc-api` shows a non-1 Response,
> RC refused step two and the fault is on RC's side of the call — that is the next reading.
>
> **-2. #249 IS THE FIX FOR THE ANDROID HAND-OFF — TEST IT ON BOTH PHONES.** Close on RC's own
> `customerId`; no timer; see "RC'S SIGN-IN IS TWO STEPS". The readout prints `RC login:
> customerId PRESENT/ABSENT` per hand-off now. **Expected:** both phones `PRESENT`, both
> headers showing the name, `close: session`. An Android run reading `ABSENT beside an Okta
> token` with the window closed means the host is a cached pre-#249 one — check `close`'s
> reason. **Web-side, no rebuild.** It touched the iOS baseline again (`rc-handoff.ts`,
> `rc-precart-script.ts`, `ClaimFlow.tsx`); if iOS regresses, the revert is the whole PR and
> the reason will be in `close`'s reason.
>
> **-1. THE TWO-PHONE HAND-OFF TEST IS SET UP AND DELIBERATELY NOT RUN (2026-09-01 evening).**
> The owner did not have the iPhone to hand, so this waits for tonight. #248 is merged/open
> with the two new readout lines; the procedure is `docs/NEXT-SESSION.md` (read-first block)
> and `docs/PLATFORM-PARITY.md` §3. **Expected if the candidate holds:** iOS
> `IDENTIFIER-FIRST` + ticked, Android `PASSWORD-FIRST` + `no checkbox on the page at all`.
> Anything else and the candidate is wrong — say so. **ASK FOR THE CART SCREEN on both**;
> `cart read back: 1 entry` has never been corroborated by a human on either platform.
>
> **-0.5. IF iOS IS NOW BROKEN, revert `src/lib/rc-login-script.ts` ALONE** — #248 touched the
> baseline to instrument Android, and that file is the only one in it that reaches an app. The
> delta was audited as behaviourally nil; the entry above says exactly what changed.
>
> ~~**-0.4. A FRESH iOS BUILD is the highest-value non-code action.** iOS is on a 2026-08-09
> binary, so the "iOS is the baseline" comparison is three weeks stale and lacks RevenueCat.
> Codemagic run, not a code change.~~ **WRONG SINCE THE DAY IT WAS WRITTEN: TestFlight #12 built
> on 2026-08-29 with RevenueCat in it.** The 09-01 trace's `1.0 (21)` is the binary on the PHONE,
> not the newest binary. Install it; no Codemagic run is needed unless native code changes.
>
> **0. A REAL HOLD IS QUEUED FOR 2026-08-29 08:00 PT, AND THE OWNER WANTS THE SITE.** Unit
> `43189` (`#94`, Morro Bay Upper Section), tapped 2026-08-28 11:46 PT by
> `tylerflores1992@gmail.com`, who is now `line_priority = 1` and ranks 1-2 in a four-row
> line. `dueHolds` serves their `requested` row. **Nothing further is needed** — the box
> needs no update (this change was worker- and web-side only) and `maybeAutoLogin` restores
> the session at 07:30. If a rival taps overnight, expect ONE cart and the other rows left
> `requested` with the "someone is ahead of you" note: **that is the line working, not a dead
> runner.** Read `last_attempt_note` before concluding anything.
>
> ~~**1. `dueHolds` SERVED BOTH RIVALS AND THE BOT CARTED ONE CAMPSITE TWICE** … the fix is
> designed and NOT built.~~ **BUILT AND MERGED IN #201, AND THIS ENTRY WAS STALE FOR TWO
> DAYS AT THE TOP OF THE LIST.** `dueHolds` carries the temporal `NOT EXISTS`; the suite
> calls it twice with a status change in between. Struck, not deleted — a "NOT built" on the
> top item is read as current state, which is the cost this file exists to prevent.
>
> ~~**1. THE FAIRNESS LINE'S NOTE NEVER REACHED A LATE TAPPER**~~ — FIXED 2026-08-28. The
> primary held unit was re-ranked only once, because its `rankHoldLine` call sat behind
> `claimHoldNotification`. Every overnight tap therefore left a `requested` row with
> `last_attempt_note` NULL — the dead-runner signature, on every contested morning. See
> "AND THE REASON NOTHING RE-RANKS WAS A GATE MEANT FOR THE NOTIFICATION".
>
> **2. READ THE NEXT RAMP — AND DO NOT TRY TO STAGE ONE.** The trail is armed (#193/#194,
> on the box since 13:26:42 PT 08-25) and **`trail-*` readings are still ZERO**. A password
> sign-in with Okta GONE was measured on 08-26 at **32 seconds and zero memory**, so the
> "force the warm-up" plan does not work — see "A PASSWORD SIGN-IN CAN BE CHEAP".
>
> **FOUR RAMPS MISSED, AND THE SILENCE IS NOW INSTRUMENTED (2026-08-28 08:44 PT).**
> 08-25 20:22 (~3.6 GB), 08-26 21:24 (9,112 MB / 100%), 08-28 02:01 (8,981 MB / 99%) and
> 08-28 08:13 (8,987 MB / 99%) all passed with no `trail-*` row. **The "segment never ends"
> explanation is RULED OUT** — on 08-28 02:01 `max_pid` went 14596 → 7812 at 02:15, so the
> teardown ran and `final: true` does include the open segment; the trigger fired and stored
> nothing. **#210 makes a silent final flush print `describeAllocTrail`, and the box has it
> (`5e399b3`).** Read the teardown line in `logs\rc-keepwarm.log` after the next ramp:
> `EMPTY — that renderer answered no CDP call at all` means the trail needs a different
> TRANSPORT; segments with sub-400 MB growth means the sampling profiler cannot see these
> bytes at all and Track A is measuring the wrong quantity. A `trail-*` row appearing is the
> third and best outcome. **Full entry: "THE TRAIL'S SILENCE IS INSTRUMENTED".**
>
> Track B is still NOT covered by the owner's go-ahead.
>
> **THE OWNER'S FOUR-ITEM QUEUE IS DONE (2026-08-24 evening → 08-25).** Fairness line,
> offer-card dismissal + ordering, RC beta copy, and alert batching — all shipped with
> mutation-verified guards, full suite **1258/1258**. Details in the five sections directly
> above. **Migration 068 is APPLIED to production and read back.**
>
> ~~**THE MAIN LANE'S MIGRATION BLOCK IS NOW FULL … must CLAIM A NEW BLOCK OUT LOUD before
> taking a number**~~ — **A BLOCK IS CLAIMED NOW: main `072–079`, side `080+`
> (`docs/LANES.md`), and the highest migration is `071_subscription_provider.sql`.** Take the
> next free number inside your own block.
> **AND 071 IS THE NUMBER `docs/LANES.md` SPECIFICALLY SAID NOT TO TAKE** — #218 took it the
> next day without claiming anything. Nothing collided, because the side lane happened not to
> write one that week, so it is a near miss rather than an incident and
> `worker/migration-numbers.test.mts` was correctly green. **The lesson is that a prohibition
> on the obvious next number loses to the obvious next number**; a standing claimed block is
> what replaces it. That test catches a duplicate and cannot stop one being written.
>
> **THE NEXT ACTION IS ONE PROBE RUN, AND IT NEEDS A BOX AND A QUIET MORNING.**
> `rc-probe.mjs --cart-lapse` (built 2026-08-27, **never run**) measures how long RC holds a
> cart by itself — the number that unblocks both the stranding fix and the expiry cascade,
> and the one `RC_CART_HOLD_MINUTES = 15` has been guessing at since the beginning. It is
> **bot-side**, so the mini-PC must update first, and it **refuses to start** within
> `RC_LAPSE_MAX_MIN + 60` of a release. Get the unit id from `rc-test-hold.mts --find`;
> it locks one real campsite for the run.
>
> **THE EXPIRY CASCADE IS NO LONGER BLOCKED ON A MEASUREMENT — only on the owner's call.**
> It was gated on RC's real cart lapse (*"~15 minutes, never observed"*, against
> `reclaimLapsedHolds`' 180). **On 2026-08-25 an unclaimed hold was released by
> `expireStaleHolds(45)` — OURS, at 45 minutes, with the entry key, RC answering HTTP 200.**
> So the moment a site returns to the market is one we choose and already know; the cascade
> can hook our own release. See the 08-25 section above for the lower-bound caveat.
> **DO NOT CARRY THIS OVER TO `reclaimLapsedHolds`' STRANDING — they need different numbers.**
> The cascade hooks OUR release, whose timing we choose, so it needs no figure from RC. A
> retry bound for the stranding needs RC's OWN lapse, which is still unmeasured and which the
> 45-minute observation only bounds from BELOW. The handover treated one retirement as
> retiring both; it does not. (And the stranding has never once fired — see the 08-27
> measurement above.)
> Cross-cycle alert batching (merging 08:00:00 and 08:00:20 into one text) is still theirs:
> it **buys fewer texts with LATENCY on the most latency-critical path in the product**.
>
> **THE 08-25 08:00 PT RELEASE HAPPENED AND WORKED.** Morro Bay #96 carted at **T+2s**, the
> fairness line's first live contest resolved correctly, and the owner deliberately did not
> claim — which is how the 45-minute release above got measured. The four untapped offers
> expired, which is not a fault.
>
> **UNIT 43191 IS NOT A DUPLICATE-FACILITY CASE — that story was our own bug.** RC's
> September inventory has ZERO overlap between the lottery pool and Upper Section, and 43191
> is in Upper Section alone. Two users collided because **both watch the same park**; one
> offer was mislabelled rc-2185 by the result-map collision `watch-key.ts` fixed. Corrected
> in two places that stated the wrong cause as fact.
>
> **TRACK A STILL HAS ZERO READINGS FROM A REAL RAMP — and now we know WHY, which is the
> useful part.** It has three stored readings and **three ramps happened in the same 30
> hours**; every reading says *"this navigation did NOT ramp"* and every one sits outside its
> ramp window. `reportNativeAlloc` fires on the RETURN path and is gated at −400 MB, so a
> trip killed mid-ramp never reports and the instrument records, by selection, the CHEAP
> retry that FOLLOWS a ramp. **Do not queue a test hold to force a ramp** — three arrived
> free and were all missed. The fix is a TRAIL sampled on the watchdog tick, like the heap
> and RAM trails. **Do NOT correct the three buffering entries on the readings that exist.**
>
> **THE LEAK IS NOT FIXED and remains the owner's standing ask.** Everything shipped is
> containment or relocation. **Track B (replay the Okta trip over `ctx.request`, no
> renderer) is designed and deliberately NOT started** — it is surgery on the
> release-critical login path and needs an explicit go-ahead.
>
> **THE RAM ARM HAS NOW SAT OUT SIX CONSECUTIVE 7–9 GB RAMPS**, and the margin is gone:
> troughs 3,191 / 3,328 / 3,035 then **2,217 / 2,473 / 2,144** against a 2,000 floor, with
> **COMMIT reaching 99% twice on 08-24/25**. A **browser replacement** ends each — the
> post-Okta recycle, not the arm. **Still a QUESTION, not a patch** (raising the trip point
> is what killed a working repair on 08-19, and the box recovers within two minutes), but
> the exposure is now ~10 minutes at 95–99% COMMIT three times a day, and ~90% is where
> Windows stopped scheduling both tasks on 08-17.
>
> ~~**A FIXTURE CAN STILL TURN `autocart.rc_session` RED**~~ — **FIXED 2026-08-27, PR #202.**
> The health route's five inline counts now go through `holdsAhead`/`holdsDueWithin`, which
> carry `REAL_UNIT` in their own bodies. **And the fix's own test shipped a `requested`
> fixture on a numeric unit id — the 2026-08-15 incident recreated inside the fix for its
> sibling — which `hold-fixture-safety.test.mts` was green on.** That guard is widened in
> three places and now derives the helper names from each file. Both entries above.
>
> ~~**AND THREE TEST SUITES STILL SWEEP EACH OTHER'S FIXTURES**~~ — **FIXED 2026-08-27, PR
> #203, closing issue #76.** Four suites shared the `__t` prefix and three swept all of it, so
> a STARTING run deleted a RUNNING one's rows. Every suite now has its own prefix (`__trh`,
> `__teh`, `__tfi`, `__tcap` beside `__tln`/`__tdc`) **and** an age gate on `offered_at`, and
> both halves are needed: the prefix stops one suite wiping another, the age gate stops two
> runs of the SAME suite. `hold-line` and `hold-decline` already had prefixes and no gate —
> the new guard found them. **So an unrelated red is no longer the expected state**; treat one
> as a regression rather than as this.
>
> **ONE TRANSITIONAL HAZARD, and it reproduced while the fix was being verified.** `__trh`
> still matches `__t%`, so a BRANCH that has not picked up #203 still sweeps master's rows.
> A local `npm run verify` at 03:44 UTC lost `once the window has closed, a cart failure IS
> final` to a side-lane CI run doing exactly that, and passed alone immediately after. **Until
> every live branch has rebased, that specific red is still #76 and not a regression** — check
> for an overlapping run on a branch behind master before treating it as one.
>
> **iOS:** `1.0 (5)` resubmitted 2026-08-22 with corrected notes — `docs/APP-STORE.md` §2d.
> Release is AUTOMATIC. A 3.1.1 rejection now is the ANSWER, not a fourth process failure.
>
> **Egress was healthy all session** — camphawk.app 200, Supabase and both readouts fine.
> **FULLY OPEN as of 2026-08-26** — the owner had the last three hosts allowlisted and all
> three now answer (`mcp.sentry.dev` 200, `mcp.vercel.com` 401, `flyctl-metrics.fly.dev` 404;
> those are the SERVERS, not the gateway). **The MCP servers still do not work, and the reason
> is now AUTH**: `mcp.sentry.dev/mcp` returns `401 invalid_token` and no `mcp__sentry__*` or
> `mcp__vercel__*` tools exist — OAuth needs an INTERACTIVE session. Sentry would be empty
> regardless: no `NEXT_PUBLIC_SENTRY_DSN` is set, so the SDK no-ops in production. **It has
> been revoked mid-session before, so check rather than assume**; the readouts fail LOUDLY
> on an unreachable DB, so an empty answer is a real answer.
>
> **STATE AT 2026-08-28 15:50 PT.** Master is **`ba0753d`**, the mini-PC is on **`5e399b3`**,
> **every GitHub issue is closed and no PR is open.** Merged 08-28: **#202** (health-route
> `REAL_UNIT` + the fixture-safety widening), **#191**, **#180**, **#203** (closed #76),
> **#204** (closed #181 and #14), **#210** (the trail's silence), **#211** (docs), **#213**
> (docs), **#214** (the hold-line priority override + the bounded-baseline test fix).
>
> **#214 FIRED A WORKER DEPLOY AND IT WENT GREEN** — both machines restarted, 2/2 shards
> held, heartbeat 8s, and the workflow's own "Verify the poller is actually alive" step
> passed. **The stronger evidence is the live re-rank**, which a poller on the old code
> could not have produced.
>
> **THE 08-28 RELEASE PASSED WITH NOTHING CARTED.** All five offers expired unclaimed —
> nobody tapped, which is not a fault. The three-way contest on unit 43187 did NOT happen,
> so #201's one-live-hold-per-unit rule is still untested in anger. **The 08-29 08:00
> release is the next chance** — one row tapped so far, three untapped offers behind it.
>
> **`autocart.rc_session` WARNS AND IT IS THE ORDINARY BETWEEN-RELEASES STATE.** The token
> lives ~1h and `okta=ALIVE`; `maybeAutoLogin` restores it at T−30. `autocart.bot_version`
> warns because the box is on `5e399b3` against web `ba0753d` — **"No bot-side code in the
> gap", which is the documented not-worth-acting-on case.** 17 of 19 ok.
>
> *(historical, 2026-08-27 21:30 PT.)* Master was **`05ee4ff`** and **EVERY GITHUB ISSUE WAS
> CLOSED.** Merged: **#202** (health-route `REAL_UNIT` + the fixture-safety widening),
> **#191** (outreach timing docs), **#180** (Play Billing gate, STOREKIT-PLAN, side-lane
> §25/§26 notes), **#203** (fixture sweep scope, closed #76), **#204** (Routine IDs, the
> nights answer, the egress-watchdog guard — closed #181 and #14).
>
> **#203 AND #204 BOTH SAID "`worker/` test files only, so no worker deploy". BOTH WERE
> WRONG.** `worker/**` is the first entry in the workflow's `paths:` list. Merging #204
> deployed on `05ee4ff` and bounced both machines; it came back clean (heartbeat 4s, 2/2
> shards held, deploy `success`). See the Deploy section — the claim is now corrected there,
> and `docs/LANES.md` had it right all along.
>
> **MERGING #180 MEANS THE NEXT ANDROID BUILD FAILS, ON PURPOSE.** `codemagic.yaml` now
> asserts `com.android.vending.BILLING` reaches the merged manifest, and
> `@revenuecat/purchases-capacitor` is not a dependency yet — so the step exits 1 until
> RevenueCat lands. That is the gate working (Play's Subscriptions page has no create button
> without it) and it does block an Android hotfix meanwhile.
>
> **FIVE OFFERS ARE OUTSTANDING FOR 2026-08-28 08:00 PT, and one unit is offered THREE
> times.** Unit `43187` (`#92`, Morro Bay Upper Section) is offered to tylerflores1992,
> iamtylerflores12345 and melinda — three users, one campsite. **That would be the first
> three-way contest**, and the real test of #201's one-live-hold-per-unit rule. **NOBODY HAD
> TAPPED AS OF 21:13 PT**, and the 08-27 release before it expired all fourteen of its offers
> untapped — which is not a fault. **So the contest is contingent, not scheduled**: two of
> those three must tap before 08:00 or there is nothing to arbitrate. `nextHoldRelease`
> ignores `offered`, so nothing is queued and **the 02:00–05:00 PT update window is open.**
> Health at 21:13: runner polling 15s ago, session live (token 59m, `okta=ALIVE`), watchdog
> firing both tasks, rehearsal PASSED 03:01. `bot_version` warn only — box 1d behind with **no
> bot-side code in the gap**, which is the documented not-worth-acting-on case.
>
> **Delete `docs/NEXT-SESSION.md` once Track A has a reading from a real ramp AND the App
> Store version has a decision**; it is a handover, not a permanent doc.
