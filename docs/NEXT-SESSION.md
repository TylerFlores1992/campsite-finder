# Next session — start here

*Rewritten 2026-08-25; state refreshed **2026-09-10** (main lane). This is a
HANDOVER, not a permanent doc — `CLAUDE.md` owns every finding.*

> ### TWO PHONE-REPORTED DEFECTS, BOTH FIXED — AND ONE SCREENSHOT IS OUTSTANDING (2026-09-10)
>
> **Neither was reachable by reasoning; both came from the owner using the app on a new Pixel.**
> Both fixes are **web-side — they reach already-installed apps on a push, no rebuild, no store
> review.** Full mechanisms in `CLAUDE.md`; do not re-derive them.
>
> **1. ANDROID 16 IGNORES `overlaysWebView: false`, AND EIGHTEEN SCREENS DREW UNDER THE STATUS
> BAR.** Controls at the top of every route outside the `(app)` group were visible and took no
> taps — including **`/claim`, the 08:00 hand-off**. The app targets SDK 36, Android 15+ enforces
> edge-to-edge, Android 16 ignores the opt-out entirely, and `@capacitor/status-bar`'s own
> `shouldSetStatusBarColor()` says so in a comment. Fixed with `env(safe-area-inset-top)` — the
> pattern `V2Nav`, `/admin` and `/auto-cart` have used since August and which was never
> generalised, which is exactly why the symptom was "some pages".
> - **DO NOT reach for `capacitor.config.ts` or `NativeBridge.tsx`.** Both already set
>   `overlaysWebView: false`. There is no config that turns edge-to-edge off; the CSS is the
>   only remedy. They stay because they still work on Android ≤14 and on iOS.
> - **THE OUTSTANDING ITEM IS A SCREENSHOT.** `env()` is 0 in headless Chromium and this
>   container cannot reach the live site, so **nothing has SEEN this on a phone.** Open
>   `/claim` or `/privacy` on the Pixel after the deploy; the CampHawk mark should clear the
>   clock. That is the confirming reading and it takes ten seconds.
>
> **2. "FAVORITES IS SPELT WRONG" — IT WAS, AND FIVE MORE WERE.** The admin user page rendered
> `label="Favourites"`; a sweep found `honour`, `authorise`/`authorised`, `organised`,
> `normalised` and `enrolment` in copy a person reads. All six fixed.
> `src/lib/us-spelling.test.mts` is the gate, because **every one was invisible to `tsc`, to
> `next build` and to the whole suite** — the `jsx-spacing` blind spot again.
> - **DO NOT add `cancelled` to that word list.** A test asserts it stays out: it is an accepted
>   American variant, it is used across ~15 user-visible strings, and **the alert bodies feed
>   the A2P 10DLC registered samples**. That is the reason, not taste.
> - **DO NOT americanise `'centre'` in `geocode.ts`.** It is DATA — a token matching real
>   published place names ("Visitor Centre") — and americanising it breaks the name geocoder.
>   It is allow-listed saying so, and the allow-list is bidirectional: a **stale** entry fails.
> - **DO NOT "tidy" the comments to match.** They are British on purpose; the guard strips them,
>   which is the only reason it produces one finding instead of four hundred.
> - The store listings were checked and are clean (`play-full-description.txt`,
>   `appstore-description.txt`). `CampingandHiking` in `reddit.ts` is the real subreddit, not a
>   missing space.
>
> **Verified: `npm run verify` exit 0** — typecheck (both configs), jsx-spacing, full suite,
> build. Eight mutations on the spelling guard and eight on the safe-area guard, each verified
> to APPLY and each caught.
>
> **These touch side-lane files** (`src/app/camping/`, `src/components/v2/ClaimFlow.tsx`)
> because the bugs do. Fixing only the main-lane half would have left `/claim` tappable and
> every SEO landing page not.


> ### THE GPU TRIAL RAN AND THE COMMAND-BUFFER CANDIDATE IS REFUTED (2026-09-10)
>
> **STOP: every block below this one treats the command buffer as the live candidate. IT IS NOT.**
> Read `CLAUDE.md` → "AND IT RAMPED ON TRIAL ONE" before touching anything GPU-related, and
> **do not re-run the trial to "confirm" it** — one counterexample refutes, and this one came with
> the whole region walk attached.
>
> **WHAT HAPPENED.** #312 took the command buffer away (`--disable-3d-apis` + `--disable-gpu`) and
> the flags were confirmed live on the running browser by an INDEPENDENT reading rather than by
> "the code is on disk": `gpu-process` fell to 20-22 MB against the 2,631 samples of the 72 h
> before it, whose MINIMUM is 78 MB and of which none is below 40, and the revert took it back to
> 99-130 — it moves both ways with the flag.
> `restart-rc` replaced the browser at 05:49:51Z. **It ramped at 05:51:53Z**, and the walk on that
> renderer read **32,774 MB across 16,385 regions of 2 MiB, one allocation base each, all
> anonymous, all READWRITE**, with the same native spin at `chrome.dll+0x18096c6` / `+0x180968b`.
> **The GPU process never moved: 20 MB throughout.**
>
> **THE ~20-TRIAL BAR WAS NEVER REACHED AND DID NOT NEED TO BE.** It exists to stop a CURE being
> credited on silence; silence is not what arrived.
>
> **THE FLAGS ARE OFF AGAIN** (#314 flipped the default; the module is KEPT for the evidence, and
> `RC_KEEPWARM_DISABLE_GPU=1` re-runs it with no deploy). **This is bot-side, so it needs a box
> update** — until then the box runs with the flags on, which is measured-useless rather than
> measured-harmful, and no login canary has failed.
>
> **DO NOT OVER-CLAIM IT.** What is established is that **removing the WebGL context does not stop
> the leak**, so `MappedMemoryManager` serving RC's ArcGIS map cannot be the mechanism.
> `--disable-gpu` leaves a GPU process running, so a *different* command-buffer client is not
> excluded by arithmetic alone. **And the 2 MiB match was a coincidence** — 2 MiB is Windows'
> large-page size and PartitionAlloc's super-page size as well as
> `gpu::SharedMemoryLimits::mapped_memory_chunk_size`, so an exact match on a round power of two
> is not a fingerprint. That was the candidate's strongest evidence and it survives the
> refutation while the mechanism does not.
>
> ### THE NEXT READING IS THE ONLY LEAD LEFT, AND ITS INSTRUMENT IS BUILT
>
> VMSTACK has the loop in native code at fixed offsets in a known build. Naming what it DOES is
> what turns "something maps 32 GiB" into a mechanism; everything else measurable from outside the
> process has been measured.
>
> **`code-bytes` (#315) reads those instructions out of `chrome.dll` ON DISK**, because the proxy
> blocks every Playwright CDN host and this container's Chromium is both the wrong revision and a
> Linux build. It reads the shipped FILE, never a process, so the `ReadProcessMemory` ban is
> untouched; its argument is an RVA and can never become a path.
> - **BOT-SIDE, so update the box first**, then:
>   `npx tsx scripts/bot-ask.mts code-bytes 18096c6` and `... 180968b`.
> - **Disassemble the hex HERE**: `objdump -D -b binary -m i386:x86-64 -M intel`, verified working
>   in the container. The window starts 64 bytes early on purpose — x86 is variable-length, so try
>   alignments until the stream is sane.
> - ~~It also returns the **PDB GUID + age**, the symbol-server key for this exact build — what a
>   later session WITH egress needs, obtained now so the answer does not wait on the proxy twice.~~
>   **EGRESS WAS NEVER THE BLOCKER (measured 2026-09-10).** The symbol server IS reachable and
>   **does not hold this build** — see below. A session with egress and the GUID both in hand
>   still gets `NoSuchKey`.
>
> ### AND IT ANSWERED: THE LOOP IS A SEARCH-AND-ERASE OVER A POINTER ARRAY
>
> `code-bytes` reached the box and worked on its first call, against
> `chromium-1228\chrome-win64\chrome.dll` — revision 1228, the build the box actually launches,
> confirmed from the FILE rather than from a lockfile. **One call covered both hot addresses**
> (`180968b` is 5 bytes inside the window for `18096c6`); ask for the higher one first.
>
> The spinning main thread is in a **linear search over an array of 8-byte pointers**
> (`[rsi+0x18]` data, `[rsi+0x24]` count), filtered on a byte flag at `elem+0x5c`, matching by
> comparing `[[elem+0x20]]` against `[[rdx]]` — and on a match it **erases**: clears the slot,
> releases the old value, memmoves the tail, decrements `[rsi+0x14]`.
>
> **THE SAMPLES ARE IN THE PEELED FIRST ITERATION, NOT THE LOOP BODY** — zero of 48 fall in the
> sweep. So it is a predicate CALLED at enormous frequency that usually exits on its first
> element, not one long scan caught mid-sweep. That distinction is the finding.
>
> **DO NOT NAME THE FUNCTION.** There are no symbols and this repo records three guessed
> mechanisms each costing a session. The fingerprint to match against Chromium source is: a byte
> flag at `+0x5c`, checks at `[+0x10]` and `[+0x1c]`, a pointer at `[+0x20]`, and an `rsi` struct
> holding TWO containers (`+0x18`/`+0x24` scanned, `+0x8`/`+0x14` erased from). **That is a
> source-reading job, not another measurement** — and it is the next step.
>
> **STATE THOSE OFFSETS PRECISELY OR THE SEARCH IS FOR THE WRONG STRUCT.** The shorthand above
> puts them all on one object and they are not: the flag byte is on the ELEMENT (`elem+0x5c`),
> the two non-zero checks are on its POINTEE (`(*elem)+0x10` and `(*elem)+0x1c`), and the sampled
> comparison is `**(elem+0x20)` against `*(*elem)`. (CLAUDE.md's own summary writes `[[rdx]]`
> where the disassembly listing shows `[r8]`, which is `*elem`.)
>
> **The PDB key came back `[hex]`: `scrub()` redacted it**, since a 32-char hex GUID is
> indistinguishable from a token. The BINARY key survived (`6A18CF41112d9000`). Recorded, not
> fixed — loosening the scrubber on the path carrying RC session material to retrieve a
> diagnostic is the wrong trade.
>
> **AND THE REDACTION COST NOTHING, BECAUSE THE SYMBOL SERVER DOES NOT HAVE THIS BUILD.**
> `chromium-browser-symsrv.commondatastorage.googleapis.com` is **200** at the proxy (unlike
> `msdl.microsoft.com`, `chromium.googlesource.com` and `source.chromium.org`, all 000), and our
> binary key **404s `NoSuchKey`** — controlled: a key the listing says exists range-fetches 206,
> and the bucket is still fed. **The trap is that our exact TimeDateStamp IS present**, with
> three Chrome variants (`0x11110000`, `0x0e7e4000`, `0x0fedf000`) and none of them our
> `0x112d9000`. **A different `SizeOfImage` is a different binary**, so a neighbour's PDB names
> the wrong function at `+0x18096c6` — confidently. Full account in `CLAUDE.md` → "THE SYMBOL
> SERVER ANSWERS, AND IT DOES NOT HAVE THIS BUILD".
>
> **WHAT IS OPEN INSTEAD: `raw.githubusercontent.com` is 200**, so Chromium source is fetchable
> by path through the GitHub mirror — which makes the fingerprint match below need no ramp, no
> box update and no symbols. It reads a repo outside this session's scope, so it wants the
> owner's word.
>
> **`restart-rc` IS 2 FOR 2 AS A FORCING LEVER** against a pooled 10% base rate. n=2, not a rate —
> but a forced restart makes a COLD browser loading RC's home page, which is the shape the 02:0x
> cluster turned out to be. **Pace forced restarts at ~15 minutes**: `supervise.ps1` stops LOUDLY
> after 5 exits in 10 minutes and leaves the RC pair dead.


> ### THE GPU CENSUS ANSWERED — AND THE SPIN IS SAMPLED NOW (2026-09-09, evening)
>
> **STOP: the block below this one says the GPU reading is still outstanding. IT IS NOT.** A
> ramp arrived at **10:19:40 PT, three minutes after the box took `2f006b7`**, and the census
> fired on it. `#310` was committed at 10:47 PT still saying "only a ramp is outstanding" —
> twenty-eight minutes after the ramp that answered it. **Read the corpus, not the state line:**
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`.
>
> ```
> TARGET  pid=11588 renderer  SPINNING on the MAIN thread: tid=7128 deltaMs=1203 of 1200 (100%)
> CONTROL pid=768   renderer  BLOCKED: busiest burned 0 ms of the same window (0%)
> GPU     pid=7044  gpu-process  BLOCKED: busiest burned 0 ms across 21 threads (0%)
> ```
>
> That is the **predicted BLOCKED branch** — the client-allocates-service-never-drains shape.
> **Quote it as the verdict does: CONSISTENT WITH, NOT PROOF.** An idle service is also what you
> see if nothing was ever sent to it; the branch that would have refuted the candidate did not
> fire. Free corroboration in the same scan's baseline dump: a healthy browser's biggest
> shared-memory owner is **`gpu/command_buffer_memory — 2 MB across 2 mappings`** — the same
> allocator and the same 2 MB unit the ramping renderer holds 13,320 of.
>
> ### ~~WHAT IS OUTSTANDING NOW: A BOX UPDATE, THEN ONE RAMP~~ — BOTH HAPPENED, IT ANSWERED
>
> **STRUCK 2026-09-10. The box took it, a ramp came, and VMSTACK named the class: NATIVE, 42
> of 48 samples inside `chrome.dll`.** The block below is kept for HOW the instrument
> refuses, which still applies — but read as current its heading is a task that is done, and
> this file's own history is that such a line gets quoted as one. The follow-through is the
> disassembly block above, not another wait.
>
> **`VMSTACK` samples the spinning thread's INSTRUCTION POINTER from outside the process.** The
> census named the symptom; this names the cause, and its two answers are in opposite halves of
> the system — **inside a loaded module** is a native loop (`chrome.dll+0xOFFSET`, symbolizable
> offline against the build the scan reports beside it), **executable but in no loaded image** is
> JIT, i.e. **RC's own page script**, and needs no Chromium change at all.
>
> **It REFUSES before it names either.** `Rip` is byte 248 of the x64 CONTEXT (six debug
> registers, not eight); a wrong offset returns a stack pointer, which belongs to no module and
> would render as JIT — a plausible answer for the wrong reason. Every address is asked whether
> its page is executable, on an axis independent of the module check, and a non-executable
> majority is refused. **If the readout prints `REFUSED`, fix the read before believing any
> class.**
>
> **Bot-side, so it is inert until the mini-PC updates.** Confirm with
> `npx tsx scripts/bot-ask.mts git-status`, **never `autocart.bot_version`**. No live holds, so
> the 6 h release gate is open.
>
> ### TWO THINGS NOT TO MISREAD
>
> **1. Ramp gaps are 2.3h to 18.6h — quote the RANGE, not a headline.** Recounted over four days
> on 2026-09-10: nine natural gaps of 18.6 / 5.4 / 5.7 / 13.9 / 4.3 / 2.5 / 2.3 / 3.5 / 11.1 h,
> median ~5.4. **Both previous figures were windows rather than cadences** — "5-28 h" caught a
> quiet stretch and "2.3-4.2 h" caught the 09-09 cluster, and this file produced each of them
> confidently. **So do not plan on reading an armed instrument "in a few hours"**: that is true
> about half the time, and the other half is overnight.
>
> **2. "No ramp dump" on any of them is arithmetic.** The renewal trips read **46.7-59.1 s** in
> `TAB CLOSES` against `MEM_DUMP_STALL_MS` of 90 s, so the trigger correctly never fired. Do not
> lower it — a wedged renderer contributes zero allocator dumps anyway.
>
> ### WHEN A RAMP COULD BE FORCED — AND IT SHOULD NOT BE
>
> **The window named below (22:33:36 PT) was 2026-09-09 and has passed; a natural ramp landed at
> 04:25Z on 09-10 without it, exactly as the last sentence predicted. The ADVICE is unchanged and
> the arithmetic is the reusable part — only the word "tonight" was perishable.**
>
> The recipe needs Okta GONE **and** the token dead. The token is dead; Okta binds, and its
> ABSOLUTE cap is **FROZEN, measured rather than inferred**: across a real 20-minute probe the
> CHECK advanced (18:55:27 -> 19:15:28 UTC) and `okta_expires_at` did not move from
> `2026-09-10T05:33:36Z`. A rolling window prints exactly `+12.0000h` from the check; this read
> `+10.64h` then `+10.30h`. So the window opens at **22:33:36 PT**, plus up to an hour for the
> token behind it — and **four or five natural ramps land first.** Forcing is 3-in-6, spends the
> warm-up's one turn per Okta lifetime, and costs a password submission from an address that has
> eaten a twelve-hour block.

> ## AND A SECOND MAIN LANE RAN TODAY — THE SUBSCRIBER READ (#307)
>
> **Two main-lane sessions on 2026-09-09.** This section is billing/acquisition; the leak
> sections above and below it are the standing priority and they touch no common files.
> `git fetch origin master` before trusting either — the 09-04 incident came out of exactly
> this.
>
> **#307: three commits, CI green on all three, `npm run verify` 2022/2022 locally.** Check
> whether it merged rather than assuming. Full write-up: `CLAUDE.md` → "THE TWO NEW SUBSCRIBERS
> PAID FOR THREE FINDINGS". No `worker/` runtime code and no bot-side change, so **nothing in it
> waits on a box update**; the one `worker/*.test.mts` re-anchor does fire a worker deploy and
> restart the pollers, which is expected — check `poller.shards` after.
>
> **THE THREE FIXES, IN ONE LINE EACH:**
> - `users.sms_consent_at` is written by the save that captures it. **Ten accounts still have
>   none and are deliberately NOT backfilled** — `created_at` predates the save and `updated_at`
>   is bumped on every page load, so both would be inventions. That is the honest answer if a
>   carrier ever asks about those ten.
> - `/new` no longer promises auto-cart — or an 8am RC hold — to a reader with no entitlement.
>   `unknown` keeps the promise; a failed lookup must never downgrade somebody who is paying.
> - `watches.notify_sms/notify_email/notify_push` are dead (migration 001 and nowhere else) and
>   are now guarded as dead rather than left looking like preferences.
>
> **THE ACQUISITION INSTRUMENT HAS ITS FIRST READING WORTH LOOKING AT: `chatgpt.com`** — landing
> to paid in **3.5 minutes**, first watch on the exact campground page they landed on. **n=1,
> client-supplied, do not act on it yet.** `NODE_USE_ENV_PROXY=1 npx tsx
> scripts/funnel-readout.mts`; **37 accounts carry no source, so that table is not a share of
> anything.**
>
> **ONE CHURN RISK LEFT UNACTIONED BY INSTRUCTION.** An Auto-Cart subscriber ($10/mo, converted
> 09-08) has zero active watches after his trip dates passed. A note is **drafted in Gmail and
> unsent** — the owner said not to send it. He is `email_alerts_opt_in = false`, which is an
> alert preference and not a blanket unsubscribe; whether that permits an account email is the
> owner's call.
>
> **TWO TRAPS PAID FOR TODAY:** the GitHub API's `head_sha` needs the **full 40 characters** —
> a short sha returns zero runs and reads as "CI never started", which my own monitor did; and
> `git checkout -- <file>` during mutation testing reverts to HEAD, so **commit before mutating**
> or the fix under test is what gets deleted.

> ### THE OUTSTANDING READING WAS TAKEN. HERE IS WHAT IT SAID.
>
> **The ramping renderer's MAIN THREAD is spinning at 100% of a core and never returns to its
> message loop — which is where CDP is serviced, so three instruments failing on three
> different calls was never three reasons. It was one, and it is now named.**

> ## VMTHREAD ANSWERED ON ITS FIRST RAMP (2026-09-09, evening)
>
> **State: master `2f006b7` (#308 and #309 merged) and the mini-PC is on `2f006b7` TOO —
> confirmed by its own `git rev-parse HEAD` via `npx tsx scripts/bot-ask.mts git-status`, never
> `autocart.bot_version`. So the GPU census is LIVE on the box and has NOT yet seen a ramp.**
> 3/3 shards, health **19 of 19 ok**, no holds queued, highest migration 076, main's block
> **077-079**. One other open PR (**#307**) and it is a **MAIN lane** one — its branch is named
> `claude/camphawk-side-lane-status-iij2xm`, which is a leftover name and not a lane token;
> it touches `src/lib/`, an API route and a `worker/*.test.mts`, all main-lane files. **That
> misread is the 09-04 shape in miniature: the branch name is the lane token only when the
> branch was named for the lane.**
>
> **READ `CLAUDE.md` → "VMTHREAD ANSWERED ON ITS FIRST RAMP: THE MAIN THREAD IS SPINNING"
> BEFORE ANYTHING ELSE.** From the 06:47 PT ramp scan:
> ```
> >>> SPINNING on the MAIN thread: the busiest of 20 thread(s) burned 1203 ms of a 1200 ms
>     window (100% of a core).
>     tid=7876  main=True   cpuMs=121031  deltaMs=1203  state=Running  wait=-
>   CONTROL (an ordinary renderer, same scan)
> >>> BLOCKED, not spinning: the busiest of 15 burned 0 ms of the same window (0%).
>     tid=9724  main=False  cpuMs=0  deltaMs=0  state=Wait  wait=EventPairLow
> ```
> - **The control at 0% is what makes it a reading.** A busy renderer on its own would be
>   unremarkable.
> - **`cpuMs=121031` is LIFETIME, not the duration of the spin.** Do not quote it as one; the
>   only rate here is `deltaMs=1203` of a 1200 ms window.
> - **"Fire earlier" is closed from the other side too** — the resident trail read `EMPTY` for a
>   whole 165 s browser life. It is quiet from birth. **There is no window in which that
>   renderer both holds the sections and answers.**
>
> **VMSPAN ANSWERED AS WELL: SCATTERED** — 16,383 regions over a 132,797,914 MB span (4053x), so
> not carved from one reservation, and the cage/pool/sandbox branch is out. **Read `VMMAP2M`
> (16,383 regions across 16,382 allocation bases), not the adjective**: `SCATTERED` fires on the
> 4-region control too and does not discriminate.
>
> ### ~~THAT NEXT MOVE IS BUILT — IT NEEDS A BOX UPDATE AND ONE RAMP~~ — IT GOT BOTH
>
> **STRUCK 2026-09-10. The GPU census fired on the 09-09 10:19 PT ramp, three minutes after
> the box took it, and read BLOCKED — the predicted branch.** Kept for the prediction and for
> the CONSISTENT-WITH-NOT-PROOF wording, both of which still govern how to quote it. The
> heading is not a task.
>
> **`VMTHREAD` takes the GPU process of the target's own browser generation now** (#309, and it
> is **on the box** — applied 17:17 UTC in 23 seconds, `updated and verified`). The
> census list is `$tthreads` = `$targets` + that process; **the WALK deliberately keeps
> `$targets`**, because a third `VirtualQueryEx` sweep costs csc.exe plus a full walk inside the
> 90-second budget and the 09-08 dump already answered that question (2 MB across 25 mappings).
> The census is the cheap half: **one `Start-Sleep` is shared by every subject.**
>
> **PREDICTED READING, stated before it was written: BLOCKED, a busiest thread near 0 ms of the
> 1200 ms window** — the known event has the GPU process at `privateMB=82 handles=609` against
> the target's `3325 / 18119`. **That zero is the informative answer, not a blind one**, exactly
> as the control renderer's 0 ms is what made the target's 1203 ms mean anything. A GPU process
> also burning CPU is a different investigation. Both words are findings.
>
> **HOW TO READ IT:** `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` prints a
> `GPU process (the service beside the ramping renderer)` block and then the pairing verdict.
> - **IDLE beside a spinning renderer** is the client-allocates-service-never-drains shape and
>   is what `MappedMemoryManager` predicts — and the verdict says **CONSISTENT WITH, NOT PROOF**
>   in its own words, because an idle service is also what you see if nothing was ever sent to
>   it. **Do not quote it as a confirmation.**
> - **BUSY** is the branch that argues against the candidate. Take it as a new investigation.
> - **`ABSENCE, not a reading`** is what the three PRE-UPDATE scans still print, and it is
>   correct for them. Only a scan taken from 17:17 UTC onward can carry a GPU line, so **check
>   the scan's own timestamp before reading an absence as a fault.**
>
> **The hazard it is built around, and it is live on the very event this targets:** the 06:47
> scan's own `CHROME` lines carry **two gpu-processes — `rc` at 82 MB and `recgov` at 23 MB**.
> The match is on PARENT, never on size, and never on the target itself. A wrong parent
> assumption yields `not found`, never a confident reading about another browser's process.
>
> ### TWO THINGS NOT TO MISREAD ON THE NEXT RAMP
>
> **1. "No ramp dump" is arithmetic, not a regression.** All three of today's ramps (01:57,
> 04:27, 06:46 PT) resolved in ~2-4 minutes and the renewal trips completed in **46.9 s and
> 47.5 s** — under `MEM_DUMP_STALL_MS` (90 s) — so the trigger correctly never fired. The 09-08
> 21:43 dump fired only because that trip never completed at all. **Read the trip durations in
> `TAB CLOSES` before concluding anything.** And **do not lower the threshold**: it would fire on
> more ramps and every one would return an empty dump, spending the discrimination 90 s was
> measured against 133 tab-closes for.
>
> **2. The peak is DOWN — 3.9-4.0 GB against 8-9 GB all week — and that is creditable to
> nothing.** Three ramps is not a regime, and every "not reproduced this session" reading in
> this file was a window that happened to miss one. The 32 GB mapping is fully present at 3.5 GB
> of private bytes: the mapping arrives in one step and the private bytes are the pages being
> touched, so a shorter ramp is a shorter *touching*, not a smaller mapping.
>
> ### STILL FORBIDDEN, each for a recorded reason
>
> The memory dump as a route to the owner (a wedged renderer contributes **zero** allocator
> dumps at every level — measured off-box); **Track B** (the renewal's Okta trip is measured
> flat, −4 MB); **parking the resident page** (refused by `checkAndReport`'s localStorage rule,
> which would silence `autocart.rc_session` and the phone alarm); **lowering `LOW_RAM_MB`**
> (killed a working repair on 08-19); narrowing `verify.yml`'s triggers;
> `ReadProcessMemory`/minidumps; and **forcing a ramp out of impatience** — 3-in-6 odds, one
> attempt per Okta lifetime, and it spends a password submission from an address that has eaten
> a twelve-hour block. Natural ramps arrive every 5-28 h and every instrument is armed for them.
>
> ### AND THE RELEASE-WINDOW ROUTINE FINALLY RECORDED (07:56 PT)
>
> `rc_release_readings` is **non-empty for the first time** after four lost firings. Today:
> **15 nights, 279 polls, 0 unreadable, 15 of 15 flipped**, `recorded 2 facility row(s)`.
> - `rc-583` locked **−1.6s** → free **+0.4s** (13 nights) · `rc-539` locked **−0.9s** → free
>   **+1.1s** (2) · `rc-542` had no locked nights for this release.
> - **Both brackets straddle T, so neither confirms nor contradicts the 09-04 finding** — that
>   rests on rc-583's `−2.2 → −0.2`, entirely before T, and is untouched. **Quote the negative
>   bracket, never the `+0.4s` median.**
> - **One CLEAN contention observation, which is rare:** `#L015 @2026-09-11` was re-taken by
>   **+74.3s**, and the hold for that unit was **offered and never tapped** — so we demonstrably
>   did not cart it, and the usual "our own carts look identical" caveat does not apply.
> - It self-disables on any Pacific date ≥ 2026-09-12, so **~2 firings remain**. A missed one is
>   run by hand before 07:58:30 PT — **not** fixed with another schedule tweak.

> ## THE STALL TRIGGER CAUGHT A RAMP — AND THE RAMPING RENDERER WOULD NOT ANSWER (2026-09-08)
>
> **State: master `6de1bca` (#305 merged — `src/lib/bot-events.ts` and `scripts/**` are in
> NEITHER of `worker-deploy.yml`'s `paths:`, read not remembered, so **no worker deploy fired**);
> **the mini-PC is on `6de1bca` as well**, having taken it in the quiet window (`bot-ask
> git-status`, never `autocart.bot_version`); 3/3 shards; no holds queued; **health 19 of 19**,
> the `bot_version` warn having cleared because the shas met; highest migration 076; main's block
> 077-079. #305 carries no bot-side code, so the box behaves exactly as it did on `c0b222c`.**
>
> **READ `CLAUDE.md` → "THE STALL TRIGGER FIRED ON ITS FIRST RAMP AND WORKED" FIRST.** A natural
> ramp at **21:43 PT** was caught by #302's trigger — the dump ran ~90 s into the stall, **85
> seconds ahead of the bail**, reading no file. **That ends four consecutive missed ramps and
> the trigger question is CLOSED.**
>
> **IT IS STILL NOT A READING, FOR A NEW REASON.** The dump reached the RIGHT browser generation
> — all seven of its pids are in the ramp scan's own `CHROME` list for the same event — and the
> one process missing is **pid 7644, the ramping renderer** (4,366 MB, 17,306 handles, the
> walk's TARGET). It came back `PARTIAL (no answer in 20000ms)` against a **194 ms** baseline on
> the healthy replacement. **Third instrument, third CDP call, same silence.**
>
> **THE READOUT SAID THE WRONG THING ABOUT THIS EVENT AND IT IS FIXED.** It asserted *"a bail
> killed the generation and the dump measured its replacement"* — **the bail came 85 seconds
> AFTER the dump** — which would have sent you to fix a trigger that had just worked.
> `dumpJoinReading` now splits the cause on the walk's own process list and prints, against the
> real row: *"7 of those 7 pid(s) ARE in the walk's own process list … Do NOT go looking at the
> trigger."* Five mutations, each verified to apply and to fail.
>
> **DO NOT LOWER `MEM_DUMP_STALL_MS` AS THE OBVIOUS FIX — and the series says why, not just the
> guard.** 90 s was measured against 133 tab-closes whose longest trip is 71,552 ms, so a lower
> floor starts firing on healthy trips and a healthy trip can then spend the ramp's slot. **And
> it buys almost no window:** at 21:40:54 the browser did not exist; by 21:42:54 its renderer
> held 2,297 MB with the ~35 GB commit step **already complete**. There is no comfortable moment
> where the renderer both holds the sections and still answers.
>
> **The "7644 did not exist yet" alternative is ruled out from the series** (it was the max pid
> at 2,297 MB, 48 s before the dump), so this is the target going silent and not a timing fault.
>
> **The walk is four for four** (16,385 regions / 16,381 allocation bases / 32,773 MB, all
> anonymous, EXCESS 37,054 MB vs an OS gap of 36,730 MB) and **needs no repeating**. The
> request counter carried a **load burst** (17,093 lifetime on a 3-minute-old browser, 0 in the
> last 120s) — not "flat"; and against 09-07 20:42's **110** lifetime with the same 32 GB
> mapping, the burst and the ramp stay independent in both directions. The
> falsifiable candidate needs no instrument: `mapped_memory_chunk_size` is **2,097,152 bytes**,
> which is 32,773 MB / 16,385 exactly.
>
> ## THE ORDERED RAMP FIRED AND MISSED — NOTHING IS PENDING (2026-09-08, 22:33 PT)
>
> *(State as above — this is the earlier half of the same evening.)*
>
> **WHAT HAPPENED, SO NOBODY RE-RUNS IT.** `trig_01DbvqTrehodKTp1Axq52rzM` fired on time. Both
> preconditions were **read, not predicted** — `okta_alive false`, `okta_expires_at null`,
> `session_ok false` (*"no token at all — signed out"*), checked 3.5 minutes earlier — so the
> attempt was legitimate and it ran. The warm-up fired 20 s after the hold went in and completed
> the **full password form in 16 seconds for a 587 MB peak**:
>
> ```
> 22:33:23 warming up the session: the release is 120m away and Okta is GONE - signing in now
> 22:33:39 OK Okta session established     RAM 10559 -> 10166 MB (-393)  => did NOT ramp
> series:  rc 250 -> 587 -> 328 MB on the SAME pid 8132, commit 7.0 -> 7.7 GB
> ```
>
> **THAT IS A MISS AND A MISS IS A NORMAL OUTCOME** — the `okta=GONE` password form is now
> **three ramps in six**, and duration↔cost tracks **six for six**. The hold was deleted at
> once (0 live holds, confirmed by query), no campsite was locked, and **the one-shot has
> disabled itself and will not refire.**
>
> **DO NOT RE-ARM A FORCED ATTEMPT.** A successful warm-up leaves Okta ALIVE, so the next GONE
> window is ~12 h out at the earliest; natural ramps arrive every 5-28 h and the stall trigger
> is live for all of them. Waiting costs nothing; each forced attempt spends a password
> submission from the address that has eaten a twelve-hour block. **Force only when a reading is
> wanted at a known moment — never out of impatience.**
>
> **SO THE OUTSTANDING READING IS UNCHANGED, AND NOTHING NEEDS BUILDING FOR IT:** one `mem-dump`
> with `phase: ramp` whose `MDPROC` pids contain the ramp-scan walk's TARGET. The stall trigger
> has still never seen a ramp. **`gpu/mapped_memory` at ~32 GB confirms the
> `mapped_memory_chunk_size` candidate; absent or small does not, and is its own finding.**
>
> **ONE FREE READING CAME OUT OF IT.** The clean-side `recaptcha__en.js` baseline is now two
> matching samples (`x7`, 2.4 MB; 233/17.0 MB then 239/17.4 MB). **Two samples of the same
> non-event say nothing about the leak** — what they buy is a baseline for the next ramping
> trace.
>
> **`rc_release_readings` IS STILL ZERO AFTER FOUR FIRINGS** (09-05/06/07/08). Self-disables
> 09-12, ~3 chances left. The remedy is **not** another schedule tweak — run it by hand before
> 07:58:30 PT.
>
> ### THE FORCING RECIPE — kept for when a reading IS wanted, NOT to be run now
>
> ```
> Force a ramp on the mini-PC. Needs the owner's word — it submits a password from the
> household IP and the budget is ONE attempt per Okta lifetime.
>
> STEP 1 — CHECK BOTH PRECONDITIONS. Do not trust any prediction:
>   select okta_alive, okta_expires_at, session_ok, session_detail
>     from rc_runner_heartbeat;
> Need okta_alive false (or okta_expires_at past) AND the RC token dead.
> IF EITHER IS ALIVE: do nothing and check again in ~45 min. A live token makes
> attemptLogin short-circuit in 4.5s and SPENDS the warm-up's only turn (#296).
> An unspent turn is worth more than a wasted attempt.
>
> STEP 2 — IF BOTH ARE DEAD, queue it. Re-run --find for a current unit id and date:
>   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --find --show 6
>   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts \
>     --unit <id> --arrival <date> --nights 1 --watch <watch-id> --in 120
> NEVER invent a unit id — a sentinel is invisible to the warm-up via REAL_UNIT.
> --in 120 opens the T-3h..T-30 window at once with 90 min of margin, so nothing can cart.
>
> STEP 3 — the warm-up fires within ~20s:
>   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts tail-log rc-keepwarm
> Look for "warming up the session ... Okta is GONE". THEN DELETE THE HOLD IMMEDIATELY:
>   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --delete <hold-id>
>
> STEP 4 — read it:
>   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts     (MEMORY DUMPS)
> plus tail-log rc-keepwarm for "* holding the bail up to 20s" then either
> "memory dump (ramp) in Nms" or one of two named expiries ("still in flight" vs
> "without a dump" — different findings, different fixes). And confirm from the series
> (chromium_memory_samples): a ramp is a NEW renderer pid plus a ~35 GB commit step, so a
> flat pid and a few hundred MB is a miss whatever the log says.
>
> READING RULES. The readout joins the dump's MDPROC pids against the ramp-scan walk's
> TARGET and prints VOID on a mismatch — a dump of a healthy renderer says nothing.
> gpu/mapped_memory at ~32 GB CONFIRMS the mapped_memory_chunk_size candidate; absent or
> small does NOT confirm it and is its own finding. Odds are 3 in 6: a MISS (fast clean
> sign-in, no ramp) is a normal outcome — report it as one, do not hunt a fault.
>
> Do not lower LOW_RAM_MB, do not build Track B, do not park the resident page, do not
> narrow verify.yml's triggers. NODE_USE_ENV_PROXY=1 on every stage of npm run verify.
> GitHub only through the MCP tools. Merges go through a PR, never a push to master.
> ```
>
> ## THE TRIGGER NO LONGER NEEDS A RAMP TO TEST (2026-09-08, latest)
>
> **State: master and mini-PC both `c0b222c` (read by `bot-ask git-status`, never
> `autocart.bot_version`); 3/3 shards; no holds queued; highest migration 076; main's block
> 077-079. Health 17 of 19 — `rc_session` and `rc_login` are the documented-benign pair after
> an update.**
>
> **READ `CLAUDE.md` → "THE METHOD WAS THE PROBLEM, NOT THE LEAK" FIRST.** Asked why we keep
> missing things; the answer is countable and it changes how the next session should work.
> **All four missed ramps were in the dump's TRIGGER, never in the dump** — which has never
> failed when allowed to run (six baselines, 209-332 ms, ownership edges resolving on both
> platforms). Four ramps, 5-28 h apart, went on plumbing that nothing exercised off-box.
>
> **THE DUMP IS NOW TRIGGERED BY THE LOOP'S OWN STALL** — `MEM_DUMP_STALL_MS` (90s), checked
> before every arm, reading **no file at all**. `Date.now() - lastTick` is local, never stale,
> never about another browser, and cannot be crossed between two samples, so **none of the four
> failure modes can reach it**. 90s is measured: the longest renewal in forty tab-closes is
> 71.5s and the bail needs 120s. The budget is **per stall episode**, so a slow healthy trip
> cannot spend the ramp's slot. The threshold and the grace are both KEPT.
>
> **AND THE TRIGGER IS TESTABLE IN A CONTAINER NOW: `node scripts/auto-cart-bot/ramp-arm-probe.mjs`.**
> Three of the arm's four inputs are forgeable (`stalledMs` is a number, the memory figure is a
> file we write), so the 09-08 conditions reproduce in seconds. **Run it before shipping
> anything that touches the arm** — it is verified to FAIL against both bugs it exists for, and
> it already caught an assumption from the previous fix (`inFlight` really is still set when the
> reporting callback resolves, so the hold really does cover the POST).
>
> **THE LEADING CANDIDATE IS NAMED, AND IS ONE LINE OF THE NEXT RAMP DUMP.**
> `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is **2,097,152 bytes** — the walk's exact
> 2.0 MB — one shared region per chunk, in the renderer, freed only when the command-buffer
> token advances, with `max_allocated_bytes` defaulting to `kNoLimit`. A ramp is a renderer
> whose loop stopped advancing, and RC's resident page runs a WebGL ArcGIS map.
> **`gpu/mapped_memory` at ~32 GB confirms it; absent or small does not.** Discardable allocates
> **4 MB** segments, so it is weakened on the size alone.
>
> **`mapped-memory-repro.mjs` did NOT reproduce it off-box** across three load shapes — **not a
> refutation**, and the probe says so itself. It did prove `gpu/mapped_memory` is a name the
> dump emits, which is what makes the candidate a read rather than an argument.
>
> **THE NEW RULE, AND IT IS CHEAP: predict the reading before building the instrument.** One
> line in the header — *"on the known 9 GB event, this reads N"*. If N is ~0, do not build it.
> The heap trail, Track A and the RAM arm were each blind for a reason documented at the time.
> `MEM_DUMP_STALL_MS` carries the first worked example.
>
> **STILL OUTSTANDING, UNCHANGED: one `mem-dump` with `phase: ramp` whose `MDPROC` pids contain
> the walk's TARGET.** The readout does the join and prints `VOID` when they disagree.
>
> ## THE FOURTH MISS — THE GRACE HELD AND WAITED FOR NOTHING. FIX IN, NEEDS A BOX UPDATE (2026-09-08, later)
>
> **State: master and mini-PC both `9641e14` (read by `bot-ask git-status`, never
> `autocart.bot_version`); 3/3 shards; no holds queued; highest migration 076; main's block
> 077-079.**
>
> **THE BLOCK BELOW SAID "the only thing left is a ramp". ONE ARRIVED 120 SECONDS AFTER THE BOX
> TOOK THE GRACE — 07:47:50 PT against an update at 07:45:50 — AND THERE IS STILL NO `ramp`
> DUMP.** The grace fired and held; the dump was killed ten seconds in. Two causes, both
> arithmetic:
> ```
> 14:47:50   * holding the bail up to 15s so the ramp dump can name what owns the 32 GB
> 14:48:05 ✗ RAMP — the loop has not advanced in 139s, rc family 3739 MB (reading 18s old)
> 14:48:06   Releasing the profile and exiting so the hold runner can use it.
>            (no `memory dump (ramp) …` line — and no `did not run` line either)
> ```
> 1. **`dumpTaken` was set when the dump STARTED**, and its branch sits ABOVE the deadline
>    check — so the very next tick bailed and the 15s deadline was unreachable code.
> 2. **`MEM_DUMP_TIMEOUT_MS` is 20s against a 15s grace.** Two constants with no stated
>    relationship, ordered the wrong way round. The old guard bounded the grace against the
>    TICK; nothing compared it with the dump's own timeout.
>
> `process.exit(1)` then threw the accumulator away — and `takeMemoryDump` deliberately keeps
> partial data ("A TIMEOUT WITH DATA IS STILL A READING"), so a reading was lost rather than
> never taken. CLAUDE.md → **"THE FOURTH MISS: THE GRACE WAS A PERMISSION SLIP, NOT A WAIT"**.
> Do not re-derive it.
>
> **THE FIX: the hold runs WHILE THE DUMP IS IN FLIGHT, to a deadline DERIVED from the dump's
> own timeout.** `inFlight` clears in the dump's `.finally`, which waits for the `.then` chain,
> so the hold covers the POST too — the half that gets the reading off the box. Worst case
> ~20-30s of extra hold against a stall already 120s old and a wedge that tolerates twelve
> minutes; the three-tick ceiling is KEPT and nothing was relaxed. Nine mutations, each verified
> to apply and to fail; the pre-existing guard that REQUIRED the bug is inverted, not relaxed.
>
> **MERGED AS #300 AND ON THE BOX: `9641e14`, applied 2026-09-08 16:2x UTC, confirmed by
> `bot-ask git-status` and NOT by `autocart.bot_version`.** The worker deploy went green and the
> fleet came back 3/3 shards with a 2s heartbeat; health 17 of 19, the two warns being
> `rc_session` (dead between releases — the update killed the browser) and `rc_login` (standing
> down inside the quiet window after a restart), both documented-benign. **So it needs only a
> ramp** — every 5-28 h, or order one by the recipe below.
>
> **HOW TO READ THE NEXT ONE.** `* holding the bail up to 20s` is the grace being granted; then
> either `memory dump (ramp) in Nms`, or one of **two** named expiries — `still in flight` (the
> browser is too slow to answer inside its own budget: the deadline is the thing to revisit)
> versus `without a dump` (nothing could start: `canDump`/`heapProbe` is the thing to look at).
> Those need opposite fixes and used to print as silence. Then
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`, MEMORY DUMPS — **the readout
> does the pid join itself** and prints `VOID` if the dump and the walk disagree. Expect a
> ~10-20s gap in the RAM trail beside the hold; that is a recorded cost, not a defect.
>
> **WHAT IS STILL OUTSTANDING IS UNCHANGED: one `mem-dump` with `phase: ramp` whose `MDPROC`
> pids contain the walk's TARGET.** `discardable/segment` at ~32 GB names the subsystem; a
> small `shared_memory` total retires discardable, mojo and the GPU transfer path together.
>
> **TWO THINGS THE SAME RAMP GAVE FREE.** The walk is now **three-for-three** — 16,387 regions
> across 16,382 allocation bases, 32,778 MB, 16,380 READWRITE, 64 sampled all anonymous, with
> the control's file-backed positive control present — and EXCESS 36,223 MB against an OS commit
> gap of 39,736 MB. And the burst's fourth sighting is its **second with statuses**: 18,953
> asks, `no answer recorded`, zero of every code, **0 in the last 120s on a browser 2 m old**
> (the load-time-burst shape, not a sustained loop). **Do not re-link the burst to the leak** —
> this ramp carried both and 09-07 20:42 carried the same 32 GB with a flat counter.
>
> ## ~~THE DUMP MISSED A THIRD TIME. THE FIX IS IN AND NEEDS A BOX UPDATE (2026-09-08)~~
>
> **SUPERSEDED BY THE BLOCK ABOVE — the fix landed, a ramp arrived two minutes later, and the
> dump missed a FOURTH time for a fourth reason.** Kept because its account of the third
> mechanism (the sampler's cadence) is still correct and the threshold it introduced is kept;
> only "the only thing left is a ramp" is wrong, and the 15-second figure it quotes is stale.
>
> **State: master and mini-PC both `6843973` at the start of this session (read by
> `bot-ask git-status`, never `autocart.bot_version`); 3/3 shards; no holds queued; highest
> migration 076; main's block 077-079.**
>
> **A NATURAL RAMP AT 02:03 PT PRODUCED NO `ramp` DUMP, WITH #296 LIVE ON THE BOX.** Third
> consecutive miss, and the mechanism is new: the memory series shows **238 MB → 3,423 MB →
> 205 MB across two samples**, i.e. the whole ramp inside ONE two-minute sampler interval. The
> dump's 1500 bar and the arm's 3000 bar are read from the SAME file, so the head start is
> **measured in megabytes and paid in sampler ticks** — and a ramp that crosses the entire gap
> between two samples gives the dump no tick at all. **#296 moved the number and left the
> mechanism.** CLAUDE.md → "THE THIRD MISS: THE HEAD START IS MEASURED IN MEGABYTES AND PAID IN
> SAMPLER TICKS". Do not re-derive it.
>
> **THE FIX GRANTS THE TICK INSTEAD: `rampDumpGrace`.** On a tick where the arm would fire and
> no ramp dump has been taken for this browser life, the bail HOLDS and the dump starts.
> Bounded by a deadline, once per browser life, ≤2 ticks; it can delay the bail, never prevent
> it. The threshold is KEPT — it wins the ~half of ramps where a sample does land in the gap.
>
> **MERGED AS #298 AND ON THE BOX: `64b40d5`, applied 2026-09-08 14:5x UTC, confirmed by
> `bot-ask git-status` and not by `autocart.bot_version`.** The fleet came back 3/3 shards with
> a 3s heartbeat. **So the only thing left is a ramp** — one arrives every 5-28 h, or can be
> ordered by the recipe below once Okta is GONE (it was ALIVE to 09-09 02:35 when this was
> written, so the window is not open yet).
>
> **HOW TO READ THE NEXT ONE.** In `logs\rc-keepwarm.log` a `* holding the bail up to 15s` line
> is the grace being granted; then either a `memory dump (ramp) in Nms` line, or
> `the dump grace expired without a dump` — which is the grace having run and bought nothing,
> deliberately distinguishable from never being granted. Then
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`, MEMORY DUMPS, **and the readout
> does the pid join itself** and prints `VOID` if the dump and the walk disagree.
>
> **EXPECT A ~10-20s GAP IN THE RAM TRAIL beside that line.** A held tick skips one heap, RAM
> and alloc trail sample; it is recorded as a considered cost in the code, not a defect.
>
> **WHAT IS STILL OUTSTANDING IS UNCHANGED: one `mem-dump` with `phase: ramp` whose `MDPROC`
> pids contain the walk's TARGET.** `discardable/segment` at ~32 GB names the subsystem; a
> small `shared_memory` total retires discardable, mojo and the GPU transfer path together. The
> readout does the join and prints `VOID` when they disagree.
>
> **TWO THINGS THAT DO NOT NEED REPEATING.** The walk is now corroborated twice (16,213
> regions / 16,212 bases / 32,443 MB, all anonymous, all READWRITE, with the control's
> file-backed positive control present both times). And the status counter answered on its
> first burst with a **fourth** branch: **69,060 asks, zero answers of any kind** — not 2xx,
> not 401, not `failed`. Candidate, labelled as one: requests outrunning the connection pool.
> **Do not re-link it to the leak.**
>
> **AND A RED CI WITHIN ~90 SECONDS OF A PUSH HAS A NAMED CAUSE.** One `git push` to a
> `claude/**` branch with a PR open starts **two** verify runs on the same SHA (`push` and
> `pull_request`), and the concurrency group takes **3-301 seconds** to cancel one — so two jobs
> run `npm test` against the production DB together. Measured four times on 09-08; the long ones
> are the hazard (five minutes covers most of the suite), so quote the range, not one figure. **Re-run in a clean window before hunting**; confirmed red at 13:33:59 and green on the
> same tree at 14:00:32. `docs/LANES.md` → "ONE PUSH STARTS TWO RUNS".
>
> ## A RAMP CAN BE FORCED. THE WALK ANSWERED. THE DUMP IS THE LAST THING OUTSTANDING (2026-09-07)
>
> **DO NOT WAIT FOR A RAMP — order one.** The previous version of this block said to wait, and
> that is now the expensive reading of the situation. `CLAUDE.md` -> **"THE RAMP WAS FORCED TO
> ORDER"** is the full account; do not re-derive it.
>
> **THE RECIPE, and both preconditions are load-bearing.** `okta=GONE` **AND** the RC token
> dead. Okta alone is what `warmupPlan` checks and it is NOT enough — a live token makes
> `attemptLogin` short-circuit in 4.5 s, which no-ops and spends the warm-up's only turn (fixed
> in #296, but the recipe still needs both). Then:
> ```
> NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts \
>   --unit <from --find> --arrival <far-future midweek> --nights 1 --watch <id> --in 120
> ```
> `--in 120` opens the T-3h..T-30 window immediately and leaves ninety minutes of margin.
> **Delete the hold the moment the trip is under way** — nothing is ever carted, no campsite is
> ever locked. The warm-up fires within ~20 s of the insert.
>
> **IT IS A COIN FLIP: three ramps in five, and one attempt per Okta lifetime.** A successful
> warm-up leaves Okta ALIVE, so the GONE precondition does not come back until the session
> lapses, and `spent` is 1 for that release. `test-login` cannot substitute — while Okta lives
> it is answered from the cookie, and it MINTS a token, which is the state that blocks the
> warm-up.
>
> **THE WALK IS ANSWERED AND DOES NOT NEED REPEATING.** The 32 GB is **15,493 separate
> anonymous READWRITE sections, one allocation base each, 31,005 MB** — N separate
> `MapViewOfFile` calls, not a few large mappings carved into views. The control renderer in the
> same scan reads 5 regions across 4 bases, and one of its five IS file-backed, which is the
> census's own positive control. All-anonymous means no file names the creator.
>
> **SO EVERYTHING NOW RESTS ON ONE `mem-dump` WITH `phase: ramp`.** `discardable/segment` at
> ~32 GB names the subsystem; a small `shared_memory` total against a walk showing 32 GB of
> `commit/mapped` retires discardable, mojo and the GPU transfer path **together**. **Join on
> the pid** — the readout does it itself and prints `VOID` when the dump's `MDPROC` list does
> not contain the walk's TARGET, which is exactly how the 09-07 02:03 dump fooled us.
>
> **THE DUMP HAS NOW MISSED TWICE, FOR TWO DIFFERENT REASONS, BOTH FIXED.** 09-07 02:03 it
> measured a fresh browser after a bail (#291's `notBefore`); 09-07 20:42 the bail arm raced it
> away on the same tick, because it shared `RAMP_MB` and sits after the arm's `return`
> (#296's `MEM_DUMP_RAMP_MB` = 1500). Both are on the box as of `aaf2fe5`.
>
> **AND THE SHARPER FINDING FROM THE SECOND FORCED RUN: duration and cost track each other,
> five for five.** The two misses completed in 32 s and 15.6 s for nothing; the hits took 11-12
> minutes and 9 GB. **The password path is not the trigger — a trip that STRUGGLES is.** The
> next cheap reading is comparing `recaptcha__en.js` fetch counts between a ramping trip and a
> clean one (the clean one did **7**, 2.4 MB); nobody has the ramping figure, because those
> traces bail and `tail-log` rolls at 16,000 characters. That needs the trace STORED rather
> than logged, not a new instrument.

> ## ~~THE OWNER QUESTION IS INSTRUMENTED, IT IS ON THE BOX — WAIT FOR A RAMP (2026-09-06)~~
>
> **SUPERSEDED BY THE BLOCK ABOVE — a ramp can be ordered, and the walk has since answered.**
> Kept because its account of the memory dump is still the right description of the instrument;
> only "wait" is wrong.
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
> **IT FIRED ON A RAMP ON 2026-09-07 AND MEASURED THE WRONG BROWSER. THE READING IS VOID.**
> The drought broke at 02:03 PT. The region walk names the ramping renderer **pid 9912**
> (browser process 3836); a `bail:ramp` at 02:03:46 killed that generation; the supervisor
> brought up a new browser; and the `ramp` dump at 02:04:03 reports **7316, 2960, 6376, 13324,
> 10176, 7660, 14400** — with lead 7316 identical to the lead the BASELINE reports three minutes
> later. **Zero overlap with the ramping generation.** Cause: `.memory-latest.json` is written by
> another process about the whole rc family and accepted up to five minutes old, so after a bail
> the newest sample describes the browser that just died. Fixed with `notBefore` on
> `readLatestMemory` — **bot-side, so it can recur until the box updates.** Full account:
> CLAUDE.md → **"IT FIRED ON A RAMP AND MEASURED THE WRONG BROWSER"**.
>
> ~~**THE INSTRUMENT IS ARMED AND ITS CADENCE IS CONFIRMED (checked 2026-09-06 ~11:50 PT).** The
> box updated at 14:56 UTC, `max_pid` moved to the current browser in the same minute, and the
> single `baseline` dump landed at 14:59:33 — **three minutes into the one browser life there
> has been since.** So one baseline and no ramp row is the instrument working, not a miss.~~
> **Accurate for the quiet box it described; struck because it reads as "a ramp row would be a
> finding", and the first one was not.**
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
> ### STATE AT 2026-09-06, 18:45 PT / 09-07 01:45 UTC (end of session)
>
> **THE PACIFIC DATE IS STILL 09-06.** UTC has rolled over and Pacific has not, so the 07:54 PT
> release-window Routine has **not fired yet** — it is ~13 hours out, not missed.
>
> | | |
> |---|---|
> | master | `6a76677` (the table below was written by the PR that merged its predecessor — trust `git`, not this row) |
> | mini-PC | **`6a76677` — it has since updated and matches master; the `notBefore` fix is NOT on it yet** (was `5399000`, when the gap to master was docs, one web-side file and the readout, so no box update was needed) (read the two commits; `autocart.bot_version` COALESCEs and can show a stale sha beside a live heartbeat) |
> | open PRs | **none** |
> | fleet | **16 of 19** checks ok, three warns, all documented-benign |
> | holds | none queued, so the 6h update gate is open |
> | migrations | highest **076**; main's block is **077-079**, side's is **080+** |
>
> - **#281 (`2ecaca8`) the walk · #282 (`aebaf13`) the trigger id · #283 (`6fdd1de`) handover ·
>   #285 (`5399000`) the memory dump · #286 (`a93829e`) it fired on the box · #287 (`2233420`)
>   the RC-load floor · #288 (`169341d`) handover · #289 (`bf294bd`) the bail-count fix.**
>   Only #285 is bot-side; **#289 fired no worker deploy**, verified after the fact against
>   `worker-deploy.yml`'s run list and not merely predicted.
> - **The three warns:** `rc_session` (RC rejects the token — the ordinary between-releases
>   state, the token lives ~1h and `maybeAutoLogin` restores it at T−30), `bot_version` (box vs
>   web, *"No bot-side code in the gap"*), `rc_login` (a stand-down inside its once-per-20h
>   gate). **A stand-down is not a failure**; do not chase any of the three, and in particular
>   **do not act on `rc_session`'s printed remedy** — `rc-login.bat` force-kills the Chromium
>   the token lives in.
>
> ### THE LEAK IS WAITING ON A RAMP — one command, nothing to build
>
> **No ramp since 09-05 20:29 PT — ~22 hours as of 18:45 PT on 09-06**, flat at ~310 MB with a
> 16-hour peak of 647 MB against the 3,000 MB trigger, commit 41-42%. The observed spread is
> **5-28 hours**, so this is at the top of the range and still neither a cure nor a fault —
> every "not reproduced this session" reading in `CLAUDE.md` was a window that missed one.
>
> **THE INSTRUMENT IS ARMED AND ITS CADENCE IS CONFIRMED TWICE, so one `baseline` row and no
> `ramp` row is it working rather than a miss.** Yesterday: the box updated at 14:56 UTC and the
> baseline landed at **14:59:33**, three minutes in. Today, the cleaner check — **zero
> `request-counts` events in sixteen hours.** Those fire at every teardown and a teardown happens
> on every browser reopen, so the resident browser has had **one continuous life** and one
> baseline is exactly right. (34 `tab-close` rows in the same window are throwaway renewal tabs,
> which do not tear the browser down.)
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
>
> **IT FIRES INTO A BOUND SESSION, AND THAT IS THE FAILURE MODE — not the cron.** Both the
> release-window Routine and the 08:15 outcome one carry
> `persistent_session_id: session_01EfFNmVeERM5XfWwfuW1DyP`. Binding fixed 09-05's "no repository
> attached"; it is what caused 09-06's loss, because a bound session that is **mid-turn** when the
> message arrives queues it until the window has passed. **So the single thing that makes 09-07
> record is that session being idle at 07:54 PT.** Nothing in the repo can enforce that. If a
> third firing is lost, the honest fix is not another schedule tweak — it is that a measurement
> needing a quiet agent at a fixed minute is the wrong shape, and the script should be run by
> hand once instead. Checked 09-06 evening: both Routines enabled, `next_run_at` 09-07 14:54Z and
> 15:15Z, prompt carries `--record`, `--after=120` and the dynamic `$(TZ=…date +%F)` date.

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
>   and the Routine's prompt passes the flag. ~~**First recorded run is 09-07 07:54 PT**~~
>   **— 09-07 WAS LOST TOO, AND THAT IS THREE FOR THREE.** It is bound to the MAIN session, so it
>   needs that session's TURN: on 09-07 the message arrived at 14:54:51Z while the session sat in
>   one tool call waiting on `npm run verify`, **no "notifications pending" notice ever
>   surfaced**, and the run started nine seconds after the window closed. `rc_release_readings`
>   is still EMPTY, so a zero-row readout remains the expected state — it is not the `--record`
>   path being broken. **DO NOT TWEAK THE SCHEDULE AGAIN** (recorded, now paid for three times;
>   moving the fire earlier spends the 600s Bash ceiling one for one). **The remedy is to RUN IT
>   BY HAND before 07:58:30 PT on a day somebody is present** — the command is in the Routine
>   prompt and in CLAUDE.md. The structural fix (a fresh session WITH the checkout attached) is
>   an environment question nobody has answered; raised, not chosen. The inert-disabler gap is
>   still open beside it.
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
> **Also deleted 2026-09-09 (evening): the "THE DUMP CAN NEVER ANSWER; THE WALK NOW CAN"
> block.** Its whole action item was *"wait for a ramp and read VMTHREAD and VMSPAN"*, and
> the ramp arrived at 06:47 PT and both answered — so read as current it sends the next
> session to wait for a reading that is already taken. Every finding in it is in `CLAUDE.md`
> under "THE DUMP CAN NEVER ANSWER — A WEDGED RENDERER IS *PRESENT AND EMPTY*": the off-box
> `dump-wedge-probe.mjs` measurement, the four artifact runs before it, the 32 GiB ceiling,
> the two populations of ramp, and "no peer holds the 32 GB".
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
