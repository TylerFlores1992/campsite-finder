# The Chromium / ReserveCalifornia memory-leak investigation

*Extracted verbatim from `CLAUDE.md` on 2026-09-21. This file is the AUTHORITATIVE RECORD
for the Chromium memory leak, the RC keep-warm browser, the RC token/Okta session renewal,
and every instrument built to measure any of them.*

**Nothing here was rewritten.** Every block below is the original text, in its original
order, including its strike-throughs — several of which are load-bearing, because they
record a tempting wrong answer that was falsified. Read a struck heading together with the
text under it; the correction is what the strike-through exists to carry.

`CLAUDE.md` keeps a router entry with the conclusion and the standing prohibitions. If you
are about to build a memory instrument, read that entry first and this file second.


**One caveat, and it is the cost of splitting one file into four.** `CLAUDE.md` interleaved
these subjects chronologically, so a cross-reference inside a block — *"the entry above"*,
*"see directly below"* — may now point at text that landed in a **different** archive. The
blocks themselves are intact and in their original relative order; only their neighbours
changed. `docs/PRUNE-LEDGER.md` maps every block to its original `CLAUDE.md` line range, so a
reference that has lost its target can be located there in one lookup.
---

### THE KEEP-WARM WEDGES ~HOURLY IN THE NEAR-EXPIRY RENEWAL (2026-08-17) — STILL OPEN
Found in the same read, and it is a **bigger risk to the next 08:00 than the outage above.**
```
15:42:58 renewing the session - the token has 10m left (src=live)
15:55:58 x WEDGED - the keep-warm loop has not advanced in 13m.
```
It enters the near-expiry cell, never returns, `HUNG_MS` (12m) fires, it releases the profile
and exits 1, the supervisor restarts it, the session recovers via `authorize` from a
token-less profile — and ~50 minutes later the token is back to 10 minutes and it repeats.
**Four times on 08-17** (05:39, 06:53, 07:43, 08:55 PT), which is what every `code=1` in
`restarts.log` is.
- **A WEDGED KEEP-WARM HOLDS THE CHROMIUM PROFILE**, and the runner's preemption is
  COOPERATIVE — it drops `.camphawk-profile-wanted` and waits for a loop that is not
  advancing. **A wedge at 07:50 is an 08:00 cart that cannot happen**, which is 2026-08-10
  exactly.
- **Playwright's `page.evaluate` HAS NO TIMEOUT**, and `readLiveToken`, `dropStoredToken` and
  `restoreStoredToken` were bare evaluates — with `readLiveToken` the FIRST line of
  `renewSession`. Every other await on that path is bounded and they sum to ~4 minutes
  against an observed 13. All three now go through `evaluateWithin` (20s), and a timeout
  returns the ABSENT reading (`source: 'none'`, empty snapshot) rather than an error — the
  shape the callers already treat as "we could not tell".
- **THAT THIS IS THE HANG IS NOT PROVEN.** Nothing recorded which await it was, and a
  Playwright call failing to honour its own timeout against an unresponsive browser is still
  live. **Confirm from the box after the update:** a `renewing the session` line followed
  within ~20s by a result instead of a wedge settles it. If it still wedges, suspect the
  browser, not the code.
  - **ANSWERED THE SAME DAY, AND THE ARROW POINTS THE OTHER WAY.** The wedge is not the
    disease, it is the browser at 25 GB refusing to answer. See directly below: the four
    wedge times above (05:39, 06:53, 07:43, 08:55) match four memory-ramp recoveries
    (05:40:35, 06:55:00, 07:45:21, 08:57:35) to within two minutes. `evaluateWithin` is
    still right — it turns a hang into a fast failure — but it prevents nothing.

### THE CHROMIUM LEAK IS FULLY ATTRIBUTED (2026-08-17, third pass) — 20 RAMPS IN 5 DAYS
The sampler (migration 059) had never once recorded an event; it has now recorded twenty, and
the family that was guessed wrong twice is settled. **Every ramp is the `rc` family — the
keep-warm's own resident browser** — and `recgov` peaks at 0 MB in nineteen of the twenty.
```
last-healthy 11:06:19  rc 214MB pid144       RAM free 13,115MB   commit 11%
first-big    11:08:20  rc 3,057MB pid144     RAM free  9,776MB   commit 58%   <- SAME pid
             11:12:20  rc 13,773MB           RAM free  1,816MB   commit 77%
peak         11:18:29  rc 27,085MB pid144    RAM free    881MB   commit 99%
recovered    11:20:21  rc 163MB pid2956      RAM free 13,480MB   commit 10%
```
- **~2,400 MB/min, and it is REAL memory.** Free RAM goes 13,112 → 881 MB, so the commit is
  being TOUCHED, not reserved. That rules out a huge-but-untouched allocation and it rules
  out reading the metric wrong.
- **ONE PROCESS, and the same pid that was healthy two minutes earlier.** `max_mb` carries
  almost all of `rc_mb` (25,183 of 25,436 in one). It is the resident tab going bad, not a
  fleet of children accumulating.
- **EVERY ~70 MINUTES, TWENTY TIMES, ACROSS FIVE DAYS.** 08-16: 08:05, 09:17, 13:50, 15:03,
  16:09, 17:17, 18:31, 19:47, 21:32. 08-17: 00:41, 01:53, 02:57, 04:12, 05:26, 06:42, 07:31,
  08:43, 09:51, 11:08, 12:14. **This was never an occasional event** — every "not reproduced
  this session" reading in this file was a window that happened to miss one.
- **60 min of token + ~10 min of ramp = the 70-minute period.** The browser opens, mints a
  token, is flat for about an hour, the near-expiry renewal runs, it ramps, it dies, repeat.
- **THE RECYCLE SHIPPED THAT MORNING COULD NEVER HAVE FIRED.** `RC_MAX_FAMILY_MB` is checked
  in the resident loop's BODY, and the leak happens during a WEDGE — which is by definition
  that loop not advancing. On all twenty occasions control never reached the check. **A guard
  placed inside the thing it guards against is not a guard**, and this is the third instance
  of the shape here, after `expireStaleHolds` living in the feed only a live runner polls and
  `reclaimLapsedHolds` living inside `withRC`. The wedge watchdog's own comment had already
  written the rule down — *"the renew timer is the only code proven to still be executing,
  which makes it the only place a watchdog can live"* — and the recycle did not obey it.
- **THE FIX IS TWO LAYERS, AND THEY ARE DELIBERATELY DISTINGUISHABLE.**
  1. **Containment (certain).** A RAM-pressure arm inside the watchdog timer: stalled >60s
     **AND** `os.freemem()` under 4 GB → release the profile and exit, exactly as the wedge
     arm does. The timer now ticks every 10s rather than 2 min, because **the tick interval
     IS the overshoot** — at 2,400 MB/min a two-minute timer lets it gain 5 GB between looks.
     The profile lock keeps its own `RENEW_MS` cadence inside the faster timer.
  2. **Root-cause candidate (a hypothesis, labelled as one).** The three throttling-disable
     flags are removed. They were added 2026-08-08 to catch *"a timer inside RC's app"* —
     and this file's own later findings killed that premise twice over: okta-auth-js's
     autoRenew fails and **deletes** the tokens (08-09), and RC issues **no refresh token at
     all** (08-15). Nothing we rely on needs them, because `page.evaluate`/`page.goto` are
     devtools-driven and unthrottled. What they cost is every brake Chrome has on an occluded
     tab — and this tab spends hours occluded running an SPA in a permanent 401 state.
- **`os.freemem()` AND NOT THE POWERSHELL SCAN, deliberately.** `rcFamilyMb()` spawns a child
  process, and spawning is precisely what fails at 99% COMMIT — it is *how* `supervise.ps1`
  could not start a shell on 08-12 and *how* the Scheduled Tasks stopped on 08-17. An
  instrument that goes quiet as the emergency peaks reports the emergency as calm.
- **BOTH CONDITIONS, ALWAYS.** Low RAM alone is the owner using their own desktop PC; a stall
  alone is an unattended sign-in doing its job. Acting on either would be the cry-wolf failure
  this file has fixed three times, most expensively at 07:33 on 08-16.
- **WHAT THE FIX BUYS, STATED HONESTLY.** The RAM floor is crossed about three minutes into a
  ramp, at ~8-10 GB and ~68% COMMIT — comfortably below the ~90% where Windows stops
  scheduling tasks and the 99% where Node aborts. **So the box never goes dark again.** It
  does NOT stop the browser being recycled; that is what layer 2 is for, and it is unproven.
- **HOW TO READ THE NEXT FEW DAYS.** The two layers act at different points, so the memory
  series tells them apart: **no ramps at all ⇒ the flags were the cause**; **ramps that still
  appear but stop around 8-10 GB ⇒ the containment is what worked and the flags were not it.**
  Shipping them together is only acceptable because of that. Crediting a repair to the wrong
  mechanism has cost this file three times.
- **THE ALLOCATION SITE INSIDE THE PAGE IS STILL UNKNOWN — do not write one in.** Candidates
  not distinguished: a retry loop in RC's SPA against a token that expired 44 hours ago, our
  own `fetch` wrapper retaining `init` per pending request, or something in Chromium's
  handling of the occluded headful window. What would settle it is a `--remote-debugging-port`
  heap snapshot taken DURING a ramp, which needs somebody at the box in the ten-minute window.
- ~~**THE CONTAINMENT FIRED ON ITS FIRST RAMP, ~70 MINUTES AFTER THE BOX UPDATED, AND THE A/B
  ANSWERED ITSELF.**~~ **BOTH HALVES OF THAT WERE WRONG. IT WAS `update.bat`.** Struck rather
  than deleted, because this is the "crediting a repair to the wrong mechanism" failure the
  entry three bullets above warns about, committed within the hour by the person who wrote
  the warning.
  ```
  16:43:02  commit 15%  RAM free 8,502MB  rc 264MB   pid9544   <- healthy
  16:45:02  commit 53%  RAM free 6,178MB  rc 2,217MB pid16816  <- ramping
  16:47:03  commit 61%  RAM free 1,580MB  rc 7,016MB pid16816  <- 7 GB
  16:47:31  [stop-all] stopping chrome.exe pid 16816 (orphaned Chromium)   <- THE UPDATE
  16:47:41  commit 15%  RAM free 9,556MB  rc 208MB   pid7896
  ```
  **The memory series alone cannot tell a guard firing from a stop-all**, and I read the
  recovery as the guard. `restarts.log` settles it: keep-warm process starts are 15:54:19,
  15:58:52, **16:47:37**, 17:11:49 — so the browser that ramped was launched at 15:58 on
  `e5cf430`, which predates the containment. There is **no `✗ RUNAWAY` line anywhere in the
  log**, which is the tell that should have been checked first: the guard announces itself,
  and silence meant it had not run.
  - **THE CONTAINMENT HAS NEVER FIRED.** Nor has the age recycle. All three instruments are
    deployed and none is production-tested.
  - **THE FLAGS ARE STILL AN OPEN CANDIDATE.** That browser still had them. The A/B written
    up as settled has not been run, and the reading rule stands unchanged: **no ramps at all
    ⇒ the flags were the cause; ramps that appear but stop around 8-10 GB ⇒ the containment
    is what worked.**
  - **The calibration doubt about `os.freemem()` is therefore NOT resolved either** — nothing
    has compared it against the PowerShell figure in anger. The first genuine trip resolves
    it, because the `RUNAWAY` line prints the reading it saw.
- **CONFIRMED, AND IT IS THE ONE THING THAT SURVIVED: THE RAMP BEGINS AT THE NEAR-EXPIRY
  RENEWAL.** From the keep-warm's own log, against the same ramp:
  ```
  23:44:16 renewing the session — the token has 9m left (src=live)
           [ramp: 23:45:02 → 2,217 MB … 23:47:03 → 7,016 MB]
  23:47:37 keep-warm restarts
  ```
  `src=live` with 9 minutes left is the **near-expiry cell** — the one half of the 2x2 that
  has never been observed to succeed. So the ramp is not merely correlated with a browser's
  age; it starts in a specific, identified code path. That is direct support for the age
  recycle, which exists precisely to arrive at every renewal from the token-less cell instead.

### THREE INSTRUMENTS FOR THE UNCURED HALF (2026-08-17, fourth pass)
- **A BREADCRUMB, because four wedges could not say which await hung.** `mark()` in the
  resident loop plus an `onStep` callback threaded through `renewSession`, so the bail prints
  `Stalled in: renew:click-sign-in (312s in that step)` instead of "the loop has not advanced".
  **`mark()` deliberately does NOT touch `lastTick`** — a step beginning is not the loop
  advancing, and if it reset the clock, entering a step would postpone the very watchdog that
  exists to catch a step never finishing. That would have made the wedge detector WORSE while
  looking like an improvement; it is the first mutation the test suite checks.
- **HEAP FACTS OVER CDP when the guard trips** (`scripts/auto-cart-bot/rc-heap.mjs`).
  `Performance.getMetrics` + `Runtime.getHeapUsage` answer the one question that halves the
  candidate space: **is the JS heap most of the process, or almost none of it?** Huge ⇒
  JavaScript is retaining it (a retry loop, our own `fetch` wrapper holding `init`). Small
  against a 25 GB process ⇒ it is NOT JavaScript, which eliminates every current candidate at
  a stroke. The log line states that verdict rather than printing counters.
  - **NOT a heap snapshot at the peak.** A snapshot of a 25 GB heap is itself many GB, written
    to disk at the moment the box cannot spawn a process — the cure arriving as part of the
    disease. The full snapshot is opt-in (`RC_HEAP_SNAPSHOT=1`), hard-capped, and wired ONLY
    to the early 1,500 MB trip, where the file is ordinary and the growing objects are already
    present. The RAM arm never writes one.
  - **No `--remote-debugging-port`.** It would open a socket with full control of a browser
    holding a live RC session, on a machine that is routinely screen-shared, to buy a
    diagnostic. CDP rides Playwright's existing channel; if that turns out to be jammed when
    needed, it reports `no answer` and the port becomes a decision made on evidence.
  - Bounded at 3s per step and every failure is a null, so it can never delay the exit — the
    mistake `rcFamilyMb` would have made in this same arm.
- ~~**AN AGE RECYCLE AT 40 MINUTES**~~ — **BUILT, MEASURED, AND REMOVED THE SAME NIGHT.** The
  argument was that a recycled browser comes back token-less, i.e. in the half of the 2x2 that
  works. **The premise is false: localStorage survives a browser restart.** The first firing
  said so in two lines:
  ```
  02:36:27 ♻ recycling the browser at 40m old …
  02:36:32 RC loaded and STAYING OPEN — token source: live      <- NOT token-less
  02:58:44 renewing the session — the token has 10m left (src=live)   <- the same cell as ever
  03:00:24 ✗ RUNAWAY … Stalled in: renew:click-sign-in
  ```
  It changed neither the cell nor the timing and cost a browser restart every forty minutes —
  and restarts are not free: one of them turned the login rehearsal red the same night. Gone,
  with `worker/keepwarm-diagnosis.test.mts` pinning that it stays gone and why.
- **AND THE SAME DATA CLOSES THE "SHOULD THE RESIDENT TAB EXIST?" QUESTION — IT SHOULD.** The
  proposal was to park it on `about:blank` so the SPA ran seconds per minute instead of
  continuously. **The idle tab is measured innocent**: it sits at 200-330 MB for the best part
  of an hour and only ramps DURING the renewal, in every one of the twenty events. Parking
  would target the harmless part and add a page load per poll from an IP that has eaten a
  12-hour block. **Do not revisit without new evidence.**

### THE FIRST REAL FIRING, AND WHAT IT COST (2026-08-18)
```
02:36:27 ♻ recycling the browser at 40m old …                    <- age recycle: worked, useless
03:00:24 ✗ RUNAWAY — stalled 99s with only 3862 MB of free RAM (floor 4000 MB)
03:00:24   heap facts unavailable (newCDPSession: no answer in 3000ms)
03:00:24   Stalled in: renew:click-sign-in (58s in that step).
```
- **THE CONTAINMENT IS PROVEN, THIS TIME WITH ITS OWN LOG LINE.** Peak **5,688 MB / 71%
  COMMIT** against 27 GB / 99% untreated. The box stayed healthy throughout.
- **`os.freemem()` IS CALIBRATED.** The guard read **3,862 MB**; the PowerShell sampler read
  **3,726 MB** twenty seconds later — 3.5% apart. The doubt recorded when it shipped is closed.
- **THE BREADCRUMB NARROWED IT TO THE RENEWAL — and NOT to the click, however tempting.**
  `rc` went 280 MB → 5,688 MB between 02:58:24 and 03:00:25, which spans the reload, the token
  prime AND the click. `renew:click-sign-in` is where it was **caught**, not where it is proven
  to allocate. What IS established is that this is the renewal path and not the idle SPA.
- **THE HEAP FACTS FAILED, AND THE REASON IS FIXED.** Creating a CDP session needs the browser
  to negotiate a target attachment, which a browser eating the machine will not do.
  `attachHeapProbe` now opens the session **at launch while everything is healthy**, and the
  trip only SENDS a command down it. The old path survives as a fallback, and the shared
  session is never detached by a borrower — doing so would silently restore the bug on the
  second firing.
- **SECOND FIRING, 04:05:54 — THE CONTAINMENT HELD AGAIN AND THE CDP FAILURE MOVED.**
  ```
  04:03:52 renewing the session — the token has 10m left (src=live)
  04:05:54 ✗ RUNAWAY — stalled 121s with only 3669 MB of free RAM (floor 4000 MB)
  04:05:54   heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
  04:05:54   Stalled in: renew:click-sign-in (80s in that step).
  ```
  Peak 4,866 MB / 51% COMMIT. **Attaching the probe at launch worked** — the failure is no
  longer `newCDPSession` — **and the browser will not answer a command down an EXISTING socket
  either.** Two firings, two different CDP failures, and together they close the question:
  **the reading cannot be taken at the trip at all**, and no timeout worth spending changes it.
  - **SO THE INSTRUMENT MOVED EARLIER: a heap TRAIL.** The watchdog tick samples
    `Performance.getMetrics` every 10s while the browser still answers and keeps the last
    dozen; the trip prints them with ages. A ramp goes 270 MB → 5 GB in two minutes, so the
    samples either side of the onset are exactly the ones that say whether the JS heap grew
    **with** the process or stayed flat while something outside it did. Same move as the memory
    sampler that started all this: a series replaces an observation that can only be taken at
    the worst possible moment.
  - **Fire-and-forget with an in-flight flag.** The timer must never await — its whole value is
    that it keeps running — and once the browser goes quiet every attempt costs its full
    timeout, so without the flag they pile up one per tick.
  - **An EMPTY trail is its own reading** and says so: "the browser answered no CDP call at
    all" and "the JS heap was flat" are different facts and a blank line would merge them.
  - **BOTH FIRINGS STALLED IN `renew:click-sign-in`, AND THAT STEP NAVIGATES TO OKTA.**
    `clickSignInControl` clicks RC's Log in control, which goes to
    `signin.reservecalifornia.com`. So the ramp coincides with loading OKTA'S page, not RC's
    SPA. **Recorded as a candidate, not a finding** — the memory rose across the reload, the
    prime and the click, so the navigation is where it was caught and not yet where it is
    proven to allocate. The trail is what will separate them.
- **THIRD FIRING, 05:09:57 — AND THE TRAIL ANSWERED THE QUESTION.**
  ```
  05:07:55 renewing the session — the token has 10m left (src=live)
  05:09:57 ✗ RUNAWAY — stalled 121s with only 3728 MB of free RAM (floor 4000 MB)
  05:09:57   heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
  05:09:57   heap trail (newest first): 123s ago JS 16 MB / 1711 nodes · 133s ago JS 16 MB /
             1711 nodes · … twelve samples, byte-identical …
  05:09:57   Stalled in: renew:click-sign-in (81s in that step).
  ```
  **IT IS NOT THE JS HEAP.** Sixteen megabytes, flat, with a flat DOM, while the process reached
  **4,903 MB**. That eliminates the entire JavaScript-retention family in one reading — the
  retry loop, our own `fetch` wrapper holding `init` per pending request, an array nobody trims,
  DOM growth. Whatever allocates is OUTSIDE the JS heap.
  - **STATED PRECISELY, BECAUSE THE TRAIL SHOWS ITS OWN LIMIT.** All twelve samples are
    identical and the newest is **123s** old against a **121s** stall — so sampling stopped the
    instant the renewal began, and the during-ramp window is UNOBSERVED. What makes "not the JS
    heap" the strong reading anyway is V8's own ceiling: default max old space is ~4 GB and
    these ramps have peaked at **27 GB**. A 27 GB process cannot be mostly JS heap.
  - **The containment had held THREE times at this point** — 5,688 / 4,866 / 4,903 MB, never
    past 71% COMMIT. And all three stalled in `renew:click-sign-in`, which navigates to
    `signin.reservecalifornia.com`. **Still a candidate**: memory rose across the reload, the
    prime AND the click, so that is where it was caught, not where it is proven to allocate.
    - **PAST TENSE DELIBERATELY — "never past 71% COMMIT" IS NO LONGER TRUE OF THE BOX.** Those
      three firings are real and this reading of them stands. What does not carry forward is the
      standing state it implies: on 2026-08-22 and 08-23 two ramps reached **8,983 and 9,180 MB
      at 82% and 88% COMMIT and the arm did not fire on either.** See "NEITHER 9 GB RAMP TRIPPED
      THE RAM ARM" below.
- **TWO INSTRUMENTS FOR THE NEXT ONE (migration 062).** The heap trail cannot answer either
  question, for one shared reason — it stops when CDP does.
  1. **A FREE-RAM TRAIL WITH THE STEP ATTACHED.** `os.freemem()` is a syscall, not a request to
     the browser, so it keeps answering through the whole event, and it is already read on every
     10s tick. Each reading carries the breadcrumb step, so the next trip prints e.g.
     `9080 MB @ renew:reload · 8900 @ renew:prime-after-reload · 4100→3700 @ renew:click-sign-in`
     — which is what separates the three steps, and they have different fixes. Consecutive
     identical steps collapse, **oldest→newest inside a group**: the first version overwrote as
     it walked and printed the OLDEST value against the NEWEST timestamp, reversing the
     direction of travel on the one line whose job is showing memory fall. Caught by rendering a
     fixture and reading it, which is the only way a formatting bug ever is.
  2. **THE CHROMIUM PROCESS TYPE.** `browser` / `renderer` / `gpu-process` / `utility` are four
     different investigations and the sampler recorded only the profile FAMILY. `--type=` sits
     on the command line it already reads for `--user-data-dir`. **The parent carries no `--type`
     at all**, so an absent flag identifies it as `browser` rather than defeating the check.
     `rc_by_type` keeps per-type totals as well, because the last three ramps put only 3,052 MB
     of 4,903 in the biggest process — naming only that describes under two thirds of the growth.
     - **The 2-min sampler can now catch a ramp at all**, which is new: it spawns PowerShell, and
       that used to fail as COMMIT passed ~95%. With the guard capping ramps near 60-70% it
       recorded the whole of this one.
     - **The parser stays backward compatible** and the type field goes BEFORE the directory: the
       directory is a path that may contain `|` and is joined from the remainder, so a field
       after it would be swallowed. A four-field line from a box that has not updated reads as
       "type not reported" rather than putting the path in the type slot and classifying every
       process as `other`.
     - The type is allow-listed on the way into the database — it crosses the network from the
       box and renders on the admin page — and an empty per-type map stores NULL, never `{}`.
- **AND THE PROCESS-TYPE CHANGE KILLED THE MEMORY SERIES FOR TEN MINUTES (2026-08-18).**
  `rc_by_type` is `jsonb`, and a plain JS object was handed to `mutate`. **`sqlit`
  INTERPOLATES rather than binds**, and its fallback is `String(val)` — so the object became
  the literal `'[object Object]'`, Postgres rejected it, the whole INSERT threw, and
  `recordMemorySample`'s `.catch` turned that into silence.
  - **THE COST WAS NOT THE MISSING COLUMN. NO SAMPLE WAS STORED AT ALL** — the instrument this
    entire investigation runs on, switched off by one unstringified argument, with nothing
    anywhere reporting it. Found only because a reading that should have arrived did not.
  - **DIAGNOSED FROM THE CLOCK, and the first two readings were both misread.** Samples stopped
    at 05:35:50 and `bot.mjs` restarted at **05:36:37**, so the NULLs read at 05:37 predated the
    new code entirely and proved nothing either way; then four minutes with no sample at all
    looked like the box, when the timing points at Vercel deploying the new route. **The box was
    never at fault.** `tail-log bot` showing a restart AFTER the samples is what separated them.
  - Fixed at the call site (`JSON.stringify` + `$15::jsonb`, verified by driving the real INSERT
    against the real table and reading it back) **and systemically: `sqlit` now THROWS on a plain
    object.** `[object Object]` is either a rejected statement or corrupt data written without
    complaint, and no caller can ever have wanted it — so throwing surfaces an existing bug
    rather than creating one. Arrays and Dates keep their real encodings; the refusal sits
    ABOVE the `String()` fallback or it could never run.
  - **A MUTATION SURVIVED AND THE REASON IS THE USUAL ONE.** The guard asserted the refusal's
    MESSAGE was present and correctly positioned, so `if (false)` left both true and passed
    against a `sqlit` that stringified objects exactly as before. Pin the comparison, not the
    branch it guards. **Twelfth time.**
### FOURTH FIRING, 2026-08-18 23:12 PT — BOTH INSTRUMENTS ANSWERED
The process type and the RAM trail landed together, and between them they name the family of
allocation and **correct a candidate this file carried for three firings.**
```
baseline  rc  264MB  {browser:42,  utility:24, renderer:103,  gpu-process:93, crashpad:2}
ramp      rc 2046MB  {browser:587, utility:28, renderer:1340, gpu-process:89, crashpad:2}
```
- **IT IS THE RENDERER *AND* THE BROWSER PROCESS.** Renderer **+1237 MB**, browser process
  **+545 MB**; GPU, utility and crashpad all FLAT. That rules the GPU family out entirely, and
  the pairing is the interesting part — the browser process is where Chromium's network stack
  lives when the network service is not in its own utility process, and utility did not move.
- **WITH THE JS HEAP FLAT AT 15 MB**, that gives: **non-JS memory, in the renderer and the
  browser process.** Network/IPC buffering is the leading CANDIDATE, and is labelled as one.
- **THE CLICK IS NOT THE TRIGGER — THE RAM TRAIL SAYS SO IN ONE LINE.**
  ```
     3s ago  6912→3946 MB free @ renew:click-sign-in      (x7)
    73s ago  8440→7253 MB free @ renew:prime-after-reload  (x4)
   113s ago  9060      MB free @ login rehearsal
  ```
  Read oldest-first: the machine was already shedding ~1,200 MB **during
  `renew:prime-after-reload`**, before the click ran at all. The click is simply the LONGEST
  step, which is why the stall landed there on all four firings — exactly the "caught, not
  proven" caveat the trail was built to settle. **The onset is the reload that follows
  `dropStoredToken`.** `renew:reload` never appears because it completes inside one 10s tick.

### STOP RENEWING AT NEAR-EXPIRY (2026-08-18) — BUILT, awaiting a box update
The step that leaks is a step that has never worked, so removing it may cost nothing.
- **Every ramp began in a NEAR-EXPIRY renewal** (`the token has 10m left (src=live)`):
  23:44, 02:58, 04:03, 05:07, 06:12 — five for five.
- **That cell has never once succeeded.** This file's own 2x2 already records it as "not
  observed to work" (`554s → none`, `-115s → none`), and on 08-18 not one attempt completed —
  the guard killed the browser every time.
- ~~**The TOKEN-LESS cell works and does not ramp**: `✓ renewed by authorize: none → 3580s`,
  observed repeatedly, with `cleared 0 storage key(s)` and no memory event after any of them.~~
  **FALSIFIED THE SAME DAY — see the section directly below.** It works and it ramps ~2.3 GB.
  Every "no memory event" reading behind that sentence was a 2-minute sampler missing a
  46-second allocation. **The stand-down is still right and it HALVES the leak; it does not
  cure it,** because the cell it moves to navigates to Okta as well.
- So: let the token lapse and renew from empty. The apparent cost — a few dead minutes per
  hour — is what we ALREADY have, because the near-expiry attempt fails anyway.
- **A WOBBLE, RECORDED SO IT IS NOT RE-DISCOVERED AS A REFUTATION.** Two near-expiry renewals
  on 08-18 (11:08, 11:38 UTC) show no ramp. Both read `· skipped: no Okta session to renew
  against` — they never ran. They neither support nor contradict.
- **BUILT.** `planRenewal` now stands down while the token is alive AT ALL (`key: 'alive'`)
  instead of acting under a 10-minute threshold. `RENEW_BEFORE_S` and the `renewBeforeS`
  parameter are GONE rather than left unused, so nobody wires the threshold back in by
  accident. `leftS == null` (no token, or one that will not decode) and `leftS <= 0` still act
  — refusing those is the ninety dead minutes of 2026-08-15.
- **THE COST, STATED HONESTLY:** the session is dead between expiry and the next attempt, at
  most one `RENEW_FLOOR_MS` (5 min). **That is not new.** The near-expiry attempt renewed
  nothing and took the browser with it, so that window was already dead — and cost several GB.
- **`maybeAutoLogin` IS UNTOUCHED.** It signs in at T−30 of a real release and is the thing
  between a queued hold and a missed cart. This schedule is the background repair; they stay
  separate, as they have since 2026-08-15.
- **THE OLD GUARD WAS INVERTED, NOT DELETED.** `worker/renewal-schedule.test.mts` asserted
  `go === true` at 5 minutes left; that assertion WAS the bug, so it now asserts the stand-down
  and says why. A second test pins the boundary as live-vs-dead (1s acts as alive, 0s acts as
  lapsed) so the threshold cannot creep back as "under a minute is basically expired".
  Four mutations, each verified to fail.
- ~~**HOW TO READ THE NEXT DAY.** If ramps stop entirely once the box updates, this was the
  cause. If they continue, the near-expiry path was merely where it was observed and the real
  trigger is the reload-with-clear itself — which the token-less renewal also performs, just
  with nothing to clear.~~ **ANSWERED IN NINETY MINUTES, AND BY NEITHER BRANCH.** The trigger
  is not the reload-with-clear either — two token-less renewals ran the identical clear and
  reload with no ramp at all. See below.

### A THREE-DAY-OLD TOKEN KEEPS COMING BACK (2026-08-19) — the session cannot exit the loop
Four consecutive renewals produced the same impossible pair:
```
✗ no fresher token (none → -267960s), got as far as: none
    cleared 0 storage key(s): (none — nothing was there to drop)
```
- **No token BEFORE, a 74-hour-dead one AFTER**, and the negative grows by ~700s per run —
  one fixed ancient expiry receding, i.e. the SAME corpse returning every time. Something
  restores it DURING the navigation.
- **This is why the session cannot recover.** Every renewal ends with the app holding a dead
  token, Okta reporting `ALIVE`, and nothing minting anything. `maybeAutoLogin` at T−30 is the
  only thing that can break the loop.
- **`dropStoredToken` COVERS LESS THAN ITS NAME SUGGESTS.** `localStorage` only, and within it
  only `ssoAccessToken`, `accessToken`, and keys starting `okta-`. It has never touched
  **sessionStorage**, **IndexedDB**, or a localStorage key under any other name. Cookies are
  excluded deliberately and must stay so — losing `DT` makes a sign-in look like a fresh
  profile, which cost the household IP twelve hours on 2026-08-06.
- The 2026-08-15 entry already named the candidates — *"IndexedDB, a cookie, or a key name
  nothing has looked for"* — and then nobody looked. `storage-census.mjs` looks.
- **VALUES ARE NEVER REPORTED: a key NAME, a character COUNT, and a locally-decoded `exp`.**
  Every value here is potentially the session, and this repo has published a credential twice
  by collecting a field it then had to filter — an OAuth code on 08-09, a password on 08-16.
  An age identifies the corpse and cannot be replayed.
- **It fires ONLY on the pathology** (`!renewed && after < 0`), because it reads every key name
  in both stores and doing that on every renewal is noise on the one log read at 07:30.
- ~~**NO `idb` FIELD.**~~ True when written and **superseded within the hour by the census's own
  first reading** — see directly below. The reasoning stands and is why the coverage arrived as
  a SECOND evaluate rather than by making one body async: an always-empty array would read as
  "we looked and found none", the zero-for-an-absent-reading mistake, twice made.
- `worker/storage-census.test.mts`, **six mutations, each verified applied** — the value
  reported, a failed read shown as empty stores, the `SURVIVES` flag dropped, sessionStorage
  treated as covered, clean stores reported as an all-clear, and the gate widened to every
  renewal.

#### IT ANSWERED ON ITS FIRST RUN: THE CORPSE IS NOT IN EITHER WEB STORE (2026-08-19 05:58)
```
05:57:54 renewing the session — the app holds no usable token (src=none)
05:58:52   ✗ no fresher token (none → -270366s), got as far as: none
05:58:52     cleared 0 storage key(s): (none — nothing was there to drop)
05:58:52     storage census: local 6 key(s), session 1 key(s) — NO token-shaped value in
             either store, so the stale token is coming from somewhere else
05:58:52    signin.reservecalifornia.com: DT, [opaque], luf_*, ln, luf_*, [opaque], idx, JSESSIONID
```
- **THE PATHOLOGY IS CONFIRMED AS ONE FIXED EXPIRY RECEDING, TO THE SECOND.** `-270133s` at
  05:54:59 and `-270366s` at 05:58:52 differ by **233s**, which is exactly the wall clock
  between them. So it is not a family of stale tokens — it is the SAME token, minted around
  2026-08-16 01:52 (the last one the box held before the session died), coming back every time.
- **AND IT IS NOT IN `localStorage` OR `sessionStorage`.** Six keys and one key respectively,
  none of them JWT-shaped. That eliminates the store `dropStoredToken` sweeps AND the store it
  has never touched, in one reading — which is the whole reason the census reports the count
  and the shape rather than just the names it knows about.
- **SO THE REMAINING CANDIDATES ARE INDEXEDDB, A COOKIE, OR THE SERVER**, and the census then
  declined to look at the first of those. **Fixed the same night (PR #134):** IndexedDB is
  enumerated through a SECOND evaluate — names, object stores and `count()`, **never a value**.
  `getAll()` would pull every row into a renderer already suspected of allocating gigabytes,
  which is `response.body()` and the multi-GB heap snapshot all over again.
- **`renewSession` ALSO REPORTS WHERE THE TOKEN WAS FOUND NOW**, and it is one field that was
  already being computed and thrown away. `primeToken` returns a `source`: **`live`** means the
  token came off RC's own outbound Authorization header — the SPA held it in memory, having
  restored it from somewhere the clear cannot see — while **`localStorage`** would mean the
  census simply ran too late and the store is the answer after all. Two different
  investigations, separated for free.
- **TWO EXISTING GUARDS BROKE OVER UNCHANGED BEHAVIOUR.** `storage-census.test.mts` pinned the
  inline `takeStorageCensus((fn, arg) => evaluateWithin(…))`, and hoisting that arrow into a
  `const` invalidated it; `keepwarm-recycle.test.mts` pinned `renewSession`'s ENTIRE return
  literal in order, so adding `afterSource` beside `visitedOkta` failed over a change that
  altered nothing. Both re-anchored on the property rather than the expression, and both
  verified still failing against the regression they exist for. **Seventeenth time.**

#### AND FOUR OKTA TRIPS IN NINETY MINUTES DID NOT RAMP — which does not fit
The first RAM-paired trace is a NEGATIVE, and it is the interesting kind:
```
05:58:52  network trace: 112 response(s), 8.7 MB declared (+30 with no content-length)
          · simple_banner.jpg 3.3 MB · index-*.js x2 1.9 MB · …
          · RAM 8837 → 8784 MB (−53) ⇒ this navigation did NOT ramp, so the byte count
            says nothing about the leak — wait for one that does
```
The memory sampler agrees independently: `rc` went 199 → 323 → 342 MB across it.
- **THE THREE-WAY VERDICT EARNED ITS KEEP IMMEDIATELY.** Without the RAM reading this would
  have printed *"buffering does NOT explain the ramp"* over a navigation that never ramped —
  which is the exact false elimination the 05:07 trace was one sentence away from being written
  up as. It refused instead.
- **AND IT CONTRADICTS "EVERY OKTA NAVIGATION COSTS ~2.3 GB".** Four token-less renewals
  between 05:43 and 05:58 all clicked through to Okta and **none of them ramped**; the hourly
  peak table reads 370 MB at 05:00 and 329 MB at 06:00 against 4,168 MB at 04:00.
- **TWO CANDIDATE EXPLANATIONS AND THE DATA CANNOT SEPARATE THEM — do not write one in.**
  (1) **The browser's AGE matters** and the post-Okta recycle, by keeping every browser young,
  has incidentally suppressed the ramp; the 08-18 19:10 counter-example (token-less, ONE trip,
  2,331 MB) was in a browser that had been alive about an hour, before that recycle reached the
  box. (2) **The CELL matters** — every ramp over 4 GB has been `src=live` (the two-trip case:
  the SPA's own `prompt=none` plus our click), and 04:00 today was `src=live` at −1m.
  **Both predict today's silence.** The discriminator is a token-less renewal in a browser that
  has been alive an hour, which the recycle now makes rare on purpose.
- **THE BOX HAS NOT BEEN PAST 71% COMMIT SINCE THE 25 GB ORPHAN**, and the orphan sweep has
  since shipped. Containment is holding; the cause is still open.

#### THE HAND SIGN-IN TOOK 17 SECONDS, AND THE LOGIN IS NOT BROKEN (2026-08-19 06:24 UTC)
Three days dead, and `rc-login.bat` fixed it on the first attempt with no CAPTCHA and no form
struggle:
```
06:24:23 Opening ReserveCalifornia for a ONE-TIME human sign-in.
06:24:40 ✓ Signed in. The keep-warm loop can take it from here.
06:24:40   token call: {"grantType":"authorization_code","usedPkce":true,…}
06:24:40   grant:      {"hasRefreshToken":false,"expiresIn":3600,…}
```
- **SO THE 08-18 "GOT HUNG UP AT PASSWORD" READING IS NOT A STANDING FAULT.** Whatever that
  was, the credentials work and Okta still remembers this device — the browser rendered
  **"Log in / Sign up"**, i.e. genuinely signed out, so this exercised the real sign-in rather
  than being answered silently. That is the `provedNothing` case avoided by luck of state.
- **`hasRefreshToken: false` AGAIN.** The script's own epilogue asks for these three lines
  because `hasRefreshToken` "decides whether the 8am hold can ever run without a human" — that
  question was **answered on 2026-08-15** and the answer is no, there is nothing to silently
  refresh with. **The prompt is older than the finding; do not re-open it on seeing that line.**
- **`autocart.rc_session` READ `fail` FOR ABOUT A MINUTE AFTERWARDS AND IT WAS AN ARTIFACT** —
  *"RC REJECTED the session … checked 0s ago"*, taken by a keep-warm that had just been
  relaunched by `rc-login.bat` and had not primed the token yet. It read `ok … token exp in
  60m; okta=ALIVE` on the next pass. **A health reading taken 0 seconds after a restart is not
  evidence**; the same family as the 08-12 note that a reading goes stale faster than a
  conclusion drawn from it, inverted — this one was too FRESH to mean anything.
- **`autocart.rc_runner` SAID "1 hold(s) due" AND IT WAS A TEST FIXTURE.** `dueHolds` is
  deliberately NOT filtered to real unit ids (the hold suites exist to test it), so any
  `npm test` run — including CI on a merge — puts a `requested` sentinel inside the 20-minute
  grace for the length of the run. It read `no holds due` once the run finished. Expect this
  whenever a merge lands; it cannot cart anything, because the unit id is non-numeric.

### `npm test` KILLED THE PRODUCTION RC SESSION (2026-08-19) — fixed in the FEED
The 2026-08-18 entry records fixture-driven profile churn as *"bounded, understood"*. **It is
not churn. It is the session**, measured:
```
13:33:52 ♻ token exp in 45m; renewed=no; src=live; okta=ALIVE   <- 7h old, self-sustaining
13:49:07 → hold runner wants the profile — closing and standing down
13:49:50 RC loaded and STAYING OPEN — token source: none        <- the token is GONE
13:50:38 ⚠ RC SESSION IS DEAD
```
- **THE LIVE TOKEN LIVES IN PAGE MEMORY, NOT localStorage**, when the SPA has been silently
  re-minting — so the keep-warm's yield-close-reopen loses it. (A token minted by OUR renewal
  goes through the exchange and into storage, and DOES survive a restart — the two behave
  oppositely, which is why 08-19's update kept the session and 13:49 did not.)
- **AND THE WORK IT YIELDED FOR WAS A TEST FIXTURE** — the runner's log names `#L__t9003`,
  `#L__t9102`, `#L__t9007`, and the 13:49 pass falls inside CI for **a PR that changed only
  Markdown.** So any `npm test` run, CI included, can take the session a real cart depends on.
- **FILTERED IN THE FEED, NOT IN THE QUERIES.** `dueHolds`/`pendingClaims` are what the hold
  suites exist to test; filtering them would gut the tests that make this table safe, which is
  why the 08-18 fix stopped at `nextHoldRelease`/`holdAtRisk`. `isRealUnitId` filters what the
  runner is SERVED — all three work lists, because all three make it take the profile, and
  `pollMs` too or a fixture drops it onto the 1s cadence. Server-side, so it reached the box on
  a push. `worker/feed-fixture-invisibility.test.mts`, six mutations.

### A BLANK RC APP IS NOT A FAILED LOGIN — in the release path too (2026-08-19)
`attemptLogin` has returned `provedNothing` for RC's *"We're having trouble loading the
application"* since 08-18. **The rehearsal honoured it; `maybeAutoLogin` did not** — the refund
sat inside the `r.ok` branch and a blank load returns `ok: false`, so the T−30 caller fell to
the plain failure arm: spent one of two attempts, reported `dead`, rang the phone, and printed
`rc-login.bat` — which force-kills the Chromium the token lives in.
- **Observed live the same day**: RC showed that screen during a hand sign-in, seconds after
  `stop-rc` killed eleven processes, and **cleared on a retry.** The transient case is real and
  it happens when the box is disturbed, which is what T−30 looks like.
- **NOTHING IS REPORTED on that arm** — `warm` and `dead` are both verdicts and a page that
  never rendered supports neither; the previous verdict goes stale, which `alarmIfSessionUnusable`
  still watches. It stays LOUD with a screenshot: this is also the 08-14 profile-fault signature.
- A REAL login failure still reports `dead` and still spends an attempt, pinned separately so
  this is not bought by making every failure inconclusive. `worker/autologin-noload.test.mts`.

### THE RENEWAL RUNS IN A THROWAWAY TAB NOW (2026-08-19) — the first CURE, and what it rests on
The owner's instruction was "solve the leak", and the recorded cure (1) is what shipped
(PR #142): **the renewal's Okta round trip runs in a tab opened for that purpose and closed
in a `finally`** — same context, same cookies, same localStorage, so the minted token lands
in the same profile — and the renderer that did the trip dies at close, taking its
allocation with it.
- **THE THREE MEASUREMENTS IT RESTS ON**, all above: the ramp is NON-JS memory (heap trail:
  15-18 MB flat against multi-GB processes); it lands in the RENDERER (+1,237 of 2,046 MB)
  plus the browser process; and across twenty ramps it has **never once been seen to come
  back down in place** — every recovery was a new pid. A renderer's memory dies with its
  page, so give the trip its own page.
- **THE RECYCLE IS GONE FROM THIS PATH AND KEPT FOR `maybeAutoLogin`/THE REHEARSAL**, which
  still navigate the resident page. The recycle was a browser restart per renewal; restarts
  are not free (one turned the rehearsal red on 08-18) and after the tab they free memory
  that is already freed. **The old guard asserting the renewal sets `oktaTrip` was INVERTED
  deliberately** — reinstating that line reintroduces a per-renewal browser restart that
  looks like caution.
- **THE RESIDENT PAGE IS RELOADED AFTER A SUCCESSFUL TAB RENEWAL**, because `checkAndReport`
  reads the resident page and `window.__camphawkRcToken` is per-page: without it, every
  report after a tab renewal announces a dead session over a fresh hour of token — a repair
  that happened and cannot be seen.
- **WHAT THIS DOES NOT CLAIM: the allocation itself is not stopped.** A ramping trip still
  ramps while it runs; the RAM arm still guards it. The claim is only that the memory is
  handed back at close, every time, without costing the browser. **HOW TO READ THE SERIES:**
  spikes that drain at tab close with no `♻ recycling` line ⇒ working as designed; rc-family
  growth ACROSS renewals ⇒ the browser-process share does not drain, which is the residual to
  chase next (cure (2), `ctx.request`, remains unbuilt and would eliminate it).
- **AND THE "~2.3 GB PER OKTA TRIP" FIGURE IS NO LONGER A LAW.** The 19:20 renewal on 08-19
  made a complete, SUCCESSFUL round trip — click, authorize, callback, code exchange, fresh
  hour — for **141 MB** (`RAM 7839 → 7698`). Whatever separates a 141 MB trip from a 2.3 GB
  one is still unknown; the tab makes the question moot for the resident browser's health,
  and the RAM-paired trace keeps measuring it per-trip either way.
- **A TAB THAT CANNOT OPEN IS RECORDED** (`recordRenewal(renewed: false)`), so `planRenewal`'s
  floor and backoff pace the retries — unrecorded, a sick browser retries every tick, which
  is the 2026-08-08 request storm. The failure diagnostics (censuses) bind to the TAB while
  it is open: localStorage is shared, but the corpse-carrying `window.__camphawkRcToken`
  lives where the trip ran.
- `worker/keepwarm-recycle.test.mts`, six mutations, each verified applied — the renewal
  moved back to the resident page, the tab never closed, the recycle reinstated, the
  resident refresh removed, a failed tab open unrecorded, and the prime dropped.

### FIVE INSTRUMENTS AND NONE OF THEM STOPS IT — so COUNT THE BYTES (2026-08-19)
The owner's question, and it is the right one: *"It sounds like we keep trying to find a
solution for what to do after the leak, not stop it from leaking."* **Correct.** A size guard,
a RAM arm, a heap trail, a post-Okta recycle and an orphan sweep are all aftermath. Each was
justified in the moment by a box actively falling over, and none was ever a cure.
- **THE CANDIDATE WAS NAMED THREE TIMES AND NEVER TESTED.** "Network/IPC buffering" is written
  into three separate entries above as the leading explanation, and it is **directly
  observable** — non-JS memory growing by gigabytes in the RENDERER and the BROWSER PROCESS is
  the shape of a huge or looping response, and the browser process is where Chromium's network
  stack lives when the network service is not in a utility process (utility was flat).
  Nobody ever watched the network during a ramp.
- **`okta-net-trace.mjs` counts them**, wrapped around `renewSession`, logged pass or fail —
  the failing renewals are the ones that ramp, so a trace gated on success would miss every
  event it exists for. Aggregated BY PATH, because forty requests to one endpoint at 30 MB is
  a LOOP and looks nothing like one big download.
- **A NEGATIVE IS THE POINT.** Small numbers ELIMINATE the whole buffering family at a stroke
  and make the next candidate worth building for. The verdict line says which way it went
  rather than printing counters.
- **IT MUST NOT BECOME THE THING IT MEASURES.** Response bodies are NEVER read —
  `response.body()` buffers the payload into this process, which on a page suspected of moving
  hundreds of MB is the cure arriving as part of the disease, the same mistake as writing a
  multi-GB heap snapshot when the box cannot spawn. Only `content-length` is consulted, and the
  record count is capped.
- **AND IT MUST NOT LEAK A CREDENTIAL.** URLs are `origin + pathname`. Okta's callback is
  `/login/callback?code=…&state=…` and that code is exchangeable for the session — published
  once already on 2026-08-09 by reporting `location.href`. **Do not collect a field you would
  then have to filter.**
- **THE TWO REAL CURES, NOT BUILT, in order of ambition.** (1) Do the Okta round trip in a
  throwaway TAB in the same context — same cookies, same session — and close it; the last
  event put 2,689 MB of 4,168 in the renderer, reclaimed deterministically instead of by
  killing the browser. (2) Skip the renderer entirely: intercept the authorize request (the
  `prompt=login` machinery already does this), abort the navigation, replay it over
  `ctx.request` following redirects, hand the callback back. No page load, no gigabytes.
  **Do the trace first** — it is the only one that could make both unnecessary.
- `worker/okta-net-trace.test.mts`, **eight mutations, each verified applied.** One survived
  first: the disarm flag deleted. **The test was wrong, not the code** — it fired a leaked
  handler and then asserted a SECOND trace saw nothing, but a leaked handler pushes into the
  FIRST run's array, which has already been summarised. The effect is not observable from
  outside, so the flag is pinned structurally and the reason is written down.
- **THE FIRST TRACE RAN, AND IT NEARLY PRODUCED A FALSE ELIMINATION (2026-08-19 05:07).**
  ```
  05:06:13 renewing the session — the app holds no usable token (src=none)
  05:07:12   network trace: 112 response(s), 8.7 MB declared (+30 with no content-length)
             · simple_banner.jpg 3.3 MB · index-*.js x2 1.9 MB · index-*.css 0.5 MB
  05:07:24 ♻ recycling the browser — the sign-in click took it through Okta
  ```
  8.7 MB across a full Okta round trip is three orders of magnitude below a 2.3 GB
  allocation, and it was one sentence away from being written up as retiring the buffering
  candidate. **It was not entitled to be.** The 2-minute memory sampler BRACKETED that
  renewal — 05:05:56 and 05:07:56 either side of a run from 05:06:13 to 05:07:12 — and the
  post-Okta recycle freed everything twelve seconds after it ended. **Whether that navigation
  ramped at all is unobserved**, and a trace of a non-ramping trip says nothing about a leak.
- **TWO INSTRUMENTS HAD MADE EACH OTHER USELESS.** The recycle now cleans up faster than the
  sampler samples, so the series can no longer see the very event the trace is attached to.
  That is a new shape here: not a guard that cannot reach what it measures, but two correct
  instruments whose cadences cancel.
- **FIXED BY PAIRING THE TWO FACTS IN ONE READING.** `os.freemem()` is taken immediately
  before and after the SAME wrapped call — a syscall, so it keeps answering under the pressure
  that stops `rcFamilyMb()` spawning PowerShell, and read inside the `try` so the recycle
  cannot have run yet. The verdict is now three-way and **refuses to speak when there was no
  ramp**: `RAM 8940 → 6610 MB (−2330) ⇒ it ramped while the network moved almost nothing`
  versus `⇒ this navigation did NOT ramp, so the byte count says nothing about the leak`.
  Same rule as `unknown` never rounding to `signed-out`.
- **AND A GUARD FROM YESTERDAY BROKE OVER UNCHANGED BEHAVIOUR.** `keepwarm-recycle.test.mts`
  anchored on `await renewSession(`; wrapping the call in `withNetworkTrace(page, () =>
  renewSession(…))` made `indexOf` return **-1**, so `readAt < -1` was false and it read as a
  real regression. Re-anchored on the callee with an explicit `> -1` assert, so a missing
  anchor fails loudly instead of silently inverting.

### THE RAM GUARD KILLED THE REPAIR IT WAS PROTECTING (2026-08-19) — floor 4000 → 2000
Reported as *"the session died after 4 hours"*. It did not, and none of the three obvious
causes is the answer.
- **IT SUSTAINED ITSELF FOR ~7h45m.** From the 19:21 sign-in to 03:00 the token cycled
  `42m → 22m → 2m → 41m → 21m → 1m → 41m → 21m → 1m → 40m` — five or six SILENT re-mints, with
  `renewed=no` and **zero `renewing the session` lines**. The self-renewal recorded the night
  before held far longer than the 2.5h it was recorded on.
- **AT 02:58:43 THE RE-MINT STOPPED AND OKTA'S EXPIRY FROZE, IN THE SAME INSTANT.**
  ```
  02:57:30  okta exp 14:57:30   <- rolling, +12h from the moment of the check
  03:17:30  okta exp 14:58:43   <- frozen
  03:37:31  okta exp 14:58:43
  03:57:32  okta exp 14:58:43
  ```
  The probe still answers `ALIVE`; the window simply stops advancing. **So there is an
  ABSOLUTE cap sitting behind the rolling idle timer**, and the SPA cannot silently re-mint
  once it is reached. That qualifies the 12-for-12 finding rather than overturning it: the
  rolling window is real and it is bounded. **What the cap is measured from is NOT
  established** — 02:58:43 is 19h37m after the sign-in, which is not a round number.
- **THEN OUR OWN GUARD KILLED THE REPAIR.**
  ```
  03:58:37 renewing the session — the token has -1m left (src=live)
  04:00:36 ✗ RUNAWAY — stalled 117s with only 3630 MB of free RAM (floor 4000 MB)
  04:00:36   RAM trail: 7158→3630 MB free @ renew:click-sign-in (x8)
  04:00:36   Stalled in: renew:click-sign-in (78s in that step).
  ```
  The stand-down worked exactly as designed — it waited for a genuinely lapsed token (−1m).
  The memory series shows the rest: flat 280 MB until 03:58, **4,168 MB** at 04:00 (renderer
  2,689 + browser 1,350, the two-trip signature), 213 MB at 04:02 after the kill.
- **AND IT WAS STRUCTURAL, NOT BAD LUCK.** The arm needs a 60s stall AND low free RAM. The
  Okta navigation **always** exceeds 60s and **always** allocates several GB, so a renewal
  that is working perfectly meets both conditions every single time. That is why all five
  firings stalled in `renew:click-sign-in` — arithmetic, not coincidence. **`maybeAutoLogin`
  makes the same navigation at T−30 of a real release**, with the breadcrumb parked on
  `auto-login`, so at 4000 the guard could take the login a campsite depends on.
- **THE POST-OKTA RECYCLE CANNOT COVER THIS**: `visitedOkta` is set when the click RETURNS,
  and here the process died mid-click.
- **FLOOR IS 2000 NOW, from the box's own series.** Free RAM maps to COMMIT roughly
  1,875 MB → 74%, 982 MB → 83%, 520 MB → 89%; the numbers that matter are ~90% (Windows stops
  scheduling) and ~99% (Node aborts). 2000 acts at about 73% — seventeen points of margin —
  while leaving room for a renewal whose worst observed peak is 5,688 MB against a ~9,000 MB
  idle, i.e. a trough near 3,300 MB.
- **THE CASE THAT JUSTIFIED 4000 HAS ITS OWN REMEDY NOW.** The 25 GB event was an ORPHAN, and
  **this arm never fired on it** — the loop kept ticking, so there was no stall. That is
  `orphan-sweep.mjs`'s job and it does not depend on this threshold. What is left here is the
  BOUNDED case, which the box survives comfortably.
- `worker/keepwarm-recycle.test.mts` now bounds the floor from BOTH sides with those measured
  numbers (≥1500 so it never acts past ~85% COMMIT, ≤3000 so it cannot trip during a normal
  renewal), rather than the old ≥2000/≤8000 which encoded the reasoning that produced 4000.
  Three mutations, each verified applied: the floor restored to 4000, dropped to 500, and the
  both-conditions rule removed.

### THE SESSION RENEWS ITSELF ONCE WE STOP TOUCHING IT (2026-08-18, first 2.5 hours)
An OBSERVATION, not yet a measurement, and it is better than the stand-down was meant to buy.
Straight off the keepalive lines, with **zero `renewing the session` entries in the window**:
```
20:58:57 ♻ … token exp in 15m; renewed=no; src=live; okta=ALIVE
21:18:58 ♻ … token exp in 54m   <- went UP
21:38:58 ♻ … token exp in 34m
21:58:59 ♻ … token exp in 14m
22:18:59 ♻ … token exp in 54m   <- again
22:39:00 ♻ … token exp in 34m
```
- **Our renewal never ran.** `planRenewal` stands down for the whole period (`the token has
  59m left — waiting for it to lapse`), so nothing of ours navigated to Okta. The token was
  re-minted twice anyway, between 20-minute checks.
- **AND THERE WAS NO RAMP.** Nothing above 400 MB in 2.5 hours, across both re-mint cycles —
  against a browser that produced twenty ramps in the five days before. That is consistent
  with the controlled comparison below: no Okta navigation, no allocation.
- **So the near-expiry stand-down may have done more than halve the leak.** It was justified
  as "the cell that leaks has never worked, so removing it costs nothing"; in the steady state
  it appears to remove our Okta round trips altogether, because the SPA re-mints on its own
  while the token is still alive and we no longer interrupt it.
- **WHAT re-mints is NOT established — do not write one in.** Candidates: okta-auth-js's own
  autoRenew (which this file records as failing and DELETING the tokens, measured in a
  different state), the keepalive's own page load, or `sessionLive`'s authenticated call.
  `renewed=no` on every line is not evidence against any of them — that flag compares before
  and after within ONE check and cannot see a re-mint between two.
- **IT INTERLOCKS WITH THE OKTA-PROBE FINDING, AND THAT IS THE PART TO BE CAREFUL WITH.** A
  silent re-mint needs a live Okta cookie, and the section below establishes that OUR OWN
  unconditional probe is what keeps that cookie from idling out. So the accidental
  load-bearing probe is plausibly what makes this loop self-sustaining, and "tidying" it would
  take this with it.
- **TWO CYCLES IS NOT A REGIME.** The reading that would matter is the same pattern still
  holding after an overnight, and after a real `attemptLogin` (which navigates and therefore
  still leaks by construction). Do not quote this as "the leak is solved".

### IT IS THE OKTA NAVIGATION, AND THAT IS A CONTROLLED COMPARISON (2026-08-18, fifth pass)
The stand-down above went live on the box at ~19:13 PT. Within ten minutes the keep-warm's own
log produced the cleanest evidence this investigation has had — three **token-less** renewals,
same code, same profile, same browser generation, differing in exactly one thing: whether RC's
sign-in control was found and clicked.

| time (UTC) | cell | stage reached | navigated to Okta? | `rc` family at the next sample |
|---|---|---|---|---|
| 19:04:04 | token-less | `no-signin-control` | **no** | 200 MB |
| 19:10:43 | token-less | `authorize` ✓ (`none → 3579s`) | **yes** | **2,331 MB** |
| 19:13:46 | token-less | `no-signin-control` | **no** | 237 MB |

- **The two that never navigated ran the identical `dropStoredToken`, `renew:reload` and
  `renew:prime-after-reload` and allocated NOTHING.** So the RAM trail's reading — "the onset
  is the reload after `dropStoredToken`" — was where the stall was *caught*, not where the
  allocation happens. That correction is the same shape as the one the trail itself made about
  `renew:click-sign-in`, one level further in.
- **THE ARITHMETIC AGREES.** A near-expiry renewal makes **two** Okta round trips — the SPA's
  own hidden `prompt=none` once a real clear signs it out, then our click — and lands at
  4,313 / 3,986 / 4,866 / 4,903 MB. One trip lands at 2,331 MB. Half the trips, half the
  memory, and the 19:03 trail shows the two halves separately
  (`8638→6552 @ renew:prime-after-reload`, then `6217→3802 @ renew:click-sign-in`).
- **WITH THE JS HEAP FLAT AT 15-18 MB** and the growth in the **renderer plus the browser
  process**, the mechanism is still non-JS memory — network/IPC buffering remains the leading
  CANDIDATE and is not promoted. What IS established is the trigger.
- **SO THE SCHEDULE CANNOT CURE THIS.** `attemptLogin` navigates to Okta too, and it is
  release-critical: `maybeAutoLogin` at T−30 is the only thing between a queued hold and a
  missed cart. There is no version of this product that never loads Okta.
- **THE FIX IS THEREFORE A RECYCLE, KEYED ON THE EVENT.** `renewSession` returns
  `visitedOkta` — read off the CLICK, not off `stage`, because `authorize`/`none` mean clicked
  and `no-signin-control` does not, which is three strings to keep in step across two files
  for one boolean. The resident loop reads one `oktaTrip` flag at the TOP (the auto-login and
  the rehearsal both `continue`, so a check beside each call site is three chances to forget
  one) and `break`s into the existing reopen path.
- **WHY RECYCLE RATHER THAN LET THE GUARD HANDLE IT.** 2.3 GB trips nothing: it leaves
  ~6,500 MB free against a 4,000 MB floor, and the renewal COMPLETES, so there is no stall
  either. Across twenty ramps in five days **every one was followed by a new pid** — the
  memory has never once been seen coming back down in place — and nothing has ever run two
  renewals in one browser life, because the guard always killed it first. **Whether it
  accumulates hour on hour is UNKNOWN**, and the choice was between finding out at 3 a.m. and
  making the question moot.
- **THIS IS NOT THE AGE RECYCLE THAT WAS REMOVED, and the reason is the fact that killed it.**
  That one fired on a clock and came back `token source: live` — because `localStorage`
  survives a browser restart — so it landed in the same near-expiry cell and changed nothing.
  Here that same fact is what makes this SAFE: the freshly minted token survives the reopen,
  `planRenewal` stands down for 59 minutes, and the browser sits at its 200 MB baseline until
  the token lapses. One recycle per token lifetime, at the moment the allocation happened.
- **NOT GATED ON `RECYCLE_COOLDOWN_MS`, though it stamps it.** We KNOW two gigabytes were just
  allocated; standing down would leave them standing. Pacing comes from `planRenewal`'s floor
  (5m), gap (10m) and backoff instead.
- **AND IT MAY BEAR ON THE LOGIN.** The owner's sign-in "got hung up at password" and a later
  one sat on *"We are processing your request…"*. Okta's form is rendered **by the navigation
  that allocates the gigabytes**, so memory pressure is now a live alternative to the CAPTCHA
  reading — **both remain candidates, neither is established.** The discriminators already
  exist: `diagnose()` reads Okta's own error banner, `saveFailureShot` writes a picture (a
  challenge is visible in it), and the RAM trail carries the step, so a login that allocates
  shows up as a trail entry losing GB `@ auto-login`.
- `worker/keepwarm-recycle.test.mts`, **seven mutations, each asserting the mutation applied** —
  `visitedOkta` read off the stage, the early skip dropping the field, the flag set after the
  `continue`, the check moved below the setters, the check moved above the profile yield, the
  cooldown gating it, and `process.exit` instead of `break`.
  **One guard failed at baseline and the reason is the usual one**: it anchored on
  `maybeAutoLogin(ctx, page)`, which matches the function DEFINITION four hundred lines above
  the call site. It anchors on the awaited call now. **Thirteenth time.**

### A 25 GB RUNAWAY, FIVE RECYCLES, AND THE GUARD CLOSED THE WRONG BROWSER (2026-08-18)
**THE CONTAINMENT DOES NOT CONTAIN AN ORPHAN, AND THE BOX REACHED 94% COMMIT.** This is the
single most urgent thing open. It followed straight on from the spurious CI-triggered login
above, and the two together are one chain.
```
20:00:44  ⏰ hold releases in 1m … signing in       <- a CI test fixture (see below)
20:01:51  [keep-warm process restarts MID-LOGIN]    <- ORPHANS its Chromium
20:02:40  rc  5,118 MB  pid 13004 renderer  64% COMMIT   free 4,361 MB
20:06:45  rc 17,811 MB  pid 13004           83%          free   982 MB
20:12:52  rc 25,307 MB  pid 13004           94%          free   163 MB
20:14:51  rc    325 MB  pid  6772           15%          free 11,788 MB
```
- **THE SIZE GUARD FIRED FIVE TIMES AND FREED NOTHING**, and said so without anybody hearing:
  `RECYCLING` at 20:02:21, 20:11:57, 20:14:20, with `over the line, but a recycle is still
  cooling down` at 22,356 / 23,994 / 24,794 / 25,408 / 25,812 MB in between. **The reading went
  UP across every recycle.**
- **THE PID SETTLES IT, AND IT WAS ALREADY IN THE MEMORY SERIES.** `max_pid` is **13004 in
  every sample** from 20:02:40 to 20:12:52 — across three recycles. And at 20:02:40, one second
  after a browser opened at 20:02:39, pid 13004 was already **4,953 MB**: a renderer born that
  second cannot be five gigabytes. **So 13004 predates the reopen. It is an ORPHAN**, left by
  the keep-warm process restarting at 20:01:51.
- **`ctx.close()` IS NOT A KILL, AND THE GUARD MEASURES A FAMILY IT CANNOT ACT ON.**
  `rcFamilyMb()` totals every Chromium on the profile directory; the recycle closes only the
  context this process owns. An orphan is therefore **fully visible to the measurement and
  invisible to the remedy** — so the guard recycles a healthy browser, over and over, while
  reporting the corpse's memory as the reason. Fourth instance in this repo of a guard whose
  remedy does not reach the thing it measures.
- **AND A SECOND CHROMIUM RAN ON ONE `user-data-dir`** — the corruption case the profile lock
  exists to prevent. The lock did not stop it because an orphan holds no lock file: the dying
  process released it on the way out, and the new keep-warm took it and launched anyway.
- **THE RAM ARM COULD NOT HELP EITHER.** It needs a stall **and** low RAM, and the loop kept
  ticking the whole time — so at 163 MB free, one condition short, it never fired. The
  both-conditions rule is right for the case it was written for (the owner using their own
  desktop) and it has no answer for a healthy loop next to a dying box.
- **WHAT TO BUILD, and it is bot-side so the box must update.** The keep-warm must **kill any
  Chromium on `.rc-bot-profile` that it does not own, immediately AFTER TAKING THE PROFILE LOCK
  and before `launchPersistentContext`** — while COMMIT is still normal and a PowerShell spawn
  still works. That is `kill-chrome`'s existing `rc` mechanism (kill by `--user-data-dir`, no
  cooperation needed) moved to the one moment it is both necessary and cheap.
  - **THE LOCK IS WHAT MAKES THE SWEEP SAFE, AND "AT STARTUP" WITHOUT IT WOULD BE A DISASTER.**
    `rc-hold-runner.mjs` drives the SAME profile directory, so a blanket kill on process start
    can land at 08:00:00 on the Chromium that is carting. Once we hold the lock the runner does
    not, so anything still on that profile is by definition owned by nobody — which is exactly
    the orphan, and nothing else. (This corrects the first draft of this entry, which said
    "at STARTUP" flat and would have been followed literally.)
  - **Do NOT put the kill in the trip path**: spawning is exactly what fails as COMMIT passes
    ~95%, which is the instrument-goes-quiet-at-the-peak trap.
  - **Scope it with the negative lookahead `kill-chrome` already uses.** A pattern that matched
    `auto-cart-bot` broadly would take the rec.gov profiles with it — that regression is
    already recorded once.
  - A second, independent candidate: a catastrophic free-RAM floor (~800 MB) that acts with **no
    stall requirement**. It reverses a documented "BOTH CONDITIONS, ALWAYS" decision, so take it
    deliberately or not at all — and note it may not help, since exiting a process does not
    necessarily reap an orphan either.
- ~~**NOTHING HERE IS FIXED YET.**~~ **BUILT 2026-08-18 — `scripts/auto-cart-bot/orphan-sweep.mjs`,
  and it needs a box update like everything else bot-side.** The keep-warm kills any Chromium on
  `.rc-bot-profile` the moment it takes the lock, before `launchPersistentContext`.
  - **THE LOCK IS THE WHOLE SAFETY ARGUMENT, and "at startup" would have been an incident.**
    Once we hold the lock the runner does not, so anything still on that profile is owned by
    nobody — which is the orphan and nothing else. A sweep on plain process start could land
    at 08:00:00 on the Chromium that is carting.
  - **It also removes the `SURVIVED` ambiguity that has bitten `kill-chrome` twice.** That
    re-check runs 3s after the kill, long enough for a supervisor to have opened a NEW browser,
    so a clean kill plus a healthy restart printed the same words as a kill that reached
    nothing. Here nothing may open a browser on this profile while we hold the lock, so a
    survivor is unambiguously a survivor.
  - **THE HOLD RUNNER DELIBERATELY DOES NOT SWEEP**, and a test pins that so it is re-taken
    rather than drifted into. Spawning costs a second or two on the one path where latency is
    the product (measured carts: T+1.8s, T+43s, T+49s). The keep-warm reopens on every yield,
    guard trip and restart — including the restart that CREATES an orphan — so one is reaped
    within minutes anyway. If the runner ever needs it, the shape is a sweep on a FAILED
    launch, not a spawn before every cart.
  - **A blind scan under-kills and can never over-kill.** An unelevated WMI query reads `$null`
    for `CommandLine`, and an unreadable process cannot match the pattern — so the elevation
    problem that has corrupted three readings here is, for once, safe by construction. The
    count is still reported, because the reading is short.
  - **Silent on the ordinary path, loud when it kills or fails.** It runs many times an hour;
    a line per reopen would bury the events worth reading. `DONE` is required before any
    reading counts — an incomplete scan is never "found nothing".
  - **`rc-diag.mjs --real-profile` IS THE ONE PARTICIPANT THAT DOES NOT RESPECT THE LOCK**, so
    a restarted keep-warm will now KILL its browser rather than merely failing to launch beside
    it. That procedure already requires stopping the bots AND disabling the watchdog; the
    script's header now says so where somebody will read it. `rc-probe.mjs` is unaffected — it
    uses `.rc-probe-profile`, which the pattern cannot match.
  - `worker/orphan-sweep.test.mts`, **nine mutations, each asserting the mutation applied** —
    the sweep before the lock, after the launch, deleted, a survivor counted as killed, `DONE`
    not required, the sleep made unconditional, the quiet path made chatty, the failure path
    silenced, and the runner starting to sweep.
  - **AND THE EXISTING ATTRIBUTION GUARD PASSED VACUOUSLY AT FIRST — FOURTEENTH TIME.**
    `chromium-attribution.test.mts` was given the new file to scan and its line regex matched
    nothing in it, so the suite went green against a pattern deliberately broken to `[^"]*`
    (verified). Its `checked >= 3` floor was already satisfied by the `.ps1` files alone.
    It now matches a JS `export const` assignment too, and asserts **per file** that a pattern
    was actually extracted — a guard that inspects nothing is indistinguishable from one that
    approves.

### OUR OWN LIVENESS CHECK KEEPS THE OKTA SESSION ALIVE — MEASURED, 12 FOR 12 (2026-08-18)
`checkAndReport` calls `oktaSessionAlive(ctx)` **unconditionally**, every keepalive tick and
every renewal. Off the box's own log, twelve consecutive readings across three hours:
```
checked 17:07:02  exp 2026-08-19T05:07:02   → +12.0000h
checked 17:27:02  exp 2026-08-19T05:27:02   → +12.0000h
   … ten more, every one +12.0000h from the moment it was CHECKED …
checked 19:50:40  exp 2026-08-19T07:50:40   → +12.0000h
```
- **A fixed 12h from creation would print the same instant every time. It does not.** The
  window moves with the clock, to the second, twelve for twelve. So the Okta session's expiry
  is a rolling idle timeout **that our own polling resets**, and it cannot idle out while the
  keep-warm is running.
- **SO THE "~12 HOUR OKTA SESSION" FIGURE THROUGHOUT THIS FILE IS OUR PROBE'S WINDOW, NOT
  RC'S.** Nobody has ever observed how long an unrefreshed one lives. Same family as the "~8
  hour session cap" that turned out to measure when we happened to look (2026-08-08).
- **WHICH SPECIFIC REQUEST REFRESHES IT IS NOT ESTABLISHED.** `/api/v1/sessions/me` is the
  leading candidate — `renewSession`'s own guard already asserts it — but every check also
  loads RC pages carrying the cookie. Do not write one in as fact.
- **THE RENEWAL'S CAREFUL GUARD IS NULLIFIED BY A SIBLING.** It skips the Okta probe when
  there is no token to lose, and says why in as many words: *"asking on every attempt would
  extend the very window we are trying to measure the length of."* `checkAndReport` then asks
  every twenty minutes regardless. The reasoning is right and the file next door defeats it —
  the recurring shape here, this time with the guard and its defeater in one process.
- **IT IS LOAD-BEARING BY ACCIDENT, AND THAT IS THE PART TO BE CAREFUL WITH.** A session that
  never idles out is why this bot can go days without typing a password. **Anyone who
  "corrects" the unconditional probe to match the renewal's guard will start the Okta session
  expiring and force real logins from an address that has eaten a 12-hour block.** Do not
  tidy it up; if it is ever changed, change it deliberately and expect more sign-ins.
- **AND IT IS WHY THE REHEARSAL KEEPS PROVING NOTHING.** `runLoginRehearsal` drops the token,
  reloads, and requires RC to REJECT the session before it will type a password. With Okta
  permanently fresh, the sign-in click is answered from the cookie with no form — which is
  `provedNothing`, correctly reported as inconclusive. Its one lifetime PASS (2026-08-16
  03:00) read `Session before the test: DEAD — RC rejected the token (401)` and `cleared 0
  key(s)`: a profile that was already genuinely empty. **The instrument is not broken; it is
  being handed a condition in which there is nothing to prove.**
  - **NOT "structurally impossible" — 2026-08-18 19:13 reached `attemptLogin` and FAILED for
    real** with Okta alive on the adjacent line. So a live Okta cookie makes an inconclusive
    run likely, not certain, and the distinction is worth keeping.
- **TWO CANDIDATE FIXES, NEITHER BUILT, and they are not equal.**
  1. **Force the form with `prompt=login`.** Intercept RC's own `/oauth2/v1/authorize` request
    with `page.route` and add the one parameter; RC's SPA still builds the client id, redirect
    URI and PKCE verifier, so nothing about the flow has to be owned here. **Non-destructive**
    — no cookie is deleted, so a failed rehearsal costs a live session nothing. Unverified:
    Okta may not honour it, and the callback may not survive.
  2. **Snapshot and delete the `idx` cookie**, attempt the password, restore on failure — the
    same shape as `dropStoredToken`'s snapshot. Certain to work and **destructive**: a
    rehearsal that discovers a broken password does so by ending the session it was testing.
    Arguably right (12h of warning beats finding out at 07:45) but it is a real cost.
  **`DT` MUST SURVIVE EITHER WAY.** It is the device cookie, and losing it makes a sign-in
  look like a fresh profile — which is what cost the household IP twelve hours on 2026-08-06.
- **BUILT 2026-08-18: the FIRST one** (`scripts/auto-cart-bot/force-login-prompt.mjs`). The
  rehearsal wraps `attemptLogin` in `withForcedLoginPrompt`, which intercepts RC's own
  `/oauth2/v1/authorize` and adds `prompt=login`. RC's SPA still builds the client id, redirect
  URI, `state` and the PKCE challenge; we add one query parameter to a request it already got
  right. **Bot-side — it needs a box update.**
  - **A 302, NOT `route.continue({ url })`.** Overriding a navigation request's URL has
    version-dependent semantics in Playwright; a redirect is something the browser does every
    day, and it re-enters the handler with the parameter already present, where the
    already-forced guard passes it through. Bounded at `MAX_REWRITES` (3) so a loop cannot hang
    the browser.
  - **THE HAZARD IS THE LEAK, AND IT IS WHY THIS IS A MODULE.** The rehearsal runs on the
    RESIDENT page. A route left installed would rewrite EVERY later authorize — including the
    silent re-mints that appear to be keeping the session alive on their own — turning a free
    background renewal into an unattended login that cannot succeed, hourly, from an address
    that has been blocked before. Disarmed TWO independent ways: a `finally` that calls
    `page.unroute`, and an `armed` flag the handler checks first, so a leaked route is inert
    even if `unroute` throws. **The flag is the half that does not depend on Playwright.**
  - **THE REHEARSAL ONLY, NEVER `maybeAutoLogin`** — that runs at T−30 of a real release and is
    the only thing between a queued hold and a missed cart. An unproven parameter in front of it
    would risk a campsite to improve a dashboard. Pinned by a test asserting exactly ONE call
    site.
  - **IT REPORTS WHETHER IT ACTUALLY ASKED.** `rewrites === 0` means the interception never
    fired, which is a different fault from Okta ignoring the parameter — and without the count
    the two produce the identical inconclusive run. A `provedNothing` WITH rewrites > 0 is
    recorded as *"Okta declined to re-prompt; forcing the form this way does not work"*, which
    is what would retire this approach in favour of the destructive cookie drop.
  - **The downside is bounded by the status quo:** nothing is deleted, so a failed rehearsal
    costs a live session nothing, and if Okta declines we land back on `provedNothing` — which
    is exactly where we already are. That is why it goes first.
  - `worker/force-login-prompt.test.mts`, **nine mutations, each verified applied.** Two of its
    own guards were wrong at baseline and **both anchored on a token that occurs twice** —
    `rewrites > 0` appears in the log line and in the detail line, so replacing either
    condition with a constant left the other matching. Anchored on `log(rewrites > 0` and
    `const detail = rewrites > 0` now. **Fifteenth and sixteenth time.**
  - **AND TWO EXISTING GUARDS BROKE OVER UNCHANGED BEHAVIOUR.** `rehearsal.test.mts` pinned
    `provedNothing[\s\S]{0,220}result: 'inconclusive'` — a PROXIMITY window, which a new comment
    pushed past. Re-anchored on the `if (r.provedNothing)` BLOCK, not widened; verified still
    failing when that branch is made to return `'ok'`. **The first re-anchor was itself wrong**
    — `if (r.provedNothing) {` also appears in `maybeAutoLogin`, earlier in the file, so a bare
    `indexOf` landed there and failed against correct code. Scope to the function first.

### THE LOGIN IS THE OPEN RISK, NOT THE LEAK (2026-08-18)
- **THE OWNER RAN THE LOGIN BY HAND AND IT "GOT HUNG UP AT PASSWORD".** That is a signature,
  not a vague symptom: a WRONG password is REJECTED (Okta shows a banner, `diagnose` reports
  `badCreds`). Hanging instead matches the 2026-08-06 reCAPTCHA, where the control reports
  `enabled=true` and every click times out because the challenge overlay swallows pointer
  events. **Retrying harder can never work**, and a CAPTCHA is a deliberate full stop for the
  unattended path.
- **So expect `maybeAutoLogin` at T−30 to fail as well** — it runs the same `attemptLogin`.
  This ALSO revises the 08-18 03:01 write-up above: that rehearsal failure was attributed to
  our own restart timing, and a real login fault is now the likelier explanation.
- **`rc_login_rehearsal` KEEPS NO HISTORY.** It is ONE ROW, updated in place (`id 1`), so the
  03:01 failure detail was overwritten by the next skip and is gone. The instrument built to
  catch exactly this cannot show a trend, and a failure survives only until the next stand-down.
  Fix it before trusting it.
- Overnight the session died completely — `okta=GONE(404)` after ~12h — so the renewal path is
  skipped entirely (`no Okta session to renew against`) and only a real sign-in can recover it.
- **OUR OWN CONTAINMENT TURNED THE DASHBOARD RED.** The supervisor restarted the process and
  the login rehearsal fired **24 seconds later**, against a browser that had just come up on a
  box recovering from 71% COMMIT. RC answered *"We're having trouble loading the
  application"*, and `autocart.rc_login` went **FAIL — "1 hold(s) ahead will fail unless a
  human signs in"**, with a real hold twelve hours out. The session was healthy again minutes
  later. Two fixes, because they are different faults:
  1. **A quiet window after an abnormal exit.** The bail writes `.camphawk-abnormal-exit`; the
     rehearsal stands down for `REHEARSAL_QUIET_AFTER_RESTART_MIN` (5). A FILE, because the
     process that knows does not survive to tell the process that needs to know. **`null` is
     "no record" and never gates** — a missing marker is the ordinary case.
  2. **RC's app failing to load is INCONCLUSIVE, not a broken login.** There is no sign-in
     link on a page that never rendered, so the hunt fails and reports the login broken. That
     is the banner trap and `provedNothing` again: an absent form means "we could not ask".
     It returns `provedNothing` now and stays LOUD in the log — it is also the 2026-08-14
     blank-page signature — but it no longer spends the once-per-20h budget or send anybody
     to the box.
- **TWO EXISTING GUARDS IN `rc-live-not-dead.test.mts` BROKE AND WERE UPDATED, NOT RELAXED** —
  they pinned `reason: await withBanner(link` by exact expression, and hoisting it into a
  `const` invalidated them over unchanged behaviour. **The first rewrite then WEAKENED one:**
  bounding the live branch at the first `withBanner(` means folding a banner INTO that branch
  merely shortens the slice, and the mutation passed. Verified failing, re-bounded on the
  `if (stillLive === true)` block, verified again. Eleventh time a guard here has anchored on
  the wrong thing.
- `worker/keepwarm-diagnosis.test.mts`, **13 mutations, each asserting the mutation applied.**
  **One survived and the reason is the lesson:** the mutation meant to delete the snapshot call
  left the identifier in place, so the regex still matched and the guard passed against code
  that still called it. A mutation that does not apply is a green proving nothing — the same
  discipline that has to be re-learned every time it is skipped.
  - **`envDefault` MISREAD A THRESHOLD FOR THE SECOND TIME IN ONE SESSION.** It was written
    hours earlier to stop `(\d+)` stopping at the underscore in `60_000`; its replacement then
    stopped at the SPACE in `40 * 60_000`, reading `MAX_BROWSER_AGE_MS` as **40 ms**. It now
    parses products. Tenth time a guard here has anchored on the wrong thing, and the second
    time inside the fix for the ninth.
- `worker/keepwarm-recycle.test.mts`, **8 mutations, each asserting the mutation applied** —
  including the guard moved back into the loop body, the stall condition dropped, the timer
  slowed back to 2 minutes, and a throttling flag restored. **Two of its own assertions were
  wrong at baseline and one PASSED FOR THE WRONG REASON:** a bare `(\d+)` stops at the
  underscore in `60_000`, so `MEM_STALL_MS` read as **60** and `WATCHDOG_MS` as **10** — and
  10 sails under a 15,000 ms ceiling. A guard that reads the wrong number will approve the
  wrong value later, silently. Ninth time a guard here has anchored on the wrong thing.

### THE AUTO-LOGIN WAS THE BIGGEST OKTA TRIP NOBODY HAD MEASURED (2026-08-20)
```
07:29  12%   rc   300 MB  pid 6360    flat
07:31  64%   rc 2,811 MB  pid 6452    the auto-login's Okta navigation
07:41  76%   rc 9,434 MB  pid 6452
07:43  12%   rc   230 MB  pid 7560    the RAM guard killed it
```
Twelve minutes and **9.4 GB** — four times the worst renewal and six times as long, because
`okta=GONE` forces a full password sign-in. That variant needs a genuinely dead Okta session to
reach, which is why it had never been sampled.
- **It matters more here than for the renewal**: a guard kill leaves the profile lock reading as
  HELD for `STALE_MS` (10 min) and only a living holder renews it, so nothing can preempt it
  cooperatively. **A kill at 07:33 clears by 07:43 and is harmless; a kill at 07:53 holds the lock
  past 08:00 and the runner cannot take the profile to cart.**
- The trip now runs in a **throwaway tab** closed in a `finally`, as PR #142 did for the renewal.
  **Every page-taking call is bound to the tab** — `window.__camphawkRcToken` is per-page, the tab
  sits on `signin.reservecalifornia.com` during a sign-in, and a screenshot of the resident page
  photographs a page on which nothing happened. A version that moved only `attemptLogin` looks
  right and gets all three wrong.
- **NOT CLAIMED: that a tab close reclaims a NINE-gigabyte trip.** The renewal's trips are
  140-350 MB and drain in place on an unchanged pid; nothing has closed a tab that ramped this
  far, and the 08-20 event put 1,330 MB in a **`utility`** process, which is not the renderer.
  **HOW TO READ IT: a spike that drains at tab close with no `♻ recycling` line is this working.**
  **STILL UNEXECUTED as of 2026-08-20** — it only runs at T−30 of a real release.

#### PERSISTING THE LOGIN BUDGET NAIVELY WOULD HAVE MADE THAT MORNING WORSE
The per-release budget was module state, and `supervise.ps1` restarts the process on exit, so
every restart re-issued it — the crash-loop-spends-the-login-budget shape that cost the IP twelve
hours on 08-06. **And that accidental refund is what saved the 08:00 cart:**
```
07:30  attempt 1 -> 9.4 GB ramp -> the RAM guard killed the browser
07:43  the supervisor restarted the process
07:48  attempt 2 -> signed in, 60m token
08:00  carted at T+2s, claimed 08:05, released
```
A plain persisted counter would have counted attempt 1 and left one attempt of margin instead of
two, on the one morning any of this was measured. So a **KILLED** attempt is inconclusive and is
refunded — same rule as `provedNothing` — but **by the record** (`startedAt`, cleared on every
terminal path) rather than by the accident of process memory, and bounded to **one per release**
by `killed`, or a process that dies every attempt refunds for ever. The rule is a module
(`autologin-budget.mjs`) because importing `rc-keepwarm.mjs` starts the keep-warm loop and this
decision has an arm that only runs after a crash.

### THE OKTA SESSION'S STATE IS A COLUMN NOW (migration 065, 2026-08-21)
`autocart.rc_session` answers "does RC accept the current token". The OKTA session behind it is
a different fact and it is the one that decides what the next sign-in **costs**:

    okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB   (2026-08-21)
    okta=GONE    full password form             12 minutes,  +9,434 MB   (2026-08-20)

- **IT WAS ALREADY BEING PRODUCED AND THROWN AWAY.** `checkAndReport` has held the structured
  reading from `oktaSessionAlive` all along, stringified it into `okta=ALIVE (exp …)` and posted
  only the sentence — so the server would have had to un-parse our own prose to recover a value
  the bot already had. Same shape as `notePlatform` emitting a fact into a region that then
  discarded it (064).
- **A COOKIE-ANSWERED SIGN-IN REUSES THE EXISTING OKTA SESSION AND INHERITS ITS CAP.** It does
  not restart the clock. This answers the 2026-08-19 absolute-cap entry from the other side:
  ```
  14:30:06  ✓ signed in — token now 60m          <- 4s, no form: answered from the cookie
  14:42:33  okta=ALIVE (exp 2026-08-21T14:47:57) <- 5m ahead, NOT the rolling +12h
  15:00:32  okta=GONE(404)
  ```
  **"The bot signed in at T−30" therefore does NOT mean "Okta is good for twelve hours."** That
  morning it meant eighteen minutes.
- **NOTHING HERE MAY GO RED, and that is structural rather than a promise.** `oktaCostNote`
  returns `string | null` and has **no severity to return**, so no later edit can promote a cost
  prediction into a verdict. `okta=GONE` is the ORDINARY state between releases and reddening it
  is the cry-wolf failure fixed three times, most expensively at 07:33 on 08-16.
- **NULL IS "NOT REPORTED", NEVER "GONE"** — a pre-065 box sends no okta fields and must produce
  SILENCE, not a claim about a machine that has said nothing. A probe that ran and could not tell
  reports `UNKNOWN`.
- **`undefined` LEAVES THE STORED READING ALONE; `null` OVERWRITES IT.** Three of six
  `reportSession` callers never ask Okta anything, and writing NULL from them would erase a
  reading `checkAndReport` took moments earlier. **Deliberately NOT COALESCE** — Okta state went
  ALIVE-with-5-minutes to GONE inside twenty, so a preserved old value is *actively misleading*
  in a way a stale `bot_commit` merely looks current. `okta_checked_at` carries the age instead.
- An unparseable expiry becomes NULL rather than reaching `::timestamptz`, which throws — and
  that statement also carries the session verdict, so a malformed diagnostic field would have
  destroyed the reading it rides along with.
- **PROVEN END TO END 2026-08-21**, write half and read half:
  `— Okta good for 720m (checked 20s ago), so a repair would be the cheap cookie-answered one`.
- `worker/okta-state-reporting.test.mts`, 16 tests, twelve mutations. **Two of its own guards
  were wrong at baseline**: a bare `/reportSession\(/` matched the DEFINITION (eighteenth time),
  and the SELECT guard sliced 700 chars back from the `FROM` and read the **TypeScript row type**
  above the query — passing against a route with all three columns removed (nineteenth).

### THE EXPENSIVE SIGN-IN WAS PINNED TO THE RELEASE-CRITICAL WINDOW (2026-08-21)
`maybeAutoLogin` acts ONLY inside `AUTOLOGIN_LEAD_MIN` (30m), so the 12-minute / 9.4 GB password
variant could happen **at no other time**. That is dangerous for a measured reason: a RAM-guard
kill leaves the profile lock reading HELD for `STALE_MS` (10 min) with nothing alive to renew or
release it — **a kill at 07:33 clears by 07:43 and is harmless; a kill at 07:53 holds the lock
past 08:00 and the runner cannot take the profile to cart.** On 08-20 the cart survived only
because `supervise.ps1` happened to restart the process in time.
- **`scripts/auto-cart-bot/autologin-warmup.mjs`** signs in at **T−3h** when a hold is queued and
  Okta is GONE, so the T−30 sign-in is cookie-answered.
- **IT DOES NOT ADD A PASSWORD SIGN-IN, IT MOVES ONE.** It fires only when the T−30 login was
  going to be a password form anyway; afterwards no credential is submitted at all. Net password
  submissions per release: **one, exactly as today.** That matters — repeated logins from this
  address cost the household IP twelve hours on 08-06.
- The token's ~60-minute life is not an objection: the warm-up **cannot** cover the release
  (`L ≤ 45` arithmetic) and is not trying to. Its whole product is the OKTA SESSION left behind.
- **UNKNOWN STANDS DOWN.** Acting would submit a password on a guess. The failure direction is
  always "we did nothing", which is the status quo.
- **THE WINDOWS ARE DISJOINT BY CONSTRUCTION**, boundary to the release-critical caller (`<=`,
  not `<`) — two sign-in drivers on one Chromium profile is worse than either. `maybeAutoLogin`
  is still called FIRST anyway, so a later edit breaking that disjointness fails safe.
- **THREE HOURS IS BOUNDED FROM BOTH SIDES.** Far enough that a guard kill (10 min) and a
  supervisor restart (seconds) are free; near enough that the Okta session survives to T−30,
  because the absolute cap's origin is **NOT established**. **Do NOT raise it to "the night
  before" without measuring that cap** — that is the version that looks obviously better and is
  the one the single cap observation says may quietly stop working.
- The probe is gated on the window (`warmupWindowOpen`, ONE definition, called by both), or a
  second unconditional `/api/v1/sessions/me` per tick doubles our traffic to that endpoint.
- Its ration is **its own file** — not a field on the auto-login budget, whose kill-refund
  arithmetic is release-critical and was got wrong once. Persisted, because the RAM guard killing
  *this exact navigation* is what causes the restarts that would re-issue it. **No kill refund**:
  a killed warm-up leaves the auto-login's full budget intact, so forgiving it buys a second
  password submission for no change in outcome.
- `worker/autologin-warmup.test.mts`, 18 tests, eight mutations; disjointness checked
  **exhaustively over every minute**, not sampled. **An existing guard broke over unchanged
  behaviour** — `session-coverage.test.mts` sliced from the FIRST `const r = await attemptLogin(`
  in the file, which was `maybeAutoLogin`'s only by luck of ordering, and a second caller above
  it made it read a different function. Twentieth time.

### THE TRAIL'S SILENCE IS INSTRUMENTED, AND THE BOX HAS IT (2026-08-28)
Four ramps have now passed with **zero `trail-*` readings**: 08-25 20:22 (~3.6 GB), 08-26
21:24 (9,112 MB / 100% COMMIT), 08-28 02:01 (8,981 MB / 99%) and 08-28 08:13→08:23
(**8,987 MB / 99%**, which resolved on its own at 08:25 — twenty minutes before the box
updated). Onsets over six days: **eleven, gaps of 5-28 hours**, so a missed one is not rare —
it is most of them.
- **THAT LAST PEAK WAS FIRST RECORDED AS 6,264 MB, FROM A MID-CLIMB SAMPLE.** The ramp was
  still rising when it was read. A ramp takes ~10 minutes and the sampler runs every 2, so
  **any figure taken while one is in progress is a lower bound, not a peak** — wait for
  `max_pid` to change before quoting a number.
- **NO RAMP HAS HAPPENED SINCE THE BOX UPDATED (checked 09:17 PT).** Flat at 285-470 MB since
  08:44. **The diagnostic is armed and has never run**, so a quiet `native_alloc_readings` is
  the expected state and NOT a fifth failure — do not read it as one.
- **THE "SEGMENT NEVER ENDS" EXPLANATION IS RULED OUT, and that is the useful part.** The
  theory was that `takeRamps` only takes ENDED segments on an ordinary tick, so a ramp on the
  long-lived resident renderer is never taken. For 08-28 02:01 that is false: `max_pid` went
  **14596 -> 7812 at 02:15**, two minutes after the peak, so the browser really was replaced,
  `warmResident`'s `finally` really did run, and `final: true` really does include the open
  segment. **The trigger fired and stored nothing anyway.**
- **TWO POSSIBILITIES REMAIN, THEY LOOK IDENTICAL FROM OUTSIDE, AND THEY NEED OPPOSITE FIXES.**
  Either the renderer answered no CDP call at all — the browser going quiet as it grows, which
  has happened twice before on two different calls, and which means the trail needs a different
  TRANSPORT rather than a different trigger — or segments are present with growth under the
  400 MB bar, which would mean **the sampling profiler cannot see these bytes and Track A is
  measuring a quantity that structurally excludes the leak.**
- **EVERY READING EVER TAKEN POINTS AT THE SECOND ONE.** 13-109 MB of renderer attribution
  against events of 5-9 GB; the newest is 08-28 02:02, `free RAM -640 MB · renderer 16 MB`.
  **Do not treat that as settled** — it is the leading candidate, not a finding, and the whole
  point of the line below is that it can be told apart rather than argued about.
- **THE DISCRIMINATOR IS LIVE ON THE BOX SINCE 2026-08-28 08:44** (`5e399b3`, requested and
  applied in 25 seconds). `flushAllocRamps` takes `describeIfEmpty`, and `warmResident`'s
  teardown passes it — so a final flush that stores nothing prints `describeAllocTrail`.
  **The teardown, not the bail:** the bail needs a stall AND free RAM under 2,000 MB, and the
  08-28 ramp bottomed at **4,191 MB**, so it never fired. The teardown is where that browser
  was replaced.
- **HOW TO READ THE NEXT ONE.** In `logs\rc-keepwarm.log`, at the teardown following a ramp:
  `EMPTY — that renderer answered no CDP call at all` is the transport answer; a line naming
  segments with sub-400 MB growth is the profiler answer. **A `trail-*` row appearing in
  `native_alloc_readings` is the third outcome and the best one** — it means the bar was
  crossed and the attribution is finally stored.
- **`describeIfEmpty` IS NOT UNCONDITIONAL, AND BOTH REASONS MATTER.** The bail already logs
  `describeAllocTrail`, so an unconditional version prints the same text twice and reads as a
  bug; and the teardown fires on **every** reopen — the post-Okta recycle, the size guard, the
  runner's preemption — while `tail-log` returns only the last 16,000 characters. Noise there
  destroys the record it exists to preserve, which is exactly how the 08-23 attributions were
  lost.

### THE TRAIL ANSWERED, AND IT IS THE PROFILER — TRACK A CANNOT SEE THESE BYTES (2026-09-04)
#210 shipped a discriminator with two branches and the box has had it since 2026-08-28
(`d341139` contains `5e399b3`, confirmed by `git-status` rather than `autocart.bot_version`).
It has now been read, and **`EMPTY — that renderer answered no CDP call at all` is NOT what
came back.** From `tail-log rc-keepwarm`, a teardown on 2026-09-04 (the log stamps UTC; this is
08:09 PT, the hold runner preempting the profile after the 08:00 cart):
```
15:09:37 → hold runner wants the profile — closing and standing down
15:09:37   alloc trail [resident],   renderer only, newest first: 2s ago   -25 MB over 1198s (RAM +10 MB)
           alloc trail [renewal],    renderer only, newest first: 4192s ago 42 MB over 741s  (RAM  -5 MB)
           alloc trail [auto-login], renderer only, newest first: 2371s ago 74 MB (one sample only)
```
- **THE RENDERER ANSWERS CDP FINE, SO THE TRANSPORT WAS NEVER THE PROBLEM.** Every registered
  target reported segments with sample windows and RAM deltas. The first branch — *"the trail
  needs a different TRANSPORT"* — is **out**, and with it the reason to build one.
- **THE NUMBERS ARE 1 TO 74 MB.** That is the second branch in as many words: *"a line naming
  segments with sub-400 MB growth means the sampling profiler cannot see these bytes."*
  `NATIVE_ALLOC_RAMP_MB` is 400, which is why `trail-*` rows have never appeared and never
  could. **The instrument is not silent — it is measuring a quantity that excludes the leak.**
- **THE TEARDOWNS ALONE WOULD NOT LICENSE THAT, AND `native_alloc_readings` IS WHAT DOES.**
  Those browsers were not ramping, so reading them as an elimination would be the 2026-08-19
  false elimination again. The RETURN-PATH readings are the evidence, because
  `trace.ram.beforeMb/afterMb` and `profBefore`/`profAfter` bracket the **same call**:

  | reading (PT) | context | free RAM lost | renderer attributed |
  |---|---|---|---|
  | 09-03 09:28 | renewal | **−801 MB** | **17 MB** |
  | 09-03 06:16 | renewal | −690 MB | 5 MB |
  | 09-02 21:19 | renewal | −698 MB | 10 MB |
  | 09-02 02:02 | renewal | −697 MB | 15 MB |

  Each of those windows is the ONSET of a ramp that went on to 8-9 GB. **One to two per cent
  attributed, same window, four for four.**
- **SO `Memory.startSampling` DOES NOT SEE THIS ALLOCATION.** Every reading Track A has ever
  produced was measuring something else, which is also why the 08-24 warm-up reading (103 MB of
  422) and the 08-28 note (13-109 MB against 5-9 GB) looked like near-misses rather than the
  same fact five times. **It retires the instrument; it does not name what allocates.**
- **WHAT IS NOT CLOSED: a teardown following an actual ramp.** `tail-log` reaches back about
  four hours and the newest ramp was five and a half old, so 09-03 17:59 and 09-04 05:13 had
  both rolled out. That would be a cleaner confirmation and is now a formality rather than the
  question — the ramping-window evidence above is what carries it.
- **WHAT THIS LEAVES.** Track B — replay the Okta trip over `ctx.request`, no renderer — is the
  only remaining plan, and it is still **not started and still needs the owner's word**. The
  reasoning that held it back was *"the renderer-only sampler cannot see the browser-process
  share, so if the growth is there `ctx.request` may be the wrong lever"*; that is **weakened,
  not removed**, because it rested on Track A eventually answering and Track A cannot answer.

#### AND THE RAMPS ARE NOT RARE ANY MORE — NINE IN 52 HOURS (2026-09-04)
The 2026-08-22 entry reads *"one ramp in thirty hours … roughly a 5x reduction"*. **That is
stale**, and the caveat written beside it is what came true: *every "not reproduced this
session" reading was a window that happened to miss one.* From `chromium_memory_samples`:
```
09-02 02:13  8,957 MB      09-03 06:24  8,196 MB      09-04 05:13  9,368 MB
09-02 05:50  8,015 MB      09-03 07:32  8,294 MB
09-02 09:03  9,352 MB      09-03 09:37  8,449 MB
09-02 21:29  9,065 MB      09-03 17:59  9,410 MB
```
- **One every 5-6 hours, all 8-9.4 GB, all a single `renderer` pid**, climbing ~800-900 MB per
  2-minute sample for 10-12 minutes, then the whole family drops to ~200-300 MB on a new pid.
- **THE RAM ARM SAT OUT ALL NINE.** Free-RAM troughs 2,240 / 2,847 / 3,967 / 4,127 / 4,448 /
  4,602 / 4,729 / 4,738 / 5,349 MB against a 2,000 MB floor — closest approach **240 MB**. With
  the six already recorded that is **fifteen consecutive ramps** it has not fired on.
- **THE RAMPING RENDERER IS A pid THAT DID NOT EXIST A MINUTE EARLIER**, on all four checked.
  Before each ramp the largest RC process is the `gpu-process` at ~95-115 MB and the family sits
  at 280-320 MB; then a new renderer pid appears and is immediately the largest. Before the
  09-03 06:24 ramp the family read `rc_procs: 0` for eight minutes. **An observation, not a
  mechanism** — a browser generation being replaced, the throwaway tab's own renderer, and the
  2-minute cadence quantising the onset all fit it, and they need different fixes.

#### AND COMMIT GOES TO 47 GB FOR 9 GB OF CHROME — UNEXPLAINED, AND IT IS THE 08-12 SHAPE
The same samples, raw rather than as a percentage:
```
09-04 05:01   rc   306 MB   commit  7,609 / 31,580 MB   free RAM 10,712 MB
09-04 05:03   rc 3,624 MB   commit 40,458 / 40,854 MB   free RAM  6,794 MB
09-04 05:13   rc 9,368 MB   commit 47,265 / 48,061 MB   free RAM  3,967 MB
09-04 05:15   rc   207 MB   commit  7,355 / 31,580 MB   free RAM 11,022 MB
```
- **THE "97-99% COMMIT" IN EVERY RAMP ROW IS AN ARTIFACT — DO NOT QUOTE IT.** Windows grows the
  system-managed pagefile as fast as the commit is taken, so the LIMIT chases the USED figure
  and the ratio stays pinned near 100% all the way up and back down. The ratio is not measuring
  pressure here; the absolute figures are. Earlier entries quoting 82/88/89/99% were reading a
  series where the pagefile was not doing this — **check the limit column before comparing.**
- **THE ABSOLUTE FIGURES ARE WORSE THAN THE PERCENTAGE READS.** Commit used goes
  **7.6 GB → 47.3 GB** and back, five or six times a day. On 2026-08-12 commit exhaustion is
  what stopped `supervise.ps1` starting a shell, took every remote lever with it, and ended
  with the box being power-cycled by hand.
- **AND ~30 GB OF IT IS UNATTRIBUTED.** `rc_mb` sums `Get-Process.PrivateMemorySize64` — private
  *committed* bytes — over chrome.exe on our profile dirs, and it accounts for 9.4 GB of the 40.
  `recgov_mb` and `other_mb` are both 0.
- **THREE READINGS, AND THE DATA CANNOT SEPARATE THEM. DO NOT WRITE ONE IN.** Either the box
  really is committing ~40 GB (materially worse than "a 9 GB ramp", and then the most urgent
  thing in this file); or `Win32_OperatingSystem`'s `TotalVirtualMemorySize`/`FreeVirtualMemory`
  — which is where these two columns come from **by choice**, because the perf counters are
  localised and can be disabled — is a proxy that does not mean what the column names say; or
  the process scan is blind to some of it, which an unelevated WMI query genuinely can be and
  which this table does not record.
- **WHAT WOULD SETTLE IT: one `bot-ask memory` DURING a ramp.** It prints the same OS figures
  alongside the per-process list, so a 40 GB commit is either explained by what it names or is
  confirmed unattributed. Ramps arrive every 5-6 hours; **nobody has to stage one.**
- **IT ALSO EXPLAINS WHY THE RAM ARM CANNOT FIRE, AND THAT IS NOT AN ARGUMENT FOR LOWERING THE
  FLOOR.** The allocation goes to the pagefile, so free RAM never falls far — the arm is
  watching the one resource that is *not* running out. The 08-19 arithmetic that chose 2,000 MB
  mapped free RAM onto COMMIT percentages from a series where the pagefile behaved differently,
  and that mapping no longer holds. **Lowering the trip point is the change that killed a
  working repair on 08-19.** The honest move is a SECOND trigger on commit-used, and it is a
  deliberate decision with a measurement behind it, not a patch.

### THE LEAK — WHERE IT ACTUALLY STANDS (2026-08-22)
**Read this before building anything memory-related. Nothing shipped so far is a cure.** The size
guard, the RAM arm, the heap trail, the post-Okta recycle, the orphan sweep, the throwaway tab and
now the warm-up are containment or **relocation**. The owner's standing ask is to fix it.

> **TRACK A IS RETIRED AS OF 2026-09-04 — read the section directly above before this one.** The
> sampling profiler cannot see this allocation (1-74 MB of segments, and 5-17 MB attributed
> against 690-801 MB of free RAM lost in the same window, four for four). Everything below about
> Track A describes an instrument that was never going to answer; the ESTABLISHED paragraph and
> Track B are unaffected.

**ESTABLISHED.** The ramp is triggered by the **Okta navigation** — a controlled comparison, not a
correlation (08-18: three token-less renewals ten minutes apart; only the one that clicked through
cost anything, 2,331 MB, against two that ran the identical clear/reload/prime for nothing). It
lands in the **renderer** (+1,237 MB) **and the browser process** (+545 MB), with GPU, utility and
crashpad flat.

**NEVER OBSERVED: what allocates.** "Network/IPC buffering" is written into three separate entries
as the leading explanation and **has never been tested**.

- **THE "JS HEAP IS FLAT" READING ELIMINATES FAR LESS THAN THIS FILE HAS ASSUMED (2026-08-22).**
  Measured locally against a real Chromium: **640 MB of `Uint8Array` in a page reports
  `JSHeapUsedSize` = 0.0 MB.** External memory — ArrayBuffers, decoded images, network buffers —
  is simply not in that number. So a flat heap trail rules out *ordinary JS retention* (an array
  nobody trims, our fetch wrapper holding `init`) and rules out **nothing else**. It has been
  treated here as eliminating the whole JavaScript-adjacent family; it does not, and the heap
  trail could never have seen this class of allocation at all.
- **TRACK A — NAME IT. BUILT, PR #155, NOT YET ON THE BOX.**
  `scripts/auto-cart-bot/rc-native-sampler.mjs` uses CDP's native sampling profiler. **Verified
  before it was written**: the same 640 MB came back attributed to
  `partition_alloc::PartitionRoot::Alloc<>() <- ArrayBufferAllocator::Allocate()` with 2% error,
  in a few kilobytes — the response scales with DISTINCT STACKS, not bytes, which is the opposite
  shape from the multi-GB snapshot the house rules forbid.
  - Sampling starts **on the tab**, at creation (per-renderer; the trip runs in the throwaway
    tab, so starting it on the resident page profiles a renderer where nothing happens), and is
    **read after the trip returns** — CDP goes quiet as a ramp peaks, measured twice.
  - **THE BROWSER PROCESS CANNOT BE PROFILED THIS WAY** — `Memory.startSampling` is absent on
    that target, verified. So a reading covers the renderer only: 1,237 of 2,046 MB on the one
    event where both were measured. The rendered line says so, because a figure silently
    describing two thirds of a ramp is how "the biggest process" became a whole explanation once.
  - **HOW TO READ THE FIRST ONE:** `net::` frames confirm the buffering candidate after three
    entries asserted it without evidence; anything else means three entries need correcting.
- **TRACK B — THE CURE. DESIGNED, DELIBERATELY NOT STARTED, NEEDS THE OWNER'S GO-AHEAD.**
  Take the renderer out of the OAuth round trip: intercept `/authorize`, replay it over
  `ctx.request` following redirects, exchange the code ourselves. No page load, no renderer, no
  gigabytes. Three pieces already exist — we intercept `/authorize` (`force-login-prompt.mjs`),
  we already read `code_verifier` off the token POST (`rc-token.mjs:108`), and okta-auth-js's
  `okta-transaction-storage` is already known to the code.
  - **For the COOKIE-ANSWERED case it is a plain redirect chain**, and that is where the chronic
    damage is: **all twenty recorded ramps were renewals.**
  - The password case is Okta Identity Engine (`/idp/idx/*`) and is the CAPTCHA-exposed path —
    leave it in a browser. It is once per release, and the warm-up now puts it three hours from
    the cart.
  - **NOT STARTED ON PURPOSE.** It is surgery on the one path between a queued hold and a missed
    cart, and Track A's first reading could change its design entirely — if the growth is
    buffering in the **browser process**, `ctx.request` may not even be the right lever. Building
    it blind is how a repair gets credited to the wrong mechanism, which has happened three times.

### TRACK A'S FIRST READING NAMED NOTHING — IT WAS VALIDATED ON THE WRONG PLATFORM (2026-08-22)
The sampler fired on the box for the first time, 19:34 PT, and produced this:
```
02:34:58 native allocation, renderer only (...): 43 MB while free RAM moved -161 MB
           22 MB  <V8 Heap>
           14 MB  0x7ffc499b1707 <- 0x7ffc4375aa42
            4 MB  0x7ffc499b1707 <- 0x7ffc44ec485f
            2 MB  0x7ffc499b1707 <- 0x7ffc44da6a91
```
- **The module's header claimed "symbolization is partial — 1,083 of 1,733 frames".** That was
  measured against the Chromium in the **Linux dev container**. Playwright's WINDOWS build
  exports no internal symbols, so in production it is not partial, it is **absent**. Same shape
  as `cap sync`'s plugin path and the headless RC login: validated somewhere that is not where
  it runs.
- **THAT NAVIGATION DID NOT RAMP** (`RAM 9462 → 9301`), and the trace said so and refused a
  verdict — the three-way rule working. So the numbers mean nothing; what the reading shows is
  the SHAPE a real ramp would have arrived in. **We would have waited days for an event and
  then been told four hex addresses.**
- **Fixed in #160: addresses resolve to `module+0xoffset`** from the `modules` array
  `Memory.getAllTimeSamplingProfile` already returns beside `samples` and which the file
  discarded. Module bases move per process under ASLR, so a raw address groups within one
  profile and **nowhere else** — the offset is fixed for a build, and the `uuid` names the
  binary for offline symbolization.
- **The module NAME is not expected to discriminate** — nearly all of Chromium is one
  `chrome.dll`. It is printed for the one case where it settles something for free: a frame in
  a **system dll** (`ws2_32`, `winhttp`, `mswsock`) is the network stack, i.e. the buffering
  candidate this file has asserted three times and never shown.
- **BOT-SIDE, so it is not live until the box updates**, and the box cannot update while a hold
  is queued inside 6h of its release.
- ~~**Nothing was going to be sampled tomorrow morning anyway.** `startNativeSampling` has ONE
  call site — the renewal's throwaway tab. `maybeAutoLogin` and the rehearsal are not sampled,~~
  **STALE AS OF 2026-08-24: there are TWO call sites — `maybeAutoLogin` IS sampled now** (and it
  produced the only reading this instrument has ever stored). Struck rather than deleted because
  read as current it says the opposite of the truth. **The gap did not close, it MOVED: the T−3h
  warm-up is the third Okta-navigating path and the one now carrying no sampler** — see "THE RAMP
  WAS ORDERED" below. And the rest of the sentence still holds:
  if T−30 mints a token `planRenewal` stands down for the hour. **A queued test hold buys
  the cart flow, not a leak reading**; do not treat the two as the same test.

### THE STALE TOKEN COMES FROM THE SERVER (2026-08-22) — every local candidate is eliminated
The 08-19 census left three candidates: IndexedDB, a cookie, or the server. The box has now
answered all three in one reading:
```
02:34:58 ✗ no fresher token (none → -603732s), got as far as: none
02:34:58   storage census: local 6 key(s), session 1 key(s) — NO token-shaped value in either
           store. IndexedDB: no databases at all, so the remaining candidates are a cookie
           or the server.
02:34:58   cookies: 10 on the RC origins, NONE token-shaped — so the stale token is coming
           from the server, not from this profile
```
- **-603,732s is a SEVEN-DAY-dead token**, and it is the same one receding, exactly as 08-19
  established for the 74-hour case. Clearing local storage cannot reach it because it is not
  there. **The `dropStoredToken` family of fixes is finished as a line of attack.**
- **This does NOT explain the leak** and must not be folded into it. It explains why the
  RENEWAL cannot repair the session — a different failure that happens to share a code path.

### THE RENEWAL HAS FAILED 20 TIMES RUNNING AND IS IN BACKOFF (2026-08-22)
`renewal stood down: 20 attempts in a row have failed, so the next is 30m apart`.
- **This does not endanger tomorrow's cart, and the distinction matters.** `maybeAutoLogin` at
  T−30 is a different mechanism with its own 2-attempt budget, and with **Okta ALIVE** it is
  the 11-second cookie-answered sign-in that migration 065 exists to predict. The login
  rehearsal passed ~24h earlier, which is the standing evidence that it works.
- **The backoff is correct behaviour**, not a fault to clear: a gate that never stops retrying
  is the 2026-08-08 request storm.
- **Do not tell anyone to run `rc-login.bat` on this alone.** The keep-warm prints "A human
  must sign in once" on every dead verdict, and that advice has been given twice over sessions
  that repaired themselves.

### RAMPS ARE MUCH RARER NOW — AN OBSERVATION, NOT A CURE (2026-08-22)
`chromium_memory_samples`, last 30 hours: **one ramp**, 01:49→01:59 PT, peaking 8,436 MB with
free RAM at 2,227 MB — then **eighteen hours flat at ~320 MB** (hourly peaks 319-496 MB).
- Against the 08-17 baseline of **twenty ramps in five days** (~one per six hours) that is
  roughly a **5x reduction**, and the near-expiry stand-down plus the throwaway tab are the
  plausible cause.
- **IT IS NOT A CURE AND MUST NOT BE WRITTEN UP AS ONE.** One ramp still reached 8.4 GB, which
  is the whole disease. And this is a 30-hour window — the file's own history is that every
  "not reproduced this session" reading was a window that happened to miss one.
- **What it does buy is patience**: there is no longer a fire, so Track B can wait for
  evidence instead of being built blind.

### THE OKTA CAP DID NOT RESET ACROSS A PASSWORD SIGN-IN (2026-08-16, folded in 2026-08-22)
Recorded here from PR #69, which sat open for a week carrying it. On the night of 08-16 the
20:00 PT rehearsal submitted a real credential, RC accepted it, and **the reported Okta expiry
did not move**: `13:53:31` printed at 02:02, 02:05, 02:07, 02:09, 02:29, 02:44, 02:56 and
03:52 UTC — pin-stable across a fresh sign-in.
- **It corroborates the absolute cap from a second direction.** 08-19 found the rolling window
  freezing while the probe still answered ALIVE, and 08-21 found that a COOKIE-answered
  sign-in inherits the existing cap. This says a **password** sign-in does too.
- **So the cap is measured from something other than the sign-in**, which narrows an
  explicitly open question rather than closing it. Do not write in an origin.
- **It bears directly on the T−3h warm-up.** That design assumes signing in early leaves an
  Okta session behind that survives to T−30. These three readings together say the session it
  leaves behind carries whatever remains of an older cap — so **do not extend the warm-up to
  "the night before" without measuring the cap first**, which the warm-up entry already warns
  about and this is the second reason for.

### THE RAMP IS AN ELEVEN-MINUTE CLIMB, NOT A SPIKE (2026-08-23)
Two ramps in thirty-two hours; everything else in the series flat at ~300 MB.

| | peak `rc` | free RAM | COMMIT | pid |
|---|---|---|---|---|
| 08-22 23:12→23:23 | 8,983 MB | 6,744 → 3,191 | 82% | 10364 throughout |
| 08-23 07:31→07:41 | **9,180 MB** | 5,960 → 3,328 | **88%** | 5296 throughout |

- **ONE renderer pid, climbing steadily for ELEVEN MINUTES at ~400 MB/min**, renderer ~90% of
  the total (8,245 of 9,180). Browser process grows proportionally but stays under 800 MB; GPU,
  utility and crashpad flat throughout.
- **That revises the ~2,400 MB/min figure recorded on 08-17.** Slower, longer, sustained — a
  different kind of allocation and a different search. The earlier number came from a 2-minute
  sampler bracketing a shorter event; this is the same instrument with the per-type breakdown
  (062) and a full climb inside the window.
- The morning ramp **begins at 07:31 — T−30, when `maybeAutoLogin` fires.**
- **CANDIDATE, NOT A FINDING: the "RC's app did not load" failures were the AFTERMATH.** They
  ran 07:43–07:45, after the ramp, with free RAM already back to 9,884 MB — so the browser had
  just been recycled, and a box coming off 88% COMMIT is exactly when RC's SPA would fail to
  boot. It reframes an alarm that read as an independent RC fault. The discriminator is whether
  those failures recur on a morning with no ramp; until then it is a candidate.
- **BOTH ATTRIBUTIONS WERE LOST, and that is the finding that produced PR #169.** The sampler
  ran for both. Its only output is `logs\rc-keepwarm.log`, and `tail-log` returns the last
  16,000 characters, so by the time anyone looked the surviving lines were all from navigations
  that did NOT ramp. `chromium_memory_samples` survived the same two events by being in
  Postgres. Migration 066 is that fix applied to the other half — **the series says a ramp
  happened, the readings say what was allocating while it did.**
- **THE MORNING ITSELF WORKED**: hold `45719` carted at **T+1.6s** (07:59:47.6 against
  07:59:46), released 08:10. The 07:45 alarm was CORRECT and the system repaired itself,
  because a `provedNothing` auto-login attempt is refunded and the retry loop kept going.
  - **IT WAS A TEST FIXTURE, NOT A USER'S HOLD (corrected 2026-08-24 from side-lane §24a).**
    `unit_name` reads **`TEST · 45719`** — a prefix written in exactly two places in the repo,
    `scripts/rc-test-hold.mts:57` and a readout test whose fixtures are non-numeric. Nothing in
    the poller can produce it, and **the readout printed it in the `site` column the whole
    time.** This file already described unit 45719 as *"a synthetic hold from `rc-test-hold.mts`
    (South Carlsbad #35, arrival 2026-12-01)"* on 2026-08-13 — same unit, same script, same
    arrival date. **The file contained its own refutation and it was read past.**
  - **THE ARGUMENT FOR "REAL" WAS EXACTLY INVERTED, AND THAT IS THE REUSABLE PART.** It ran: *it
    carries a `user_id` and a real campground.* `rc-test-hold.mts:240` **copies both from a real
    watch by construction**, so every test hold has them — the property offered as evidence is
    produced by the thing it was meant to rule out. **The discriminator is `unit_name`**; the two
    genuinely real rows in the same table read `#W123` and `#W121`, on a different user id.
  - **DO NOT OVER-CORRECT: THE CART PROOF SURVIVES INTACT.** `rc-test-hold.mts` takes a REAL
    numeric unit id by design — that is what exercises the whole chain — so this hold locked a
    real site and really carted it, and its `✓ Added to cart` on iOS is still genuine evidence
    the two RC cart POSTs fire. **"Fixture" means nobody was waiting on the other end, not that
    nothing was at stake.** Only what it is evidence OF was overstated.
  - **WHAT IT COST: nothing, and that is luck.** For a day the `docs/LANES.md` SERIAL rules, the
    update-window decisions and the "keep #146 away from a release" caution were all applied on
    the belief that a **stranger was waiting on this campsite**. Those happened to be the
    conservative calls. A correction, not an incident.

### NEITHER 9 GB RAMP TRIPPED THE RAM ARM (2026-08-24, folded from side-lane §24b)
The two ramps above ended, and **the containment is not what ended them.** The arm is
`stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB` — **an AND** — with `LOW_RAM_MB = 2000`
(`rc-keepwarm.mjs:470`) and `MEM_STALL_MS = 60_000` (`:480`), joined at `:2241`.

| | peak `rc` | free RAM at peak | floor | COMMIT |
|---|---|---|---|---|
| 08-22 23:12→23:23 | 8,983 MB | **3,191 MB** | 2,000 | 82% |
| 08-23 07:31→07:41 | **9,180 MB** | **3,328 MB** | 2,000 | **88%** |

- **Free RAM never came within 1,190 MB of the floor**, so the AND fails on the RAM half alone
  and the stall half does not matter. `os.freemem()` was calibrated against the PowerShell
  sampler to within 3.5% on 2026-08-18, so a 60% gap is not a reading error.
- **A BROWSER REPLACEMENT ENDED THEM — the series says so.** Not a tab close and not an in-place
  drain: the **`gpu-process` pid changes across both events** (6464 → 2824, then 2824 → 2348),
  and that process is one per browser. The entry above already says of the second that *"the
  browser had just been recycled"*; what was never recorded is that **the arm was not what did
  it**, and the consequence below.
- **THE FLOOR IS BEHAVING EXACTLY AS DESIGNED. WHAT MOVED IS THE PEAK.** The 08-19 change to
  2000 wrote its own arithmetic down: *"leaving room for a renewal whose worst observed peak is
  5,688 MB against a ~9,000 MB idle, i.e. **a trough near 3,300 MB**."* Observed troughs: **3,191
  and 3,328 MB.** The prediction is essentially exact, and the floor was deliberately set BELOW
  the expected trough so a working renewal could not be killed — which was the entire point of
  4000 → 2000. But that reasoning was built on a 5,688 MB worst case; it is **9,180 MB now, 61%
  higher**, and 88% COMMIT is two points off the same entry's *"~90% is where Windows stops
  scheduling"*.
- **THIS IS A QUESTION FOR A DELIBERATE SESSION, NOT A PATCH.** `keepwarm-recycle.test.mts`
  bounds the floor 1500–3000 with recorded reasoning, and **lowering the trip point is precisely
  the change that killed a working repair on 08-19.** The honest options differ in kind — leave
  it and rely on the recycle, or give the arm a second trigger that is not free-RAM. Neither is
  a drive-by, and "just lower the number" is the version that looks like caution.
- **WHAT WOULD SETTLE WHAT ENDED THEM:** a `♻ recycling` line in `logs\rc-keepwarm.log` at
  14:41:5x, via a `tail-log` bot command. The post-Okta recycle (`visitedOkta`) is the leading
  **candidate** for the 08-23 ramp; the 08-22 one coincides with the box update at 23:12 PT, so
  a `stop-all` is likelier there. **Both are candidates.**

### A REAL TEST HOLD IS QUEUED FOR 2026-08-24 07:58:47 PT — to MANUFACTURE a ramp (2026-08-23)
Track A has been armed for weeks and has never had a ramp to read, because ramps are rare
(two in thirty-two hours on 08-23, none since). **This hold exists to make one happen at a
predictable time**, and it is the first deliberate attempt to produce the measurement rather
than wait for it.

    hold      3020e05a-8e3f-444b-8973-1426f3211760
    site      Morro Bay SP — Lower Section, unit 43129 (#33), arrival 2026-12-01, 1 night
    releases  2026-08-24T07:58:47 PT
    claim     https://camphawk.app/claim/3020e05a-8e3f-444b-8973-1426f3211760?t=WNWD1BgU
    delete    npx tsx scripts/rc-test-hold.mts --delete 3020e05a-8e3f-444b-8973-1426f3211760

- **THE MECHANISM IS THE T−3h WARM-UP, NOT THE RELEASE.** `warmupWindowOpen` fires between
  T−3h and T−30 **only when Okta is GONE**, and then does the full password sign-in — the
  **12-minute, ~9,434 MB** trip measured on 2026-08-20, which is the biggest Okta navigation
  this system makes and the one #163 taught the sampler to read. Window opens **~04:59 PT**.
- **OKTA WILL BE GONE, AND THAT IS READ RATHER THAN ASSUMED.** `okta_expires_at` sat at
  `2026-08-24 03:00:59Z` across a 33-minute gap (checked 20:32 and 21:05 UTC) — **frozen, so
  it is the absolute cap of the 08-19 finding and not the rolling window**. It lapses at
  20:00:59 PT on 08-23 and nothing renews it overnight.
- **IT HAD TO BE A REAL UNIT ID, AND THAT IS THE COST.** The warm-up reads `nextRelease` off
  the feed, which is `nextHoldRelease()`, which carries `REAL_UNIT` — so **a sentinel hold is
  invisible to it and would have proved nothing.** That is the 2026-08-18 fixture fix working
  exactly as designed, and it means this test locks a real campsite at 07:58:47 until the
  claim releases it or RC drops the cart. Far-future midweek, 28 bookable that night, id taken
  from `--find` and never invented.
- **A DIFFERENT SITE FROM 45719 ON PURPOSE.** `recordClientReports` keeps the TAIL of 40, so
  re-requesting that row would have pushed this morning's `✓ Added to cart` — the third proof
  the RC cart POSTs fire — out of `client_reports`.
- **TWO CONSEQUENCES TO EXPECT, NEITHER A FAULT.** The 6h update gate **shuts at 01:58:47 PT**
  and is not liftable, so the box cannot update after that until the hold clears; and
  `holdAtRisk` may **ring the phone at ~07:14 PT** if the session is dead then, which is the
  alarm doing its job on a queued hold.
- **IT ANSWERS THE SECOND OPEN QUESTION FOR FREE** — the two app fixes from #171 have never run
  against a real hold. **The claim link must be opened IN THE APP** (`canInject` is false in a
  browser and the injected precart is never exercised). Look for `cart read back`.
- **READ IT AFTERWARDS:**
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts` (the attribution) and
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts` (the hand-off).
  **"No readings yet" is a real answer and means the trip did not ramp** — the three-way
  verdict refuses to speak without a RAM delta, which is correct and is not a broken sampler.
  Both scripts **fail loudly** on an unreachable database (`DB query error`, exit 1), verified
  2026-08-23 — so an empty answer is never a silent network failure wearing its clothes.
- **A 9 GB RAMP ON THE MORNING OF 08-24 IS THE DESIRED OUTCOME, NOT AN INCIDENT.** Do not open
  `chromium_memory_samples` at 08:00, read `peak_rc 9,180 / COMMIT 88%`, and write it up as the
  leak recurring or as the containment failing. **It is the experiment running — somebody
  ordered this ramp.** The leak is still unfixed and still the standing ask; this particular
  ramp was requested. (And per the entry above, the arm would not have fired on it anyway.)
- **PREDICTION, STATED SO IT CAN BE FALSIFIED:** the expensive trip lands at **~04:59 PT**
  (warm-up, Okta gone), and the T−30 sign-in at 07:28:47 is then the **cheap cookie-answered**
  kind because the warm-up left an Okta session behind. **Check where it actually landed rather
  than assuming** — the 08-22 handover predicted a quiet morning on exactly this reasoning and
  was falsified by a 9,180 MB ramp at T−30.
- **THE PRECONDITION, AND WHAT IS ACTUALLY KNOWN ABOUT IT.** `okta_expires_at` was frozen at
  `2026-08-24T03:00:59Z` across four reads by two sessions (33 minutes apart, then 70 minutes
  apart) — so it is the **absolute cap**, not the rolling window our own probe refreshes. That
  timestamp is **20:00:59 PT on 08-23**, so the cap was DUE to lapse then and Okta should be
  GONE for the 04:59 warm-up. **Due, not observed** — the last read was at 21:37Z and nobody
  watched it expire, so this is arithmetic on a prior reading, not a measurement. If the warm-up
  does not fire, an Okta session that outlived its stated cap is the first thing to check.

### THE MANUFACTURED RAMP WAS NEVER READ — EGRESS IS STILL BLOCKED (2026-08-24 08:15 PT)
The 08-23 session queued a real test hold to produce a ~9.4 GB Okta trip at ~04:59 PT and hand
Track A its first attribution. **The check-in ran on time and could not take the reading.** The
denial recorded on 08-23 at 20:15 PT is still in force twelve hours later:
```
camphawk.app          curl: (56) CONNECT tunnel failed, response 403
*.supabase.co         curl: (56) CONNECT tunnel failed, response 403
fly.io                403 to CONNECT   (also mcp.vercel.com, mcp.sentry.dev)
api.github.com        OK — the MCP tools work, so the denial is HOST-SCOPED
```
- **IT SURVIVED THE SESSION BOUNDARY, so it is standing policy and not a blip.** The previous
  entry says "revoked MID-SESSION", which reads as transient and is the sentence a later reader
  would use to justify simply retrying. It has now outlived a session restart and an overnight.
  **Do not retry or route around it — report the hosts.** `$HTTPS_PROXY/__agentproxy/status`
  lists the rejections with timestamps.
- **THE READOUTS FAILED LOUDLY, EXACTLY AS THE HANDOVER PROMISED** — `DB query error: TypeError:
  fetch failed`, **exit 1**, with the SQL printed. That is the one property that makes this a
  clean non-answer rather than a dangerous one: **"No readings yet" (the trip did not ramp) and
  "the database is unreachable" are different sentences here**, so nothing could be misread as
  the sampler having found nothing. The rule was verified by running it, not quoted.
- **SO NOTHING IS KNOWN ABOUT THE EXPERIMENT.** Not whether the warm-up fired at ~04:59, not
  whether the ramp happened, not what allocated, not whether the T−30 sign-in was the cheap
  cookie-answered kind, and not whether `cart read back` appeared. **Track A still has zero
  attributed readings.** Every prediction in the entries above remains a prediction.
- **THE READING IS NOT LOST, ONLY UNREAD.** `native_alloc_readings` (066) and
  `chromium_memory_samples` (059) are in Postgres precisely so a truncated log cannot eat an
  attribution — that is what PR #169 bought. The next session with egress reads the same rows.
  **Widen the readout window past 14 days if it has been a while**, or the query that survives
  will outlive the row it was meant to fetch.
- **THE LOCKED CAMPSITE IS NOT STRANDED BY THIS, and that was checked in source rather than
  assumed.** `scripts/rc-test-hold.mts --delete` needs the same blocked database, so cleanup was
  not available from here either — but `worker/expire-holds.ts` runs **on the Fly worker every
  60 seconds**, deliberately not in the feed ("a watchdog wired to the thing it watches"), and
  `reclaimLapsedHolds` marks a lapsed `carted` hold `expired` on its own. Morro Bay unit 43129
  needs nothing from this session.
- **AN AGENT WITH NO EGRESS CANNOT VERIFY ITS OWN BLINDNESS IS THE WHOLE PROBLEM**, and the
  house shape says so: a watcher that cannot see its subject is indistinguishable from one
  patiently waiting. The 08-23 `GITHUB_TOKEN` watchdog is the same failure one layer up. What
  saved this one is that somebody wrote "check outbound access FIRST" into the handover.

### BOTH FIXES ARE DEPLOYED, AND THE THIRD DOOR IS INSTRUMENTED (2026-08-24, evening)

Three things landed and were verified against production rather than assumed.

**THE COMING-SOON STORM IS FIXED ON FLY.** #183 merged as `d842dc0`; the worker deploy fired
(the branch touches `worker/**` and `src/lib/db/**`) and reported **success**, and that workflow
fails unless a fresh heartbeat lands — `worker.heartbeat` read `last beat 11s ago, 13 watches`
immediately after. **The handover's "#183 is web-side, so it will not restart the pollers" was
STALE by the time it was read**: the SMS fix was added to the same branch after that line was
written, which is what made the merge carry both.
- **NOTHING RE-ANNOUNCED ON DEPLOY, and that was checked rather than trusted.** All six watches
  carrying a claim still read exactly their backfilled `<hour>|*` wildcard afterwards — no new
  per-unit keys appended — so the deploy guard held. `eb886697`, the watch primed with the
  namespaced `rc-583|2026-8-25T8`, is among them.
- **`notifications` CANNOT BE READ FROM AN AGENT SESSION** — RLS answers `policy context
  unavailable`. It fails LOUDLY, so it is a clean non-answer; the claim-key column is the
  evidence that is actually reachable from here. Worth knowing before planning a check around it.

**THE WARM-UP IS SAMPLED NOW (#184, `18bb337`).** `maybeWarmupLogin` was the third
Okta-navigating path and the only one with no instrument, and by construction it is the
expensive one — it fires only when Okta is GONE, i.e. the full password form. That is what cost
the 08-24 ordered ramp its attribution.
- **THREE THINGS, BECAUSE SAMPLING ALONE WOULD HAVE BEEN INERT.** The sampler starts on the
  tab's own CDP session with a BEFORE profile; `attemptLogin` is wrapped in `withNetworkTrace`,
  because `reportNativeAlloc` REFUSES a reading whose RAM delta is missing and the delta comes
  from the trace; and the report is in the `finally` before the tab closes, since a trip that
  ramps 9 GB is by definition one that struggled. Wiring only the first would have rendered a
  line into a 16k-truncated log and stored nothing — the fix-present-and-inert shape, four times
  now.
- **THE CONTEXT STRING IS `'warmup'`, AND THE SERVER ALREADY ALLOW-LISTED IT.**
  `recordNativeAlloc` keeps a `CONTEXTS` set and stores anything else as NULL, so a plausible
  `'warmup-login'` would have landed the reading **unattributed** — in the table, absent from the
  readout, and looking exactly like the instrument working.
- **THE GUARD IS THE GENERAL ONE.** `worker/warmup-sampler.test.mts` enumerates every
  `attemptLogin`/`renewSession` call and requires each to be sampled or listed in `EXCEPTIONS`
  with a reason, so a **fifth** path fails the build. Pinning "the warm-up samples" would have
  been the sixth instance of the house shape in waiting.
- **`runLoginRehearsal` IS A RECORDED EXCEPTION, NOT A GAP.** It navigates to Okta with
  `prompt=login` forced, but runs on the **resident page** — no close to reclaim what it
  allocates, and an all-time profile there carries hours of the SPA's history. Different change,
  different risks, and it runs once a night hours from any release.
- **Seven mutations, each verified to APPLY and to fail. ONE DID NOT APPLY ON THE FIRST
  ATTEMPT** — the string it targeted now occurs three times, once per sampled path, so the
  assertion tripped and the suite went green against unmutated code. Redone scoped to the
  function. **Twenty-third time**, and the first where the count changed *because of the fix
  being tested*.

**THE BOX IS ON `18bb337` — 24 SECONDS, "updated and verified".** Requested at 21:57:03,
applied 21:57:27, heartbeat beating on the new sha. `npm ci` was skipped because the lockfile
did not move. Health went to **19 of 19 ok** (the `bot_version` warn cleared because box and web
now match).
- **`pending` IS NOT `requested_at IS NOT NULL`, AND READING IT THAT WAY INVENTS A CHURN THAT IS
  NOT THERE.** A hand-rolled readout said `pending: true` after a successful update, which under
  this file's own "a pending request churns the box" rule reads as an updater re-spawning every
  15 minutes. The real rule is `botUpdateState`'s: `requested_at && (!applied_at || applied_at <
  requested_at)` — and `claimBotUpdate` carries the same predicate, so once `applied_at` passes
  `requested_at` the request is **structurally unclaimable**. Nothing clears `requested_at`, and
  nothing needs to. **Use `botUpdateState()`, not a derivation of your own.**

**THE FIRST REAL RAMP READING IS NOT GUARANTEED TOMORROW, AND THE REASON IS `offered`.**
`maybeWarmupLogin` reads `nextHoldRelease()`, whose status filter is
`('requested','carted','claiming')` — **never `offered`**. All four real offers for 08-25 08:00
PT are untapped, so **if nobody taps, the warm-up stands down and there is no expensive trip to
sample at all.** The renewal path is sampled and has been for weeks; it has produced no reading,
which is consistent with ramps having become much rarer. **A tap is the precondition for the
measurement, and nobody here can produce one.**

**TRACK B IS STILL NOT STARTED, AND THAT IS THE OWNER'S DECISION TAKEN DELIBERATELY** (asked and
answered 2026-08-24): wait for one attributed reading first. The reasoning that decided it is
worth keeping — the renderer-only sampler **cannot see the browser-process share**, which on the
one event where both were measured was 545 MB of 2,046, so if the growth is there `ctx.request`
may be the wrong lever entirely. Building it blind is how a repair gets credited to the wrong
mechanism, which has happened three times.

### THE RAMP WAS ORDERED, IT ARRIVED ON CUE, AND TRACK A HAD NO INSTRUMENT ON IT (2026-08-24 13:00 PT)
Egress came back (camphawk.app 200, fly.io 200, supabase 401-with-no-key — all three of the
blocked hosts answer; the proxy's `recentRelayFailures` now names only `mcp.vercel.com`,
`mcp.sentry.dev` and `flyctl-metrics.fly.dev`). Both ordered readouts ran. **The experiment
worked and the instrument was pointed somewhere else.**

**THE MANUFACTURED RAMP HAPPENED, AT THE PREDICTED TIME AND THE PREDICTED SIZE.** From
`chromium_memory_samples`, 2-minute cadence, PT:
```
04:58:51  commit 16%  free 9484  rc   287   {browser 49, renderer 110, gpu 98, utility 26}
05:00:51  commit 77%  free 5738  rc  3233   {browser 269, renderer 2820, gpu 98,  utility 42}
05:04:57  commit 83%  free 3645  rc  6653   {browser 535, renderer 5961, gpu 105, utility 48}
05:08:57  commit 87%  free 3035  rc  8503   {browser 713, renderer 7627, gpu 105, utility 54}
05:10:57  commit 89%  free 3071  rc  9338   {browser 779, renderer 8406, gpu 107, utility 42}
05:11:56  commit 16%  free 9401  rc   258   <- gpu-process pid 7608 -> 12544
```
**9,338 MB, eleven minutes, ~840 MB/min, renderer 8,406 of 9,338 (90%)**, browser process 779,
GPU/utility/crashpad flat throughout. It began 05:00:51, **two minutes after the T−3h warm-up
window opened at 04:58:47**, and matches the 08-20 password-sign-in figure (9,434 MB, twelve
minutes) almost exactly. **The 08-23 prediction was right on both halves** — see the T−30
reading below — which is worth saying plainly, because the 08-22 handover made the same kind of
prediction on the same kind of reasoning and was falsified.

- **AND IT PRODUCED ZERO ROWS IN `native_alloc_readings`.** The readout's own header names this
  case: *"a spike there with nothing here means the sampler could not answer — which is itself
  a reading."* This is that, and the cause is in our source rather than in the browser.
- **`maybeWarmupLogin` IS THE THIRD OKTA-NAVIGATING PATH AND THE ONLY UNSAMPLED ONE.** It opens
  a tab, calls `attemptLogin`, and closes it in a `finally` (`rc-keepwarm.mjs` ~872-971) — with
  **no `newCDPSession`, no `startNativeSampling`, no `readNativeProfile`.** `startNativeSampling`
  has exactly two call sites: `maybeAutoLogin` (~1150) and the renewal's throwaway tab (~2626).
  **CLAUDE.md's "`startNativeSampling` has ONE call site — the renewal's throwaway tab;
  `maybeAutoLogin` and the rehearsal are not sampled" is STALE** — it has two, and the gap moved.
- **THE UNSAMPLED PATH IS BY CONSTRUCTION THE MOST EXPENSIVE ONE.** The warm-up fires only when
  Okta is **GONE**, which is precisely the full password variant — the 12-minute / 9.4 GB trip.
  So the one Okta navigation guaranteed to be the big kind is the one nothing is watching.
- **FIFTH INSTANCE OF THE HOUSE SHAPE, and the first where it cost an experiment somebody
  deliberately set up.** `expireStaleHolds` lived in a feed only a live runner polls;
  `reclaimLapsedHolds` lived inside `withRC`; the size-guard recycle was checked in the body of
  the loop that stops advancing; `holdAtRisk`'s fixture filter reached two queries and not the
  health route's copies. Here the instrument is fine and it is bolted to two of three doors.
  **The 08-23 entry setting this test up even names the mechanism** — *"THE MECHANISM IS THE
  T−3h WARM-UP, NOT THE RELEASE"* — so the path was identified in writing and the sampler was
  never followed to it.

**THE ONE READING THAT LANDED IS THE CHEAP T−30 SIGN-IN, AND IT MUST NOT SETTLE THE BUFFERING
QUESTION.**
```
24/08, 07:29:15 PT  auto-login
   free RAM moved -422 MB · renderer attributed 103 MB
         69 MB  <V8 Heap>
         27 MB  chrome.dll.pdb+0x9961707 <- chrome.dll.pdb+0x370aa42
          4 MB  chrome.dll.pdb+0x9961707 <- chrome.dll.pdb+0x4e7485f
```
- **No `net::` frames, and no frame in a system dll** (`ws2_32`, `winhttp`, `mswsock`) — which
  the readout names as the one thing that would confirm buffering for free. So the candidate
  gets **no support here.**
- **THAT IS NOT LICENCE TO CORRECT THE THREE BUFFERING ENTRIES.** The reading rule "anything but
  `net::` ⇒ those entries need correcting" assumed a reading **of a real ramp**. This is not
  one. `NATIVE_ALLOC_RAMP_MB` is **400**, so −422 MB cleared the bar by 22 MB: it is **4.5% of
  the event under investigation**, on a **different code path** (cookie-answered vs password).
  Retiring the candidate on it would be the 2026-08-19 false elimination one level up — a trace
  of a navigation that barely moved says nothing about a 9 GB one, which is the exact reason the
  three-way verdict refuses to speak without a RAM delta.
- **THE SHAPES DISAGREE, WHICH IS THE SHARPER REASON.** Here the renderer is **103 of 422 MB
  (24%)**; on the real ramps it is **90%** (8,406 of 9,338 today, 8,245 of 9,180 on 08-23). And
  `<V8 Heap>` is 69 MB of the 103 — the largest single site — where the 9 GB events have a heap
  trail flat at 15-18 MB. These are not the same event sampled at two sizes.
- **AND SYMBOLIZATION IS ABSENT ON WINDOWS** (recorded 08-22), so "no `net::` frames" is partly a
  property of the instrument. The offsets share one caller (`chrome.dll.pdb+0x9961707`) and are
  stable for a build, so they are worth offline symbolization if this recurs — but a
  system-dll frame was the reading that could have spoken without it, and none appeared.

**THE RAM ARM DID NOT FIRE — THIRD CONSECUTIVE 9 GB RAMP, AND THE FLOOR IS STILL BEHAVING AS
DESIGNED.** Free RAM bottomed at **3,035 MB** against the 2,000 floor, never within 1,035 MB:

| | peak `rc` | free RAM at trough | COMMIT |
|---|---|---|---|
| 08-22 23:12 | 8,983 MB | 3,191 MB | 82% |
| 08-23 07:31 | 9,180 MB | 3,328 MB | 88% |
| **08-24 05:00** | **9,338 MB** | **3,035 MB** | **89%** |

- **89% is the highest yet and is one point off ~90%, where Windows stops scheduling tasks** —
  the 08-17 failure where both Scheduled Tasks went silent together. The margin is thinning
  (82 → 88 → 89) and the trough is drifting down (3,191 → 3,328 → 3,035), slowly.
- **The 08-19 arithmetic that set the floor to 2000 is still exactly right and still built on a
  5,688 MB worst case.** The peak is 9,338 now — 64% higher. Same open question as the 08-24
  side-lane entry; **still a question, not a patch.** Lowering the trip point is the change that
  killed a working repair on 08-19.
- **A BROWSER REPLACEMENT ENDED IT AGAIN — the `gpu-process` pid moved 7608 → 12544.** That
  process is one per browser, so a replacement definitely occurred. **Fourth consecutive event
  ended this way, and none of them by the arm.**
- **THIS DOES NOT PROVE THE THROWAWAY-TAB CURE ON A 9 GB TRIP, AND IT IS THE TEMPTING READ.**
  CLAUDE.md's rule is *"a spike that drains at tab close with no `♻ recycling` line is this
  working"*. The warm-up **does** close its tab in a `finally` — but it also navigates to Okta,
  which sets `visitedOkta` and fires the post-Okta recycle, so **the close and the replacement
  coincide at ~05:11 and this event cannot separate them.** A changed gpu pid is a replacement,
  not a tab close. The cure remains unproven at this size; what would settle it is a ramping
  trip whose tab closes with no recycle line in `logs\rc-keepwarm.log`.

**THE WARM-UP ITSELF WORKED, WHICH IS THE DESIGN VINDICATED AND THE ONE UNAMBIGUOUS WIN.** The
T−30 sign-in at 07:29 cost **~106 MB of rc family with COMMIT flat at 16%** (234 → 340 MB in the
2-minute series), i.e. the cheap cookie-answered kind, exactly as predicted — and the cart fired
at **T+2s**. That is what the T−3h warm-up was built for: move the 9 GB password sign-in out of
the window where a RAM-guard kill would hold the profile lock past 08:00. It did, and the
morning was clean.

**THE HOLD READOUT ANSWERED THE OTHER OPEN QUESTION — #171's TWO APP FIXES ARE PROVEN ON A REAL
HOLD.** `TEST · 43129` (Morro Bay Lower Section) carted **T+2s**, claimed 15:02:13Z, `released`,
and the hand-off reported:
```
TEST · 43129 [ios build 1.0 (21)]: ✓ Added to cart — opening your cart…
    cart read back: 1 entry — RC confirms it is holding something
```
~~**`cart read back` is the reading nobody could force**, and it is RC's own answer rather than a
status string we wrote ourselves. The handover called it "the whole verification"; it has
landed, on iOS.~~ **THAT READING IS RETIRED — see "`cart read back` NEVER PROVED THE OWNER COULD
REACH THE CART" (2026-08-29).** It is RC's answer to OUR question with OUR key, and on 08-29 it
read 1 entry while the owner was shown an empty cart and a sign-in prompt. **This run was never
corroborated by anyone looking at RC's cart page**, so it may have had the same defect. Struck
rather than deleted: "the whole verification" is exactly the sentence a later reader quotes.
**Still not exercised on Android.** Session healthy (token 44m, `okta=ALIVE`
to 08-25 07:42), and the login rehearsal **PASSED** at 08-24 03:00.

**FOUR REAL USER OFFERS ARE OUTSTANDING FOR 2026-08-25 08:00 PT** — Morro Bay `#96` (two
different parks), Pfeiffer Big Sur `#SC10`, Carpinteria `#R330`, across **three different
users**, all `offered` and none tapped as of 12:58 PT. Untapped offers do not block the
02:00–05:00 update window (`nextHoldRelease` ignores `offered`); **a tap makes tomorrow a real
morning with a stranger on the other end**, and changes what the SERIAL rules and the update
window are protecting.

### THE CONTENTION TEST RAN ITSELF, AND TRACK A WAS POINTED THE WRONG WAY (2026-08-25)

Asked to STAGE an RC contention test and a Track A ramp test. **Neither needed staging: both
events happened on their own overnight.** The contention case behaved; Track A did not.

#### THE FAIRNESS LINE'S FIRST LIVE CONTEST — IT WORKED
Unit 43191 ("#96", Morro Bay Upper Section), 08-25 08:00 PT release, two users:

    melinda  watch created 08-24 09:53:55   rank 1   status offered    requested_at NULL
    tyler    watch created 08-24 12:45:30   rank 2   status requested  carted 08:00:03 (T+2s)

- **The ordering is the owner's rule, applied correctly** — earliest watch first. Melinda took
  rank 1 and was charged the rotation ticket (`hold_offer_seq` 0 → 118), which is the design:
  the ticket is spent on being given first dibs, not on winning.
- **She never tapped, so `dueHolds` served tyler and he carted at T+2s.** "Somebody who never
  answered is not in the running" is true of the CART, exactly as designed.
- **IT IS NOT TRUE OF THE NOTE, and that is the one defect.** `rankHoldLine` ranks `offered`
  rows as well as `requested` ones — deliberately, since an untapped rival can still tap before
  the release — and then wrote onto tyler's row *"their hold is the one being carted"*. It was
  not, and never would be. `last_attempt_note` is read by `rc-holds-readout.mts` and by
  **nothing user-facing** (checked, not assumed), so this cost nobody a campsite; what it costs
  is a readout that states the opposite of what happened, on the morning somebody is
  diagnosing. Wording is conditional now, guarded from both sides in `hold-line.test.mts`.

#### RC HELD THE CART FOR 45 MINUTES — WE LET GO, RC DID NOT
The owner deliberately did not claim, to see what happens. From the box's own log:

    15:00:02  ✓ held #96 (2026-09-04) — entry 4147de1f-…
    15:45:12  0 to hand over, 0 to cart, 1 to release
    15:45:16  released #96 → HTTP 200

**That is `expireStaleHolds(holdMinutes = 45)`, ours, to the second** — 45m13s after the cart.
It is not RC lapsing anything.
- **SO THE PREMISE BLOCKING THE EXPIRY CASCADE IS WRONG.** `hold-line.ts` and this file both say
  the cascade waits on RC's real cart lapse, *"read off RC's own bundle as ~15 minutes and NEVER
  OBSERVED"*, against a `reclaimLapsedHolds` that waits 180. **Neither number is what happens.**
  We release at 45, precisely, with the entry key — so the moment the site goes back on the
  market is a moment WE choose and already know. The cascade never needed RC's number.
- **STATED AS A LOWER BOUND, because that is all it is.** RC accepted a precise removal at
  T+45m and nothing in `watch_site_alerts` or `availability_observations` shows the site opening
  between 08:00 and 08:45. Whether RC would have held it longer is still unmeasured, and a
  `remove/cartentry` returning 200 is not by itself proof the entry was there.
- **We tell users "held ~15 min" (`RC_CART_HOLD_MINUTES`) and hold it for 45.** Conservative in
  the user's favour, but the two numbers are unrelated and one of them is now measured.

#### TRACK A HAS SAMPLED THREE RAMPS AND CAUGHT NONE OF THEM
Three ramps in 30 hours, from `chromium_memory_samples`, and **the box reached 99% COMMIT twice**:

    08-24 19:37→19:43   peak 7,250 MB   free 2,217   commit 95%   pid 15092
    08-25 02:30→02:40   peak 8,312 MB   free 2,473   commit 98%   pid  1296
    08-25 07:31→07:37   peak 7,471 MB   free 2,144   commit 99%   pid 13296

Track A has exactly three stored readings, one per ramp hour, and **every one says "this
navigation did NOT ramp"**:

    08-24 07:29  auto-login  ramΔ  -422 MB   renderer 103 MB
    08-25 02:31  renewal     ramΔ  -671 MB   renderer  17 MB
    08-25 07:43  auto-login  ramΔ  -412 MB   renderer 109 MB

- **THE 07:43 READING IS AFTER THE RAMP ENDED AT 07:39, ON A DIFFERENT BROWSER.** pid 13296
  ramped and was replaced by pid 3912; the sampled sign-in ran at 07:43 in pid 12584 and cost
  109 MB. The keep-warm log shows why: 07:41 and 07:42 both failed with *"We're having trouble
  loading the application"*, and 07:43 succeeded. **That is the 08-23 "the app-not-load failures
  were the AFTERMATH" candidate confirmed** — they follow the recycle, they do not precede it.
- **THE 02:31 RENEWAL READING IS INSIDE ITS RAMP AND DISAGREES BY TWO ORDERS OF MAGNITUDE** —
  17 MB of renderer while the family's renderers went to 8,052 MB, and the climb continued for
  eight minutes AFTER the reading was stored.
- **THE CAUSE IS STRUCTURAL, NOT BAD LUCK.** `reportNativeAlloc` is called on the RETURN path,
  after `attemptLogin`/`renewSession` returns and before the `finally` that closes the tab. **A
  trip that is killed mid-ramp never returns, so it never reports** — and it is gated on
  `ramΔ ≤ -400 MB`, so only a trip that both survived and moved bytes is ever stored. The
  instrument therefore samples, by selection, the CHEAP retry that follows a ramp. That is the
  fifth instance of the house shape and the first inside a diagnostic built to escape it.
- **SO STAGING A RAMP WOULD HAVE PROVEN NOTHING.** Three arrived free of charge and the
  instrument was blind to all three. **Do not queue a test hold to "force a ramp" until the
  sampler reports from a TRAIL** — sampled on the watchdog tick while the browser still answers,
  the way the heap trail and the RAM trail already do — rather than from the return path.
- **THE RAM ARM DID NOT FIRE ON ANY OF THE THREE.** Troughs 2,217 / 2,473 / 2,144 MB against a
  2,000 floor: it came within **144 MB** and did not act. That is now **six consecutive** 7–9 GB
  ramps the arm has sat out, and the 08-19 arithmetic that chose 2,000 was written for a worst
  case of 5,688 MB and an expected trough near 3,300. **What ends these is the post-Okta recycle
  — the `gpu-process` pid changes across every one — not the arm.** Still a QUESTION and not a
  patch: raising the floor is what killed a working repair on 08-19, and the box recovers fully
  within two minutes each time. What is new is the exposure: ~10 minutes at 95–99% COMMIT, three
  times a day, and ~90% is where Windows stopped scheduling both tasks on 08-17.

### THE TRACK A TRAIL — BUILT 2026-08-25, and it corrected me twice on the way

The owner's instruction: *"start track a trail do whatever we need to fix leak. Update box when
needed and do tests to stress test."* The trail is built and mutation-guarded. **It is an
INSTRUMENT, not a cure** — Track B is still unstarted and still wants its own word.

`scripts/auto-cart-bot/rc-alloc-trail.mjs` samples the native allocation profile **on the
watchdog tick** — the only code proven to keep executing while the loop is stalled, and a ramp
IS the loop stalled — keeps a **time-bounded** window, and reports a segment's peak when it
ends. Four renderers are registered: `resident`, `renewal`, `auto-login`, `warmup`, each
reported under its own context (`trail-resident` and friends, allow-listed in
`src/lib/native-alloc.ts`).

- **THE RESIDENT PAGE IS SAMPLED FOR THE FIRST TIME, AND THAT IS THE POINT.** Every existing
  `startNativeSampling` call site is on the TRIP's own tab. If the gigabytes are on the resident
  renderer, **PR #142's throwaway-tab cure is aimed at the wrong renderer**, which would explain
  why ramps continued after it shipped. Still a CANDIDATE; the trail is what settles it.
- **`TRAIL_KEEP` WAS NOT REUSED.** 12 samples at a 10s tick is two minutes against a ten-minute
  ramp — the shape that made the heap trail print twelve byte-identical samples already 123s
  stale. This window is **20 minutes of wall clock**, and a test fails if it becomes a count.
- **THE TRIGGER IS A SEGMENT ENDING**, plus a flush at teardown and in the runaway bail. Not the
  RAM arm (six consecutive ramps, closest approach 144 MB) and not the post-Okta recycle, which
  since the throwaway-tab change fires only for the **rehearsal** — the renewal and auto-login
  both dropped `oktaTrip`. The bail's flush is **awaited and bounded**: `process.exit` kills a
  fire-and-forget POST, and an unbounded wait delays releasing the profile lock, which is what
  loses a cart at 08:00.

#### THE PROFILE-RESET FINDING IS WRONG ABOUT RC, AND I WROTE IT IN AS FACT FIRST
The obvious explanation for 17 MB reported against an 8,052 MB family is that CDP's all-time
profile is reset by the navigation. **It is — and not by RC's.** Measured on a real Chromium:
```
a.probe2     -> b.probe2        (different SITE)   192 ->   1 MB   RENDERER SWAPPED
www.rc.probe -> signin.rc.probe (SUBDOMAIN)        216 -> 217 MB   same renderer
```
**Chromium isolates by SITE — scheme + eTLD+1 — not by origin.** RC goes
`www.reservecalifornia.com` -> `signin.reservecalifornia.com`, a subdomain hop, which keeps its
renderer and its profile.
- **It was written into three files as established fact for about an hour**, on the strength of
  a first experiment that used `a.test`/`b.test` — two genuinely different sites, and not the
  navigation this product makes. **Only `alloc-trail-probe.mjs` REFUSING A VERDICT caught it**:
  its control did not reproduce the blindness, so it printed `THE QUESTION WAS NEVER REACHED`
  instead of a pass. That refusal is the single most valuable thing built this session.
- **Kept rather than deleted**, because it is the obvious first hypothesis, it is easy to
  "confirm" with the wrong pair of hostnames, and the next reader will reach for it.
- **What survives is the ESTABLISHED half**: the return-path report fires after the trip returns
  and is gated at 400 MB, so a trip killed mid-ramp never reports. Six ramps missed that way.

#### THE PROBE FOUND A REAL BUG IN THE TRAIL, BY BEING RUN
`splitSegments` started a new segment on any DECREASE, on the reasoning that an all-time total
is monotonic by construction. **It is not, quite.** A real run stepped **955.4 -> 955.2 MB**
between two consecutive reads — fractions of a megabyte, invisible in a rounded log line, and
enough to cut a 1,271 MB ramp into 954 and 319 and report the larger half as the whole event.
**An instrument that halves the number it exists to report is worse than none.** It splits on a
**collapse** now (under half), because a real swap resets to ~0.4% of what it held. Both
directions are pinned: noise must not split, a collapse must.

#### THE INSTRUMENT WAS ABOUT TO BECOME PART OF THE DISEASE, AND THAT WAS MEASURED TOO
`Memory.getAllTimeSamplingProfile`'s response grows **linearly with bytes ever allocated**:
```
  373 MB allocated ->   245 entries -> 0.7 MB of JSON
2,346 MB allocated -> 1,508 entries -> 4.0 MB of JSON
```
~1.7 KB per MB. The resident page is read every 20s **for the life of the browser**, so at the
9 GB these ramps reach, each read would ask a renderer that is already eating the machine to
serialize **~16 MB**, over and over, at the peak — the multi-GB heap snapshot and
`response.body()` buffering in a third costume. The long-lived target samples at **8 MB
resolution** instead of 1 MB (`LONG_LIVED_INTERVAL`), cutting the response by the same factor;
the short-lived trip tabs keep the fine default because they exist for one navigation. Pinned,
because reverting it looks like a tidy-up.

#### PROVEN END TO END: 2 MB AGAINST 819 MB ON THE SAME EVENT
`scripts/auto-cart-bot/alloc-trail-probe.mjs` drives the REAL trail against a REAL Chromium and
runs the OLD reading as a control on the same event. It checks the control FIRST and refuses a
verdict when the blindness does not reproduce.
```
CASE A — 800 MB allocated in the RESIDENT renderer during a tab trip
   return-path reading on the tab (the old instrument):    2 MB
   trail reading on the resident renderer:               819 MB
CASE B — 800 MB allocated in the tab, return-path read never taken
   trail reading on the trip renderer:                   767 MB
```
Case A reproduces the production 17-MB-against-8,052-MB shape exactly, with the old instrument
blind and the trail seeing it. **It runs in the dev sandbox and imports `playwright-core`** —
deliberately, unlike its siblings; "fixing" that import stops it running where it is useful.

#### GUARDS
`worker/alloc-trail.test.mts` (16 tests, **13 mutations**, each grep-verified to APPLY) and six
new tests in `worker/warmup-sampler.test.mts` (**7 mutations**) — extended rather than pinned to
the trail, because a guard that pins one path is the house shape this whole change exists to
stop repeating. The general rules: every sampled renderer is on the trail, every registered
target comes off it, the sampling happens in the TIMER and not the loop body, the bail awaits
its report, the teardown takes the OPEN segment, and the contexts the two files use agree.
**One of the new guards anchored on a comment line** — and `code` strips comments so a guard
cannot fail on its own explanation — so it failed against a correct file. Twenty-fourth time.

#### WHY A RAMP RUNS TO 9 GB UNCHECKED — NEITHER ARM CAN FIRE DURING ONE
Read out of the resident loop's own ordering while wiring the trail, and it completes the
picture the RAM-arm entries leave half-drawn. One iteration runs: preemption check -> closed
window -> post-Okta recycle -> **size scan** -> expiry poll (**the renewal**) -> keepalive.

- **THE SIZE ARM (`RC_MAX_FAMILY_MB = 1500`) IS STRUCTURALLY UNREACHABLE DURING A RAMP.** It
  sits in the LOOP BODY and the ramp happens inside `renewSession`, which the loop is awaiting
  — so for the ten minutes that matter, control is past the check and cannot come back to it.
  That is the "a guard placed inside the thing it guards against" shape for the fourth time,
  and the entry that recorded it for the RAM arm did not notice the size arm still had it.
- **THE RAM ARM IS EXACTLY ONE CONDITION SHORT.** It needs `stalledMs > 60s` **and**
  `freeMb < 2000`. During these ramps the first is amply true (a ten-minute renewal is a
  ten-minute stall) — it is the **RAM** half that never trips, at troughs of 2,144-3,328 MB.
- **SO NOTHING CONTAINS A RAMP WHILE IT RUNS.** The size arm fires on the NEXT iteration, once
  the renewal returns, and breaks the loop into a reopen — which is the **leading candidate for
  the browser replacement that ends every recorded ramp** (the `gpu-process` pid changes across
  all six). Candidate, not established: the confirming `✗ RC Chromium at N MB` line sits outside
  `tail-log`'s 16,000-character window.
- **AND THE TRAIL NOW REPORTS FROM EXACTLY THAT MOMENT.** `flushAllocRamps({ final: true })` is
  in the `finally` that this break lands in, so the mechanism that terminates the ramp is the
  mechanism that stores its attribution. That is not luck — it is why the teardown flush takes
  the OPEN segment.
- **NOT ACTED ON, DELIBERATELY.** Moving the size scan into the timer would spawn PowerShell
  there, and spawning is the thing that fails first at 99% COMMIT. Lowering the RAM floor is
  what killed a working repair on 2026-08-19. Both are the deliberate decision `docs/LANES.md`
  reserves for a session with evidence — which is what the trail is for.

#### HOW TO READ THE NEXT RAMP
The ramps arrive ~3x a day unprompted. **Do NOT queue a test hold to force one** — three arrived
free in thirty hours and all three were missed, and a staged one locks a real campsite.
- `chromium_memory_samples` shows a ramp as ~5 samples climbing over ~10 minutes.
- `native_alloc_readings` should then carry a `trail-*` row for it. **Which context it lands
  under is the finding**: `trail-resident` means the allocation is on the page PR #142 does not
  touch; `trail-renewal`/`trail-warmup` means the cure is aimed correctly and something else
  keeps the memory.
- **A ramp in the series with nothing in `native_alloc_readings` is still a reading** — it says
  the trigger is wrong, and the next move is the trigger rather than the sampler.
- **EXCEPT FOR THE ONE ALREADY ON THE BOARD, WHICH IS NOT A MISS.** The box moved to `64f9f92`
  at **13:26:42 PT on 2026-08-25** (`bot_update_requests.applied_at`, confirmed by `git-status`).
  The series carries a ramp at **13:0x PT — peak 9,113 MB, 99% COMMIT** — with no `trail-*` row,
  and it ran **twenty minutes before the trail reached the box**. What it left instead is a
  `renewal` RETURN-PATH reading at 13:10:26 (−468 MB, renderer 13 MB): the old instrument doing
  the old thing one last time. **Applying the rule above to that ramp would retire a trigger
  that has never yet been given an event.** Date every reading against 13:26:42.
- **THE TRAIL HAS THEREFORE NOT YET SEEN A RAMP**, and at 15:00:51 PT the box was flat at
  273 MB. Nothing to read is the expected state, not a fault.
- **CADENCE, AS A FALSIFIABLE PREDICTION:** 08-24 19:37, 08-25 02:30, 07:31, 13:0x — ~7h, ~5h,
  ~5.5h apart, so the next is due roughly **18:00–19:00 PT on 08-25**. Four points, not a law;
  the 08-22 handover predicted a quiet morning on comparable reasoning and was falsified by a
  9,180 MB ramp.
- **`applied_note` DOES NOT DESCRIBE THE UPDATE THAT LANDED** — the row reads `SKIP - outside
  the quiet window (15:00 PT…)` plus the known-harmless libuv `UV_HANDLE_CLOSING` assertion,
  which is a LATER scheduled run writing beside the new sha. That is the documented
  `appliedNote`/`appliedSha` trap. `applied_sha` and `git-status` both say `64f9f92`.

### A PASSWORD SIGN-IN CAN BE CHEAP — 32 SECONDS AND ZERO MEMORY (2026-08-26)
The same rehearsal is a controlled reading of the trip this file calls the expensive one:

    16:19:27 Session before the test: DEAD — no token in localStorage
    16:19:40     → password entered, submitting
    16:19:43   (asked Okta for a fresh credential — rewrote 1 authorize request(s))
    16:19:44 ✓ the bot can still sign itself in

Okta was **GONE**, so this was the full password form with `prompt=login` forced — and the
memory series is flat across it: `rc` 274-324 MB, **COMMIT 17% throughout**, free RAM never
below 10,246 MB. No Track A reading, because there was nothing to report.

- **SO "okta=GONE MEANS THE 12-MINUTE, 9,434 MB TRIP" IS NOT A LAW.** That figure (08-20) is
  one observation of a trip that *struggled*; this one completed in 32 seconds for nothing.
  **Duration and cost track each other**, which makes a retrying or stalling navigation the
  better candidate than the password path itself. Do not write either in as the cause.
- **THEREFORE A RAMP CANNOT BE MANUFACTURED ON DEMAND.** The plan of queueing a hold so the
  T−3h warm-up fires a password sign-in **does not reliably produce one**, and this run is the
  evidence. Combined with the standing rule (three ramps arrived free in 30h and all were
  missed), the answer is unchanged: **wait for one; do not stage it.**
- **AND THE BOX HAS BEEN QUIET FOR ~20 HOURS** — no ramp since 13:0x PT on 08-25, against a
  cadence of ~5-7h before that. The trail has still never seen one. **That is not a cure**;
  every "not reproduced this session" reading in this file was a window that missed one.

#### FORCING IS A COIN FLIP, AND ONLY ONE RECIPE HAS EVER WON (2026-09-07)
Asked to force a ramp so the one-shot capture could be exercised immediately. `test-login` was
fired — the only remote lever that drives an Okta trip on the **RESIDENT** renderer, which is
the renderer the 09-04 measurement says ramps (the renewal runs in a throwaway tab whose trail
reads `-4 MB`). It cost **eleven seconds and nothing**:
```
19:16:45 PT  Session before the test: DEAD — no token in localStorage
19:16:52       → password field, password entered, submitting
19:16:55       (asked Okta for a fresh credential — rewrote 1 authorize request(s))
19:16:56     ✓ the bot can still sign itself in
19:17     rc 320 MB (new pid, the post-Okta recycle) · commit 7.1/17.1 GB · free RAM 10.6 GB
```
- **THAT READING IS FROM THE CHEAP CELL AND SAYS NOTHING ABOUT THE EXPENSIVE ONE — the first
  write-up of this run got that wrong and it is corrected here.** The health line immediately
  before it reads `⚠ RC SESSION IS DEAD … okta session STILL ALIVE`, so Okta was **ALIVE**:
  `prompt=login` forced a form and a real credential was submitted, but Okta answered from the
  existing session. Eleven seconds is the cookie-answered band exactly (08-21: 11s, +24 MB).
  **It does not pair with 2026-08-26**, which was the `okta=GONE` full-password cell.
- **THE GONE CELL HAS RAMPED TWO TIMES IN THREE**: 08-20 (12 min, 9,434 MB), 08-24 (11 min,
  9,338 MB — the ordered ramp, at the predicted minute), 08-26 (32 s, zero). So *"a ramp cannot
  be manufactured on demand"* is too strong as written on 08-26; the honest figure is a coin
  flip with the odds slightly in favour.
- **THE ONE RECIPE THAT HAS EVER WON IS A TEST HOLD.** `maybeWarmupLogin` fires at T−3h **only
  when Okta is GONE**, and that is by construction the full password form. That is what was
  ordered on 08-23 and delivered a 9,338 MB ramp at 05:00 PT the next morning. Nothing else
  reaches that cell on demand: `test-login` is answered from the cookie while Okta lives, and
  `restart-rc`/`kill-chrome` only reopen a browser.
- **AND IT COSTS A REAL CAMPSITE.** `scripts/rc-test-hold.mts` takes a real numeric unit id by
  design — that is what makes the chain real — so a staged ramp locks a site until the claim
  releases it or RC drops the cart, and it shuts the box's 02:00–05:00 update window for the
  6h before the release. **That is the standing reason not to do it casually, and it is a
  decision for the owner rather than a lever to reach for.**
- **THE OKTA CAP DID NOT RESET ACROSS THIS PASSWORD SIGN-IN — third corroboration.**
  `okta_expires_at` read **19:30 PT** against a sign-in at 19:16:56, i.e. thirteen minutes,
  unmoved by a fresh credential. 08-16 found the same across a password sign-in and 08-21
  across a cookie-answered one. **So the GONE precondition arrives on its own schedule and
  cannot be brought forward by signing in either.**
- **WHAT THE ATTEMPT DID BUY, AND IT IS NOT NOTHING:** it repaired a genuinely dead RC session
  (`token exp in 60m` afterwards). That is the legitimate reason to reach for this lever, and
  the box rations it to one on-demand run per 6h on its own clock.
- **A CANDIDATE COST, LABELLED AS ONE:** the fresh 60-minute token stands `planRenewal` down
  for an hour, and every recorded onset has sat beside a renewal — so the attempt plausibly
  pushes the next natural ramp further out rather than nearer. The 09-04 walk puts the ramp in
  the resident renderer while the renewal ran in a tab, so the two are adjacent rather than
  identical; do not write this in as the mechanism.
#### THE RAMP WAS FORCED TO ORDER, THE WALK ANSWERED, AND THE DUMP WAS RACED AWAY (2026-09-07)
The owner asked for a ramp on demand so #294's one-shot capture could be exercised now rather
than waiting out the 5-28h cadence. **It was produced, at 20:38 PT, second attempt** — and the
first attempt is a finding of its own.

**THE RECIPE, AND IT IS NARROWER THAN THE WARM-UP'S OWN GATE.** `maybeWarmupLogin` needs
**Okta GONE *and* RC's own token dead.** The entry above says only the first, and that is not
enough:
```
20:06:23  hold queued (release +120m)          <- rc-test-hold.mts --in 120
20:06:35  warming up the session: the release is 120m away and Okta is GONE - signing in now
20:06:40      -> already signed in - nothing to do
20:06:40    x warm-up did not establish an Okta session: already signed in
            RAM 10846 -> 10731 MB (-115) => this navigation did NOT ramp
20:07:54     warm-up stood down: the warm-up has already had its 1 turn for this release
```
`attemptLogin` short-circuits on a live RC token, so the trip no-opped in **4.5 seconds** and
spent the module's one turn on it. **`--in 120` is the right offset**: it opens the T-3h..T-30
window immediately and leaves ninety minutes of margin, so the hold is deleted long before it
can cart — **no campsite was ever locked**, unlike the 08-23 experiment which let one run to
the cart. The warm-up fired **17 seconds** after the insert.

**THAT IS A PRODUCTION DEFECT, NOT AN ARTIFACT OF THE TEST.** Okta's ABSOLUTE cap can expire
while a 60-minute token is still running — measured here: a 19:16:56 sign-in whose Okta session
died at the cap at 19:30 and whose token lived to 20:17. In that state the warm-up is
structurally incapable of succeeding, burns its turn learning so, and stands down — **so the
twelve-minute password trip lands at T-30 anyway, which is the exact failure the module exists
to prevent.** Fixed with a fourth gate in `warmupPlan`: a POSITIVELY alive token stands down
**keeping the turn**. It converges by construction (a 150-minute window against a 60-minute
token), and **only a positive reading blocks** — `readLiveToken` returns `{token: null}` for
"no token" and "the page would not answer" alike, so blocking on null would silently disable
the warm-up on any unresponsive page. A refund was rejected: it retries every 60s, and each
no-op is ~50 responses / 2.8 MB to RC from the address that has eaten a twelve-hour block.

**ATTEMPT TWO, WITH THE TOKEN GENUINELY DEAD, RAMPED — ON CUE.**
```
20:37:59  keep-warm probe: RC rejected the session - token exp in -21m; okta=GONE(404)
20:38:30  hold queued (release 22:38:30), deleted at 20:41 once the trip was under way
20:38:13  rc   301 MB  pid 14332  commit  7,054/17,150  free RAM 10,841
20:40:13  rc 2,811 MB  pid  1916  commit 41,397/41,871  free RAM  7,709
20:42:14  rc 4,805 MB  pid  1916  commit 43,758/44,960  free RAM  5,859
20:44:14  rc   208 MB  pid  3528  commit  6,991/17,150  free RAM 10,916
```
The ~35 GB commit step inside one two-minute tick, on a renderer that did not exist two minutes
earlier. **So the GONE cell's record is three ramps in four** (08-20, 08-24, this; 08-26 is the
miss), and forcing is worth doing when a reading is wanted. **The RAMP arm contained it to
4,805 MB in about four minutes** against the 8-9 GB of an untreated event.

**THE NEW CENSUS ANSWERED BOTH OF ITS BRANCHES ON ITS FIRST FIRING.**
```
2-4M mapped: 15494 region(s) across 15493 allocation base(s) - each is its OWN mapping, so
             this is N separate sections, not one carved up.
2-4M protection: 0x1x2 0x2x1 0x4x15491        (0x4 READWRITE)
name census: 64 sampled, ALL ANONYMOUS - pagefile-backed sections with no file behind them.
```
- **IT IS N SEPARATE `MapViewOfFile` CALLS, NOT A FEW LARGE MAPPINGS CARVED INTO VIEWS.** One
  base per region, 15,493 of them, 31,005 MB. The fork #294 was built to settle is settled.
  The CONTROL in the same scan reads **5 regions across 4 bases**, which is what makes this a
  comparison rather than an assertion.
- **ALL READWRITE**, consistent with per-object shared buffers rather than anything mapped for
  execution or read-only data.
- **ALL ANONYMOUS, so the branch that would have ended this outright did not fire.** The name
  census is not silently returning nothing: **one of the control's five IS file-backed**
  (`SortDefault.nls`), which is the positive control for the instrument itself. That hands the
  question to the memory dump's owner column — and the dump is what did not run.

**AND THE DUMP WAS RACED AWAY BY THE BAIL, WHICH IS THE HOUSE SHAPE IN THE LAST INSTRUMENT
STANDING.**
```
20:42:23  ramp-scan       rc 4805 MB, vmwalk complete
20:42:24  request-counts  reason=bail:ramp
          (no mem-dump, on the one ramp anybody had ordered)
```
`maybeMemoryDump` sat AFTER the arm's `return` and shared its `RAMP_MB`, on the recorded
reasoning that *"the ramp arm needs a 120s stall on top of this same threshold, so this
typically runs ~2 minutes ahead of the exit"*. **That assumes the stall starts when the memory
does.** It does not: the loop is stuck inside the Okta trip from its first second, so by the
time the family crosses the bar the stall is already ~215s old, both arms go true on ONE tick,
and the dump is never called at all. Not a lost POST — a call that never happens.
- **Fixed with `MEM_DUMP_RAMP_MB` (1500), strictly below the bail's 3000.** The head start is
  bought with a threshold, not with the arm's extra condition. Chosen from this event's own
  series: rc read 2,811 MB at 20:40:13 and 4,805 MB at 20:42:14, so it now fires a **full
  sampler tick earlier** — and while the renderer still answers CDP, which is the other thing
  that stops working as a ramp peaks (measured twice, on two different calls).
- **The dump stays OUT of `reportAndBail`, deliberately**, and that is pinned: a multi-second
  CDP call on the path that releases the profile lock is what loses a cart at 08:00.
- **A PRE-EXISTING GUARD REQUIRED THE BUG.** *"it uses the SAME reading and the SAME comparison
  as the ramp arm"* asserted `memory.rcMb > RAMP_MB` by name. Its premise was right — the two
  arms must not disagree about which EVENT they see — and its conclusion was wrong: sharing the
  threshold does not put them on one side of an event, it puts them on the same TICK.
  **INVERTED, not deleted**, with the reason written in; the one-reading half is kept verbatim.
  Same shape as `held-offer-scope` requiring the 26-text storm.
- **AND A MUTATION SURVIVED: `if (false) maybeMemoryDump(memory);` PASSED ALL 33 TESTS.** Every
  guard anchors with `indexOf`, which matches just as happily inside a dead branch, so nothing
  asserted the call was REACHABLE. Pinned as a bare statement on its own line now. Sixth-odd
  instance of fix-present-and-inert, this time inside the guard written for the previous one.

**A SECOND FORCED RAMP WAS ATTEMPTED AN HOUR LATER, ON THE FIXED BOX, AND IT MISSED — WHICH
PRODUCED THE MORE USEFUL FINDING.** Both fixes were merged (#296) and confirmed live by
`git-status` (`aaf2fe5`), the fleet came back 3/3 shards, and a fresh hold put the warm-up in
the correct cell (`no token at all` AND `okta=GONE(404)`). It ran the **full password form** —
`email field` -> `ticked "Keep me signed in"` -> `password entered` -> `✓ Okta session
established` — in **15.6 seconds for 413 MB.** No ramp, so no dump, and nothing was wasted
except the attempt.

**DURATION AND COST TRACK EACH OTHER, SEVEN FOR SEVEN, AND THAT RETIRES THE CELL AS THE
EXPLANATION.**

| event | duration | cost |
|---|---|---|
| 08-20 auto-login | 12 min | 9,434 MB |
| 08-24 warm-up (ordered) | 11 min | 9,338 MB |
| 09-07 20:38 warm-up (ordered) | ~4 min, bailed | 4,805 MB peak |
| 08-26 rehearsal | 32 s | 0 |
| 09-07 21:49 warm-up (ordered) | 15.6 s | 413 MB |
| 09-08 22:33 warm-up (ordered) | 16 s | 587 MB peak |
| **09-10 16:58 warm-up (ordered)** | **16 s** | **no ramp — peak UNOBSERVED, see below** |

- **SO THE QUESTION IS NO LONGER "WHICH CELL?" BUT "WHAT MAKES A TRIP SLOW?"** The
  `okta=GONE` password form is now **three ramps in seven**, and all four misses completed
  cleanly and quickly. A password sign-in does not cost gigabytes; a password sign-in **that
  struggles** does. This file already said *"duration and cost track each other, which makes a
  retrying or stalling navigation the better candidate than the password path itself"* — that
  was one observation then and it is seven now.
- **NOT THE BYTE COUNT.** This trip moved **233 responses / 17.0 MB**, roughly double the
  09-07 05:07 trace's 112 / 8.7 MB, and did not ramp. The three-way verdict refused to speak,
  correctly.
- **A CANDIDATE, LABELLED AS ONE: the trace shows `recaptcha__en.js` fetched SEVEN times
  (2.4 MB).** A challenge appearing is exactly the shape that makes a navigation slow, and the
  2026-08-06 finding is that a challenge's overlay swallows pointer events so retries time out
  rather than fail. **Nothing has compared the recaptcha counts of a ramping trip against a
  clean one** — the ramping traces are the ones that bail, and `tail-log` rolls at 16,000
  characters. That comparison is the next cheap reading and it needs no new instrument, only
  the trace being stored rather than logged.
  - **THE CLEAN-SIDE BASELINE IS NOW THREE READINGS AND THEY ARE THE SAME: `x7`, 2.4 MB, on
    09-07 21:49, 09-08 22:33 AND 09-10 16:58** — and the byte totals sit within 3% of one
    another (233 responses / 17.0 MB, 239 / 17.4 MB, 238 / 17.0 MB). So a clean password trip
    has a stable shape, and it is the RAMPING side that is unmeasured. **Do not read the
    matching set as evidence about the leak** — three samples of the same non-event say nothing
    about the event; what they buy is a baseline to compare the next ramping trace against.
- **A SUCCESSFUL WARM-UP CLOSES ITS OWN WINDOW.** It leaves Okta ALIVE, so the GONE
  precondition does not return until the session lapses, and `spent` is 1 for that release.
  **One forced attempt per Okta lifetime** is the real budget, whichever way the coin lands.

##### A FOURTH ORDERED ATTEMPT MISSED, AND THE SERIES COULD NOT SEE INSIDE IT (2026-09-10 16:58 UTC)
Fired to put the new commit trigger (below) in front of a ramp on demand rather than waiting out
the 2.3-18.6 h cadence. **Both preconditions were READ before it ran, not predicted** — the
keep-warm reported `no token at all` and `okta=GONE(404)`, so the recipe landed in the correct
cell for the fourth time since #296 added the token gate. (The one pre-fix attempt, 09-07 20:06,
found a live token, no-opped in 4.5 s and spent its turn learning so — which is what #296 is
for.) It then produced a clean sign-in for nothing:
```
16:58:57 warming up the session: the release is 120m away and Okta is GONE - signing in now
16:59:10     -> password entered, submitting
16:59:13   OK Okta session established - the sign-in before the release will be the cheap one
16:59:14   network trace: 238 response(s), 17.0 MB ... recaptcha__en.js x7 2.4 MB
           RAM 10570 -> 10232 MB (-338) => this navigation did NOT ramp
16:59:59    warm-up stood down: the Okta session is alive
```
- **NOTHING WAS AT STAKE AND NOTHING WAS LOCKED.** `--in 120` opens the T-3h..T-30 window at
  once with ninety minutes of margin; the hold was deleted the moment the trip finished, and
  the table read 0 live / 0 offered afterwards — **by query, not by assumption.**
- **THE PEAK IS UNOBSERVED, AND THAT IS A DIFFERENCE FROM 09-08 RATHER THAN A SMALLER
  NUMBER.** `chromium_memory_samples` runs every two minutes and the samples either side are
  **16:58:32 (rc 293 MB, commit 6,891) and 17:00:35 (rc 337 MB, commit 6,982)** — so the whole
  16-second trip fell between two samples and the series never looked inside it. 09-08's
  "587 MB peak" was genuinely sampled; **this one has no series figure at all**, and the only
  in-trip reading is the trace's own RAM delta. Do not put the two in a column together as if
  they were the same kind of measurement — the table above says `UNOBSERVED` for that reason.
  - **THE COMMIT TRIGGER WOULD NOT HAVE HELPED HERE EITHER, AND THAT IS THE DESIGN.** It reads
    the same two-minute file, so a 16-second event is invisible to it as well. It exists to
    catch a **burst**, which is a ~30 GB commit step that persists for minutes; a trip that
    allocates nothing for sixteen seconds is not the case it is for.
- **THE WARM-UP'S PRODUCT SURVIVED, WHICH IS THE HALF WORTH CHECKING.** Okta read **alive at
  17:17:44** — eighteen minutes on — so the attempt delivered the thing it exists for even
  though it produced no ramp. **A `dead` reading four minutes earlier (17:13:23, "no token at
  all — signed out; okta session GONE") was TRANSIENT and repaired itself**, and I was one step
  from writing it up two ways: as a session my forced attempt had killed, and as a bug in
  `okta_checked_at` (which had not moved on that row). The next report moved every okta column
  correctly, so the write path is fine and the row was a probe catching the resident page
  between states. **Re-read before concluding** — this file's own rule, nearly broken for the
  fifth time, on a reading four minutes from correcting itself.
- **DO NOT RE-ARM ON THIS.** A successful warm-up leaves Okta ALIVE and spends the turn, so the
  next GONE window is ~12 h out; the token is fresh for an hour, so `planRenewal` stands down
  and no renewal-driven ramp can arrive inside it either. Natural ramps run 2.3-18.6 h apart and
  **the commit trigger is live for all of them**, so waiting costs nothing while every forced
  attempt spends a password submission from an address that has eaten a twelve-hour block.
- **WHAT IT ACTUALLY BOUGHT: the third clean-side network baseline**, and one distinction
  worth keeping apart. **Landing in the cell is a GATE and it is reliable** (four for four
  since #296). **Ramping once you are there is a COIN** — of the five ordered attempts, two
  ramped; of the seven `okta=GONE` password trips on record, three did. Quoting either number
  as "the success rate of forcing a ramp" merges a thing we control with a thing we do not.

##### A CAPTCHA STOPPED THE WARM-UP — FIRST ONE ON THIS PATH, AND A REAL HOLD WAS RIDING ON IT (2026-09-17 12:00 UTC)
The T-3h warm-up fired **on a real user's hold** (`#A124`, rc-357, releasing 15:00 UTC) with all
four gates read rather than predicted, and was stopped by an image challenge on Okta's email step:
```
11:59:39 warming up the session: the release is 180m away and Okta is GONE - signing in now
11:59:49     -> email field: input[name="identifier"]
11:59:50     -> ticked "Keep me signed in"
11:59:50     -> submitting the email (attempt 1) - Enter
12:00:00     -> Enter did not advance - clicking button[type="submit"] (visible=true enabled=true size=339x46)
12:00:08     -> x the click FAILED: locator.click: Timeout 8000ms exceeded.
12:00:08     -> trying a direct DOM click (bypasses actionability checks)...
12:00:21   x warm-up did not establish an Okta session: a CAPTCHA appeared during sign-in
```
- **IT IS THE 2026-08-06 SIGNATURE TO THE LETTER, AND THAT IS WHAT MAKES IT A DIAGNOSIS RATHER
  THAN A GUESS.** That entry records the control reporting `visible=true enabled=true` while every
  click times out, *"because the challenge's overlay was swallowing pointer events"*, and concludes
  **retrying harder can never work**. Today's line is `visible=true enabled=true size=339x46` and an
  8,000 ms click timeout. The detection `rc-probe.mjs` grew that day is what named it.
- **FIRST CAPTCHA EVER RECORDED ON THE WARM-UP PATH, and the trip duration says so independently.**
  All seven warm-up/auto-login `tab-close` rows in `bot_events`:
  ```
  09-17 12:00  warmup      42,241 ms   <- the CAPTCHA
  09-17 04:31  auto-login  45,230 ms   <- the npm test phantom-release fixture
  09-10 16:59  warmup      16,306 ms   |
  09-09 05:33  warmup      15,967 ms   |  the three clean password forms
  09-08 04:49  warmup      15,622 ms   |
  09-08 03:06  warmup       4,541 ms   <- found a live token and no-opped (the #296 case)
  09-05 14:42  auto-login  17,165 ms
  ```
  **42 s is a new band on this path**, and it is the 8 s click timeout plus the DOM-click fallback
  plus the detection. The four recorded "misses" were all 15.6-16.3 s CLEAN sign-ins.
- **SO "THE SCHEDULED REPAIR WILL FIX IT" IS FALSIFIED FOR TODAY, and that sentence was in the
  handover.** `docs/NEXT-SESSION.md` read *"`maybeAutoLogin` at 14:30 UTC is the designed repair
  ... **Do not reach for `rc-login.bat` or `test-login`** - both cost the session again and the
  repair is scheduled."* **`maybeAutoLogin` runs the same `attemptLogin`**, so it will meet the
  same overlay, spend both attempts, and ring the phone. The repair is not merely late; it is
  structurally unavailable.
- **AND THE USUAL REASON TO REFUSE `rc-login.bat` DOES NOT APPLY IN THIS STATE.** This file warns
  repeatedly that it **force-kills the Chromium the token lives in** - which is why printing it
  over a healthy session is the 2026-08-16 07:33 cry-wolf. **There is no token to destroy**: the
  heartbeat reads `no token at all - signed out` and `okta session GONE (404)`, and
  `session_live_since` has not moved since 10:54 UTC. **A dead session plus a CAPTCHA is the one
  configuration where the human sign-in is the correct remedy rather than the destructive one**,
  and it is what the 08-06 design says survives: a human signs in ONCE with "Keep me signed in"
  ticked, and the bot never lets the session lapse. `rc-login.bat` detects the challenge and waits
  up to five minutes for a person to solve it (**headful only**).
- **THE WARM-UP'S TURN IS SPENT AND THE AUTO-LOGIN'S BUDGET IS INTACT** - the log says both in its
  own words (`the warm-up has already had its 1 turn for this release`; *"The auto-login still has
  its full budget at T-30"*). So the module's accounting is correct and it is the accounting of a
  repair that cannot succeed.
- **IT DID NOT RAMP** (`RAM 10291 -> 10121 MB (-170) => this navigation did NOT ramp`), so it buys
  nothing for the leak either. The three-way verdict refused to speak, correctly.
- **WHY NOW IS NOT ESTABLISHED - do not write one in.** The 08-06 entry's own candidate is
  *repeated fresh-profile logins*, and nothing here has changed its profile. What IS on record for
  this box today is a network episode (`ERR_NAME_NOT_RESOLVED` at 10:00:46, losing a `tab-close`
  row outright) and 23 hours of failing renewals - neither of which explains an anti-bot posture.
  **One CAPTCHA is an event, not an escalation**; the reading that would matter is whether the
  next unattended sign-in after a human one also meets it.

#### THE STALL TRIGGER FIRED ON ITS FIRST RAMP AND WORKED — AND THE RAMPING RENDERER WOULD NOT ANSWER (2026-09-08 21:43 PT)
**A natural ramp arrived fifty minutes before the ordered one, and #302's trigger caught it.
Four consecutive missed ramps end here.** It is also still not a reading, and the reason is new
— which is the part that matters, because the readout named the wrong one until it was fixed
the same night (below).
```
~21:42:07  browser starts (3m old at the bail)
 21:43:42  mem-dump  phase=ramp  7 process(es)  20011ms  x PARTIAL (no answer in 20000ms)
 21:44:55  ramp-scan walk: TARGET pid 7644 renderer, 4366 MB private, 17,306 handles
 21:45:07  bail:ramp
 21:48:24  mem-dump  phase=baseline  7 process(es)  194ms      <- the control, healthy
```
- **THE TIMING IS THE DESIGN, TO THE SECOND.** `MEM_DUMP_STALL_MS` is 90s and the dump ran ~90s
  into a browser whose loop had stalled from the start — **85 seconds ahead of the bail**, i.e.
  the three-tick head start #302 specifies, obtained by reading NO file. The grace was never
  needed: the dump had finished long before the arm fired. **Threshold, grace and stall trigger
  are three mechanisms and only the third had to work.**
- **IT REACHED THE RIGHT BROWSER GENERATION, AND THE JOIN IS WHAT PROVES IT.** Every one of the
  dump's seven pids — 9472, 1864, 6864, 14316, 4568, 5896, 13364 — appears in the ramp scan's
  own `CHROME` list for the same event. What is missing is **pid 7644, the ramping renderer**,
  and 1664, a crashpad handler that does not participate. So the dump is not describing a
  replacement browser; it is describing this one, minus the single process that holds the 32 GB.
- **AND IT SPENT ITS ENTIRE BUDGET WAITING FOR IT.** `20011ms · PARTIAL (no answer in 20000ms)`
  against a **194 ms** baseline on the healthy replacement two minutes later. The instrument is
  fine; the subject stopped speaking.
- **THE ONE ALTERNATIVE IS RULED OUT BY THE SERIES, NOT BY REASONING.** "7644 did not exist
  yet" would make this a timing fault after all — and 2026-09-04 records that a ramping renderer
  is often *"a pid that did not exist a minute earlier"*, so it is a live possibility rather than
  a pedantic one. The 2-minute series answers it:
  ```
  21:40:54  rc 0 procs                    commit  6,609 MB   <- browser not yet started
  21:42:54  max pid 7644 at 2,297 MB      commit 43,964 MB   <- 48s BEFORE the dump
  21:43:42  the dump runs — 7644 absent, PARTIAL after 20s
  21:44:54  max pid 7644 at 4,277 MB      commit 45,948 MB
  21:46:55  new pid 8132 at 81 MB         commit  6,980 MB
  ```
  **7644 was already the ramping renderer and had already taken the ~35 GB commit step 48
  seconds before the dump asked it anything.** So it was there, it was the right process, and it
  did not answer.
- **AND THAT IS THE ARGUMENT AGAINST "JUST FIRE EARLIER", WHICH IS THE OBVIOUS FIX.** The
  browser did not exist at 21:40:54 and by 21:42:54 its renderer held 2.3 GB with the commit
  step **already complete** — so the whole step happens inside one two-minute sample, within
  ~2 minutes of browser start, and there is no comfortable window in which the renderer is both
  holding the sections and still answering. A lower `MEM_DUMP_STALL_MS` buys very little of that
  window and spends the discrimination 90s was measured for. **Neither half of that trade is
  free; do not take it on the strength of "earlier is obviously better".**
- **THIRD INSTRUMENT, THIRD CDP CALL, SAME SILENCE.** `newCDPSession` (2026-08-18),
  `Performance.getMetrics` (08-18 and 08-19), now `Tracing.requestMemoryDump`. **A renderer
  eating the machine does not answer CDP, and no timeout buys it** — 20,000 ms was already the
  budget, and the 08-18 entry closed this question once: *"the reading cannot be taken at the
  trip at all, and no timeout worth spending changes it."* That conclusion was drawn about the
  heap trail and it transfers.
- **THE READOUT'S VOID GLOSS NAMED A MECHANISM THIS EVENT REFUTES, AND THAT WAS A REAL DEFECT.**
  It printed *"this is the 2026-09-07 shape, where a bail killed the generation and the dump
  measured its replacement."* **Here the bail came 85 seconds AFTER the dump** and the pids are
  one generation. Read literally it would have sent the next session to fix the trigger — which
  is now correct — and that is the most expensive kind of wrong: an instrument confidently
  naming the half that already works. **Two VOID cases need telling apart and they need OPPOSITE fixes:**
  - **generation mismatch** (09-07): NONE of the dump's pids are in the scan's list. The dump
    described a different browser; the fault is timing.
  - **target silent** (09-08): the dump's pids ARE the scan's list minus the TARGET. The timing
    is right and the ramping renderer will not answer.
  ~~**NOT BUILT**~~ — **BUILT THE SAME NIGHT, and the real event is what verified it.**
  `dumpJoinReading` takes the walk's own `CHROME` pid list now and splits the cause; the readout
  passes it. Rendered against the 21:43 row it prints *"**7 of those 7 pid(s) ARE in the walk's
  own process list**, so the dump reached the RIGHT browser and the ramping renderer alone did
  not answer it. The timing is right… **Do NOT go looking at the trigger.**"* — stronger than
  the reasoning above, which only claimed overlap.
  - **THE KIND STAYS `void` FOR EVERY CAUSE.** The caller suppresses on `kind === 'void'`, so a
    cause it has never heard of must still suppress; the cause rides BESIDE the kind rather than
    replacing it. A mutation returning `joined` for `target-silent` would un-suppress the one
    sentence a reader quotes, and is pinned.
  - **AND THE `unknown` CAUSE ASSERTS NEITHER MECHANISM.** With no generation list the two are
    genuinely indistinguishable, so it says so instead of picking — which is the defect being
    fixed, in miniature.
  - Five mutations, each verified to APPLY and to fail: the overlap test inverted, `target-silent`
    returning `joined`, **the readout dropping `walkGenerationPids`** (the fix-present-and-inert
    shape — the function can be perfect and unreachable), the 09-07 mechanism asserted
    unconditionally again, and the *"do not go looking at the trigger"* steer removed.
- **THE WALK IS FOUR FOR FOUR AND NEEDS NO REPEATING.** 16,385 regions in `2-4M` across
  **16,381 allocation bases**, 32,773 MB, 16,380 READWRITE, 64 sampled and all anonymous, with
  the control's file-backed positive control (`SortDefault.nls`) present as ever. **EXCESS
  37,054 MB against an OS commit gap of 36,730 MB** — the walk has named the 35 GB, again.
- **AND THE REQUEST COUNTER CARRIED A LOAD BURST — 17,093 lifetime on a browser 3 MINUTES OLD,
  with 0 in the last 120s.** "Flat" would be wrong: that lifetime count IS a burst, fired at page
  load and over before the ramp peaked, exactly the recorded shape. Sixth sighting.
  **It still says nothing about the leak**, and this event plus 09-07 20:42 are the pair that
  show it: same 32 GB mapping, 17,093 lifetime requests here against **110** there. Independent
  in both directions.
- **SO THE FORK IS NARROWER AND IT IS NOT A FREE CHOICE.** Chromium's ownership graph is the
  only thing that can name the creator of an anonymous section, and reaching it requires the
  ramping renderer to answer. Firing the dump EARLIER is the obvious move and it costs the one
  property that makes the trigger sound: 90s was measured against **133 tab-closes whose longest
  trip is 71,552 ms**, so a lower floor starts firing on healthy trips and a healthy trip can
  then spend the ramp's slot. **Do not lower it without measuring what replaces that
  discrimination.** The falsifiable candidate is unchanged and needs no instrument:
  `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is **2,097,152 bytes**, which is
  32,773 MB / 16,385 exactly.

##### A THIRD ORDERED ATTEMPT, AND THE MEMORY SERIES IS WHAT CONFIRMED THE MISS (2026-09-08 22:33 PT)
Fired by a one-shot Routine timed to land just past Okta's absolute cap, and **both
preconditions were read before it ran rather than predicted** — `okta_alive false`,
`okta_expires_at null`, `session_ok false` (*"no token at all — signed out"*), checked 3.5
minutes earlier, with the box on `c0b222c`, i.e. the stall trigger live. That is the recipe
working: the gate this attempt needed is exactly the one #296 added.
```
22:33:23 warming up the session: the release is 120m away and Okta is GONE - signing in now
22:33:35     -> password entered, submitting
22:33:39   OK Okta session established - the sign-in before the release will be the cheap one
           network trace: 239 response(s), 17.4 MB - RAM 10559 -> 10166 MB (-393)
           => this navigation did NOT ramp
```
- **THE SERIES AGREES INDEPENDENTLY OF THE TRACE, WHICH IS THE PART WORTH KEEPING.** The
  trace's RAM delta is one instrument; `chromium_memory_samples` is another, and it read
  **250 -> 587 -> 328 MB on the SAME pid 8132**, commit 7.0 -> 7.7 GB, free RAM never below
  10,055 MB. No browser replacement, no bail, no dump. A ramp is a new renderer pid and a ~35 GB
  commit step; this is neither, twice over.
- **NOTHING WAS AT STAKE AND NOTHING WAS LOCKED.** `--in 120` opens the T-3h..T-30 window
  immediately with 90 minutes of margin, and the hold was deleted the moment the trip finished
  — 0 live holds afterwards, confirmed by query rather than assumed.
- **THE ODDS ARE NOW 3 IN 6 AND THE BUDGET IS UNCHANGED.** A successful warm-up leaves Okta
  ALIVE, so this Okta lifetime's turn is spent and the next GONE window is ~12h out at the
  earliest. **Do not re-arm a forced attempt on a miss** — natural ramps arrive every 5-28h and
  the stall trigger is live for all of them, so waiting costs nothing, while every forced
  attempt spends a password submission from the address that has eaten a twelve-hour block.

**HOW TO READ THE NEXT ONE.** The walk half is answered and does not need repeating; what is
outstanding is one `mem-dump` with `phase: ramp` whose `MDPROC` pids contain the walk's TARGET.
`discardable/segment` at ~32 GB names the subsystem; a small `shared_memory` total against a
walk showing 32 GB of `commit/mapped` retires discardable, mojo and the GPU transfer path
together. **Both fixes are BOT-SIDE and inert until the box updates** — confirm with
`npx tsx scripts/bot-ask.mts git-status`, never `autocart.bot_version`.

#### THE THIRD MISS: THE HEAD START IS MEASURED IN MEGABYTES AND PAID IN SAMPLER TICKS (2026-09-08)
A natural ramp arrived at **02:03 PT with `MEM_DUMP_RAMP_MB = 1500` live on the box**
(`6843973`, confirmed by `git-status`), the region walk fired and completed, and there is
**still no `ramp` dump** — one in the whole table, and it is the VOID one from 09-07. Third
consecutive miss, third distinct mechanism, and the third one is inside the fix for the second.

**THE MEMORY SERIES IS THE WHOLE DIAGNOSIS, AND IT TAKES THREE ROWS.**
```
09:01:10 UTC  rc =   238 MB   commit  7,273 / 17,150   pid 8468
09:03:11 UTC  rc = 3,423 MB   commit 43,760 / 44,960   pid 1640   <- the ONLY sample of the ramp
09:05:11 UTC  rc =   205 MB   commit  7,000 / 17,150   pid 6012
```
- **ONSET, PEAK AND BAIL INSIDE ONE TWO-MINUTE INTERVAL.** 238 → 3,423 MB is **≥1,580 MB/min**,
  nearly double the ~850 MB/min the threshold gap was sized against, and the `request-counts`
  event puts the browser at **2m old** when it bailed.
- **SO THERE WAS NO SAMPLE BETWEEN 1500 AND 3000.** The single reading above the dump's bar was
  above the arm's bar too, both arms went true on that tick, the arm `return`ed, and
  `maybeMemoryDump` sat below it exactly as it did on 09-07.
- **THE GAP IS MEASURED IN MEGABYTES AND PAID IN SAMPLER TICKS.** Both arms read ONE file that
  `bot.mjs` writes every two minutes, so a lower threshold only helps when a SAMPLE happens to
  land between the two numbers. **No threshold separation can guarantee that** — the ramp can
  cross the entire gap between two samples, and here it crossed nearly four times the gap.
  **#296 moved the number and left the mechanism**, which is the shape #296 was itself written
  to end. Its own guard even records the arithmetic that predicts this (*"the onset takes the
  family past 2,800 MB inside one two-minute sampler tick"*) and then sized a 1,500 MB gap
  against it.
- **IT IS A COIN FLIP, NOT A DEAD LEVER.** On 09-07 20:38 a sample DID land in the gap
  (2,811 MB at 20:40:13), so with the fix live that ramp would have been caught. The threshold
  is **KEPT** — it wins the ~half of ramps where a sample lands in the gap, and it takes the
  dump while the browser is healthier — it is simply not sufficient on its own.

**FIXED BY GRANTING THE TICK RATHER THAN THE MEGABYTES.** `rampDumpGrace` (`ramp-bail.mjs`):
on a tick where the arm would fire and no ramp dump has been taken for this browser life, the
bail **HOLDS** and the dump is started instead. `dumpTaken` is set when the dump STARTS, so the
ordinary path holds exactly **one tick**.
- **BOUNDED BY A DEADLINE, ONCE PER BROWSER LIFE, AND THE DEADLINE IS THE POINT.** `HUNG_MS`
  already tolerates twelve minutes and this arm exists to cut that to two; an unbounded hold
  hands the twelve minutes back. The cost is the **profile lock** — the bail is what releases
  it, and the lock held past 08:00 is what loses a cart — so it is capped at ≤2 ticks against a
  stall already 120s old and a bail whose own diagnostics cost 2-8s. The guard bounds it from
  BOTH sides: longer than one `WATCHDOG_MS` or the retry can never run, at most three or it
  stops being a rounding error on the exit.
- **TWO TICKS AND NOT ONE, deliberately.** A refusal puts the phase back and the next tick
  retries; and a **baseline** dump can be in flight when the arm fires, which is not rare —
  the baseline is due three minutes into a browser life and **every burst-carrying ramp so far
  has landed in a browser 2-3 minutes old** (2m, 3m, 2m). One tick would spend the grace on a
  call that could not start.
- **THE DUMP STAYS OUT OF `reportAndBail`, unchanged and still pinned.** The grace delays the
  whole exit for a bounded tick; it does not put a multi-second CDP call on the path that
  releases the lock. It can delay the bail, never prevent it: the grace is spent whether or not
  the dump lands, and an expired one **says so** rather than going quiet.
- **`Number(null)` IS 0 AND `Number.isFinite(0)` IS TRUE**, so the first version read "no grace
  granted" as "the grace expired at the epoch" and bailed on the first firing tick — the fix
  present and inert, in the fix for the previous instance of it. **Caught by the guard on its
  first run**, which is what a behavioural test on a pure function is for.
- **TWO EXISTING GUARDS WERE RE-ANCHORED, NOT RELAXED, AND ONE WAS INVERTED.**
  `rc-mem-dump.test.mts`'s *"the bail still returns before the dump, so ONLY the threshold
  creates the gap"* **required the premise this ramp falsified** — the `held-offer-scope` shape
  again — so it is inverted with the reason written in; its sibling lost the half that asserted
  source-order adjacency and kept the half that matters (never inside `reportAndBail`). And
  `keepwarm-recycle.test.mts` pinned `reportAndBail` as the arm's FIRST statement, which the
  grace now precedes; re-anchored on the CALLEE (and strengthened: the arm may never call
  `bail`/`process.exit` directly).
- **13 mutations, each verified to APPLY and each caught** — the consult deleted, the held tick
  starting no dump, the deadline never stored, the grace not reset per browser life,
  `dumpTaken` ignored, the deadline pushed out on every hold (an unbounded hold wearing a
  bound's clothes), an expired grace still holding, `canDump` ignored, the `Number(null)` trap
  restored, the default raised past three ticks, the keep-warm carrying its own copy of that
  default, the held tick falling through to the bail on the same tick, and the dump moved
  inside `reportAndBail`.
- ~~**BOT-SIDE, so it is inert until the box updates**~~ — **MERGED AS #298 AND ON THE BOX
  (`64b40d5`, 2026-09-08, confirmed by `bot-ask git-status`), fleet back at 3/3 shards.** It
  now needs only a ramp; they arrive every 5-28 hours, or one can be ordered (recipe above).
  **HOW TO READ IT** *(the durations here are superseded by the entry below — the grace is 20s
  now and holds while the dump is in flight)*: a `* holding the bail up to Ns` line in
  `logs\rc-keepwarm.log` is the grace being granted, followed by either `memory dump (ramp) in
  Nms` or one of the two named expiries — the grace having run and bought nothing, which is
  deliberately distinguishable from never having been granted.

#### AND THE SECOND WALK CORROBORATES THE FIRST, WITH THE CENSUS ATTACHED (2026-09-08)
The 09-05 walk was the only one carrying the `2-4M` census; the 09-08 02:03 ramp is the second,
and it agrees to within a per-cent:

| | regions in 2-4M | MB | allocation bases | protection | name census |
|---|---|---|---|---|---|
| 09-07 20:42 | 15,494 | 31,005 | **15,493** | 15,491 READWRITE | 64 sampled, **all anonymous** |
| **09-08 02:03** | **16,213** | **32,443** | **16,212** | 16,210 READWRITE | 64 sampled, **all anonymous** |
| control, same scan | 4 | 18 | 3 | 1 READWRITE | 1 of 4 **FILE-BACKED** |

One allocation base per region on both, so it is N separate `MapViewOfFile` calls and not one
mapping carved into views — twice, on two different browsers, two days apart. **The control's
file-backed entry is the census's own positive control** and it appeared both times, so
"all anonymous" is a reading and not a broken scan.

#### THE FOURTH MISS: THE GRACE WAS A PERMISSION SLIP, NOT A WAIT (2026-09-08)
The grace reached the box at **07:45:50 PT** and a natural ramp arrived at **07:47:50** — one
hundred and twenty seconds later. It fired, it held, and **there is still no `ramp` dump.**
The keep-warm's own log is the whole diagnosis, and the missing lines are as load-bearing as
the present ones:
```
14:47:50   * holding the bail up to 15s so the ramp dump can name what owns the 32 GB
14:48:05 ✗ RAMP — the loop has not advanced in 139s, rc family 3739 MB (reading 18s old)
14:48:05   heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
14:48:06   Releasing the profile and exiting so the hold runner can use it.
           (no `memory dump (ramp) …` line — and no `did not run` line either)
```
- **THE GRACE HELD ONE TICK AND ITS OWN DEADLINE WAS NEVER CONSULTED.** `rampDumpGrace` took a
  single `dumpTaken`, the caller passed `memDump.ramp`, and that flag is set **synchronously
  when the dump STARTS** — so the next tick took the `already under way` branch above the
  `now < until` check and bailed **ten seconds in**. The 15-second deadline was unreachable
  code on this path. **`dumpTaken` merged two facts**: "we asked for a reading" and "we have
  one", and the gap between them is the entire event this instrument exists to measure.
- **AND THE DEADLINE WOULD NOT HAVE BEEN ENOUGH EITHER — THIS IS ARITHMETIC, NOT BAD LUCK.**
  `MEM_DUMP_TIMEOUT_MS` is **20s** and the grace was **15s**: two constants with no stated
  relationship, ordered the wrong way round, so **the bail was always going to kill a dump that
  was still inside its own budget.** Both paths gave the instrument strictly less time than it
  needs. The old guard bounded the grace against the **TICK** (`> 1`, `<= 3`) and **nothing
  anywhere compared it with the dump's timeout** — a guard on the wrong pairing is how that
  goes unnoticed for a release. Same shape as `nextHoldRelease` disagreeing with `dueHolds`
  about whether a hold existed.
- **`process.exit(1)` THREW THE ACCUMULATOR AWAY, WHICH IS WHY IT IS SILENT.** `takeMemoryDump`
  deliberately keeps whatever arrived — *"A TIMEOUT WITH DATA IS STILL A READING"* — so a dump
  still streaming at ten seconds had data worth having. The exit discarded it, and neither the
  success line nor the `did not run` line ever printed: the two outcomes that module goes out of
  its way to keep apart, merged into nothing.
- **AND THE BAIL'S OWN "the grace bought nothing" LINE COULD NOT SEE IT.** It gated on
  `!memDump.ramp` — *no dump was STARTED* — so the one case that actually happened printed
  no line about a grace it had just spent. `landed` is set on a dump that produced a reading.
- **FIXED THREE WAYS, AND THE HOLD IS THE ONE THAT MATTERS.** The grace now runs **while the
  dump is IN FLIGHT**, to the deadline — which is what the word meant all along. `inFlight` is
  cleared in the dump's `.finally`, and `.finally` waits for the `.then` chain, so it stays true
  until `reportBotEvent` has resolved: **the hold covers the POST as well as the dump**, which
  is the half that actually gets the reading off the box. The default is **DERIVED**
  (`MEM_DUMP_GRACE_MS_DEFAULT = MEM_DUMP_TIMEOUT_MS`) so raising one raises the other, and a
  guard pins the relationship rather than the number. The two expiries are worded apart — a
  dump still running when the deadline binds is a browser too slow to answer inside its own
  budget; a deadline reached with nothing started is a dump that could never begin.
- **IT CAN DELAY THE BAIL AND STILL CANNOT PREVENT IT.** The deadline binds whatever the dump is
  doing, and the bail fires on the first tick after it — worst case ~20-30s against a stall
  already 120s old and a wedge that tolerates twelve minutes. The cost is the profile lock
  arriving that much later, and it stays inside the hold runner's own 60s preemption wait.
  **The ceiling of three ticks is KEPT**; nothing was relaxed to make room.
- **THE PRE-EXISTING GUARD REQUIRED THE BUG** — *"the ordinary path holds exactly one tick — a
  dump that STARTED spends it"* — on the premise that a dump costs ~200 ms, which is the
  **healthy-path baseline**. During a ramp the browser answered no CDP call in 3000 ms.
  **INVERTED, not relaxed**, with the reason written in. The `held-offer-scope` shape for the
  third time in this file.
- **Nine mutations, each verified to APPLY and each caught** — the in-flight hold removed (the
  09-08 bug restored), the grace back to a literal 15s, the deadline pushed out on every held
  tick, an in-flight dump allowed to outlast the deadline, the two expiries collapsed to one
  string, the call site dropping `dumpInFlight` (**the pure function is perfect and unreachable
  without it** — every behavioural guard calls it directly, so that one is pinned structurally),
  the expiry line gated back on `ramp`, `landed` never set, and `landed` never reset with the
  browser life.
- **AND `tsconfig.worker.json` CAUGHT WHAT THE TESTS COULD NOT**: a duplicate
  `MEM_DUMP_TIMEOUT_MS` import the suite ran through happily. Second time in two days that the
  worker config has been the thing that noticed.
- ~~**BOT-SIDE, so it is inert until the box updates.**~~ **MERGED AS #300 AND ON THE BOX
  (`9641e14`, 2026-09-08 16:2x UTC, confirmed by `bot-ask git-status` and not by
  `autocart.bot_version`).** The worker deploy went green, the fleet came back 3/3 shards with
  a 2s heartbeat, and health read 17 of 19 with only the two documented-benign warns
  (`rc_session` dead between releases, `rc_login` standing down after the restart). Struck
  rather than deleted: "inert until the box updates" is exactly the sentence a later reader
  quotes as a task. **It now needs only a ramp** — they arrive every 5-28 h, or one can be
  ordered by the recipe above.

#### AND THE SAME RAMP MADE THE WALK THREE-FOR-THREE, AND THE BURST TWO-FOR-TWO
Free corroboration from the event that produced the miss above, and neither needs repeating
again.
- **THE WALK: 16,387 regions across 16,382 allocation bases, 32,778 MB, 16,380 READWRITE, 64
  sampled and all anonymous**, against a control of 5 regions / 4 bases with its file-backed
  positive control (`SortDefault.nls`) present as ever. Three walks, three browsers, three days.
  **EXCESS 36,223 MB against an OS commit gap of 39,736 MB** — the walk has named the 35 GB.
- **THE BURST'S FOURTH SIGHTING, AND ITS SECOND WITH STATUSES: 18,953 asks on
  `futurebookingstartsendsdates`, `no answer recorded`.** Zero 2xx, zero 401, zero `failed` —
  the fourth branch, now twice. And **0 in the last 120s on a browser 2 m old**, which is the
  recorded load-time-burst shape rather than a sustained loop.
- **DO NOT RE-LINK THE BURST TO THE LEAK.** This ramp carried both; 09-07 20:42 carried the same
  32 GB with a flat counter and 110 lifetime requests. Independent in both directions, five
  times over now.

### THE DUMP CAN NEVER ANSWER — A WEDGED RENDERER IS *PRESENT AND EMPTY* (2026-09-09)
Three instruments have hit the same wall on three different CDP calls, and the entries above
each recorded it as "the subject has gone quiet". **It is sharper than that, it was measured
off-box in under a minute, and it retires the instrument the last four sessions were building
toward.** `scripts/auto-cart-bot/dump-wedge-probe.mjs`, against a real Chromium, one arm per
browser:
```
control    ok=true ms=141   processes=5  rendererPid=4369
wedged     page.evaluate -> SILENT
  detailed   ms=15083  success:false  peersWithData=4  wedgedRenderer=0 allocator dump(s)
  background ms=15040  success:false  peersWithData=4  wedgedRenderer=0 allocator dump(s)
  light      ms=15076  success:false  peersWithData=4  wedgedRenderer=0 allocator dump(s)
```
- **CHROMIUM'S COORDINATOR HAS ITS OWN TIMEOUT (~15,050 ms, the same at all three levels).**
  When a child does not answer inside it the coordinator gives up, returns `success: false`,
  and **emits a process dump for that child anyway — carrying ZERO allocators.** No roots, no
  `shared_memory`, nothing, while its healthy peers contribute normally in the same trace.
- ~~**SO THE RENDERER IS NOT MISSING FROM THE DUMP. IT IS PRESENT AND EMPTY**, and our fold
  dropped a process with no allocator dumps, which is why it read as absent.~~ **TRUE ON
  LINUX AND FALSE ON THE BOX — measured 2026-09-17 across all three post-fix ramp dumps:
  `emptyPids` is `[]` and the target is not in `MDPROC` at all, so on 149/Windows the
  coordinator omits the silent child rather than emitting an empty dump for it.** Struck
  rather than deleted because it is the sentence that made "our fold dropped it" the fix, and
  a reader looking for a present-but-empty process on the box will not find one. **The
  conclusion is untouched: there is no allocator data either way.** The reasoning still names
  the real hazard — that is the absent-reading-as-a-negative shape **handed over by the
  tooling**, and it is why 2026-09-08 21:43 was written up as a coordination fault worth
  chasing.
- **BOTH OBVIOUS FIXES ARE NOW PROVABLY WORTHLESS RATHER THAN MERELY COSTED.** A longer
  timeout buys an empty dump five seconds sooner; a cheaper level buys the same empty dump.
  **There is no allocator data to be had from a renderer that never emitted any.** The 08-18
  conclusion — *"the reading cannot be taken at the trip at all, and no timeout worth spending
  changes it"* — is now true for a stated reason rather than by induction over three calls.
- **AND THE "ASK IT EARLIER" IDEA IS CLOSED TOO, from the box's own log.** The 09-09 11:30
  bail printed `alloc trail [resident]: EMPTY — that renderer answered no CDP call at all`
  **for the whole 165-second browser life.** There is no healthy window to sample: it is quiet
  from birth. A dump trail would have predicted a ~0 reading, which is the rule saying do not
  build it.
- **FOUR EARLIER RUNS OF THIS PROBE WERE ALL ARTIFACTS, AND THAT IS THE METHOD LESSON.** Three
  said *"no level answers"* — because a previous arm had left tracing started, so every level
  failed at `Tracing.start` in two milliseconds and the sweep reported a verdict having asked
  **nothing**. One said *"background works"* — because a timed-out `detailed` arm's late data
  arrived during the `background` arm and was counted as its own. **Each was one sentence from
  being written up.** The arms run one per browser now, `startFailed` refuses a sweep that
  never asked, and the score is the allocator COUNT rather than the pid's presence — because
  presence is exactly what an empty dump has.

#### AND THE PEERS ANSWERED, WHICH IS A FREE READING NOBODY HAD TAKEN
The 09-08 21:43 dump is `partial` and **seven processes DID contribute**. Joined against the
same event's walk, every one is in its `CHROME` list — same generation — and the only absentees
are pid 7644 (the ramping renderer) and crashpad, which never participates.
```
GPU process 6864:  handles=601   privateMB=82   shm=2MB   gpu/transfer_memory 1MB count=7
browser     9472:  handles=1197  privateMB=115  shm=5MB
TARGET      7644:  handles=17306 privateMB=4366 commit/mapped 32,849MB across 16,535
```
- **NO PEER HOLDS THE 32 GB.** A registered GPU transfer buffer is mapped in the SERVICE as
  well as the client, so 16.4k of them would put ~32 GB and ~16k handles in the GPU process.
  It holds **2 MB across 25 mappings and 601 handles** — *lower* than a healthy baseline's
  `gpu/transfer_memory 6MB count=14`.
- **DO NOT PROMOTE THAT TO "THE GPU CANDIDATE IS REFUTED", AND I NEARLY DID.** The failure
  mode of the same hypothesis predicts exactly this: buffers created client-side whose
  registration never reaches a service that is not pumping its channel would be mapped in the
  renderer alone. The reading is **"these sections are mapped in exactly one process"** — which
  is a real narrowing and is not a verdict on the creator.

#### SO THE READING MUST COME FROM OUTSIDE THE PROCESS — TWO ADDITIONS TO THE WALK
The region walk is the one instrument that needs nothing from the renderer, and both additions
ride data it already has. **Predicted readings stated before building, per the 09-08 rule; on
the known 9 GB event neither is ~0.**
- **`VMTHREAD` — SPINNING OR BLOCKED, which nothing has ever measured.** Two CPU snapshots
  1.2 s apart, per thread, with the main thread identified by `StartTime`. One thread holding
  the window is a spin — and `main=True` says it is on the renderer's main thread, which is
  also *why* it answers no CDP call. **No thread burning CPU means it is BLOCKED, not looping**,
  and `wait=` names what on: that would put the cause in an IPC peer rather than an allocation
  loop, and it is a completely different investigation.
  **NO P/INVOKE, DELIBERATELY.** `GetThreadDescription` would give the thread NAME
  (`CrRendererMain`) and needs three more DllImports in a C# blob **no dev container can test**
  — and PowerShell parses the WHOLE script before executing any of it, so a syntax error there
  would cost the region walk too. `StartTime` identifies the main thread for free.
- **`VMSPAN` — where the 2-4M population sits.** Packed into a span about its own size means
  consecutive sub-allocations of ONE reservation (a cage, a pool, a sandbox — and `VMTOP` in
  the same scan names which); orders of magnitude larger means 16k mappings taken from wherever
  the allocator landed, which is ordinary shared memory. **Free: `AllocationBase` is already in
  the `MEMORY_BASIC_INFORMATION` the walk reads.**
- **THE PARSE RISK IS REAL AND IS GUARDED MECHANICALLY.** There is no PowerShell in the dev
  container, so the script cannot be run at all; `worker/ramp-scan.test.mts` now checks the
  JOINED script for balanced braces, parens and brackets **outside single-quoted strings**, no
  literal double quote, and no unterminated string. That is the strongest check available
  without an interpreter, and it converts an untestable risk into a testable one.

#### THREE DEFECTS IN THE DUMP ITSELF, ALL FOUND BY RUNNING SOMETHING
- **`Tracing.end` DOES NOT STOP TRACING.** It returns before the browser is done; the browser
  is done at `Tracing.tracingComplete`. Both the `finally` and the first version of the
  stuck-state recovery sent `end` and moved on, so the NEXT `Tracing.start` was refused — which
  is the mini-PC's `Tracing was stopped before start has been completed` at **11:29:54 on
  2026-09-09, which cost that ramp its dump**, and the container's `Tracing has already been
  started`. `stopTracing` waits, bounded.
- **AND THE FIRST VERSION OF THAT FIX AWAITED THE SEND BARE**, which pins the caller against a
  browser that never answers it. **Caught immediately by this module's own pre-existing
  "a hung teardown cannot pin the caller" guard** — the send is inside the deadline now.
- **`started_tracing` WENT UP AFTER THE SEND.** The outer race can fire while that await is
  pending, so a start that took effect left tracing running with the `finally` believing there
  was nothing to stop — which is precisely the state the next dump reports as *stopped before
  start*. It goes up before the send; `stopTracing` already tolerates never having started.
- **AND THE EMPTY-PROCESS FIX NEEDED ITS OWN GUARD OR IT WOULD HAVE READ AS SUCCESS.**
  Recording the timed-out renderer means it is now IN `dumpPids`, so `dumpJoinReading` would
  have returned `joined` — flipping every future ramp dump from VOID to a verdict that reads
  like an answer. `cause: 'target-empty'` keeps it `void`, and says the shared_memory figure is
  not small but ABSENT.
  - **IT HAS NEVER FIRED, AND THAT IS NOT A DEFECT — KEEP IT.** Windows omits the silent child
    entirely (measured 2026-09-17, `emptyPids` `[]` on all three post-fix ramp dumps), so the
    production cause is always `target-silent` by absence. The branch is the guard against a
    reading Linux genuinely produces, and deleting it on the strength of never having fired is
    how the flip-to-`joined` regression gets reintroduced by somebody tidying up.

#### AND THE 32 GiB IS A CEILING, NOT A RUNAWAY — 2^14 EXACTLY
Eight walks, and the 2-4M population barely moves: **15,499 / 15,663 / 16,219 / 16,385 /
16,386 / 16,386 / 16,387 / 16,387** regions. `16,384 x 2 MiB = 32,768 MiB = exactly 32 GiB`,
and the totals sit just above it (32,773-32,779 MB).
- **Something fills a 32 GiB budget in 2 MiB units and then stops.** A process killed at a
  random point in unbounded growth does not land within 0.02% of the same count three times.
  ~~The three lower readings are consistent with the walk catching a fill in progress.~~
  **WITHDRAWN — they are the COMMIT-LIMITED ones**, and the withdrawal is in "THE BURST RUNS
  UNTIL THE BOX SAYS NO" below. Struck here rather than left to a reader who never reaches that
  section: a correction further down is not a correction to somebody reading this one.
- **Recorded as an observation, not a mechanism.** What it does is make "what has a 32 GiB
  ceiling?" a sharper question than "what leaks?", and `VMSPAN` is the cheap next fact about it.

##### AND EVERY COUNT ABOVE IS THE WRONG COLUMN — THE MAPPED POPULATION STOPS *BELOW* 2^14 (2026-09-10)
`VMMAP2M`'s own header says the bounds are the histogram's `d 2-4M` bucket **exactly**, so
"`VMMAP2M regions` and `VMHIST d` are one population and a reader can diff them". **Diffed, for
the first time, across all sixteen stored `ramp-scan` rows: they are NOT one population, and the
number this file has been quoting is the larger one.**
```
when (UTC)         pid    VMHIST d   VMMAP2M   bases    diff   vs 2^14
2026-09-08 14:47   9944     16387     16383    16382      4       -1
2026-09-09 04:45   7644     16385     16381    16381      4       -3
2026-09-09 08:59  10524     16386     16382    16382      4       -2
2026-09-09 11:30   8956     16386     16382    16382      4       -2
2026-09-09 13:47  10604     16387     16383    16382      4       -1
2026-09-10 05:52  13332     16385     16381    16381      4       -3
       control    11772         7         4        4      3
```
- **READ IN SOURCE, NOT INFERRED: `VMMAP2M` counts `MEM_MAPPED` (262144) ONLY**
  (`ramp-scan.mjs`, the comment above the band test), while `VMHIST d` counts **every committed
  region** in the size band whatever its Type. So the gap is committed 2-4M regions that are
  private or image — a **near-constant 4-6 on the target and 3 on the CONTROL**, i.e. a baseline
  property of any renderer rather than part of the ramp.
- **SO THE MAPPED POPULATION — THE LEAK'S ACTUAL POPULATION — IS 16,381-16,383, NEVER 16,384 AND
  NEVER ABOVE IT.** Six walks, all 1 to 3 SHORT, on the six events that reached the cluster.
- **AND THE FOUR LOWER ROWS ARE *NOT* ALL COMMIT-LIMITED — I NEARLY WROTE THAT THEY WERE.**
  Mapped counts 13,320 / 14,321 / **15,494** / **16,213**. "THE BURST RUNS UNTIL THE BOX SAYS NO"
  attributes the two lowest to commit exhaustion and I carried that across to all four without
  checking. **Its own table refutes it for the third:** it marks the 15,499 event
  `CAP (1,344 spare)` — i.e. NOT commit-limited — while that event stopped **885 short** of the
  cap, and 16,213 stopped **171 short** with headroom too. So that table's summary line, *"it
  stopped at 16,384 ± 3"*, is true of nine rows and false of the one it labels `CAP` at 15,499.
  **A middle population exists that neither constraint explains, and this reading does not settle
  it** — the walk fires ~77 s after the burst, so "caught mid-fill" is available but not
  established. Recorded as an open wrinkle, which is what it is.
- **THAT REVERSES THE SENTENCE ABOVE, and the direction is the whole value.** "The totals sit
  just above it (32,773-32,779 MB)" is an artifact of counting those 4-6 non-mapped regions:
  16,381 x 2 MiB is 32,762 MB, and the extra ~12 MB is four regions of ~3 MB. **A count that
  approaches 2^14 from below and never reaches it is the signature of a hard maximum of 16,384;
  a count sitting slightly above invites "16,384 plus a few", which is a different search.**
  Criterion 4 gets sharper rather than weaker.
- **AND IT RECONCILES TWO ENTRIES THAT DISAGREED IN PRINT.** "THE 2^14 CAP IS THE ALLOCATOR'S"
  quotes **16,381-16,383** and labels its column `count (VMMAP2M)`; this section quotes
  **16,385-16,387** and labels its column nothing. Both read as "the count", they are four apart,
  and the labelled one was right. **Label the column or the next reader picks whichever number is
  nearer to hand.**
- **THE ALTERNATIVE IS NOT EXCLUDED AND IS STATED: the walk may race a few unmap/remaps.** Both
  fit 16,384 − (1..3). What the reading DOES exclude is the population ever exceeding 2^14, which
  is what the file has said for six entries.
- **`allocBases` still equals `regions`** (or is 1 short) on every row, so the one-base-per-region
  finding — N separate `MapViewOfFile` calls — is untouched.
- **THE COMMENT IN `ramp-scan.mjs` IS WHERE THE CONFLATION CAME FROM, AND IT IS HALF RIGHT.** It
  reads *"the bounds are the histogram's `d 2-4M` bucket EXACTLY, so `VMMAP2M regions` and
  `VMHIST … d 2-4M count` are the same population"*. The BOUNDS do match to the byte
  (`-ge 2097152 -and -le 4194304`); the POPULATIONS do not, because `VMMAP2M` carries
  `$mbi.Type -eq 262144` and the histogram is gated on `State -eq 4096` alone. **Same size band,
  one extra filter** — and CLAUDE.md inherited the claim from the comment rather than from the
  code.
- **DELIBERATELY NOT FIXED IN THE COMMENT, and the reason is recorded two sections up.** A
  prose-only edit under `scripts/auto-cart-bot/` moves `CH_BOT_CODE_AT`, so `autocart.bot_version`
  reports *"MISSING bot-side changes"* — and the honest reading of that warn is to update the box,
  **which ends the RC session**. A comment is not worth that. Corrected here instead; the next
  bot-side change that has a real reason to ship should carry the one-line fix with it.
- **THE METHOD NOTE: the file told a reader to diff two columns and nobody had.** Same shape as
  the paged-pool quota, which was one query away for as long. **When an entry says "a reader can
  diff them", that is a task, not a reassurance.**

#### TWO POPULATIONS OF RAMP, AND THE RECORDED DECOUPLING SURVIVES
Every `bail:ramp` paired with its own request counter splits perfectly in two:
```
young browser 135-195s, 16 distinct paths, burst 17k-75k   x7
old browser   85m / 125m, ~78 distinct paths, burst 4 / 9  x2
```
- **So "the ramp is always on a young browser" is FALSE** — which matters, because it was about
  to be the load-bearing premise of an early dump trail.
- **And the burst/leak decoupling HOLDS**: both populations reach the same ~16,386-region,
  ~32,776 MB signature, so the same 32 GiB arrives with and without a 17k-request burst. The
  two counter-examples the file already records are exactly the two old-browser ramps.

### VMTHREAD ANSWERED ON ITS FIRST RAMP: THE MAIN THREAD IS SPINNING (2026-09-09)
#306 reached the box at some point before 06:47 PT (`bot-ask git-status` → `HEAD 45019ec on
master`) and the ramp forty minutes later exercised both new instruments. **Both answered, and
the first one turns "a ramping renderer answers no CDP call" from an observation into a
mechanism.**
```
>>> SPINNING on the MAIN thread: the busiest of 20 thread(s) burned 1203 ms of a 1200 ms
    window (100% of a core).
    tid=7876  main=True   cpuMs=121031  deltaMs=1203  state=Running  wait=-
    tid=2040  main=False  cpuMs=469     deltaMs=16    state=Wait     wait=UserRequest
  CONTROL (an ordinary renderer, same scan)
>>> BLOCKED, not spinning: across 15 thread(s) the busiest burned 0 ms of a 1200 ms window (0%).
    tid=9724  main=False  cpuMs=0  deltaMs=0  state=Wait  wait=EventPairLow
```
- **THE MAIN THREAD IS WHERE CDP IS SERVICED.** So `newCDPSession` (08-18),
  `Performance.getMetrics` (08-18/19) and `Tracing.requestMemoryDump` (09-08) did not fail for
  three unrelated reasons — **they failed for one, and it is now named.** The 08-18 conclusion
  (*"the reading cannot be taken at the trip at all, and no timeout worth spending changes
  it"*) was induction over three calls; it is now a statement about the dispatcher.
- **AND IT CLOSES "FIRE EARLIER" TOO, from the other side.** `alloc trail [resident]: EMPTY —
  that renderer answered no CDP call at all` over a whole 165 s browser life said the renderer
  is quiet from birth; this says what it is doing instead. **There is no window in which it is
  both holding the sections and answering.**
- **THE CONTROL IS WHAT MAKES IT A READING.** An ordinary renderer in the same scan burns
  **0 ms of the same 1200 ms window** and sits on `EventPairLow`. Without it, "a busy renderer"
  would be unremarkable.
- **`cpuMs=121031` IS LIFETIME AND IS NOT A DURATION OF THE SPIN.** Do not quote it as "the
  thread has been spinning for two minutes" — it is the thread's total CPU since it started,
  and the sampler's own window (`deltaMs=1203` of 1200) is the only rate here.

**VMSPAN ANSWERED TOO — SCATTERED, NOT PACKED.** 16,383 regions totalling 32,766 MB spread over
a **132,797,914 MB span (4053x)**, so each was taken from wherever the allocator landed rather
than carved from one reservation. **That eliminates the cage/pool/sandbox branch** the
instrument was built to separate.
- **THE VERDICT WORD DOES NOT DISCRIMINATE AND THE NUMBERS DO.** The control prints `SCATTERED`
  as well — 4 regions over an even larger span — because any handful of regions is scattered by
  construction. **The discriminating fact is the one `VMMAP2M` reports separately: 16,383
  regions across 16,382 allocation bases**, i.e. N separate `MapViewOfFile` calls. Read that
  line, not the adjective. (Recorded rather than "fixed": a share gate on a 4-region control is
  a threshold nobody has evidence for, and the raw counts are already unambiguous.)

**SO THE CANDIDATE IS SHARPER AND IS STILL A CANDIDATE.** Everything now measured fits
`MappedMemoryManager`: `gpu::SharedMemoryLimits::mapped_memory_chunk_size` is **2,097,152
bytes** against a 2-4M bucket of 32,778 MB / 16,387 = 2.0000 MB; one shared region per chunk, in
the renderer, anonymous and READWRITE; the JS heap flat at 8-11 MB so it is not JS retention;
and RC's page runs a **WebGL ArcGIS map**, whose client lives on the main thread. Its
`FreeUnused()` reclaims only blocks **whose tokens have passed**, and a main thread that never
returns to its message loop is a main thread whose tokens cannot advance — so every allocation
takes a fresh chunk and nothing is ever reclaimed. **That is a story that fits every reading and
it has not been tested.** Three mechanisms have been guessed on this leak and each cost a
session.

**THE CHEAP NEXT READING NEEDS NO NEW INSTRUMENT: point VMTHREAD at the GPU PROCESS of the same
family.** It runs on TARGET and CONTROL today. **Renderer main thread spinning while the GPU
process is idle is the client-allocates-service-never-drains shape**, which confirms the
candidate from outside without asking Chromium anything; a GPU process that is also busy is a
different investigation. The same scan's `CHROME` lines already lean that way and are not a
thread census — `gpu-process pid=15260 privateMB=82 handles=609` against the target's
`privateMB=3325 handles=18119` — so this is a formality to take rather than a question to argue.
**A stack of tid 7876 would name it outright and is the expensive route**: it needs ETW with
symbols for `chrome.dll`, which the box does not have.

#### AND ALL THREE OF TODAY'S RAMPS WERE TOO SHORT TO ATTEMPT A DUMP (2026-09-09)
```
01:57  rc   960 MB -> 01:59  3,870 MB   pid 10524   commit 23,406 -> 44,960
04:27  rc 1,244 MB -> 04:29  3,976 MB   pid  8956   commit 31,809 -> 46,711
06:46  rc 1,924 MB -> 06:48  4,040 MB   pid 10604   commit 44,847 -> 47,080
06:50  rc   204 MB               pid 11604   commit 6,836        <- replaced
```
- **PEAK IS DOWN AND DURATION IS DOWN** — ~2-4 minutes and 3.9-4.0 GB, against 8-9 GB over
  10-12 minutes on 09-02..09-08. **Not a cure and creditable to nothing**: three ramps is not a
  regime, and every "not reproduced this session" reading in this file was a window that
  happened to miss one. The 32 GB mapping is fully present at 3.5 GB of private bytes, exactly
  as recorded — the mapping arrives in one step and the private bytes are the pages being
  touched, so a shorter ramp is a shorter *touching*, not a smaller mapping.
- **NO RAMP DUMP FIRED ON ANY OF THEM, AND THE REASON IS ARITHMETIC, NOT A REGRESSION.**
  `MEM_DUMP_STALL_MS` is 90 s and today's renewal trips completed in **46,903 ms and 47,516 ms**
  — so the loop never stalled 90 s and the trigger correctly never fired. The 09-08 21:43 dump
  fired only because *that* trip never completed at all: the bail killed it, and the stall grew
  past 90 and then past 120.
- **SO THE DUMP IS DOUBLY BLOCKED, and the two blocks are independent.** A ramp that resolves
  inside 90 s of stall never attempts one; a ramp that stalls past 90 s has a renderer that will
  not answer. **Do not read "no ramp dump" as the trigger regressing** — read the trip durations
  in `TAB CLOSES` first.
- **DO NOT LOWER `MEM_DUMP_STALL_MS` ON THIS.** There is genuine headroom (90 s against today's
  46-48 s trips and a 71,552 ms worst case over 133 closes), so the change would fire on more
  ramps — **and every one of them would return an empty dump**, because the coordinator's
  ~15,050 ms timeout and the spinning main thread are what stop it, not the trigger. It spends
  the discrimination 90 s was measured for and buys nothing.

#### THE CENSUS TAKES THE GPU PROCESS NOW (2026-09-09) — ON THE BOX, awaiting one ramp
The section above names the cheap next reading and this is it. `$tthreads` is `$targets` plus
the **GPU process of the target's own browser generation**, and the census loops iterate it.
**The WALK deliberately keeps `$targets`**: a third `VirtualQueryEx` sweep costs csc.exe plus a
full walk inside the 90-second budget, and the 09-08 dump already reported the GPU process
holding **2 MB across 25 mappings** — it does not hold the 32 GB, and that question is answered.
The census is the cheap half, because **one `Start-Sleep` is shared by every subject**: a third
process costs two thread enumerations and no extra wall clock.

- **PREDICTED READING, STATED BEFORE IT WAS WRITTEN, and it is not the ~0 the rule forbids.** On
  the known event the GPU process reads `privateMB=82 handles=609` against the target's
  `3325 / 18119`, so the prediction is **BLOCKED — a busiest thread near 0 ms of the 1200 ms
  window.** Zero is the INFORMATIVE answer here rather than a blind one, exactly as the control
  renderer's 0 ms is what made the target's 1203 ms mean anything. The other branch — a GPU
  process also burning CPU — is a different investigation with a different fix. **Both words are
  findings, which is the test that rule actually applies.**
- **MATCHED ON PARENT, NEVER ON SIZE — AND THE HAZARD IS REAL ON THIS VERY EVENT.** `$ours` spans
  BOTH profile families, and the 06:47 scan's own `CHROME` lines carry **two gpu-processes: `rc`
  at 82 MB and `recgov` at 23 MB**, live at the same instant. A largest-first pick happens to get
  the right one there, and that is luck of size rather than a discriminator — the rec.gov
  keepalive opens its own browser twice per 30 minutes, so which sizes are present is not
  something to rest a reading on. Reporting a DIFFERENT browser's idle GPU process as this one's
  is a **false confirmation of the leading hypothesis**, the most expensive kind of wrong.
- **AND NEVER THE TARGET ITSELF.** If the largest process by private bytes were ever the GPU
  process, a sibling match on `PPid` matches it, `$tthreads` carries it twice, and the readout
  pairs a process with a second copy of itself — reporting a spinning client beside an idle
  service where there is **one process**. Found by writing the match and then reading it, not by
  a test.
- **NO MATCH REPORTS ITSELF.** The parent relationship is an assumption (Chromium spawns its
  children from the browser process on Windows), and it is one this repo cannot verify from
  here — the stored `CHROME` lines carry no `ParentProcessId`. **The failure direction is what
  makes that acceptable:** a wrong assumption yields `gpu-process not found in the target browser
  generation`, i.e. an absence, never a confident reading about the wrong process.
- **THE VERDICT REFUSES TO CLAIM PROOF, AND THAT IS PINNED.** `servicePairReading` prints
  *"CONSISTENT WITH, NOT PROOF"* on the idle branch and says why in the same breath: **an idle
  service is also exactly what you see if nothing was ever sent to it**, and the same
  hypothesis's failure mode predicts an idle GPU either way. A mutation deleting that caveat, and
  one making the busy branch render as the idle one, are both caught.
- **AN ABSENT CENSUS IS AN ABSENCE.** No GPU line must never render as an idle service — that is
  the one sentence away from a confirmation this whole instrument could manufacture. A scan that
  LOOKED and found nothing carries its own sentence into the verdict, because *"we could not
  look"* and *"the service was idle"* point in opposite directions.
- **RENDERED, OR IT WOULD HAVE BEEN INERT.** The GPU process is not walked, so nothing in the
  readout's per-pid loop would ever have printed it — the fix-present-and-inert shape, for the
  eighth time. The render and the pairing are both pinned as line-initial statements.
- **AN EXISTING GUARD WAS RE-ANCHORED, NOT RELAXED.** `printVerdict('      ', busyThreadReading({`
  was pinned by exact expression; the verdict is assigned now so its KIND can be paired, so the
  guard pins the assignment AND the render, both line-initial so `void 0 && …` and `if (false) …`
  still fail it. Verified failing against a computed-but-never-printed verdict.
- **`src/lib/leak-capture.test.mts`, 14 mutations, each asserted to APPLY and each caught.**
  Guards under `src/` and `scripts/`, **not `worker/`** — checked against `worker-deploy.yml`'s
  `paths:` rather than remembered, so **this fires no worker deploy.**
- **THE ABSENT BRANCH IS WHAT RENDERS TODAY, and that is the expected state.** Verified by
  running the real readout against the real corpus: *"no GPU-process reading in this scan — the
  box predates the GPU census … That is an ABSENCE, not a reading."* **Bot-side, so it needs a
  box update and then one ramp.** **APPLIED 2026-09-09 17:17 UTC in 23 seconds (`updated and
  verified`, `2f006b7`), confirmed by the box's own `git rev-parse HEAD` through `bot-ask
  git-status` and NOT by `autocart.bot_version`** — which COALESCEs and can show a stale sha
  beside a live heartbeat. Health 19 of 19 afterwards, 3/3 shards, and the RC session survived
  with a fresh 58-minute token. **So only a ramp is outstanding**, and the three scans taken
  before 17:17 still print the absent verdict, correctly — **read the scan's own timestamp
  before treating an absence as a fault.**
- **I NEARLY RECORDED A FABRICATED FACT OUT OF MY OWN INSTRUMENT.** A first pass at counting the
  processes used an `awk` range whose end pattern did not match, so it ran to EOF and merged all
  three scans — reading as **three rc browsers and four gpu-processes simultaneously**, which
  would have been written up as a finding about the box. Segmenting on the scan headers gives
  **two browsers and two gpu-processes** in the 06:47 event. Same shape as the 08-14 reconstructed
  log buffer: **evidence assembled by a tool needs its own audit before it is quoted.**
- **AN OBSERVATION IN PASSING, NOT ACTED ON:** in the 06:47 scan the walk's CONTROL renderer was
  `pid=5116 fam=recgov` — an ordinary renderer, so the comparison stands, but it came from the
  rec.gov browser rather than the rc one. `$ctl` takes the smallest renderer regardless of
  family. Recorded rather than changed; it does not affect the excess, which is what that control
  exists to produce.

#### THE GPU CENSUS ANSWERED THREE MINUTES AFTER IT REACHED THE BOX (2026-09-09 10:19 PT)
The entry above ships the census and says it "needs a box update and then one ramp". **It got
both the same morning, and the reading is in.** The box applied `2f006b7` at 17:17 UTC and a
natural ramp arrived at **17:19:40 UTC (10:19:40 PT)** — under three minutes later:
```
TARGET  pid=11588 renderer privateMB=2981  committed 29967 MB  mapped 26728 MB
        2-4M 26655 MB across 13325 region(s), 13319 allocation bases, ALL ANONYMOUS
        >>> SPINNING on the MAIN thread: tid=7128 main=True deltaMs=1203 of 1200 (100% of a core)
CONTROL pid=768   renderer privateMB=17    committed 406 MB
        >>> BLOCKED, not spinning: busiest burned 0 ms of the same window (0%)
GPU     pid=7044  gpu-process threads=21 busyMs=0
        >>> BLOCKED, not spinning: busiest burned 0 ms of the same window (0%)
```
- **THE PREDICTED READING WAS RIGHT AND IT IS THE INFORMATIVE BRANCH.** The census entry above
  predicted BLOCKED and said the other branch would be a different investigation. The GPU
  process reads **0 ms across 21 threads** beside a renderer at 100% of a core — the
  client-allocates-service-never-drains shape, and what `MappedMemoryManager` predicts.
- **THE VERDICT SAYS `CONSISTENT WITH, NOT PROOF` IN ITS OWN WORDS, AND THAT WORDING IS DOING
  REAL WORK.** An idle service is also exactly what you see if nothing was ever sent to it, and
  the same hypothesis's failure mode predicts an idle GPU either way. **Do not quote this as a
  confirmation.** What it did was fail to refute: the branch that would have argued against the
  candidate — a GPU process also burning CPU — did not fire.
- **AND A FOURTH READING RIDES ALONG FOR FREE, from the same scan's baseline dump: on a HEALTHY
  browser the biggest shared-memory owner is `gpu/command_buffer_memory — 2 MB across 2
  mapping(s)`.** That is `MappedMemoryManager`'s own allocator, at one or two chunks, with
  `mapped_memory_chunk_size` = 2,097,152 bytes. The ramping renderer holds 13,320 mappings of
  the same size. Same allocator name, same unit, ~6,600x the count. **Still a candidate**, and
  still not a creator — the dump cannot attribute the ramping renderer's mappings, because that
  renderer contributes zero allocator dumps.
- **BOTH DOCS SAID THE READING WAS STILL OUTSTANDING FOR HALF A DAY.** `#310` was committed at
  **10:47 PT** under the title *"only a ramp is outstanding"* — twenty-eight minutes AFTER the
  ramp that answered it. The stale-handover shape, in the commit written to prevent it.

### THE SPINNING THREAD IS SAMPLED NOW (2026-09-09) — VMSTACK, built, awaiting a box update
The census named the SYMPTOM and stopped one step short of the cause. `VMSTACK` takes the step:
it samples the spinning thread's **instruction pointer** from outside the process and classifies
each address against the renderer's loaded modules.
- **IT IS THE ONLY ROUTE LEFT, AND THAT IS NOW A STATEMENT ABOUT THE DISPATCHER RATHER THAN AN
  INDUCTION OVER THREE FAILURES.** CDP is serviced on the main thread, so a main thread that
  never returns to its message loop answers no CDP call — which is why `newCDPSession`,
  `Performance.getMetrics` and `Tracing.requestMemoryDump` all failed. Nothing that asks the
  renderer can work. `SuspendThread`/`GetThreadContext` asks WINDOWS.
- **TWO ANSWERS, OPPOSITE FIXES, AND NOTHING HAS EVER SEPARATED THEM.** Samples inside a loaded
  image are a NATIVE loop, and `chrome.dll+0xOFFSET` is fixed for a build — the scan reports
  chrome.dll's version beside it, so it symbolizes offline and names the function; the fix is
  then Chromium-level. Samples on executable pages belonging to no image are **JIT-compiled
  code**, i.e. RC's own page script is the loop, and the fix is on our side of the page with no
  Chromium change at all. **A third outcome is also a reading**: samples spread over hundreds of
  addresses would mean this is not a tight loop and the `MappedMemoryManager` story would need
  re-examining.
- **IT REFUSES BEFORE IT NAMES EITHER, AND THAT GUARD IS THE POINT.** `Rip` sits at byte **248**
  of the x64 CONTEXT because that struct carries SIX debug registers and not eight. Misremember
  it and the read returns `Rbp` or `R15` — a stack or data pointer, which belongs to no module
  and would render as **JIT-compiled JavaScript**: a plausible answer, for the wrong reason,
  pointing the next session at the wrong half of the system. So every address is asked whether
  its page is EXECUTABLE (protect mask 240), **on an axis kept independent of the module check**
  so that a bad offset landing in chrome.dll's *data* still shows up, and a reading whose
  non-executable samples dominate is REFUSED rather than explained.
- **THE SUSPEND IS BOUNDED BY WHAT IS BEING SUSPENDED.** The thread is, by the census's own
  reading, in a loop that never returns to its message loop — already doing nothing the product
  needs, so pausing it for microseconds cannot make the page less responsive than the spin
  already has. The resume is in a C# `finally` **inside one method**, so PowerShell cannot be
  interrupted between the two; the handle asks for `THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT`
  and nothing wider; and `bail:ramp` fired **3-35 s** after every one of the five ramps on
  09-09, so even a leaked suspend is bounded by a browser being destroyed anyway. It never
  touches the browser process, the GPU process or the control — the gate is `$tp.Ty -eq
  'renderer'` on the TARGET only.
- **A SECOND `Add-Type` UNDER A SECOND FLAG, WHICH IS WHAT MAKES IT SAFE TO ADD AT ALL.**
  `VMTHREAD`'s header records the standing decision against P/Invoke here: PowerShell parses the
  WHOLE script before running any of it, so a fault costs the region walk — the one instrument
  that still works. `ChThr` compiles separately, after `ChMem`, gated on its own `$stkOk`, and
  emits last. A C# failure costs this instrument only.
- **NOT `ReadProcessMemory` AND NOT A MINIDUMP.** Those are banned because they COPY the
  process's memory — the cure arriving as the disease, and a renderer's pages are RC session
  material. This collects a REGISTER and the name of the module it falls inside. No page is
  ever read, and neither a code address nor a DLL name can carry a token.
- `src/lib/leak-capture.test.mts`, **21 mutations, each verified to APPLY and each caught.**
  **One survived the first round and it is the house shape**: the guard on the readout's render
  matched `/VMSTACKTOP/`, which also occurs on the line that FILTERS for it — so it passed
  against a render replaced by `void stkTops`. Re-anchored on the `console.log`. And one guard
  failed at baseline for the mirror-image reason: it scanned the whole FILE for
  `ReadProcessMemory`, which the comments NAME in order to explain why they are not used, so it
  failed on its own explanation. Both now assert against the EMITTED PowerShell.
- **GUARDS UNDER `src/` AND `scripts/`, WHICH ARE IN NEITHER OF `worker-deploy.yml`'s `paths:`
  LISTS** — read, not remembered — **so this fires no worker deploy.**
- **BOT-SIDE, so it is inert until the box updates**, then it needs one ramp. Confirm with
  `npx tsx scripts/bot-ask.mts git-status`, **never `autocart.bot_version`**.

#### RAMPS ARE ARRIVING EVERY 2.3-4.2 HOURS, NOT EVERY 5-28 (2026-09-09)
Five in 12.5 hours, off `bot_events` rather than the memory series: **04:45, 08:59, 11:30,
13:47, 17:19 UTC**, gaps of 4h14m, 2h31m, 2h17m, 3h32m. Every entry in this file quoting 5-28 h
is describing a quieter regime.
- **`bail:ramp` FIRED ON ALL FIVE, 3-35 SECONDS AFTER THE SCAN.** That is the containment
  working, and it is also what bounds every risk taken inside a ramp scan.
- **NO `ramp` MEMORY DUMP FIRED ON ANY OF THEM, AND THAT IS ARITHMETIC.** The renewal trips in
  `TAB CLOSES` ran **46.7-59.1 s** against `MEM_DUMP_STALL_MS` of 90 s, so the stall trigger
  correctly never fired. **Read the trip durations before reading "no ramp dump" as a
  regression**, and do not lower the threshold — a wedged renderer contributes zero allocator
  dumps anyway.

##### AND "EVERY 2.3-4.2 HOURS" HAS THE SAME DEFECT AS THE FIGURE IT CORRECTED (2026-09-10)
The heading above was written off a twelve-hour window, and a four-day recount says it was a
BUSY DAY rather than a cadence — which is precisely what it accused "5-28 h" of being. Eleven
onsets over four days (a sample crossing 1,500 MB whose predecessor was under it), natural gaps
only:

    18.6h · 5.4h · 5.7h · 13.9h · 4.3h · 2.5h · 2.3h · 3.5h · 11.1h

- **THE RANGE IS 2.3h TO 18.6h WITH A MEDIAN NEAR 5.4h**, and the 09-09 cluster (4.3 / 2.5 / 2.3
  / 3.5) is the tight run the entry above generalised from. **Quote the range, not either
  headline** — this file has now produced two confident cadences from two windows and both were
  the window rather than the leak.
- **THE 1.4h GAP IS OURS AND IS EXCLUDED.** 2026-09-10 05:51 is the FORCED restart-rc ramp of the
  GPU trial, so counting it would put our own experiment into a natural-cadence figure.
- **THE COUNT DEPENDS ON THE BAR, and that is worth saying rather than hiding.** At 1,500 MB
  (`MEM_DUMP_RAMP_MB`) eleven onsets qualify, two of which peak at 1,688 and 1,924 MB — real
  against a 200-330 MB baseline, but far short of the 8-9 GB events the earlier entries describe.
  A count at 3,000 MB (the bail's bar) is a smaller number about a different population.
- **WHAT IT CHANGES: waiting for a ramp is not reliably an afternoon.** A session that arms an
  instrument and plans to read it "in a few hours" should expect that to be true about half the
  time. That is the argument for the forcing recipe existing at all — and not for using it, which
  costs a password submission from an address that has eaten a twelve-hour block.

###### AND THE RANGE IS A MIXTURE OF TWO POPULATIONS WITH DIFFERENT CADENCES (2026-09-17)
Both corrections above are about the WINDOW. This one is about the POPULATION, and it does not
fix itself with a longer window. `bail:ramp`'s own `request-counts` splits every ramp cleanly —
`distinct=16` is the young/cold-load BURST shape, `distinct=76-79` the old-browser one — and
**they have completely different cadences**, computed over the whole corpus:
```
BURST (young, cold RC load)   18 ramps   gaps 1.4h – 37.8h    current gap 46.5h  << OUTSIDE
OLD browser                    8 ramps   gaps 11.6h – 62.2h   current gap 27.7h  (inside)
```
- **SO "2.3-18.6h" IS DOMINATED BY THE BURST POPULATION, which fires 2-3x as often.** Judging a
  single population's gap against it is comparing one thing to a mixture of two. **On 2026-09-17
  a 27.7-hour gap read as "outside the recorded range" and as a possible regime change; split, it
  is squarely inside the surviving population's own range and needs no explanation at all.**
- **WHAT IS GENUINELY ABSENT IS THE BURST POPULATION — 46.5h against a max of 37.8h**, and it has
  been noted since its last appearance on 2026-09-15 09:04. That is 69% of all ramps gone, which
  by itself predicts a ~3x longer POOLED gap — so the pooled figure is not merely a mixture, it
  is a mixture whose weights have moved.
- **AND IT DISSOLVES AN APPARENT ANOMALY IN THE PER-TRIP RATE.** 52 Okta trips since the last
  ramp with none ramping is a **1.1%** outcome at the recorded "at most 1 in 12" — which reads as
  something having changed. **The bound pools the same two populations**, and the burst one is
  enriched by browser REPLACEMENT rather than by trips (the 8x association, and `restart-rc` being
  a forcing lever at all), so the per-trip rate for the surviving population is lower by roughly
  the population split — **around 1 in 37, where 52 clean trips is a 24% outcome.** Unremarkable.
  **Do not quote 1-in-12 as a per-trip rate for a specific population**; it is an upper bound over
  a mixture, and the file already labels it a bound "in a known direction".
- **THE CONSEQUENCE FOR THE CURE'S PROOF IS THE SHARP PART.** The wedge the cure needs arrives
  with a ramp, the burst population is the commoner source, and its shape is a COLD RC page load
  in a fresh browser — which is what `restart-rc` and a box update produce. **So while forcing is
  held, the proof waits on the population whose gaps run 11.6-62.2 hours.** That is the honest
  expected wait, not "a few hours".

###### AND `bot_events` GOES SILENT FOR HOURS WHEN THE SESSION IS HEALTHY (2026-09-10 21:53 UTC)
Checked for a new ramp and found something better: **the whole event stream had stopped, and that
is the good regime.** Last event of ANY kind **19:31:28**, against a `tab-close` every ~31 minutes
for the six hours before it — **two hours and twenty-two minutes of complete silence.**
```
14:08 · 14:39 · 15:11 · 15:42 · 16:14 · 16:45 · 16:57   tab-close label=renewal  tripMs ~68-69s
17:53 ramp-scan · 17:55 tab-close · 18:06 tab-close
19:17 ramp-scan · 19:18 mem-dump · 19:19 request-counts · 19:20 tab-close · 19:31 tab-close
   [ nothing, for 2h22m ]
21:51:31  session_ok · token exp in 39m · renewed=no · src=live · okta=ALIVE   (beat 2s ago)
```
- **`session_live_since` IS THE PROOF, AND IT IS A TIMESTAMPED TRANSITION RATHER THAN A LOG
  READING.** It reads **20:32:09** — migration 047's column, which moves only when the verdict
  CHANGES — against a last renewal trip ending **19:31:28**, exactly one token lifetime earlier.
  So the session went dead when that token lapsed and **came back an hour later with no renewal
  in between.** RC's SPA re-minted it silently. That is the 2026-08-18 self-renewal finding
  reproduced with better evidence than the original, which rested on reading `♻` lines.
- **AND IT HAS RE-MINTED AT LEAST TWICE.** A 60-minute token with 39m left at 21:51:31 was issued
  ~21:30 — after the 20:32 one had lapsed — while `session_live_since` did NOT move again, because
  the verdict never changed. Two silent mints, zero renewals.
- **THE MECHANISM IS THE STAND-DOWN FEEDING ITSELF.** `planRenewal` stands down while the token is
  alive AT ALL, so one silent re-mint removes the reason for our next renewal, which removes the
  next Okta trip, and the loop sustains. **Every renewal runs in a throwaway tab and every
  throwaway tab close emits `tab-close`** — read in source, not assumed: three call sites
  (`renewal`, `auto-login`, `warmup`), each passing `report: reportBotEvent`, and the close sits
  in a **`finally`**, so a thrown renewal still reports. So no `tab-close` is not merely "no
  event", it is positive evidence that no trip ran.
  - **THE ONE EXCEPTION, so this is not quoted as absolute: a process KILLED mid-trip runs no
    `finally` and emits nothing.** That is the bail path — and it is separable, because a bail
    emits its own `request-counts` and (past the threshold) a `ramp-scan`. Silence with no bail
    event either is a trip that never started; silence WITH one is a trip that never finished.
- **AND THAT IS THE TRAP: AN EMPTY `bot-events-readout` READS AS A DEAD BOX.** Every kind in that
  table is emitted by a keep-warm that is DOING something — a trip, a bail, a scan — so a keep-warm
  with nothing to do is indistinguishable from one that is wedged, from the readout alone. **The
  discriminator is one health read**: `autocart.rc_session` carries `checked Ns ago`, and
  `autocart.bot` carries the sampler's own beat. Both were seconds old here.
  **`chromium_memory_samples` keeps arriving either way** and cannot settle it — that series is
  posted by `bot.mjs`, a different process from `rc-keepwarm.mjs`, so it stays healthy through a
  dead keep-warm. It is what made the silence look alarming rather than reassuring.
- **THE NATURAL FLOOR IS ~1.4h, NOT 2.3h — WITH ONE CAVEAT THAT MATTERS.** The two onsets today
  are **17:52:52 and 19:16:56, 1h24m apart**, and the 16:58 forced warm-up between them produced
  no ramp. But **CLAUDE.md now records the 17:53 ramp's `auto-login` step entry as caused by a
  test fixture** (`npm test`'s phantom release), and whether that step NAVIGATED is not
  established — so one of the pair is of uncertain provenance. **Quote it as a floor candidate,
  not a measurement.** Third window, third number; the standing instruction to quote the range
  rather than a headline is what this reinforces.
- **STILL UNBROKEN AT 22:17 — 2h46m, RE-READ RATHER THAN ASSUMED.** The 2h22m above is what the
  first read saw; the newest `bot_events` row is still 19:31:28 three quarters of an hour later.
  **That is the regime holding, not a second finding**, and it is the same reading the overnight
  question wants — just not yet across a night.
- **NO RAMP IN THE 2.6h OF SILENCE, WHICH IS CONSISTENT AND IS NOT EVIDENCE.** No renewal means no
  Okta navigation means no trigger, which fits the ESTABLISHED finding — but 2.6h sits inside the
  ordinary range, so it discriminates nothing on its own. **The reading that would matter is the
  same pattern holding across an overnight**, which is what the 08-18 entry asked for and still
  nobody has.

###### `tab-close` GAPS READ `planRenewal` RETROSPECTIVELY — AND THE RENEWAL FAILS 96% OF THE TIME (2026-09-10)
Found while checking why the events above stopped, and the instrument matters more than the day.
**Each of `planRenewal`'s stand-down branches has its own cadence, and `bot_events` has recorded
every trip's wall clock since migration 075 — so the GAPS between consecutive `tab-close` rows say
which branch the schedule sat in, hours or days after the fact, with no log and nothing from the
box.** Nobody had ever read them.
```
floor    RENEW_FLOOR_MS      5m  |  backoff  RENEW_BACKOFF_GAP_MS  30m, after 3 failures
minGap   RENEW_MIN_GAP_MS   10m  |  alive    stands down for the token's ~60m life
```
- **FILTER TO `label = 'renewal'` FIRST, AND THAT IS NOT A DETAIL.** `tab-close` has three
  emitters — **198 `renewal`, 4 `warmup`, 1 `auto-login` of 203 rows** — so an unfiltered series
  measures the gap from a warm-up to a renewal as though it were a schedule decision, and carries
  five gaps that are not schedule decisions at all. Re-deriving this without the filter gave a
  different population (196 gaps, 6 in the alive band). **It is NOT what produced the correction
  below** — that run changed the bands as well, so the two are not separated, and saying "the
  filter flipped the verdict" would be a tidy story rather than a measurement.
- **THE BANDS ARE SEPARABLE, WHICH IS WHAT MAKES IT AN INSTRUMENT AND NOT A STORY.** The
  distribution over **191 renewal-to-renewal gaps under four hours** is starkly bimodal, and the
  two modes sit on the two failure cadences plus one trip (~68s):
  ```
  minGap band   9.5-15m   63        alive band  55-75m    7
  backoff band   29-35m  100        neither              21
  ```
- **AND THE SHORT BANDS ARE FAILURES BY THE CODE, NOT BY INFERENCE.** Every branch below `alive`
  is reached only once that first check has FAILED — i.e. the token is null or lapsed at the
  moment of the poll. For a gap of 10 or 30 minutes against a **60-minute** token that can only
  mean the previous attempt did not mint one. (`minGap` and `backoff` additionally require
  `token === state.lastToken`, so those two are explicit.) **Only the alive band requires a token
  that was really minted.**
- **SO: 163 of 191 gaps sit in a failure cadence and SEVEN in the alive band — 85% of all gaps,
  and 96% of the gaps that land on a recognisable branch at all.** It is CHRONIC rather than an
  episode: every day the table covers, and **every day carrying more than ten attempts succeeds
  8% of the time or less** (2% · 0% · 7% · 4% · 8%):
  ```
  09-05   4 fail /  0 ok   <- 6 gaps only; the box picked the instrument up partway through
  09-06  44 fail /  1 ok      09-08  27 / 2      09-10  35 / 3
  09-07  28 fail /  0 ok      09-09  25 / 1
  ```
- **THE FIRST DRAFT OF THIS ENTRY PUT 89% IN THE HEADING, AND 89% IS A DIFFERENT QUANTITY.**
  170 of 191 gaps land on a NAMED branch — 89% — and that number is about how well the instrument
  attributes, not about how often the renewal fails. **It was one edit from being published as the
  failure rate**, in the heading and in two files, which would have understated a 96% failure as
  an 89% one *and* silently discarded the "21 gaps this cannot explain" caveat by folding them in.
  Caught by re-deriving the figures before committing them rather than by re-reading the draft.
  **Two numbers of the same size describing different denominators is the house shape** — the
  same trap as `status = 'sent'`, one layer up.
- **THAT REVISES TWO THINGS IN THIS FILE.** The 08-22 entry records *"THE RENEWAL HAS FAILED 20
  TIMES RUNNING AND IS IN BACKOFF"* as a moment worth noting; **it is the steady state.** And the
  five 31.5-minute gaps that opened this investigation today — 14:08 → 16:45, the backoff to
  within four seconds five times running, with `okta=GONE(404)` independently read at 16:58 **at
  the end of that window** — are **one ordinary instance of it, not an event.** Do not write them
  up as one. (The Okta reading is evidence about 16:58; it covers the preceding six hours only by
  continuity, since an Okta session does not come back on its own.)
- **IT COSTS THE SESSION NOTHING — AND IT IS NOT FREE.** The session is healthy and the token
  keeps being re-minted, none of it ours: the entry above shows the SPA doing it silently while
  our renewal has stopped running at all. **But 198 trips in six days is ~33 Okta navigations a
  day, at least ~28 of them accomplishing nothing** (163 failures over the six days is the
  FLOOR — the 21 unattributed gaps could go either way), from the residential address that has
  eaten a
  twelve-hour block — and an Okta navigation is the leak's own ESTABLISHED trigger. So the two
  standing costs of this are anti-bot exposure and the ramps.
  - **THAT PUTS NUMBERS UNDER A READING THIS FILE ALREADY HAS.** 2026-08-15: *"the automation
    answer is: DON'T RENEW THE TOKEN, re-run the bootstrap"* — argued then from two hand-read log
    lines, and now with a six-day denominator behind it.
  - **NOT ACTED ON, AND NOT A DRIVE-BY.** `planRenewal` is bot-side, it is what repairs a session
    between releases, and the SPA's re-mint is an OBSERVATION of RC's behaviour rather than a
    guarantee — the 08-18 entry's own caveat (*"two cycles is not a regime"*) has still never been
    answered across an overnight. Removing our renewal on the strength of the SPA covering for it
    is a decision with a measurement behind it, not a tidy-up.
- **WHAT IT DOES NOT SAY: WHY they fail.** `tab-close` carries `tripMs`, `closeMs`, `hung` and
  `ramMb` and **no verdict**, so which attempt succeeded and which did not is recoverable only as
  a band, never as a reason. Today's 12m08 gap at 16:57 is the sharp edge of that: it precedes the
  forced warm-up by one minute and is already `minGap` rather than backoff, so the failure counter
  had dropped below three before anything was forced — **and nothing in these events can say what
  reset it.** Do not narrate it. **The 21 unattributed gaps are the same limit**: 4-8 minutes
  (under the floor, so not a schedule decision at all), 15-28, 40-55, and 80-233 — each is a
  question this table cannot answer, and folding them into either verdict is the thing the
  correction above nearly did.
- **THE FORCED WARM-UP FILED AS "MISSED" IS THEREFORE NOT CLEANLY CREDITABLE EITHER**, and it
  still did what the 09-07 entry records: it established an Okta session (`OK Okta session
  established`, 15.6s, 413 MB, no ramp), which is the resource the backoff's own comment says the
  failures are about — *"when that cookie is gone every attempt will fail identically until a
  human signs in."* Consistent with removing the cause; **not proof**, because the counter had
  already reset.
- **ONE FREE BOUND ON THE LEAK RIDES ALONG: 198 renewal trips against 17 onsets**, both counted
  over the same window (`bot_events` starts 2026-09-04 22:33, and the onset bar is the sampler's
  own 1,500 MB) — so a renewal trip ramps **at most about one time in twelve.** First
  quantification of "most trips are cheap", and a BOUND rather than a rate **in a known
  direction**: `auto-login` and `warmup` navigate to Okta as well, so some of those 17 are not
  renewals, which can only make the true figure rarer.
- **AND IT MAKES THE OVERNIGHT READING A ONE-QUERY JOB, WHICH IS WHY IT HAS NEVER BEEN TAKEN.**
  The 08-18 entry asks for "the same pattern still holding after an overnight" and nobody has
  answered it in three weeks, because answering it used to mean reading a log that rolls at 16,000
  characters. It does not any more: **the gap between the last `tab-close` and the next one, over
  a night, IS the answer** — a gap of many hours with `autocart.rc_session` healthy throughout is
  the SPA carrying the session unaided, and a gap that closes back to 10-30 minutes is our renewal
  resuming and failing. Both are in `bot_events`, retrospectively, whenever somebody looks.

###### THE OVERNIGHT ANSWER IS IN — TEN HOURS OF TOTAL SILENCE, AND IT COST ONE QUERY (2026-09-11)
The entry above says the 08-18 question is now a one-query job and that nobody had taken it in
three weeks. **Taken, the morning after, and it is the strongest form of the reading:**
```
2026-09-10 19:31:28   tab-close renewal          <- the last trip of the evening
   [ 599.8 minutes. ZERO bot_events of ANY kind. ]
2026-09-11 05:31:15   tab-close renewal  trip=46.6s
             05:42:46   +11.5m  minGap
             05:54:06   +11.3m  minGap
             06:25:40   +31.6m  backoff   ... and backoff for the next six hours
```
- **THE SILENCE IS TOTAL, NOT MERELY RENEWAL-SHAPED.** Zero rows of every kind — no `tab-close`,
  no `mem-dump`, no `ramp-scan`, no `request-counts` — checked as a count rather than eyeballed
  off a listing, because `tab-close` has three emitters and a filtered query would have proved
  much less.
- **`chromium_memory_samples` POSTED 312 SAMPLES ACROSS THE SAME WINDOW**, which is the
  discriminator the entry above predicts working in anger: that series comes from `bot.mjs`, a
  different process, so it stays healthy through a silent keep-warm and settles nothing on its
  own. **An empty `bot-events-readout` beside a live memory series is the HEALTHY regime.**
- **AND THE SILENCE IS ITSELF THE PROOF THE TOKEN NEVER LAPSED, which is tighter than a health
  reading.** `planRenewal` stands down only while the token is alive AT ALL; `leftS <= 0` and
  `leftS == null` both ACT. So ten hours of no trips means ten hours in which every poll found a
  token with time left on it — i.e. **RC's SPA re-minted it repeatedly, silently, unaided,
  overnight.** The 08-18 entry's own caveat (*"two cycles is not a regime"*) is answered.
  - **STATED PRECISELY: it proves a NON-EXPIRED token was present at every poll, not that RC
    would have ACCEPTED one.** Those are different facts — `session_ok` is RC's answer and this
    is the token's own `exp`. Do not upgrade it.
- **THEN IT RESUMED AND FAILED, EXACTLY AS PREDICTED.** The gap closes to 11.5 and 11.3 minutes
  (minGap) and then runs **31.5-minute backoffs for six hours straight** — thirteen consecutive
  failure-band gaps. That is the 96% figure being watched live rather than computed after the
  fact, and it is the first time the instrument has been read forward instead of backward.
- **THE 599.8-MINUTE GAP LANDS IN THE BAND SCHEME'S `other` BUCKET, AND THAT IS CORRECT.** It is
  not a stand-down branch, so a classifier that named it would be inventing one. The overnight
  shows up as an outlier in the very instrument built to classify gaps, which is the right
  behaviour and not a hole in it.

###### AND THE BROWSER THAT RAMPED WAS 611 MINUTES OLD — THE AGE FRAMING IS DEAD
The silence is what makes it possible: no renewals means nothing recycles the browser, so the
healthy self-sustaining regime is precisely what produces the oldest browsers this box has ever
had — and **the oldest one ever recorded is the one that ramped**, at 05:28 UTC, `bail:ramp` with
`ageMs` **611 minutes** against a previous "old" record of 125.

| ramp (UTC) | browser age | busiest path, lifetime | module / anonExec | spread | top sample |
|---|---|---|---|---|---|
| 09-10 04:26 | 2.75 min | 17k-75k (burst) | 42 / 6 | 19 of 48 | `chrome.dll+0x180968b` x12 |
| 09-10 05:52 | 2.6 min | burst | 43 / 5 | 23 of 48 | `chrome.dll+0x18096c6` x11 |
| 09-10 17:53 | 57.5 min | **6** (no burst) | 39 / 9 | **40 of 48** | **anon-exec (JIT) x9** |
| **09-11 05:28** | **611 min** | **20** (no burst) | **46 / 2** | **22 of 48** | **`chrome.dll+0x180968b` x12** |

- **IT IS OLD AND BURST-FREE ON BOTH AXES THAT DEFINED THE OUTLIER, AND ITS STACK READS LIKE A
  YOUNG ONE.** 22 distinct addresses of 48, the three `HandlerAdded` offsets carrying **28 of
  48**, and JIT down to **2** — the most module-dominant reading of all four. The recorded split
  was perfect at n=3 and **is broken at n=4 by the most extreme old-browser case available.**
- **SO NEITHER AGE NOR BURST PRESENCE PREDICTS THE STACK PROFILE**, and the 17:53 event stands
  alone rather than heading a population. CLAUDE.md's own caution — *"do not build on the age
  framing"*, written when the correlation was 3-for-3 — was right, and this is what it was right
  about. **The trip-type reading (cold page load vs Okta navigation) is untouched by this and is
  now the only surviving candidate**; it is also unmeasured here, because nothing recorded which
  kind of trip the 611-minute browser was making.
- **THE WALK IS TWELFTH-TIME CONSISTENT AND IS A `middle` EVENT:** 14,434 regions in `2-4M` across
  **14,433 allocation bases**, 28,868 MB, 14,431 READWRITE, 64 sampled and **all anonymous**,
  against the control's 5 regions / 4 bases with its file-backed positive control
  (`SortDefault.nls`) present as ever. **1,950 short of 2^14 with the commit limit at 47,870 and
  the box's baseline near 7,000** — so there was room for thousands more and it stopped anyway.
  That is the sixth member of the population neither the cap nor commit exhaustion explains.
- **`VMTHREAD` IS FOUR-FOR-FOUR: main thread `Running`, 1,203 ms of a 1,200 ms window**, against a
  control renderer at **0 ms** and the **GPU process idle at 109 ms across 20 threads** — the
  same `CONSISTENT WITH, NOT PROOF` shape, which still must not be quoted as a confirmation.
- **THE RAMP DUMP IS `target-silent` FOR THE FOURTH TIME.** `MDPROC` answered for eight processes
  — `1864 12984 4884 8976 9180 6404 13152 3024` — and the walk's TARGET **14676 is not among
  them**, with `partial: no answer in 20000ms` and `emptyPids: []`. **Nothing new; do not spend
  another ramp on it.** `dump-wedge-probe.mjs` settled off-box that a wedged renderer contributes
  zero allocator dumps at every level.
- **AND THE BURST/LEAK DECOUPLING HOLDS FOR THE SEVENTH TIME**: 28,868 MB of mapping beside a
  busiest path of **20 lifetime requests**, all `200`s to split.io's SDK. **Stop re-litigating
  it.**

#### WHEN A RAMP CAN BE FORCED, MEASURED RATHER THAN ESTIMATED (2026-09-09)
The recipe needs **Okta GONE *and* the RC token dead**, and the binding half is Okta's ABSOLUTE
cap, which our own probing cannot bring forward (measured not to reset across a password sign-in
on 08-16, a cookie-answered one on 08-21, and again on 09-07).
- **THE CAP IS FROZEN AND THE READING IS A MEASUREMENT, NOT ARITHMETIC ON ONE SAMPLE.** Across a
  real 20-minute probe the CHECK advanced (18:55:27 -> 19:15:28 UTC) and `okta_expires_at` did
  **not** move, staying at `2026-09-10T05:33:36Z`. A ROLLING window prints exactly `+12.0000h`
  from the moment it was checked (12 for 12, 08-18); this read `+10.64h` then `+10.30h`, i.e.
  shrinking by the elapsed time. **Frozen, so it is the absolute cap.**
- **SO THE WINDOW OPENS AT 22:33:36 PT** and not before — plus up to another hour for the token,
  because `renewSession` can still mint from the `idx` cookie until Okta actually goes.
- **AND IT SHOULD NOT BE USED, because four or five natural ramps arrive before it opens.** At
  today's 2.3-4.2 h cadence the window is ~10 hours out and every instrument is already armed
  for a free event. Forcing is 3-in-6, spends the warm-up's one turn per Okta lifetime, and
  costs a password submission from an address that has eaten a twelve-hour block. **The gating
  item is the BOX UPDATE, never the ramp.**


#### A FRESH BROWSER IS 8x MORE LIKELY TO RAMP — and that is a forcing lever (2026-09-09)
Asked whether the ramps we cannot explain line up with rec.gov carting. They mostly do not; what
they line up with is **the browser being REPLACED**, and that is the strongest association this
investigation has found from the memory series alone.
```
onsets preceded by a browser replacement within 6 min : 11/26  (42%)
expected by chance (110 replacements x 7-min window)  :  1.4
replacements that go on to ramp                       : 11/110 (10%)
```
- **THE 02:0x CLUSTER IS THIS, AND IT IS NOT A CLOCK.** Four ramps at 02:02/02:02/02:03/02:03
  read as a scheduled trigger. The raw samples say otherwise — quiet for fifteen minutes, the
  browser is replaced, and the NEW renderer is already at 1.9 GB in the next sample:
  ```
  09-01 01:59  rc  297  procs 9  pid 6596     <- quiet
  09-01 02:01  rc  233  procs 7  pid 12984    <- REPLACED
  09-01 02:01  rc 1893  procs 7  pid 1260     <- the new renderer, already ramping
  ```
  09-02 is the same shape. **09-03 had no replacement at 02:0x and no ramp.** The bot's update
  window opens at 02:00 PT, so a pending update restarts the browser at 02:01 — the hour is the
  restart's, not the leak's.
- **IT FITS THE `MappedMemoryManager` CANDIDATE RATHER THAN DISPLACING IT.** A cold browser
  loading RC's WebGL ArcGIS map is when the command buffer does the most work, and chunks are
  taken and never reclaimed while the main thread spins.
- **DIRECTION IS NOT ESTABLISHED — do not write one in.** The post-Okta recycle, the size guard,
  a profile yield and a bail all replace a browser, and several are themselves downstream of an
  Okta trip, so this may be "Okta trip -> recycle -> the NEXT trip ramps". The 02:0x cases are
  the clean ones, because they follow fifteen quiet minutes rather than a ramp.
- **NEITHER NECESSARY NOR SUFFICIENT.** 15 of 26 onsets had no replacement before them and 99 of
  110 replacements cost nothing. It is a strong enrichment, not a mechanism.

**THE PREDICTION, STATED BEFORE THE TEST: `restart-rc` replaces the browser on demand, so ~10
restarts should produce a ramp.** That is a forcing lever costing **no test hold, no campsite, no
password submission and no wait for Okta's cap** — a renewal re-mints from the `idx` cookie and
is not a login. **`supervise.ps1` STOPS LOUDLY AFTER 5 EXITS IN 10 MINUTES**, which would leave
the RC pair dead, so restarts must be paced at ~15 minutes; that also matches the ~11 minutes the
session takes to repair itself. Run it only with no holds queued.


#### VMSTACK ANSWERED, AND THE FORCING LEVER WORKED FIRST TRY (2026-09-09 21:26 PT)
The prediction above was tested the evening it was written. `restart-rc` fired at 21:23:58 with
the box quiet at 295 MB, and **the replacement browser ramped inside ninety seconds** — one
restart, not the ten the prediction budgeted for.
```
21:23  rc  295  procs 9  pid  4972  commit  7108     <- quiet
21:23:58  restart-rc
21:25  rc 2366  procs 8  pid 15284  commit 38596     <- new browser, ~35 GB commit in one tick
peak 3913 MB, contained; 21:27 replaced, commit back to 7064
21:26:52  request-counts  reason=bail:ramp  ageMs=165061   <- the RAMP arm, not a recycle
```
- **THE BAIL CORROBORATES THE REPLACEMENT FINDING FROM A SECOND INSTRUMENT.** `ageMs=165061` puts
  the browser at **165 seconds old** when the arm fired — dead centre in the 135-195s "young
  browser" ramp population recorded above, measured by something that knows nothing about the
  memory series. And "what ended it" is settled for this event rather than inferred: `bail:ramp`,
  which is the question that has had three incompatible accounts in this file.
- **ONE TRIAL IS NOT A RATE.** The measured base rate is 10% of replacements, so a first-try hit
  is luck as much as evidence. What it establishes is that the lever WORKS, not how often.
- **AND IT COSTS NOTHING**: no test hold, no campsite, no password submission, no waiting on
  Okta's cap. That is the cheapest ramp this investigation has ever bought.

**THE READING — IT IS A NATIVE LOOP, NOT OUR PAGE SCRIPT.**
```
pid=15284 tid=6460 main=True deltaMs=1234 samples=48
   count=12 chrome.dll+0x180968b      count=6 anon-exec (JIT)
   count=8  chrome.dll+0x18096c6      count=6 chrome.dll+0x1809694
   count=2  chrome.dll+0x18096b1      count=1 chrome.dll+0x180969f
42 of 48 samples inside a loaded module; chrome.dll is 149.0.7827.55
```
- ~~**THE JIT BRANCH IS CLOSED.** Six of forty-eight. RC's own JavaScript is not the loop, so there
  is no fix on our side of the page and no point looking for one. **The fix is Chromium-level —
  a flag, or not using the feature.**~~ **TRUE OF THIS RAMP AND NOT OF ALL OF THEM — the 09-10
  17:53 ramp reads 40 distinct addresses of 48 with JIT as the largest single bucket.** Struck
  rather than deleted: read as current it closes a fork on the strength of one reading, which is
  what it did. The split is by BROWSER AGE and it is perfect on three points — see "THE COMMIT
  TRIGGER FIRED, AND THE SPIN IS NOT ALWAYS `HandlerAdded`". **What survives is the reading of
  THIS ramp**, which is a young-browser one: 42 of 48 in a loaded module, 29 of them in a 59-byte
  window, and that is a native loop.
- **THE HOT ADDRESSES SPAN 59 BYTES** (`0x180968b` to `0x18096c6`) and carry 29 of 48 samples.
  One small loop body, not a call graph. `chrome.dll 149.0.7827.55` symbolizes that offset
  offline and names the function; that is the next reading and it needs no ramp.
- **THE HANDLE COUNT CORROBORATES FROM OUTSIDE**: the ramping renderer held **14,600 handles and
  58,281 KB of paged pool** against ~230-290 handles and ~780 KB for every healthy renderer in
  the same scan — the shape of ~14.3k section objects, matching `commit/mapped count=14534`.
- **`MappedMemoryManager` IS STILL A CANDIDATE AND IS NOT PROMOTED BY THIS.** VMSTACK says the
  loop is native and WHERE; it does not say WHAT. The 2 MiB unit, the idle GPU process and the
  token-reclaim argument are unchanged — better aimed, not confirmed.
- **THE CHEAP FIX TO TRY FIRST, and it is testable in minutes now rather than days.** The
  keep-warm's browser exists to hold a session; it does not need to RENDER RC's WebGL ArcGIS map.
  Launching it with GPU acceleration off removes the command buffer entirely. **The restart lever
  makes that iterable** — but note the arithmetic: at a 10% base rate, a handful of clean restarts
  is weak evidence and ~20 would be needed to speak. Do not credit a repair to it on three quiet
  restarts; that is the mistake this file has made three times.

#### ~~THE COMMAND BUFFER IS OFF NOW, GATED~~ — IT RAN, IT RAMPED, AND THE CANDIDATE IS REFUTED (2026-09-10)
`keepwarmLaunchArgs()` (`scripts/auto-cart-bot/keepwarm-launch.mjs`) adds `--disable-3d-apis`
(the targeted flag — no WebGL context, so no command buffer, so no `MappedMemoryManager`) and
`--disable-gpu` (the belt). **ONE definition, BOTH launch sites** — `withProfile` and the
resident loop — because two arrays is two chances for the browser under test to differ from the
browser being measured in the variable under test.
- **GATED ON `RC_KEEPWARM_DISABLE_GPU`, DEFAULT ON, REVERTIBLE WITH NO DEPLOY.** Set it to `0`
  and restart. That matters because **RC and Okta fingerprint this browser, and a browser with
  no WebGL is itself a bot signal** — the recorded cost of getting anti-bot posture wrong on
  this address is twelve hours of IP block. **If the login rehearsal starts failing or a CAPTCHA
  appears, turn it off first and ask questions second.**
- **THE BAR WAS WRITTEN INTO THE MODULE BEFORE THE EXPERIMENT, AND IT WAS NEVER NEEDED.** A
  browser replacement ramps ~**10%** of the time (11 of 110 over ten days), so three quiet
  restarts is what a change doing NOTHING produces three quarters of the time, and ~**twenty**
  clean trials was the bar for crediting a CURE. **The first trial ramped**, so there was no
  cure to credit and no quiet run to interpret — see directly below. The bar stays written down
  because it is the right bar for the next candidate, not because this one reached it.
- **A RAMP THAT STILL ARRIVES WITH THE FLAGS ON IS WORTH AS MUCH AS A CURE, AND ARRIVES
  SOONER** — it refutes the command-buffer candidate outright. **It did, in under half an hour.**
- **AND CI CAUGHT A REAL REGRESSION FROM THE EXTRACTION — the ~28th instance of the shape.**
  `keepwarm-recycle.test.mts` pinned `'--hide-crash-restore-bubble'` in `rc-keepwarm.mjs`'s OWN
  source, and moving the args took the literal with them. Behaviour was unchanged. **Re-anchored
  rather than relaxed, and the extraction WIDENS what it must cover**: the obvious repair —
  point the assertion at the new file — would leave the three banned throttling flags scanned in
  only one of the two places they can now be reinstated. `launchCode` is the UNION of both.
  Three mutations, each verified to apply and to fail; **the one that matters is a throttling
  flag added to the NEW module**, which a naive re-point would have sailed past.


#### AND IT RAMPED ON TRIAL ONE — THE COMMAND-BUFFER CANDIDATE IS REFUTED (2026-09-10 05:51 PT-UTC)
The flags reached the box at 05:21:50Z and were confirmed live by an INDEPENDENT reading rather
than by "the code is on disk" — `gpu-process` fell to **20-22 MB** and stayed there, against a
prior distribution of **2,631 samples in the 72 h before the flags went live** (the
`rc_by_type->'gpu-process'` series over `2026-09-07T05:21:50Z .. 2026-09-10T05:21:50Z`): **minimum
78 MB, median 111**, p05 95, p95 130. **Not one of those 2,631 readings is below 40 MB** — nor is
any of them zero, so no filter is doing quiet work here. The plateau is outside the whole range
rather than merely low in it, which is a stronger statement than a range and is what makes this a
confirmation instead of an impression.
**The window is stated because the first draft's "2,577 over three days" was `NOW() - 3 days` at
the moment the query happened to run** — a number nobody could reproduce, in the paragraph whose
job is to be checkable. The figures that matter did not move.

`restart-rc` replaced the browser at **05:49:51Z**. Two minutes later:
```
05:49:53  rc   209 MB  pid  1692  renderer  101 MB  commit  7050/29035  gpu-process 20 MB
05:51:53  rc  3452 MB  pid 13332  renderer 3234 MB  commit 44336/45513  gpu-process 20 MB
05:52:22  rc  3889 MB  pid 13332  renderer 3670 MB  commit 44606/45513  gpu-process 22 MB
05:52:53  rc   166 MB  pid  3292  (replaced by the RAMP arm)  commit  7230/29035
```
- **EVERY ELEMENT OF THE SIGNATURE, ON A BROWSER LAUNCHED UNDER BOTH FLAGS.** The ~35 GB commit
  step inside one two-minute tick; the commit LIMIT chasing it (29,035 -> 45,513 -> back); a
  renderer pid that did not exist a minute earlier, immediately the largest; and the walk on that
  renderer reading **32,774 MB across 16,385 regions in the 2-4M bucket, one allocation base
  each, 16,379 READWRITE, 64 sampled and all anonymous.** `16,384 x 2 MiB = 32 GiB` exactly — the
  ceiling holds for the ninth walk — with **EXCESS 35,982 MB against an OS commit gap of
  35,899 MB**, so the walk named the 35 GB again.
- **AND THE SAME NATIVE SPIN AT THE SAME OFFSETS.** `SPINNING on the MAIN thread`, 1234 ms of a
  1200 ms window, `chrome.dll+0x18096c6` (11 of 48) and `chrome.dll+0x180968b` (9 of 48) — the
  addresses VMSTACK named on 2026-09-09, on a build with no WebGL context at all.
- **THE GPU PROCESS DID NOT MOVE AT ANY POINT: 20 MB before, 20 MB during, 22 MB after.** It is
  not merely uninvolved, it is at the reduced post-flag value throughout, which is the same
  reading that proves the flags applied.
- **AND THE REVERT CLOSES IT FROM THE OTHER SIDE — ONE SERIES, BOTH EDGES, A 5x SWING EACH WAY.**
  The whole trial fits in ninety minutes of `chromium_memory_samples`, so the baseline is not
  quoted from another day:
  ```
  05:21:23  rc 317 MB  gpu-process 119 MB   <- BEFORE, flags off
  05:21:50  rc 236 MB  gpu-process  22 MB   <- flags ON (browser replaced)
  05:51:53  rc 3452 MB gpu-process  20 MB   <- THE RAMP, flags still on
  06:23:56  rc 167 MB  gpu-process  21 MB   <- still on, thirty quiet minutes
  06:24:55  rc 246 MB  gpu-process  99 MB   <- flags OFF (browser replaced)
  06:42:57  rc 325 MB  gpu-process 130 MB   <- settled back at the pre-trial baseline
  ```
  **The instrument moves 119 -> 20 -> 99+ as the flag goes on and off, and the ramp sits in the
  middle of the low plateau.** That is what closes *"were the flags really applied during the
  ramp?"*, which would otherwise rest on a single reading taken before it.
- **`max_type` SPANS BOTH PROFILE FAMILIES — READ `max_family` BESIDE IT OR IT IS NOT ABOUT THIS
  BROWSER.** This entry first claimed `max_type` "returns to `gpu-process` at the same instant,
  having been renderer or browser for the whole trial", offering it as a second column agreeing.
  **That is false and the row that disproves it is inside the trial window**: two of the 42
  flags-on samples read `gpu-process`, and at 06:22:32 `max_mb` is **118 MB** while the rc family's
  largest sub-total is `browser` at 52 and its gpu-process is 21.
  - **Confirmed in the sampler's source, not inferred from the arithmetic.** In
    `memory-sample.mjs` the `if (mb > out.maxMb)` block sits OUTSIDE any family filter, while
    `rcByType` is explicitly gated on `fam === 'rc'`. So `max_pid`/`max_type`/`max_mb` are the
    largest of **ours**, across both families; `rc_by_type` is per-family by construction.
  - **THE DISCRIMINATOR EXISTS AND IS ONE COLUMN OVER: `max_family`.** That row reads
    `max_family = recgov`, `source = bot-keepalive` — the rec.gov keepalive browser, which opens
    for a few seconds twice every thirty minutes. **So this is not "`max_type` is useless", it is
    "`max_type` alone is ambiguous"**, and the first draft of this bullet said the stronger, wrong
    thing before the column was looked up.
  - **What it would have cost:** a confirmation manufactured out of a different browser's
    arithmetic, on the one reading whose whole job is to prove the flags applied. The genuine
    second witness is `rc_by_type['gpu-process']`, which is what the table above already quotes.
- **AND THE COMMIT LIMIT SHRANK BACK TO 17,150 MB AT 06:34**, having been 29,035 all trial and
  45,513 during the ramp. That is Windows growing and then reclaiming the system-managed pagefile,
  and it is the artifact the percentage readings in this file were warned about: **the ratio was
  never measuring pressure — the absolute figures were.**
- **STATED PRECISELY, BECAUSE THE OVER-CLAIM IS THE FAILURE MODE OF A GOOD FINDING.** What is
  established is that **removing the WebGL context does not stop the leak**, so
  `MappedMemoryManager` serving RC's ArcGIS map — the mechanism as proposed, and the one the
  2 MiB unit was matched against — cannot be it. `--disable-gpu` leaves a GPU process running,
  so a *different* command-buffer client is not excluded by arithmetic alone. **The 2 MiB unit is
  now MORE interesting, not less: something maps 16k two-megabyte shared sections in a renderer
  that has no GPU context.**
- **`--disable-3d-apis` IS A REAL, POLICY-BACKED WEBGL KILL-SWITCH, AND IT IS ORTHOGONAL TO
  `--disable-gpu` BY DESIGN — checked, not assumed.** `kDisable3DAPIs` ("disable-3d-apis")
  disables client-visible 3D APIs, WebGL and Pepper 3D, and Chromium's own review notes say it
  was deliberately kept "orthogonal to existing ones, so that further changes to those command
  line arguments will not accidentally regress the group policy support." **That is the residual
  this entry was one sentence from leaving open**: the GPU-process drop is direct evidence
  `--disable-gpu` applied and says nothing about the other flag, and `--disable-gpu` ALONE would
  have left WebGL running on SwiftShader — still through a command buffer. The targeted flag is
  what makes "removing the WebGL context" the thing that was actually tested.
  **What is still not DIRECTLY read is that this build accepted the switch** (an unknown switch
  is logged and ignored). It is a stable policy-backed name, so a silent rename is unlikely, and
  nobody took a reading. Say "no WebGL context was requested", not "no WebGL context existed".
- **AND THE 2 MiB MATCH WAS A COINCIDENCE, WHICH IS THE REUSABLE LESSON.** The candidate's
  strongest evidence was an EXACT numeric identity — `mapped_memory_chunk_size` is 2,097,152
  bytes and the walk's unit is 2.0000 MB — and that identity survives the refutation while the
  mechanism does not. **2 MiB is a very common granularity** (Windows' large-page size,
  PartitionAlloc's super-page size, and the unit of several unrelated Chromium allocators), so
  matching it is far weaker evidence than it feels. **An exact match on a round power of two is
  not a fingerprint.** Whatever maps these sections still uses 2 MiB; that no longer points
  anywhere in particular.
- **ONE COUNTEREXAMPLE IS WHAT A REFUTATION NEEDS, AND THIS ONE CAME WITH THE WHOLE WALK
  ATTACHED.** Accumulating the twenty quiet trials would have added nothing — that bar exists to
  stop a CURE being credited on silence, and silence is not what arrived. **Do not re-run this
  trial to "confirm" the refutation**; the confirming evidence is in the walk above.
- **THE FLAGS ARE OFF AGAIN (default flipped), AND THE MODULE IS KEPT FOR THE EVIDENCE.** Their
  entire justification was the candidate; what is left without it is the fingerprint hazard — RC
  and Okta fingerprint this browser and a browser reporting no WebGL is itself a bot signal, with
  a recorded cost of twelve hours of IP block. A change that does not work and carries that is
  uncompensated risk. **Deleting the module would take the refutation with it**, which is the
  Feature E fold-in failure, so it stays and `RC_KEEPWARM_DISABLE_GPU=1` re-runs it with no
  deploy. `src/lib/keepwarm-launch.test.mts` had **three guards INVERTED, not relaxed** — they
  pinned the flags ON, which is the `held-offer-scope` shape (a test requiring the change that
  was measured not to work). Six mutations, each verified to APPLY and to fail.
- **A METHODOLOGICAL OBSERVATION, NOT A FINDING: `restart-rc` IS 2 FOR 2.** The 2026-09-09 21:26
  forced restart ramped first try and so did this one, against a pooled base rate of 10% (p~0.01
  for two). That rate was computed over ALL 110 replacements, most of them natural (post-Okta
  recycle, profile yield, bail), while `restart-rc` produces a COLD browser loading RC's home
  page — which is the shape the 02:0x cluster turned out to be. So a forced restart plausibly
  ramps far more often than the pooled figure, and **the ~20 bar is probably too conservative for
  forced trials specifically**. n=2; do not quote it as a rate.

#### THE BOX HAS THE BINARY — `code-bytes` READS THE HOT INSTRUCTIONS OFF DISK (2026-09-10)
With the command-buffer candidate refuted, VMSTACK's native offsets are the only lead left, and
symbolizing them is blocked from a web session: **all four Playwright CDN hosts are 000 at the
agent proxy**, and this container's own Chromium is the wrong revision AND a Linux build — two
independent reasons, the second of which survives a version match, which is the "validated on the
wrong platform" trap that burned the native sampler. **The mini-PC has the exact file.**
- **IT READS THE SHIPPED BINARY, NEVER A PROCESS.** The standing ban on `ReadProcessMemory` and
  minidumps is about a renderer's pages being RC session material; a file on disk carries none of
  it, and a code address plus a section name cannot carry a credential. Pinned: neither the
  handler nor the parser may contain `ReadProcessMemory`, `MiniDumpWriteDump` or `OpenProcess`.
- **THE ARGUMENT IS AN RVA AND CAN NEVER BECOME A PATH.** That is the whole reason this is safe
  to add as a lever to a box holding the live RC session, the DPAPI credential store and a
  residential IP both providers have blocked. `chrome.dll` is **DERIVED** on the box from
  Playwright's own `chromium.executablePath()`; the arg reaches a hex regex and `parseInt` and
  nothing else. **It imports `playwright`, NOT `playwright-core`, and that is load-bearing** —
  the command is only useful if it names the binary `rc-keepwarm.mjs` LAUNCHES, and that file
  imports `playwright`. The probes in that directory use `playwright-core` deliberately so they
  run in the dev sandbox; copying that habit here would mean disassembling bytes from a build the
  box may not be running, which is plausible, silent and wrong. A guard reads the keep-warm's own
  import and requires this to match, so the day that launch import moves, this fails rather than
  drifting. **There is no fallback**: a `playwright-core` fallback is precisely what would turn a
  clear "could not resolve Playwright's Chromium" into a wrong answer. A guard asserts that no line constructing the path mentions `arg` or `hex`, and
  the widened-pattern mutation (`/^\S{1,260}$/`) is caught — verified by applying it.
- **BOTH ALLOWLISTS RE-VALIDATE, and the box's is the load-bearing one.** A leaked
  `AUTOCART_TOKEN` reaches the feed, not this repo — the same split as `restart-rc`'s rate limit
  living on the box rather than only on the server.
- **IT ANSWERS TWO WAYS FROM ONE OPEN, and the second is the one that survives this session.**
  The BYTES (to disassemble — `objdump -D -b binary -m i386:x86-64 -M intel`, verified working in
  the container) name what the loop DOES, which is arguably better than a function name. And the
  **PDB GUID + age** is the symbol-server key for this exact build, which is what a later session
  WITH egress needs; deriving it now means the answer does not wait on the proxy twice. The
  binary's own key (`TimeDateStamp` + `SizeOfImage`) rides along, because they are DIFFERENT keys
  and whichever is published is the one that works.
- **THE WINDOW STARTS 64 BYTES BEFORE THE ADDRESS.** x86 is variable-length, so disassembling
  from exactly the reported address begins mid-instruction and produces confident nonsense; the
  caller needs room to find a boundary.
- **`parsePeHeaders` REFUSES PE32 RATHER THAN ASSUMING PE32+.** Data directories sit at optional
  header offset 112 for 64-bit and 96 for 32-bit, so guessing reads a different structure and
  returns something shaped like an answer. Same rule as `unknown` never rounding to a verdict.
- **AN RVA PAST A SECTION'S RAW DATA REFUSES**, rather than returning the next section's bytes —
  a section can be larger in memory than on disk, and neighbouring bytes disassemble into
  plausible garbage, which is the worst output this command could produce.
- **THE PDB GUID IS MIXED-ENDIAN AND THAT IS NOT A DETAIL.** The first three fields are
  little-endian integers and the last eight bytes are raw, so a straight hex dump of the sixteen
  bytes yields a key that looks right and matches nothing — and the resulting 404 reads as
  "symbols are not published" rather than "we computed the key wrong". The age is appended in hex
  **unpadded**. A non-RSDS record reports NOTHING rather than a fabricated key.
- **THE READING HALF TAKES A PATH; THE COMMAND DOES NOT.** `readCodeWindow(dllPath, rva)` is
  split out so the arithmetic can be tested against a real file on disk **without the command
  growing a path parameter to make it testable** — which would have traded the safety property
  for the test. Positioned reads throughout: `chrome.dll` is ~200 MB and this runs on the process
  that carts campsites, so a `readFileSync` here is the cure-arriving-as-the-disease mistake.
- `src/lib/pe-rva.test.mts` (15) + `src/lib/code-bytes-safety.test.mts` (7), **nine mutations,
  each verified to APPLY and each caught** — the arg widened to a path, the box dropping its own
  check, the arg reaching the path, a whole-file read, the absence throwing instead of answering,
  the CodeView pointer mapped through `rvaToFileOffset` a second time, the RVA ignoring the
  section table, the GUID dumped straight, and the import switched to `playwright-core`.
- **GUARDS UNDER `src/`, NOT `worker/`** — read out of `worker-deploy.yml`'s `paths:`, not
  remembered — so this fires **no worker deploy**. **BOT-SIDE, so it is inert until the box
  updates**; confirm with `bot-ask git-status`, never `autocart.bot_version`.
- **HOW TO USE IT:** `npx tsx scripts/bot-ask.mts code-bytes 18096c6 > /tmp/a.txt`, then
  `npx tsx scripts/disasm-code-bytes.mts /tmp/a.txt 18096c6`. The two addresses to ask for are
  `18096c6` (11 of 48 samples) and `180968b` (9 of 48).

#### AND THE DISASSEMBLY STEP ALMOST SHIPPED A TAUTOLOGY AS ITS CONFIDENCE READING (2026-09-10)
`scripts/disasm-code-bytes.mts` sweeps the first 16 start offsets, because the window begins 64
bytes early and x86 is variable-length, so decoding from byte zero begins mid-instruction and
produces a plausible, confidently-wrong stream — the worst output this pipeline can give.
- **ITS FIRST VERSION REPORTED "ALL ALIGNMENTS AGREE ON THE INSTRUCTION AT THE TARGET" AS THE
  CONFIDENCE, AND THAT IS TRUE BY CONSTRUCTION.** Decoding is deterministic from a byte, so any
  alignment that lands on the target decodes the same bytes and MUST produce the same answer. It
  measures nothing and it can never fail — a constant wearing a measurement's clothes, minutes
  from being shipped. **The disagreement branch it printed was unreachable code.**
- **WHAT IS ACTUALLY AMBIGUOUS IS EVERYTHING BEFORE THE TARGET** — the loop head, which is the
  part that says what the loop does. So the output is a **CONVERGENCE POINT**: the earliest
  address from which every alignment still in range agrees. From there to the target the stream
  is trustworthy; before it, it is a guess, and the script says which is which instead of
  printing one confident wall of assembly.
- **AN ALIGNMENT THAT STARTS AFTER AN ADDRESS GETS NO VOTE ON IT.** Counting silence as agreement
  would under-report how much of the head is readable — the absent-reading shape, in the
  direction that discards evidence rather than inventing it.
- **AND THE `main()` GUARD MATCHED ITS OWN TEST FILE.** `argv[1].includes('disasm-code-bytes')`
  is true for `disasm-code-bytes.test.mts`, so importing the module ran the CLI and exited 1
  before a single assertion. It compares `import.meta.url` against `pathToFileURL(argv[1])` now.
  Anchored on the wrong thing; caught by running it.
- **TWO OF THE FOUR GUARDS WERE VACUOUS AND MUTATION TESTING FOUND BOTH.** The provenance-line
  fixture contained nothing an unanchored row regex would actually swallow, so "the keys are not
  read as bytes" passed either way; and the "no vote" test's own comment admitted every run in
  its fixture started before the address, i.e. **it proved the opposite of its title**. Both
  re-done and re-verified failing. Nine mutations across this and `code-bytes`, each asserted to
  APPLY first.

#### THE LOOP IS A LINEAR SEARCH-AND-ERASE OVER A POINTER ARRAY (2026-09-10) — first read of what it DOES
`code-bytes` reached the box and answered on its first call.
`C:\Users\Tyler\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.dll`,
285,203,968 bytes, `timeDateStamp 0x6a18cf41`, `sizeOfImage 0x112d9000` — **revision 1228, the
build the box actually launches**, so the identity is confirmed from the file rather than inferred
from a lockfile.
- **ONE CALL COVERED BOTH HOT ADDRESSES.** `180968b` is 5 bytes inside the window returned for
  `18096c6`, so the second round trip was unnecessary. Ask for the higher address first.
- **THE HOT INSTRUCTION IS A POINTER COMPARISON INSIDE A GUARDED DEREFERENCE CHAIN**, and the
  code around it is unambiguous once disassembled:
  ```
  mov  eax, [rsi+0x24]          ; a COUNT
  mov  r15, [rsi+0x18]          ; an ARRAY of 8-byte pointers
  xor  r13d, r13d               ; index = 0
0x108: mov  rcx, [r15+r13*8]    ; elem = array[index]
       cmp  BYTE PTR [rcx+0x5c], 0
       jne  0xfc                ; a FLAG BYTE filters most elements out
       mov  r8, [rcx]
       cmp  QWORD PTR [r8+0x10], 0  / je 0xfc
       cmp  DWORD PTR [r8+0x1c], 0  / je 0xfc
       mov  r9, [rcx+0x20] / mov r9, [r9]
       cmp  r9, [r8]            ; <-- THE SAMPLED COMPARISON
       jne  0xfc                ; no match -> ++index, next element
  ```
  and on a match it **ERASES**: `mov QWORD PTR [rdi],0` (clear the slot), a call to release the
  old value, `mov r8d,[rsi+0x14] / shl r8,3 / add r8,[rsi+0x8] / sub r8,rdx` then a call — a
  memmove of the tail — and `dec DWORD PTR [rsi+0x14]`. **A vector erase, open-coded.**
- ~~**`rsi` CARRIES TWO CONTAINERS**: the scan reads its bound from `[rsi+0x24]` and its data from
  `[rsi+0x18]`, while the erase decrements `[rsi+0x14]` and reads `[rsi+0x8]`. So it searches one
  list and removes from another — bookkeeping, not a single collection.~~ **FALSE, AND THE ERROR
  WAS IN THE TRANSCRIPTION RATHER THAN THE READING — see the section below.** The hand-copied
  excerpt above merged TWO loops into one: the first scans `+0x08`/`+0x14` and erases from
  `+0x08`/`+0x14`, and a SECOND loop further down scans `+0x18`/`+0x24`. Each is an ordinary
  find-and-erase over its own vector, and "searches one list and removes from another" was an
  artifact of splicing them. Struck rather than deleted because it was about to become the premise
  of a search for a bookkeeping structure that does not exist.
- **THE SAMPLES ARE IN THE PEELED FIRST ITERATION, NOT THE LOOP BODY, AND THAT IS THE READING
  THAT CHANGES THE STORY.** The compiler peeled iteration one; the hot offsets `+0x05`, `+0x0e`
  and `+0x40` are all in the peel, and **zero of the 48 samples fall in the loop body at
  `0x108`-`0x13a`**. So this is not one long O(n) scan being caught mid-sweep — **it is a
  predicate being CALLED at enormous frequency and usually exiting on its first element.**
- **WHAT IS ESTABLISHED, AND WHAT IS NOT.** Established: the spinning main thread is in a
  linear search-and-erase over an array of 8-byte pointers, filtered by a byte flag at
  `elem+0x5c`, matched by comparing `[[elem+0x20]]` against `[[rdx]]`, called very often. **Not
  established: which function this is.** There are no symbols, and this file records three
  mechanisms guessed and each costing a session — **do not name one.** The `[+0x5c]` flag,
  `[+0x10]`/`[+0x1c]`/`[+0x20]` offsets and the two-container `rsi` are the fingerprint to match
  against Chromium source, and that is a source-reading job rather than another measurement.
- **A CANDIDATE, LABELLED: registry bookkeeping going quadratic.** A registry of ~16,384 live
  objects, each removal a linear scan, is O(n²) in exactly the quantity the walk counts — and it
  would explain the spin AND why nothing is released. **The peel reading argues AGAINST it**
  (samples in the entry check, not the sweep), which is precisely why it is written down as a
  candidate with its own counter-evidence rather than as a finding.
- **THE PDB KEY CAME BACK AS `[hex]` — `scrub()` REDACTED IT.** The GUID is a 32-character hex
  run and the reporter's secret-scrubber cannot tell it from a token. **The binary key survived
  (`6A18CF41112d9000`)**, which is the symbol-server key for the BINARY and is the one a later
  session with egress would use anyway. Recorded rather than fixed: loosening `scrub` on the path
  that carries RC session material to retrieve a diagnostic is the wrong trade, and this file has
  published a credential twice by collecting a field it then had to filter.

#### IT IS `blink::RejectedPromises::HandlerAdded` — NAMED FROM THE BINARY, CONFIRMED IN SOURCE (2026-09-10)
The entry above ends *"Not established: which function this is … do not name one."* **It is named
now, and not by guessing: the binary states its own source file, function name and line number, and
the source then matches the disassembly instruction for instruction.**
`third_party/blink/renderer/bindings/core/v8/rejected_promises.cc`, `HandlerAdded`, **line 222**.

**HOW — the method is reusable and cost five `code-bytes` calls.**
- **A 15-BYTE `0xCC` RUN AT `0x1809631` GIVES THE FUNCTION'S START FOR FREE.** MSVC pads between
  functions with `int3`, so the next 16-byte boundary — **`0x1809640`** — is the entry point.
  **That retires the alignment guessing `disasm-code-bytes.mts` exists to manage**: disassembly
  from a true function start is unambiguous, and the prologue that appears there
  (`push r15/r14/r13/r12/rsi/rdi/rbx`, `sub rsp,0x60`, stack cookie) confirms it landed right
  rather than merely looking plausible. **Look for the padding before sweeping alignments.**
- **`code-bytes` TAKES AN RVA, SO A WIDER REGION IS ONLY MORE CALLS.** `readCodeWindow` returns 320
  bytes from `rva-64` and the handler passes no options, so the arg is the only lever: three
  windows tiled `0x1809546`-`0x1809906` and two more reached `0x1809b7f`. **Merge by ADDRESS MAP,
  never by requiring exact tiling** — the windows overlap, and a contiguity check rejects them and
  reports a "gap" that is not one.
- **THE NAME CAME OUT OF `FROM_HERE`.** At `0x1809873`: `lea rdx,[0xff64201]`, `lea r8,[0xff641ba]`,
  `mov r9d,0xde`. That is `base::Location::Current()` — function name, file name, **line 222** —
  and `code-bytes` reads a data RVA as happily as a code one. **Chromium embeds `__FILE__` and
  `__FUNCTION__` at every `PostTask`, so any function that posts a task can be made to name
  itself.** No symbols, no PDB, no ramp, no box update.
- **THREE OTHER `lea` TARGETS WERE CODE, NOT STRINGS** (`0x7334560`, `0xc5ca9d0`, `0xc5ca700`):
  `base::BindOnce` internals — `operator new(0x38)` for the `BindState`, two function pointers, an
  invoke thunk at `+0x20`, `this` at `+0x28`. **Read a `lea` target before assuming it is a
  string**; two of the three that looked most promising were destructors.

**FOUR INDEPENDENT CONFIRMATIONS, which is what separates this from the three mechanisms this file
records as guessed at a session's cost each.** The file string, the function string, the line
number (`0xde` = 222, and `FROM_HERE` is on line 222 of that file), and a complete structural match
with nothing left over:
```
RefCounted<RejectedPromises>       -> +0x00 (8 bytes)
MessageQueue queue_                -> +0x08 buffer, +0x10 capacity, +0x14 size
Vector<..> reported_as_errors_     -> +0x18 buffer, +0x20 capacity, +0x24 size
bool collected_                    -> cmp BYTE [elem+0x5c],0
script_state_->ContextIsValid()    -> [r11+0x10]!=0 and [r11+0x1c]!=0   (IsCollected, inlined)
promise_ == data.GetPromise()      -> cmp *(elem+0x20) , *(*rdx)        (two v8::Local slots)
queue_.erase(it); return;          -> slot=0, ~Message, memmove tail, --[rsi+0x14], RET
MakePromiseStrong/GetTaskRunner/
  PostTask(FROM_HERE, BindOnce)    -> the second loop's match arm
reported_as_errors_.EraseAt(i)     -> the same erase against +0x18/+0x24
```
The `rdx` in the compare is the **second argument** (`v8::PromiseRejectMessage data`), not a member
— which is why the earlier transcription could not make sense of it. And the odd null-null match
path at `0x1809750` is just `v8::Local` comparison where both handles are empty.

**WHAT THIS ESTABLISHES.** The spinning main thread is Blink's unhandled-promise-rejection
bookkeeping. `HandlerAdded` runs once per promise that gets a rejection handler attached after
having been rejected without one, and it linearly scans `queue_` then `reported_as_errors_`.
**With the samples in the peeled first iteration and none in the loop body, the cost is the CALL
RATE and not the scan length** — so the page is attaching handlers to already-rejected promises
often enough to saturate a core.

**WHAT IT DOES NOT ESTABLISH, AND THIS IS THE HALF THAT WILL GET QUOTED WRONG: it is not where the
32 GiB comes from.** `HandlerAdded` scans and erases; it allocates nothing but one `BindState` per
second-loop match. `Message` holds v8 handles and a `SourceLocation` — V8 and Oilpan memory, and
the heap trail reads 8-11 MB flat. **The spin now has a mechanism; the mapping still does not.**

**IT DOES WEAKEN A CONCLUSION RECORDED AS SETTLED.** This file says *"VMSTACK put the loop in
native code, so RC's own JavaScript is not the loop and there is no fix on our side of the page."*
The first clause stands — the loop is native Blink code. **The inference does not.** The loop is
*driven* by JavaScript promise rejection, so RC's SPA is the workload after all; VMSTACK
distinguished native code from JIT code, which is not the same question as what drives it.
- **It also promotes a candidate this file has carried since 2026-08-17 without mechanism** — *"a
  retry loop in RC's SPA against a token that expired"*. A retry loop of failing `fetch`es is
  exactly a promise-rejection storm, and the RDR burst (**69,060 asks, zero answers of any kind**)
  is the shape that produces one. **Not a finding: nobody has paired the burst against the SPIN.**
  The recorded burst/leak decoupling is about the burst versus the 32 GiB MAPPING, which is a
  different pairing and is untouched by this.

**THE NEXT QUESTION IS SHARPER THAN "WHAT LEAKS?"** A Blink main thread that never returns to its
message loop cannot drain anything whose release runs as a posted task — and `HandlerAdded` itself
posts `RevokeNow` tasks that can then never run. **So ask what accumulates as 2 MiB pagefile-backed
shared sections while the main thread does not yield.**
- **A CANDIDATE, WITH ITS OWN COUNTER-EVIDENCE STATED.** `kLargerDataPipeAllocationSize` in
  `services/network/public/cpp/loading_params.cc` is **exactly `2 * 1024 * 1024`**, and
  `services/network/url_loader.cc` uses it for **every response body**; a mojo data pipe's ring
  buffer is one pagefile-backed anonymous shared section mapped in the renderer, which matches the
  walk on size, count-of-one-allocation-base, anonymity, protection and process. **Against it: the
  09-07 20:42 ramp carried the same 32 GiB with 110 lifetime requests**, and 110 requests cannot be
  16,384 pipes. **And the house rule bites hardest here — "an exact match on a round power of two
  is not a fingerprint" is exactly how `MappedMemoryManager` was over-credited.** Do not promote
  this without a reading that is not the number 2 MiB.

##### THE COMMIT TRIGGER FIRED, AND THE SPIN IS NOT ALWAYS `HandlerAdded` (2026-09-10 17:53 UTC)
A natural ramp arrived while a session was reading the box and was **very nearly missed** — the
memory readout's default is the last 30 samples, which by then had rolled past it, so the session
had already reported "no ramp in 13 hours", and it was found only by reading `VMTOP` out of
`bot_events` for an unrelated question. **Read `bot_events` for `ramp-scan`, not the tail of the
series** — a ramp lasting under four minutes leaves ONE sample and rolls out of the default window
within the hour.
```
17:50:51  rc=  321 MB  pid 12784 gpu-process  commit  6,968 / 47,870  free 11,054
17:52:52  rc=4,561 MB  pid  4224 renderer     commit 38,949 / 47,870  free  6,343   <- the ONLY sample
17:54:52  rc=  275 MB  pid  4188 gpu-process  commit  6,945 / 47,870  free 10,983
```
- **THE COMMIT TRIGGER FIRED FOR THE FIRST TIME: `trigger: "both"`.** `commitUsedMb 38,949` against
  `commitThresholdMb 9,000` and `rcMb 4,561` against `thresholdMb 3,000`, so both arms were true on
  the same tick. It is the arm shipped for the case where the family figure alone might not cross
  its bar, and it has now been exercised in anger rather than argued about.
- **THE WHOLE EVENT FITS INSIDE ONE TWO-MINUTE SAMPLE.** Commit went **6,968 -> 38,949 -> 6,945**,
  a ~32 GB step and back, in under four minutes — the shortest complete ramp on record, and exactly
  the "<=34 s burst, then touch" model with the touching cut short.
- **AND THE RAMP ARM ENDED IT: `bail:ramp`, `ageMs 3,450,474`.** The browser was **57.5 minutes
  old**. The RAM arm could not have: free RAM bottomed at **6,343 MB** against a 2,000 MB floor,
  another in a run this file last counted at 15+, and the arm behaving as designed rather than
  failing.

**THE FINDING: THE MAIN-THREAD SPIN IS NOT ALWAYS THE SAME CODE.** `VMSTACK` has now read three
ramps, and they split cleanly on the browser-age populations this file already records:

| ramp (UTC) | browser age | distinct paths | module/anonExec | spread | top sample |
|---|---|---|---|---|---|
| 09-10 04:26 | 2.75 min | 16 | 42 / 6 | 19 of 48 | `chrome.dll+0x180968b` x12 |
| 09-10 05:52 | 2.6 min | 16 | 43 / 5 | 23 of 48 | `chrome.dll+0x18096c6` x11 |
| **09-10 17:53** | **57.5 min** | **78** | **39 / 9** | **40 of 48** | **anon-exec (JIT) x9** |

- **BOTH YOUNG-BROWSER RAMPS SPIN IN THE `HandlerAdded` NEIGHBOURHOOD; THE OLD-BROWSER ONE DOES
  NOT.** 29 of 48 samples inside a 59-byte window becomes **40 distinct addresses out of 48**, with
  the largest single bucket being **JIT-compiled code** rather than any native address.
- **SO "THE JIT BRANCH IS CLOSED, SIX OF FORTY-EIGHT" DOES NOT GENERALISE.** That was one reading of
  one ramp, and this file recorded it as settling the fork. It settles the YOUNG population.
  `VMSTACK`'s own third documented outcome — *"samples spread over hundreds of addresses would mean
  this is not a tight loop"* — is the branch that fired here, and it is the branch nothing had seen.
- **IT IS NOT A CONTRADICTION OF THE NAMING, AND THAT DISTINCTION MATTERS.**
  `blink::RejectedPromises::HandlerAdded` is still named, from the binary, confirmed in source, and
  still what the young-browser ramps spin in. What is retired is the generalisation. The 09-10
  correction already said *"the loop is DRIVEN by JavaScript promise rejection, so RC's SPA is the
  workload after all"* — a thread mostly in JIT with a wide native spread is what that looks like
  from the other end, so the two readings are consistent and only the summary was too strong.
- **AND IT IS FURTHER EVIDENCE THE SPIN IS A SYMPTOM.** The identical 2 MiB signature arrives under
  two completely different main-thread profiles, so whatever allocates is upstream of both.
  `HandlerAdded` scans and erases; it allocates nothing. That was already true and is now visible
  from a second direction.
- **AND "BROWSER AGE" IS THE LABEL, NOT THE ESTABLISHED VARIABLE.** The 17:53 ramp is now known to
  be an **Okta trip** (`Stalled in: auto-login`), while 05:52 was a `restart-rc` replacement
  ramping on a COLD browser loading RC's home page. So the same three points are equally consistent
  with the split being **trip type** — cold page load versus Okta navigation — and age is simply
  correlated with it. **Do not build on the age framing**; what is measured is that two ramps of one
  kind spin in a tight native loop and one of another kind does not.
- **n=3, AND ONLY ONE OLD-BROWSER RAMP HAS A STACK AT ALL** — `VMSTACK` reached the box on 09-09
  evening, so the two earlier old-browser ramps (85 min, 125 min) predate it. **The correlation is
  perfect and it is three points.** The cheap confirmation is the next old-browser ramp; nothing
  needs building.

**THREE THINGS RODE ALONG FREE.**
- **A THIRD "MIDDLE" EVENT, and a big one.** 13,550 mapped regions / 27,100 MB, against a commit
  limit of 47,870 and a baseline near 7,000 — so there was room for roughly **19,000** and it
  stopped **~5,400 short of 2^14 with headroom to spare.** That is the wrinkle recorded hours
  earlier ("a middle population that neither constraint explains") gaining its third member and its
  clearest one: neither the 2^14 cap nor commit exhaustion accounts for this stop.
  **AND "WRINKLE" UNDERSTATES IT — THE SPLIT IS 6 TO 5.** Of the eleven walks that carry `VMMAP2M`,
  **six** land at 16,381-16,383 and **five** stop short (13,320 / 13,550 / 14,321 / 15,494 /
  16,213), of which only the two lowest are attributable to commit exhaustion. So stopping below
  the cap is nearly half of all observed ramps, not an exception to it, and any account of the
  2^14 maximum has to explain why it binds only about half the time.
- **THE BURST/LEAK DECOUPLING, SIXTH SIGHTING.** `distinct=78` and a busiest path of **6 lifetime
  requests** — a completely quiet counter beside 27 GB of mappings. The two are independent in both
  directions and this should stop being re-litigated.
- **THE WALK'S SIGNATURE HOLDS, ELEVENTH TIME.** 13,550 regions across **13,550 allocation bases**,
  `protect=0x4` on 13,548 of them, 64 sampled and **all anonymous**, with the control's file-backed
  positive control (`SortDefault.nls`) present as ever — and `PAGEFILE allocatedMB=31,744` against
  **`currentMB=73, peakMB=73`**, i.e. 31.7 GB charged and 73 MB ever written. Untouched mappings.
- **THE LOOP WAS STALLED 150 s IN THE `auto-login` STEP — AND THAT DOES NOT ESTABLISH A LOGIN.**
  The first reading of this event said no trip was running, inferred from a 56-minute hole in
  `tab-close` events (16:59:17 → 17:55:12) that brackets the whole ramp. **That inference is
  worthless either way**, because a trip that is KILLED emits no `tab-close` — a gap in that stream
  means a trip that did not FINISH, never that there was no trip. The log says
  `17:53:58 Stalled in: auto-login (150s in that step)` and `17:54:06 the previous sign-in attempt
  was killed before it reached a verdict — refunded`.
  - **BUT `mark('auto-login')` PRECEDES `maybeAutoLogin` IN THE LOOP** (`rc-keepwarm.mjs`, the
    `mark` on the line above the call), so the breadcrumb names the step ENTERED and a stand-down
    reads identically to a sign-in. **A 150 s stall there is equally consistent with the FEED CALL
    inside `maybeAutoLogin` hanging, with no Okta navigation at all.** Read in source rather than
    inferred from the log, after the first draft of this entry asserted an Okta trip outright.
  - **SO WHAT RAMPED IS STILL NOT ATTRIBUTED**, and the breadcrumb cannot attribute it. What would:
    a `tab-close` (absent, because it was killed), or the alloc trail naming which registered
    renderer grew — `[resident]`, `[renewal]`, `[auto-login]` or `[warmup]`. **That is a line the
    bail already prints and the log window has already rolled past.**
- **AND NO HOLD WAS QUEUED, WHICH IS A REAL QUESTION AND NOT A DETAIL.** `rc_hold_requests` has
  **zero rows touched in twelve hours**, and the restarted process said so itself at 17:54:23
  (`auto-login stood down: no hold is queued`) and at 17:54:24 for the warm-up. So something
  entered the `auto-login` step at **17:51:28** with nothing to sign in for — and the 150 s figure
  rules out a stale breadcrumb left by the 16:58 forced warm-up, which would have reported ~3,000 s.
  **BOTH READINGS OF THAT ARE WORTH KNOWING AND THEY ARE DIFFERENT FAULTS.** If it navigated, an
  unattended Okta trip with no release in view is exactly what the one-attempt-per-release rationing
  exists to bound, from an address that has eaten a twelve-hour block. If it hung in the feed call,
  then `maybeAutoLogin` can park the whole resident loop for minutes on a network read — which is
  the shape that starves the profile and loses an 08:00 cart.
  ~~**NO MECHANISM IS WRITTEN IN.** Candidates nobody has separated: a hold visible to the bot and
  already deleted server-side, a warm-up whose window was still open from the deleted hold, a step
  marked on a path that does not check the gate, or an unbounded feed read inside the stand-down.~~
  **ANSWERED THE SAME EVENING, AND IT IS THE FIRST OF THOSE FOUR: `npm test` ITSELF.** See "A
  NUMERIC TEST FIXTURE PUTS A PHANTOM RELEASE IN FRONT OF THE KEEP-WARM" directly below — the
  mechanism was read live at 19:35:40 and the run windows bracket 17:51:28. **What it explains is
  the STEP, not the stall**: `mark('auto-login')` records the step ENTERED, so a `maybeAutoLogin`
  that stood down on coverage reads identically to one that navigated. The 150 s is still
  unattributed.
- **NO RAMP MEM-DUMP, AND THE "read the trip durations" RULE DOES NOT EXPLAIN IT EITHER.**
  The ramp arm needs a **120 s**
  stall on top of the family threshold; `MEM_DUMP_STALL_MS` is **90 s**. The breadcrumb puts the
  stall at **150 s**, so it passed 90 s a full minute before the bail and **the dump's own trigger
  should have been reached then.** There is no `mem-dump` with
  `phase: ramp` anywhere in the window; the 17:57:17 one is a `baseline` on the replacement browser.
  - **BOTH CONSTANTS CHECKED IN SOURCE, because the whole argument rests on them:**
    `MEM_DUMP_STALL_MS = 90_000`, `RAMP_STALL_MS = 120_000`, `MEM_DUMP_RAMP_MB = 1500` against the
    bail's `RAMP_MB_DEFAULT = 3000`. At a 150 s stall and 4,561 MB **both of the dump's conditions
    were met a minute before the bail's**, and the trigger is called FIRST in the timer,
    unconditionally on stall. **Do NOT reach for lowering `MEM_DUMP_STALL_MS`** — 90 s was crossed.
  - **AND THE SILENCE NARROWS IT TO TWO PATHS, BOTH READ IN SOURCE.** `maybeMemoryDump` opens with
    `if (memDump.inFlight || !heapProbe) return;` — **a null `heapProbe` returns silently**, and
    `attachHeapProbe` returns `null` on any failure with no log, so one failed CDP attach at launch
    disables the dump for that browser's whole life with nothing said. The other is
    `takeMemoryDump(...).then(...).catch(() => {})`: **a THROW is swallowed with no line and the
    phase stays spent**, sitting directly beneath the comment insisting a refusal must be
    *"NAMED, ALWAYS … a silence would merge them"*. That comment governs the `!r.ok` branch and
    not the throw — the house shape, inside the fix written for its previous instance.
  - **THE DISCRIMINATOR IS ALREADY IN THE LOG AND COSTS NOTHING.** `alloc trail: resident renderer
    armed` is printed only when `heapProbe` is non-null, so its presence beside a dumpless ramp
    rules the first path out and leaves the throw. **On this event that line is in the rolled
    portion**, which is why the reading was lost — the new process printed it at 17:54:07, and that
    is a different browser.
  - **AND IT IS THE FIFTH CONSECUTIVE RAMP WITH NO ATTRIBUTION.** The only stored `ramp` dump
    remains the VOID one from 09-07. **The keep-warm log is where the answer is** — a
    `* holding the bail up to Ns` line says the grace was granted, and one of the two named
    expiries says what became of it. `tail-log rc-keepwarm` rolls at 16,000 characters, so it is
    worth reading BEFORE the next ramp pushes it out.

##### THE COMMIT TRIGGER CAUGHT THE BURST ITSELF — THE MAPPING IS COMPLETE AT 1.8 GB (2026-09-10 19:17 UTC)
Everything this investigation has ever walked was measured AFTER the mapping, during the private-byte
climb. **This one was not, and the readout says so in its own trigger line:**
```
12:17:08 PT  trigger COMMIT 44354 MB — fired DURING the burst, private bytes only 1869 MB
TARGET pid=11912 renderer privateMB=1843
  committed 34956 MB — image 310 · mapped 32848 · private 1798
  2-4M  32774 MB across 16385 region(s)   [VMMAP2M: 16382 across 16382 bases, ALL ANONYMOUS]
  pagedPoolKB=66564   handles=17827
```
- **THE FULL 32 GiB IS MAPPED, AT THE CAP, WITH PRIVATE BYTES AT 1.8 GB.** So the three-act model
  is now OBSERVED rather than inferred from a gap between two sampler ticks: the burst maps
  ~16,384 sections, and **the cap is reached IN THE BURST** — it is not something the climb walks
  up to. Any account of the 2^14 maximum has to explain a number chosen before a single one of
  those pages is touched.
- **AND IT IS A FIFTH CRITERION, WHICH REFUTES THE DATA PIPE FROM A SECOND DIRECTION.** Anything
  that maps **incrementally as work arrives** is out: one pipe per response body cannot produce
  16,384 mappings before the first byte is read. The earlier refutation was arithmetic on request
  counts (a full Okta trip is 112-239 responses); this one is about the SHAPE of the allocation and
  does not depend on counting anything.
- **THE INSTRUMENT CLASSIFIES ITSELF, AND THIS IS THE FIRST `DURING`.** The other three scans in
  the same corpus print *"AFTER the burst; the mapping was already complete"*. **That is what the
  commit arm is FOR** — it is the only trigger that can fire before the family's private bytes
  reach 3,000 MB, and it has now done the one thing the `rc` arm structurally cannot.
- **AND IT FIRED ALONE.** 17:53 was `trigger: "both"`; this is `trigger: COMMIT` with `rc` still
  well under its bar. Second firing, first solo.
- **THE PAGED-POOL CROSS-CHECK HOLDS MID-BURST TOO** — 66,564 KB over 16,382 mapped regions is
  **4.06 KB each**, and handles run ~1 per section (17,827). Both are computed from
  `Get-Process`, not from `VirtualQueryEx`, so the walk keeps its independent second witness at a
  moment when the private bytes cannot supply one.
- **EXCESS 34,551 MB against an OS commit gap of 37,586 MB.** The walk still accounts for the bulk
  of it, but the two are **~3 GB apart** where earlier (post-burst) walks agreed to within a few
  hundred — expected, since this one fired with the climb still ahead of it. **No mechanism is
  written in for the residual**; it is one reading, and the two figures come from different scans
  in the same sweep.
- **VMSTACK IS FOUR READINGS NOW AND THE SPLIT HOLDS 4 FOR 4.** This is a **young** browser (3 min
  at the bail) and it reads like the other young ones: 41 of 48 samples in a loaded module,
  **23 distinct addresses**, top `chrome.dll+0x180968b` (9 of 48), and the four `HandlerAdded`
  addresses carrying **23 of 48 between them**. The old-browser outlier stays the only one with
  JIT on top and 40 distinct.
  - **THE YOUNG WINDOW IS 23-29 OF 48, NOT A CONSTANT 29.** Entries above quote "29 of 48 samples
    in a 59-byte window" — that is the 09-09 21:26 reading, and the range across three young
    ramps is 23 / 24 / 29. **Do not read 29 as the signature**; the signature is
    `HandlerAdded`-dominant with a narrow spread, against JIT-dominant with a wide one.
  - **JIT IS SECOND HERE AT 7 OF 48** (against 5 and 6 on the other two young ones), so the two
    populations are ends of a range rather than two discrete states. **`n` is four and three of
    them are young** — the age framing is still a LABEL, not an established variable, and trip
    type remains equally consistent with all four points.
- **THE RAMP MEM-DUMP IS `target-silent` FOR THE THIRD TIME.** The walk's target is pid 11912 and
  the dump answered for seven others, six of which are in the walk's own process list — so the
  timing was right and the ramping renderer alone did not answer, exactly as the readout's join
  gloss predicts. **Nothing new: `dump-wedge-probe.mjs` settled off-box that a wedged renderer
  contributes zero allocator dumps at every level. Do not spend another ramp on it.**
- **THE RAM ARM SAT OUT AGAIN** — free RAM bottomed at **8,331 MB** against a 2,000 floor, which is
  not close. And **the GPU process was idle again** (24 threads, 0 ms of a 1,200 ms window) beside
  a renderer at 103% of a core; the readout prints its own *"CONSISTENT WITH, NOT PROOF"* caveat
  and it still applies.
- **AND THE ANSWER-LESS BURST BRANCH HAS A THIRD SIGHTING.** The same event's counter reads
  **17,699 lifetime on `futurebookingstartsendsdates` with `no answer recorded`** — no 2xx, no
  401, no `failed` — on a browser 165 s old with 16 distinct paths, i.e. the young-burst shape.
  That is the fourth branch of `loopAnswerReading` for the third time, and it is still the only
  branch that fires on that path.
- **WHAT IT DOES NOT DO: name a creator.** It sharpens the question rather than answering it —
  *what asks for 16,384 two-megabyte shared sections in one burst, before touching any of them?*

###### AND ONE INSTRUMENT WAS CONSIDERED AND PREDICTED BLIND — DO NOT BUILD IT (2026-09-10)
A section object can be open in more than one process, so enumerating handles system-wide
(`NtQuerySystemInformation(SystemExtendedHandleInformation)`) and matching the `Object` pointers
would say whether the browser or GPU process holds the same 16,384 sections. **It discriminates
hard** — a peer holding them is IPC/mojo; nobody holding them means the renderer created 16k
anonymous sections it never shared, which is not buffering at all — it needs **nothing from the
wedged renderer**, and it collects handle metadata only, so it clears the standing ban on
`ReadProcessMemory` and minidumps.
- **PREDICTED READING: the `Object` pointers come back ZERO.** Windows' kernel-address-disclosure
  mitigation zeroes them for medium-integrity callers, and **this box's processes are unelevated** —
  the same elevation gap that made `stop-all` read `$null` for a whole generation on 2026-08-15.
  That is the ~0 case the predict-first rule exists to stop.
- **THE PRECONDITION IS ONE COMMAND, NOT AN INSTRUMENT:** enumerate handles for *our own* process
  and report whether `Object` is non-zero. Build the matcher only if it is.
- **Recorded because it is the obvious next idea**, and the point of the rule is that a session
  should not spend a box update and a ramp discovering this.

##### A NUMERIC TEST FIXTURE PUTS A PHANTOM RELEASE IN FRONT OF THE KEEP-WARM (2026-09-10)
The entry above records a loop stalled 150 s in the `auto-login` step with **no hold queued**, and
calls the mechanism unestablished. **It is `npm test`, and the box printed the whole chain in
plain words while a master CI run was in flight:**
```
19:33:56Z  master Verify starts (the merge of #328)
19:35:40   warm-up stood down: the release is 5m away - inside the 30m lead,
                                where the auto-login owns this
19:36:39   warm-up stood down: no hold is queued          <- the suite swept its fixture
```
- **`worker/health-hold-counts.test.mts:148` IS `cartedHold(REAL, 5)` WHERE `REAL = '0'` — a
  `carted` row with unit id `0`, releasing FIVE MINUTES OUT.** That is the "5m away" line to the
  minute. `hold-fixture-invisibility.test.mts` carries the same shape at ~60 s.
- **AND `'0'` PASSES `REAL_UNIT`.** Read in source rather than assumed: `REAL_UNIT` is
  `unit_id ~ '^[0-9]+$'`, and **both** `nextHoldRelease` and `holdAtRisk` select
  `status IN ('requested','carted','claiming')` — so a numeric `carted` fixture is exactly the row
  they are built to return.
- **SO THE 2026-08-18 `REAL_UNIT` FIX HAS A HOLE, AND THE HOLE IS THE FIXTURE THE 08-27 GUARD
  INTRODUCED TO PROVE THE FILTER IS NOT A BLANKET MUTE.** That fixture's safety argument is
  written out at length and lists three independent reasons — `carted` and never `requested` so
  `dueHolds` never serves it; seconds old and not `claiming` so the sweeps cannot list it; the id
  is one digit, under `hold-fixture-safety`'s two-digit floor. **All three are about the CART
  path. None is about `nextHoldRelease` or `holdAtRisk`.** A safety argument that names a
  different consumer than the dangerous one is not a safety argument — the 2026-08-07 rule,
  arriving inside the fix for its own sibling.
- **THE TIMING FITS THE 17:53 EVENT WITHOUT NEEDING ANOTHER READING.** Verify run 1353 ran
  **17:48:30 → 17:58:22Z** and the step was entered at **17:51:28**. Inside, with margin either
  side. That also explains why the table read "zero rows touched in twelve hours": the suites
  sweep on the way out, and a deleted row leaves no `updated_at` behind.
- **WHAT IT EXPLAINS AND WHAT IT DOES NOT.** It explains the STEP — `mark('auto-login')` precedes
  `maybeAutoLogin`, so entering it says nothing about whether a credential was submitted, and at
  19:35 the session was healthy (token 59m) so it stood down on coverage. **The 150 s stall and
  the ramp itself remain unattributed.** Do not upgrade this into "the ramp was a test-driven
  Okta trip".
- **THE SHARP HALF IS THE ALARM, AND THE TWO SUITES DIFFER — CHECK WHICH ONE BEFORE QUOTING
  EITHER.** `health-hold-counts` inserts its own user with `(id, email)` and **no phone**, so
  `holdAtRisk` returns a row the alarm cannot ring. **`hold-fixture-invisibility` takes
  `SELECT id FROM users LIMIT 1` — a REAL account, unordered** — and its positive test asserts in
  as many words that `holdAtRisk` returns the numeric fixture (`assert.equal(risk?.hold?.unit_id,
  UNREACHABLE_NUMERIC)`). So for the seconds that row exists, the alarm's own query returns a
  fixture attached to a real person's phone. **The guard REQUIRES the dangerous behaviour**, which
  is the `held-offer-scope` shape, and the same file two tests earlier asserts a `__t` fixture must
  NOT come back because *"it would ring the owner"* — the authors were alive to the risk for
  sentinel ids and then introduced a numeric one.
- **IT HAS NOT RUNG, AND THAT IS TIMING RATHER THAN DESIGN.** The alarm also needs a session
  reported dead in the same moment, the feed is polled every 15 s, and the row is deleted a
  statement later. **Do not read "it has never fired" as a guard.**
- **AND IT IS FAR RARER THAN THIS ENTRY READS — COUNTED 2026-09-17: TWO AUTO-LOGIN TRIPS IN 297
  HOURS.** `bot_events` holds **427 `tab-close` rows labelled `renewal` and exactly 2 labelled
  `auto-login`** over twelve and a half days, across dozens of CI runs. The entry above says "the
  second observed instance", which is right about the count and reads as though every `npm test`
  produces one. **It does not**, and the reason is structural: `maybeAutoLogin` still requires the
  token to be genuinely INADEQUATE at that moment, which is a narrow window inside the fixture's
  own five minutes.
  - **SO A SESSION CANNOT PUMP CI TO FORCE AN OKTA TRIP, and that question is now closed with a
    number rather than a worry.** ~0.16 auto-logins per day is not a lever. **Pushing more often
    does not buy ramps** — which matters, because the temptation while waiting out a drought is to
    find work that needs a push.
  - **IT ALSO SHARPENS THE TRIP POOL: ~99.5% of Okta trips are RENEWALS.** The "at most 1 in 12"
    bound is caveated as pooling auto-login and warm-up trips too; in practice those are a rounding
    error, so the caveat protects against almost nothing and the bound's real looseness is the
    POPULATION split, not the trip mix.
  - **THE DENOMINATOR IS SLIGHTLY TOO SMALL, IN THE SAFE DIRECTION.** A trip killed by a bail runs
    no `finally` and emits no `tab-close`, so the ~26 ramping trips are missing from those 427.
    That makes the measured per-trip rate an OVERestimate, which is the direction that cannot
    flatter the argument above.
  - **AND THE REAL T-30 AUTO-LOGIN IS ITSELF A COIN FLIP — 1 OF 3 PRIOR RELEASES.** Five real
    releases fall inside the 297-hour `bot_events` window (09-05, 09-09, 09-15 and today's pair),
    and the only auto-login trip that pairs with one is **09-05 14:42 against a 15:00 release**,
    i.e. T-18. **09-09 and 09-15 produced none at all**, because `maybeAutoLogin` stands down when
    the token already covers the hold — a renewal mints ~60 minutes and the requirement is
    `LEAD + CART_HOLD_MIN + AUTOLOGIN_MARGIN_MIN` = 60. Whether it fires turns on where the last
    renewal happened to land.
    - **SO "the T-30 auto-login is the day's one free ramp trigger" OVERSTATES IT**, and that
      sentence was in this session's own handover. **A quiet arm at T-30 is the ordinary case, not
      a fault** — check for an `auto-login` `tab-close` before concluding anything ran.
    - **ONE CAVEAT, STATED BECAUSE IT CANNOT BE EXCLUDED:** a trip killed by a bail emits no
      `tab-close`, and 09-15 has a `bail:ramp` sixteen minutes AFTER its release. Its browser age
      (**6.2 h**) and the timing fit a renewal rather than a T-30 trip, which acts between T-30 and
      T-0 — so a killed auto-login is unlikely there and is not ruled out.
    - **AND TODAY'S OWN RELEASE THEN PRODUCED FOUR IN FOUR MINUTES, WHICH IS TWICE THE ENTIRE
      297-HOUR CORPUS.** The 09-17 15:00 release had a genuinely dead session (the 12:00 warm-up
      was stopped by a CAPTCHA), so `maybeAutoLogin` acted — and its FIRST trip ramped:
      ```
      14:31:49  rc 3,168 MB   commit 45,568 / 48,894   pid 14608 renderer   <- one sample
      14:32:00  ramp-scan (trigger both)      14:32:46  mem-dump (ramp)
      14:32:56  bail:ramp   ageMs 4,924,386 = 82 MINUTES of browser age
      14:34:00 / 14:35:01 / 14:36:01 / 14:37:06   tab-close auto-login   41.1 / 41.5 / 41.1 / 45.3 s
      ```
      **The bail killed the browser mid-trip, so that trip emitted no `tab-close` at all** — and
      the four that follow are the arm retrying on fresh browsers, every one cheap
      (`ramMb` +13 / −12 / −21 / −137). So a single release can produce a burst of them, and the
      0.16/day figure is a MEAN over a corpus where most days have none.
    - **IT IS ALSO THE MISSING-DENOMINATOR CAVEAT ABOVE, OBSERVED RATHER THAN REASONED.** That
      bullet says a bail-killed trip is absent from the 427 and calls the rate an overestimate;
      here is one, with the `bail:ramp` and the four retries either side of the hole it left.
    - **THE RAMP ITSELF IS THE OLD POPULATION AND ADDS NOTHING NEW.** 82 minutes is inside the
      52-611 minute band; the walk is thirteenth-consistent (16,386 regions / 16,381 allocation
      bases / 32,778 MB, all anonymous, main thread at 103% of a core, GPU idle); and the dump is
      **`target-silent` for the sixth time** — 8 of 8 answering pids in the walk's own list, the
      ramping renderer alone absent. **Do not spend a ramp on the dump.**
- **AND THE DASHBOARD HAS NO SUCH LUCK.** `autocart.rc_session` and the health route's hold counts
  go red for the length of a run — the 2026-08-23 finding recurring through a numeric fixture that
  **#202's `holdsAhead`/`holdsDueWithin` fix cannot see**, because that fix carries `REAL_UNIT` and
  `REAL_UNIT` is exactly what `'0'` satisfies.
- **THE OBVIOUS REPAIR IS THE FORBIDDEN ONE, AND THERE IS A NARROW ONE BESIDE IT.** Pushing the
  fixture's `release_at` far out is what the guard's own comment rules out: the row sits inside the
  next minute so it is unambiguously the minimum and an `AND false` on `REAL_UNIT` cannot pass.
  Move it out and a real production hold can beat it, which makes the guard flaky **in the
  direction that reads GREEN**. **The narrow one is to stop `hold-fixture-invisibility` borrowing
  `SELECT id FROM users LIMIT 1` and give it its own inserted user with no phone**, exactly as
  `health-hold-counts` already does — it touches neither the assertion nor the timing, and it
  closes the only path to a real handset. **NOT TAKEN HERE**: it is a real-DB fixture in
  `worker/**`, so verifying it restarts all three pollers, and a finding whose failure mode has
  never been observed is written down before it is acted on.
- **THE EXPOSURE IS BOUNDED AND IT IS NOT ZERO:** seconds per test run, on every merge. The
  routine outcome is a red dashboard plus a spent `maybeAutoLogin` turn; the tail is the alarm
  above. **Do not read a red `autocart.rc_session` within a few minutes of a merge as a real dead
  session** — check whether a Verify run was in flight first.

##### THE REJECTION COUNTER WOULD BE BLIND — PREDICTED BEFORE BUILDING IT (2026-09-10)
The obvious successor to naming `HandlerAdded` is to count the page's rejection traffic on the
resident page, in the shape `rc-request-count.mjs` already works (attach where `residentPage = page`,
report at teardown/bail/hung-close). **Do not build it. The predicted reading is ~0, and the reason
is structural rather than a matter of tuning.** Read out of Chromium source, not reasoned from the
outside:
- **`HandlerAdded` is called SYNCHRONOUSLY from V8's promise reject callback** —
  `v8_initializer.cc`: `if (data.GetEvent() == v8::kPromiseHandlerAddedAfterReject)
  rejected_promises.HandlerAdded(data);`. Nothing is queued; it runs on the spot, once per event.
- **The DOM `unhandledrejection` event is dispatched from a POSTED TASK.**
  `Agent::NotifyRejectedPromises()` calls `ProcessQueue()`, which moves `queue_` into per-context
  `MessageQueue`s and `PostTask`s `ProcessQueueNow` (`rejected_promises.cc:254`, the file's SECOND
  `FROM_HERE`); `ProcessQueueNow` is what calls `Message::Report()`.
- **A spinning main thread never runs a posted task, so the event never fires.** Both candidate
  observables — a page-side `unhandledrejection`/`rejectionhandled` listener and Playwright's
  `page.on('pageerror')` — are downstream of `ProcessQueueNow`. **They go silent during exactly the
  event they would be built for**, which is the heap trail, Track A and the RAM arm all over again:
  blind for a reason knowable before a line was written. This is the "PREDICT THE READING BEFORE
  BUILDING THE INSTRUMENT" rule paying for itself for the first time.
- **AND IT SHARPENS THE PICTURE OF THE SPIN.** Microtasks are draining — `HandlerAdded` is being
  called, so promises are settling — while posted TASKS are not. That is a microtask queue kept
  perpetually non-empty by the page's own promise chain: the event loop never advances to the next
  task. **So "the main thread is spinning" is precisely "the microtask queue never empties".**
- **`reported_as_errors_` IS CAPPED AT 1,000** (`kMaxReportedHandlersPendingResolution`, trimmed by
  10% on overflow), so the second loop is bounded and **`RejectedPromises` cannot itself grow
  without limit.** That retires the tempting sub-hypothesis that this structure is the memory, and
  it is consistent with the heap trail reading 8-11 MB flat.
- **WHAT WOULD ACTUALLY BE WORTH MEASURING IS NOT ON THIS PATH.** Anything whose release runs as a
  posted task accumulates here, so the question is which subsystem maps 2 MiB sections and frees
  them from a task — and that is answered by reading source, not by another counter on a page whose
  event loop is wedged.

#### THE 32 GiB ARRIVES IN A 33-SECOND BURST, AND THE DATA PIPE IS DEAD (2026-09-10, Route A)
Asked to name the allocator from source. It is **not named**, and saying so is the honest headline.
What the session did produce is a decisive refutation of the standing candidate, a **reframing of
the question**, and four constraints nobody had extracted from walks already in the database.

**THE COMMIT STEP IS ≤34 SECONDS, MEASURED TWICE AT SUB-MINUTE RESOLUTION.** The `bot-keepalive`
forced samples (2026-08-15) bracket a ramp far more finely than the 2-minute series, and nobody had
read them for this:
```
09-09 13:45:30  rc_mb   306  commit  7,101      quiet, pid 4384
09-09 13:45:54  rc_mb   410  commit 10,081   +2,980   <- new renderer pid 10604
09-09 13:46:27  rc_mb 1,924  commit 44,847  +34,766   <- THIRTY-THREE SECONDS
09-09 13:47:10  rc_mb 2,958  commit 45,934   +1,087
09-09 13:48:18  rc_mb 4,040  commit 47,080     +407
09-09 17:17:29  rc_mb    45  commit  6,793            <- browser replaced
09-09 17:18:03  rc_mb 1,688  commit 35,794  +29,001   <- THIRTY-FOUR SECONDS
```
- **THE MAPPING AND THE PRIVATE-BYTE CLIMB ARE TWO DIFFERENT CURVES, AND EVERY INSTRUMENT SO FAR
  HAS WATCHED THE SECOND ONE.** ~30-35 GB of commit lands in one ~33 s window while `rc_mb` is
  still at 1,688-1,924 MB; the private bytes then climb for another two minutes at ~450-900 MB/min.
  The memory series, the RAM arm and every "ramp rate" figure in this file describe the *touching*,
  not the *allocation*.
- **SO IT IS A BULK ALLOCATION, NOT A PER-EVENT LEAK.** At 2 MiB a section, ~30 GB in ≤34 s is
  **~450-500 sections per second** (an inference from the commit step, not a direct count — the
  walk fires later). That is not one-per-request, not one-per-frame (60/s), not one-per-anything a
  user does. **The question is no longer "what leaks 2 MiB at a time" but "what tries to allocate
  32 GiB of shared memory in a burst, in 2 MiB units, and stops at exactly 16,384".**
  - **QUOTE IT AS A LOWER BOUND, BECAUSE 33-34 s IS A SAMPLE GAP AND NOT A DURATION.** Both
    readings are the interval between two `bot-keepalive` samples that happen to bracket the
    step, so the burst is **at most** that long and the rate is **at least** ~482/s. The
    tempting next move is to divide it out — 2.07 ms a section — and reason about what paces
    an allocation that slowly (an IPC round trip fits; a bare `CreateFileMapping` at 10-50 us
    does not). **That inference is not available**: 2.07 ms is an upper bound on the per-section
    time, so a plain syscall loop finishing in two seconds fits the same data. Nothing here
    licenses a claim about pacing, and the sampler cannot produce one — the forced keepalive
    pair is the finest resolution this box has.
- **AND IT SHARPENS THE CEILING RATHER THAN WEAKENING IT.** Across 13 walks the 2-4M count is
  never above **16,387** and shows **no relation to `privateMB`** (2,981-4,587 MB) — so it is not
  "how far the ramp got". A cap of 2^14 reached in half a minute reads like a loop bounded by a
  count, or an allocator that gives up, rather than a slow accumulation.

**THE 2 MiB MOJO DATA PIPE IS DROPPED.** The brief required the 110-request counterexample to be
explained or the candidate abandoned. Pairing **every** walk with **its own** `request-counts`
event settles it far more strongly than one counterexample:

| requests (lifetime) | 2 MiB sections |
|---:|---:|
| **109** | **16,387** |
| **110** | **15,499** |
| 17,036 | 16,386 |
| 18,970 | 16,387 |
| 69,077 | 16,219 |
| **78,188** | **14,326** |

Requests span **717x**; sections span **1.23x**; and the two *smallest* request counts produced two
of the *largest* section counts. **Within the busy population alone there is already no
correlation** — 78,188 requests yields FEWER sections than 17,036 does. `kLargerDataPipeAllocationSize`
is confirmed to be exactly `2 * 1024 * 1024` (`services/network/public/cpp/loading_params.cc`), and
that remains the coincidence this file warns about: **an exact match on a round power of two is not
a fingerprint.**

**AND THE COUNTER HAS A BLIND SPOT THAT HAD TO BE RULED OUT FIRST — IT IS UNRECORDED AND IT
QUALIFIES EVERY READING THAT USES IT.** `rc-request-count.mjs` attaches with `page.on('request')`
**per PAGE**, and the keep-warm attaches it to the RESIDENT page only. Every renewal, auto-login and
warm-up runs in a **throwaway TAB** — and `signin.reservecalifornia.com` and
`www.reservecalifornia.com` share an eTLD+1, so by this file's own site-isolation finding they are
the **same renderer process**. **So the tab's requests happen in the ramping renderer and are not
counted.** It does not rescue the data pipe (a full Okta trace is 112-239 responses, two orders of
magnitude short of 16,384, and the counted-only population already shows no correlation) — but
**the recorded burst/leak decoupling rests on this instrument, and "109 lifetime requests" means
"109 on the resident page", never "109 in that renderer".**

**FOUR CONSTRAINTS EXTRACTED FROM THE EXISTING WALKS, ALL AGAINST THE SAME SCAN'S OWN CONTROL.**
Deltas against the healthy renderer in the same scan, which is the only rigorous comparison:
- **~1 retained HANDLE per section.** pid 11588: +13,380 handles against +13,451 mapped regions
  (0.99); three other walks give 1.0-1.14. So the owner keeps the **region object** alive, not just
  the view — a mapped view whose handle was closed would not show this.
- **~4.0 KB of paged pool per section, constant.** +53,479 KB / 13,451 regions = 3.98; another walk
  gives 3.99. That is ordinary Windows section-object overhead, and it confirms ~16k **distinct
  kernel section objects** rather than one carved-up mapping.
- **THE 32 GiB IS ESSENTIALLY UNTOUCHED.** Working set 2,965 MB against private 2,979 MB — so the
  26.7 GB of `commit/mapped` contributes almost nothing resident. Something allocates and maps
  2 MiB regions and **never writes to them**. That is the shape of a pre-allocated pool or a
  transfer that never happens, and it is why free RAM never moves (the RAM arm's blindness,
  explained from the allocation side rather than the symptom side).
- **One allocation base per region and SCATTERED** (span/packed ~5000x) — already recorded; it is
  what rules out a cage/pool/sandbox reservation carved into views.

**THE METHOD LIMIT, so the next session does not rediscover it.** Every real code-search host is
**000 at the proxy** — `source.chromium.org`, `chromium.googlesource.com`, `searchfox.org`,
`grep.app`, `codesearch.chromium.org`. `raw.githubusercontent.com` serves Chromium **by path**, and
`mcp__github__search_code` on `repo:chromium/chromium` works **only for unique identifiers**: a
control on `kLargerDataPipeAllocationSize` returned it exactly, while `"2 * 1024 * 1024"` returned
**3 files** for a pattern that occurs everywhere. **So Route A is reason-then-fetch-by-path; it
cannot enumerate.** That is why the spin was nameable (a `FROM_HERE` string gave the path) and the
allocator is not.

**A LOCAL HARNESS EXISTS NOW, AND IT MEASURES WHAT CDP CANNOT.** On Linux, Chromium's shared
regions are `/tmp/.org.chromium.Chromium.* (deleted)` mappings visible in `/proc/<pid>/maps`, so
counting 2 MiB `rw-s` regions **asks the renderer nothing** — the one property every CDP instrument
lacks, and the reason three of them got silence. A healthy renderer holds **zero**.
- **THE WEDGE WAS CONTROLLED, WHICH IS THE ONLY REASON THE FLAT RESULT MEANS ANYTHING.** An
  infinite microtask chain rejecting and handling a promise each turn (the exact described
  condition: the microtask queue never empties, and it drives `HandlerAdded`) was verified to
  wedge the main thread — `page.evaluate('1+1')` **answers before and is silent after**. Without
  that control this would have been three arms that never reached the question.
- **FLAT on all three arms** — microtask wedge, wedge + compositor animation, wedge + 300 in-flight
  fetches. **So the spin alone is NOT sufficient to reproduce the mapping.** Per this file's own
  rule, flat is much weaker than a refutation: Linux memfd/tmpfs is not a Windows section object,
  the container has no GPU and no ArcGIS (`js.arcgis.com` is 000), and 25 s is not 34.
- **THE ONE ARM THAT WOULD HAVE MATTERED NEVER RAN.** Loading RC's real page locally failed with
  `ERR_CONNECTION_RESET` — the documented agent-proxy reset of headless-Chromium TLS, with `curl`
  reaching the same host fine. **`requests=1` is the tell**; it is reported as "the question was
  never reached", not as a flat result.

**WHAT WOULD ANSWER IT NEXT, and neither is a fifth instrument.** The burst reframing makes two
things worth trying that were not before: a source hunt for something that **chunks a large size
into 2 MiB shared segments with a 16,384 cap** (fetch-by-path, since search cannot enumerate), and
the local harness pointed at a page that actually reproduces — which needs RC reachable from a
browser, i.e. an allowlist entry, not a new probe.


##### THE BURST RUNS UNTIL THE BOX SAYS NO — AND "CAUGHT MID-FILL" WAS WRONG (2026-09-10)
The reading above says the count pins at 2^14 and calls the lower walks a fill in progress.
**Half of that is right and the other half is not, and the correction is the sharper finding.**
Every walk on file, with the OS line beside the count:
```
 commitLimit  spare(limit-used)  sections
   38,784          1,078          13,325   <- NOT mid-fill: commit-limited
   40,840            625          14,326   <- NOT mid-fill: commit-limited
   43,935          1,127          15,663
   44,960          1,176          15,499
   44,960          1,177          16,219
   45,513          1,526          16,385
   45,995          1,014          16,386
   47,024            291          16,386
   47,030            457          16,387
   49,082          1,124          16,387
   50,119            425          16,387
```
- **THE CAP AND THE COMMIT LIMIT ARE SEPARABLE, AND THE CAP WINS 9 TIMES IN 12.** Computing the
  headroom the burst actually had — `(commitLimit - the box's own pre-ramp baseline - the
  renderer's private bytes) / 2 MiB` — against what it took:
```
   limit  baseline  private   could have taken   took     binding
  50,119     7,348    4,587             19,092  16,387   CAP (2,705 spare)
  49,082     7,163    3,528             19,195  16,387   CAP (2,808 spare)
  47,030     7,101    3,328             18,300  16,387   CAP (1,913 spare)
  45,513     7,050    3,289             17,587  16,385   CAP (1,202 spare)
  44,960     7,054    4,219             16,843  15,499   CAP (1,344 spare)
  43,935     8,675    3,050             16,105  15,663   COMMIT
  40,840     7,108    3,021             15,355  14,326   COMMIT
  38,784     6,793    2,981             14,505  13,325   COMMIT
```
  **On nine events there was room for 1,091-2,808 MORE sections and it stopped at 16,384 ± 3
  anyway.** That is the doubt closed: 2^14 is a real cap and not an artifact of when the scan
  fired or of how much commit the box happened to have. The three that fell short are exactly
  the three lowest commit limits, and on those the burst simply ran out.
- **"THE THREE LOWER READINGS ARE CONSISTENT WITH CATCHING A FILL IN PROGRESS" IS WITHDRAWN.**
  They are the commit-limited three. That is a different fact with a different consequence: a
  count from a commit-limited box is a FLOOR on what the allocator wanted, not a sample of its
  progress.
- **THE WALK-TIME `spare` IS 291-1,526 MB AND THAT IS THE *AFTERMATH*, NOT THE STOP.** Every
  walk finds the box a few hundred MB from its limit — but the walk fires ~77 s after the burst,
  and the private-byte climb in between is what eats the headroom. Reading the walk-time figure
  as the reason the burst stopped is the mistake this table exists to prevent: at the moment it
  stopped there was room for ~1,100-2,800 more sections in three quarters of the events.
- **SO THE SEQUENCE IS THREE ACTS, NOT ONE RAMP.** A burst of <=34 s takes 16,384 sections (or
  whatever commit allows); the private bytes then climb ~450-900 MB/min for ~2 minutes and walk
  the box to the edge of its commit limit; then the bail fires.
- **AND IT IS THE ACTUAL DANGER, stated plainly.** This is not "a leak that happens to be
  large" — it is something that allocates until Windows will not commit another 2 MiB. Getting
  to 291 MB of the commit limit is how `supervise.ps1` could not spawn a shell on 2026-08-12
  and how both Scheduled Tasks went silent on 08-17. **The containment caps the ramp; it does
  not stop the box being walked to the edge of its commit limit first.**
- ~~**DO NOT "FIX" THIS BY ENLARGING THE PAGEFILE.** On the evidence a bigger pagefile buys a
  bigger burst up to 32 GiB and no further, which is more commit taken and nothing gained.~~
  **THE PREMISE WAS RETIRED THE NEXT DAY AND THE CONCLUSION IS NOW UNSUPPORTED (2026-09-11).**
  Struck rather than deleted, because "it buys a bigger burst" is exactly the sentence a later
  reader quotes as a refusal. The burst is capped by **Chromium** at 32 GiB — one constant, one
  function, independent of the pagefile — so a larger limit **cannot** buy a larger burst. What a
  larger limit would buy is headroom for everything else on the box while one is in flight, which
  is not nothing: commit exhaustion is the only failure this box has had that needed a human.
  **It is still NOT a recommendation, and it has a precondition nobody has settled:** every
  observed spare sits **665-1,072 MB ahead of used across four different limits** (36.7 / 39.8 /
  45.5 / 47.9 GB), which is the signature of a system-managed pagefile growing exactly as much as
  it needs — i.e. Windows keeping up — rather than of a box about to run out. **If that is
  tracking rather than pressure, enlarging it buys nothing after all.** Separate the two before
  running `fix-pagefile.ps1 -Apply`; it needs a REBOOT, which ends the RC session.

**ONE CANDIDATE ELIMINATED FROM SOURCE while checking the above.** `base::UnsafeSharedMemoryPool`
is a pool of retained `UnsafeSharedMemoryRegion`s — one held handle each, mapped, reusable, which
matches the shape — and its own header says **"Up-to 32 regions would be pooled"**. Thirty-two,
not sixteen thousand. Ruled out.

##### THE BASELINE 2 MiB SECTION *IS* `gpu/mapped_memory` — AND IT IS NOT THE RAMP'S (2026-09-10)
A shortcut worth closing, because it is attractive and it is wrong. **The memory dump cannot be
read during a ramp** (a wedged renderer contributes zero allocator dumps), but it succeeds on a
HEALTHY renderer in ~350 ms — so the obvious move is to read the owner of a healthy renderer's
2 MiB anonymous section and call that the allocator. **Nobody had tried it. It works, and it
answers a different question.**
- **TODAY'S HEALTHY BASELINE NAMES IT, WITH THE COUNTS MATCHING EXACTLY.** `MDHIST` on the RC
  renderer reads `2-4M 2MB count=1`, and `MDOWNER` on the same process reads
  **`gpu/mapped_memory 2MB count=1`** — one bucket entry, one owner, same size. So
  `MappedMemoryManager` really is what puts a 2 MiB anonymous pagefile-backed shared section in
  a normal RC renderer, by Chromium's own ownership graph rather than by the size coincidence.
  **That is why the 2 MiB match was so persuasive for so long.**
- **AND THE GPU-OFF TRIAL'S OWN BASELINE SHOWS IT GONE.** The dump taken at **05:24:58 on the
  flags-on browser** (launched 05:21:50 with `--disable-3d-apis --disable-gpu`) has
  **no `2-4M` bucket at all**, **no `gpu` root at all**, and owners of only
  `discardable/segment 7MB count=2` plus `(no ownership edge) count=10`. The flags removed
  `MappedMemoryManager` from that renderer completely.
- **A BROWSER IN THAT STATE THEN RAMPED TO 16,385 REGIONS IN THE 2-4M BUCKET.** So the ramp's
  sections are **not** `gpu/mapped_memory`, and the healthy renderer's 2 MiB section **cannot be
  used to identify the ramp's allocator** — they are two different things that happen to share a
  size. The GPU-off refutation is **strengthened**, not weakened, by finally knowing what the
  baseline section was.
- **THE TECHNIQUE IS SOUND EVEN THOUGH THE ANSWER IS NO**, and it is worth keeping: the
  ownership graph resolves cleanly on a healthy renderer, off rows already stored, with no ramp
  and no box. What it cannot do is speak about a population that is absent at baseline — and the
  ramp's 16,384 is absent at baseline, which is the whole point.
- **`discardable/segment` IS THE ONE OWNER PRESENT IN BOTH**, at 4 MB a segment
  (`4-16M count=1`) — consistent with the recorded weakening of discardable on size, and not
  something the 2-4M bucket can be blamed on.

##### THE 2^14 CAP IS THE ALLOCATOR'S, NOT WINDOWS' — AND THE CHECK COST ONE QUERY (2026-09-10)
Route A's fourth criterion is *"plausibly caps near 16,384"*, and it is the one nobody has
pressed on. **There is an obvious alternative that is not a Chromium constant at all, and it
has to be killed before a source hunt keyed on that number means anything.** A 2 MiB section
needs 512 prototype PTEs at 8 bytes each = **exactly 4 KB of paged pool**, so
*"stops at 16,384 sections"* and *"stops at 64 MiB of paged pool"* are **the same sentence in
different units** — and if Windows were refusing on a paged-pool charge, the count would come
out at 2^14 with no Chromium cap involved anywhere.
- **THE 4 KB IS MEASURED, NOT ASSUMED.** Across all ten stored walks, the target renderer's
  paged pool minus the same scan's own CONTROL renderer divided by `VMMAP2M regions` is
  **4.015-4.017 KB, dead linear over a 1.23x range of counts** (13,320 -> 16,383). So the
  identity is real and the ambiguity is real.
- **ELIMINATED TWO WAYS, off rows already in `bot_events`.** Over the six capped walks:

  | | count (`VMMAP2M`) | target paged pool |
  |---|---|---|
  | spread | 16,381-16,383 (**±0.012%**) | 66,552-66,582 KB (**±0.045%**) |

  1. **THE COUNT IS THE TIGHTER QUANTITY, BY ~4x.** A binding byte ceiling makes the BYTES the
     pinned number and forces the count to absorb the slack left by everything else charging
     paged pool. It is the other way round.
  2. **THE RANK CORRELATION IS POSITIVE.** The two walks at 16,383 carry the two highest
     paged-pool figures and the two at 16,381 the two lowest. A ceiling predicts a flat pool
     with the count varying **inversely** against the ~150 other mapped regions (which
     themselves vary 150-158 across those same six walks).
- **SO CRITERION 4 STANDS: something in the allocator caps the 2 MiB population at 2^14**, and
  a source hunt for that number is hunting a real thing. **Six capped walks is a small sample**
  and both readings are about ±30 KB of spread — this is an elimination, not a proof, and the
  reason to record it is that the quota idea is the first thing a fresh reader will raise.
- **AND IT LEAVES A FREE CROSS-CHECK ON THE WALK.** Excess paged pool ÷ 4.015 is an INDEPENDENT
  count of the sections — it comes from `Get-Process`, not from `VirtualQueryEx` — and it agrees
  with `VMMAP2M regions` on all ten walks. The walk has never had a second witness before.
- **NO RAMP, NO BOX, NO NEW INSTRUMENT.** The hypothesis was raised and killed inside one query
  against stored rows, which is the shape Route A is supposed to have.

##### THE 2 MiB UNIT NOW IDENTIFIES NOTHING — TWO OF THREE CANDIDATES DEAD, AND 16,384 IS NOT A CHROMIUM CONSTANT (2026-09-10)
The record's next step for a rampless day is *"which subsystem maps 2 MiB sections and frees them
from a task — and that is answered by reading source, not by another counter."* Taken, with a
capability no earlier session had: `chromium.googlesource.com`, `source.chromium.org` and
`searchfox` are all 000 at the proxy, and `mcp__github__search_code` **cannot enumerate** (its own
control: `"2 * 1024 * 1024"` returned 3 files for a pattern that occurs everywhere). A **sparse
partial clone** — `--depth 1 --filter=blob:none --sparse`, tip `ca4eadea`, **91 MB of git and 151 MB
checked out** — makes an exhaustive `grep` possible instead. Searched: `base/memory`, `mojo`,
`gpu/command_buffer`, `components/discardable_memory`, `services/network`, `content/browser/loader`,
`third_party/blink/renderer/platform/loader`, `third_party/blink/renderer/core/fetch`.

- **EXACTLY TWO 2 MiB CONSTANTS EXIST IN ALL OF IT**, and one is already refuted:

  | candidate | 2 MiB? | status |
  |---|---|---|
  | `gpu::SharedMemoryLimits::mapped_memory_chunk_size` | yes, 2,097,152 exactly | **the proposed mechanism is REFUTED** — the GPU-off trial ramped on trial one |
  | `base::DiscardableSharedMemory` segments | **NO — 4 MiB** on 64-bit Windows | out on size, now read in source |
  | `network::kLargerDataPipeAllocationSize` | yes, 2,097,152 exactly | the only survivor on size |

- **THE GPU ROW IS THE RECORD'S OWN WORDING AND NOT A DEGREE STRONGER.** What the trial refutes is
  `MappedMemoryManager` serving RC's WebGL map — the mechanism as proposed, and the one the 2 MiB
  identity was matched against. **`--disable-gpu` leaves a GPU process running, so a DIFFERENT
  command-buffer client is not excluded by arithmetic alone**, and the baseline dump's own
  `gpu/command_buffer_memory — 2 MB across 2 mappings` shows the allocator is present and small in
  a healthy renderer. It is out as an explanation, not struck from the codebase.
- **DISCARDABLE IS OUT BY SOURCE, NOT BY A SNIPPET.** `GetDefaultAllocationSize()` returns
  `4 * kOneMegabyteInBytes` on every branch except 32-bit and low-end Fuchsia; the 1 MiB
  low-end value is unreachable on this box. The record already weakened it "on the same
  evidence"; it is now closed rather than weakened.
- **AND THE COUNT IS NOT A CHROMIUM CONSTANT.** `16384` / `1 << 14` / `0x4000` across all of
  those trees returns **nothing that governs a mapping**. Every hit, in full: a memory
  ALIGNMENT (`kProtectedMemoryAlignment`), two BIT FLAGS (`SHARED_IMAGE_USAGE_SCANOUT_DCOMP_SURFACE`,
  `kUniform4ui`), a D3D texture DIMENSION, two byte sizes (`kMaxPendingDatagramBytes` and
  `max_transfer_buffer_size`, both 16 **MiB**, caught by the same pattern), a test fixture, and
  `gpu/command_buffer/service/client_service_map.h`'s `kMaxFlatArraySize = 0x4000` — the
  client↔service **id map**, service-side, not a renderer allocator. Separately, `kMax… = <number>`
  across `mojo/` and `base/memory/` yields nothing above `kMaxStoredBuffers = 32` and
  `kMaxAttachedHandles = 256`.
- **SO ROUTE A's CRITERION 4 WILL NOT BE SATISFIED BY FINDING A `kMax… = 16384`.** Either the cap
  lives outside the allocator families, or — the reading this session prefers and does not claim —
  **16,384 is not a cap in Chromium at all**, and the number comes from the box rather than the
  binary.
- **THE SURVIVOR CANNOT SUPPLY THE COUNT, WHICH IS THE BIND.** A data pipe's ring buffer is one
  shared region per in-flight response body, mapped in the renderer, anonymous, READWRITE — every
  column of the walk — and `kMaxNumConsumedBytesInTask`'s own comment establishes the drain is a
  **posted task** (*"When there are more bytes in the data pipe, they will be consumed in following
  tasks"*), which is exactly the "anything whose release runs as a posted task accumulates here"
  shape a wedged main thread produces. **And a full Okta trip is 112-239 responses.** Two orders of
  magnitude short of 16,384, on an event (09-07 20:42) that carried the identical 32 GiB.
  **THE 09-10 17:53 RAMP MAKES THAT ARITHMETIC MUCH SHARPER.** Its counter stored 78 distinct paths
  with a busiest of **6 lifetime requests**, so the resident page made **at most ~468 requests in
  the browser's whole 57.5-minute life** — a bound, not a total, since only the top ten rows are
  stored. Even adding the uncounted tab trips (two renewals at ~130 responses each) puts the
  renderer's whole traffic near 700 against **13,550 sections**. A pipe per response body cannot be
  it, and this is the first event where the bound comes from the same scan as the section count
  rather than from a different day.
- **THEREFORE THE HONEST HEADLINE IS THE NEGATIVE: the 2 MiB unit is no longer evidence for
  anything.** Of three exact-size matches, one is refuted by experiment, one by source, and the
  third cannot produce the count. **This is the file's own rule paying out — "an exact match on a
  round power of two is not a fingerprint" — and it should now be read as retiring the size as a
  search key rather than as narrowing the field to the data pipe.** Do not promote the data pipe on
  the strength of being last man standing; being last in a field of three that were all selected
  BY the 2 MiB coincidence is not evidence.
- **WHAT THIS DOES NOT TOUCH.** The spin (`blink::RejectedPromises::HandlerAdded`) is unaffected —
  it is named, from the binary, and confirmed in source. So is the microtask-queue reading. What is
  retired is one search key, not a finding.
- **THE CLONE IS CHEAP AND WORTH RE-MAKING.** 91 MB with `--filter=blob:none --sparse`, and blobs
  arrive only for the paths checked out, so widening the search is `git sparse-checkout add`. **Do
  NOT clone it whole** — and do not reach for GitHub code search, which cannot enumerate. This is
  the first session able to grep Chromium exhaustively; the negative above is the first thing that
  capability bought.

#### THE 32 GiB CEILING IS `base::SharedMemorySecurityPolicy`, AND THE LEAK IS REPRODUCED (2026-09-11)

Asked to run Route A — reason-then-fetch-by-path against Chromium source — and to probe everything
that could produce a result. **The ceiling is named from source with exact arithmetic, the allocation
family is proved, and the mechanism is REPRODUCED locally with two single-variable controls.** No
ramp, no box update, no instrument was needed for any of it.

**THE CONSTANT.** `base/memory/shared_memory_security_policy.cc`:
```cpp
// 32 GB of mappings ought to be enough for anybody.
constexpr size_t kTotalMappedSizeLimit = 32ULL * 1024 * 1024 * 1024;   // 34,359,738,368
...
if (total_mapped_size >= kTotalMappedSizeLimit) { return false; }      // >=, not >
```
A per-process atomic budget on **total currently-mapped shared memory**, added to stop an attacker
spraying the address space to defeat ASLR (its header cites Project Zero's *Virtually Unlimited
Memory*). `34,359,738,368 / 2 MiB = 16,384 exactly`, and because the check is `>=` the mapping that
would land on the limit is refused — so **the maximum reachable pure-2 MiB count is 16,383.**

- **THE MEASURED POPULATION IS 16,381-16,383 AND NEVER ABOVE**, six capped walks. The 1-3 shortfall
  is the renderer's OTHER budget-counted shared mappings: `AlignWithPageSize` rounds to the Windows
  **allocation granularity (64 KiB)**, so a handful of small shared mappings costs 64 KiB each, and
  the arithmetic puts the residual at **0-6 MiB** across the six. Exactly the right magnitude and
  exactly the right direction. Nothing else in the widened checkout is 32 GiB — one grep, one hit.
- **IT IS COMMIT-INDEPENDENT**, which is why nine of twelve events stopped with 1,091-2,808 sections
  of headroom. **And it answers the "middle population" wrinkle more simply than that entry does:**
  a cap is a CEILING, not a target — an event whose driver ran out of work stops below it. Labelled
  a candidate, but it needs no second constraint.
- **THE REFUSAL IS SILENT.** `MapAt` returns `std::nullopt` — no log, no CHECK, no crash. That is why
  nothing anywhere reports hitting it.

**SO THE SECTIONS ARE `base::SharedMemoryMapping`s, AND THAT IS THE STRONGER FINGERPRINT.** Only two
callers charge this budget (`PlatformSharedMemoryRegion::MapAt` and `ChannelLinux`, which is Linux
only), so anything stopping at exactly this number went through `base`'s shared memory. **A raw
`MapViewOfFile` would not stop there at all** — the stopping point IS the evidence of the code path.
Note how much stronger that is than the 2 MiB coincidence this file spent weeks on: 2 MiB is a
common granularity, whereas 32 GiB with a `>=` producing a maximum of 16,383, matched to within
0.01% on six independent walks, is one constant in one function.

**AND NO PEER HOLDS THEM — the walk's own `CHROME` lines said so and nobody had read them.**
Every process of the 09-11 05:28 generation:
```
pid=12984 browser     privateMB=240   pagedPoolKB=1167   handles=1224
pid=4884  gpu-process privateMB=110   pagedPoolKB=1256   handles=832
pid=8976  utility     privateMB=29    pagedPoolKB=991    handles=391
pid=9180  renderer    privateMB=76    pagedPoolKB=798    handles=401
pid=14676 renderer    privateMB=2408  pagedPoolKB=58731  handles=14721   <- TARGET
```
Excess paged pool `57,953 KB / 14,433 regions = 4.015 KB` — the prototype-PTE cost of a 2 MiB
section — so **one section, one handle, one mapping, in ONE process.** That eliminates every
candidate needing a peer: **ipcz `NodeLinkMemory` expansion is out** (`RequestBlockCapacity` shares
each new buffer with the remote node, which maps it — and it is otherwise a good fit, since
`8 blocks x 256 KiB` rounded to `kBlockAllocatorPageSize` is exactly 2 MiB); **discardable is out**
(the browser's manager retains every segment); **GPU transfer is out twice over.**

**THE SIZE GREP IS CLEAN, WHICH IS ITSELF THE LESSON.** Across `base mojo gpu components content
services third_party/blink third_party/ipcz media cc skia ipc`, the only fixed 2 MiB SIZE constants are
`mapped_memory_chunk_size` (refuted by the GPU-off trial), `kLargerDataPipeAllocationSize`, and
ipcz's soft cap — which is not a buffer size. **So a 2 MiB allocation is either one of those or
COMPUTED, and a size grep is blind to computed sizes.** ipcz is the worked example.

##### REPRODUCED LOCALLY, WITH CONTROLS — a wedged main thread plus undrained responses
**`scripts/leak-repro.mjs`** drives the container's own Chromium and counts 2 MiB shared mappings by
reading **`/proc/<pid>/maps` from OUTSIDE the process** — the one property every CDP instrument
lacks, and the reason three of them got silence. The cap constant is identical on Linux.

| candidate | 2 MiB shared mappings in the renderer |
|---|---|
| idle control | **0** |
| `promise-spin` — the recorded microtask wedge, no fetches | **0** |
| `fetch-fail` — tight fetch loop, connection refused | **0** |
| `fetch-ok` — fetch and drain the body | **0-1** |
| `fetch-nodrain` — fetch, retain the Response, never read the body | 13 -> 31, climbing |
| **`wedge-and-fetch` — microtask loop that issues fetches and never yields to the task queue** | **12 -> 800 in 30 s, linear** |

and pushed harder, with the per-process breakdown taken live:
```
pid=2738 renderer 2MiB_shared=3208 (6.3 GiB)   <- the wedged renderer
pid=2696 utility  2MiB_shared=6                <- the network service, which CREATES them
browser processes                    0
```
**That is the production peer asymmetry reproduced exactly** — 14,721 handles in the renderer against
1,224 in the browser and 180-391 in the utilities.

- **BOTH SINGLE-VARIABLE CONTROLS ARE FLAT.** Wedging alone does nothing; fetching alone does
  nothing. **Only the two together.** That is what makes this a controlled comparison rather than an
  observation, and it is the first time this leak has been reproduced at all.
- **THE CAP ITSELF WAS NOT REACHED LOCALLY.** The run was stopped at 3,208 because the container was
  at 14.3 GB of 16 GB — the retained `Response` objects, not the mappings. **So the 16,383 plateau is
  proved from source and matched against six production walks, and is NOT directly observed here.**
  Say it that way.
- **AND IT IS A DIFFERENT BUILD ON A DIFFERENT PLATFORM — say that too.** The container runs
  Chromium **141.0.7390.37 on Linux**; the box runs **149.0.7827.55 on Windows**, where the
  sections are pagefile-backed rather than memfd. **That is the exact shape that burned the native
  sampler twice** (validated in the dev container, absent in production), so what the repro
  establishes is the MECHANISM and not the production event. It transfers on the two things that
  matter — `kTotalMappedSizeLimit` and `kLargerDataPipeAllocationSize` are both cross-platform and
  both long-standing — and the production event is still carried by the cap arithmetic, the peer
  handle counts and the source chain, not by this run.

##### THE SOURCE CHAIN, READ RATHER THAN INFERRED
1. `services/network/url_loader.cc:1221`, inside **`ContinueOnResponseStarted`** — a data pipe of
   `GetDataPipeDefaultAllocationSize(kLargerSizeIfPossible)` = **2 MiB**, created **when the response
   starts**, in the network service. **Not at request time** — so an unanswered request costs
   nothing, which is why the 09-08 event's 69,060 answer-less asks produced no pipes and why the
   burst/leak decoupling is real.
2. `mojo/core/ipcz_driver/data_pipe.cc:155` — `CreatePair` creates ONE region and **maps BOTH ends in
   the creating process**, then one end is sent away and its mapping goes with it. That is why the
   network service holds only its handful of in-flight producers.
3. `DataPipe::Deserialize` — the receiver **maps on arrival, on the IO thread**, before the main
   thread ever sees the message. **So a wedged main thread does not prevent the mapping; it only
   prevents the release.**
4. `mojo_url_loader_client.cc` — `DeferredOnReceiveResponse` holds the consumer handle in an
   **unbounded** `deferred_messages_` vector. There is no back-pressure between the pipe arriving and
   the main thread running.
5. `kLimitForRendererSideResourceScheduler = 1024` — a renderer may have 1,024 requests outstanding,
   so the rate is structurally available.
6. **The size is compile-time**, not a Finch flag: `GetDataPipeDefaultAllocationSize` only drops to
   512 KiB on ChromeOS and 32-bit. **There is no runtime lever to shrink it.**

##### WHAT THIS DOES NOT ESTABLISH — the production count, and it is an INSTRUMENT gap
One pipe per response means ~14,433 answered responses in that renderer inside the burst. The
resident page's counter read **20 lifetime requests** over the 09-11 browser's 611 minutes, and a
full Okta trip traces 112-239 responses. **The arithmetic does not close.**
- **`requestCounter.attach(page)` is on the RESIDENT page alone.** Subframes ride the same event, but
  **dedicated workers, service workers and the throwaway tabs do not** — and `withNetworkTrace` is
  equally page-scoped. So both counters are blind to most of what the renderer does.
- **That is a named gap, not a refutation of the mechanism**, and it is the next thing worth closing.
  **Do not read "20 requests" as "20 responses in that renderer".**
- **AND THE RATE IS NOT HYPOTHETICAL — it is in `request-counts` already.** The burst-carrying
  ramps read `recent` of **45,369 and 49,356 in the last 120 s** on
  `rdapi.reservecalifornia.com/api/webaccessfacility/futurebookingstartsendsdates` — i.e. about
  **380-410 asks per second on the resident page**, which is the ~425/s the leak needs. So the
  driver exists and is measured; what is not established is how many of those are ANSWERED.
  **Their `statuses` map is `{}`**, which the readout glosses as nothing coming back — and an
  empty status map over 78,171 asks is as much a question about the instrument as about RC.
- **THE QUIET RAMPS ARE THE REAL COUNTER-EXAMPLE, NOT THE BUSY ONES.** 09-11 05:28 (79 distinct,
  top path 20 lifetime) and 09-10 17:53 (78 distinct, top 6) ramped with no burst at all. Those
  are where the page-scoped blind spot has to be doing the work, and it is the one place this
  account is still carried by an instrument gap rather than by a reading.
- **AND THE GAP HAS A ONE-LINE FIX, CHECKED IN PLAYWRIGHT'S OWN TYPES RATHER THAN ASSUMED.**
  `request.serviceWorker()` and *"Requests originated in a Service Worker do not have a frame"*
  say what the scoping is: **service-worker requests are reported on the CONTEXT, not the PAGE**,
  and `page.on('request')` is frame-scoped. So moving `requestCounter.attach()` from
  `page.on('request')` to **`context.on('request')`** closes the service-worker gap AND the
  throwaway-tab gap at once, because a context event covers every page in it. Subframes already
  ride the page event, as that module's header records. **Dedicated workers are NOT settled** —
  Playwright's `Worker` class has no request event either way — so do not claim that half.

##### WHAT IT CHANGES, AND WHAT TO STOP DOING
- **The damage is hard-capped by Chromium at 32 GiB of commit**, known rather than hoped. The box's
  ~47 GB peak is ~7 GB baseline plus the cap plus slack. The sections are **never touched** (working
  set tracks private bytes, and the pagefile in use is 73 MB against 31.7 GB charged), which is
  exactly why the RAM arm has sat out fifteen-plus ramps: **it watches the one resource that is not
  running out.**
- **STOP CITING "the sections are NOT base shared memory".** That verdict came from the 09-07 VOID
  dump of a healthy REPLACEMENT browser; all four ramp dumps are `target-silent`, so `shared_memory`
  has never been read for a ramping renderer. The cap proves it IS base shared memory.
- ~~**The fix is not ours to make.**~~ **TRUE OF THE ALLOCATION AND FALSE AS WRITTEN — see "THE
  CURE" directly below (2026-09-16).** No flag shrinks the pipe, the drain is a posted task and
  the wedge is RC's own promise loop, so none of the three *mechanisms* is ours. What does not
  follow is that there is nothing to build: **the wedge can be ended from OUTSIDE the page**, and
  closing the page releases every mapping it held. Struck rather than deleted, because "not ours
  to make" is exactly the sentence a later reader quotes as a reason to stop looking. **The
  containment we already have is what bounds it** — and it is now a bounded problem rather than
  an open-ended one.
- **BUT "CONTAINED" IS NOT "CURED", AND THE RESIDUAL IS COMMIT (measured 2026-09-11).** Six onsets
  in the following 48 hours, `bail:ramp` on all six, peak `rc_mb` down to **4,661 MB** from 8-9 GB
  — so the containment really does cut the private-byte climb every time. **It does not touch the
  mapping**, which completes in ≤34s: COMMIT still reached **46,807 MB of a 47,870 MB limit**, with
  **665 MB** of headroom at the tightest. Free RAM never fell below 5,140 MB, so the arm that
  watches RAM structurally cannot help. **Nothing anywhere is gated on commit**, and commit
  exhaustion is the only failure this box has had that needed a human. Four options, with their
  predicted readings and counter-arguments, are under **"THE RESIDUAL IS COMMIT, AND NOTHING
  WATCHES IT"** in the Open block.

#### THE CURE: RECYCLE THE WEDGED **PAGE**, NOT THE BROWSER (2026-09-16) — measured, and bounded
The mechanism was settled on 09-11 and named three things that are not ours — the 2 MiB pipe size
(compile-time, no Finch flag), the drain (a posted task), and the wedge itself (RC's own promise
loop). **It named a fourth thing that IS ours, and nobody had looked at it: the PAGE.** A renderer
holds its mappings for as long as its page exists, so ending the page ends them — and a page close
needs nothing from the main thread that is wedged.

`scripts/auto-cart-bot/page-wedge.mjs` is one small module and one arm in the keep-warm's existing
watchdog timer: probe the resident page, and after `WEDGE_STRIKES` (3) consecutive no-answers at
`WEDGE_PROBE_EVERY_MS` (10 s), close the page and let the loop's own reopen path rebuild it.

- **THE PROBE IS A BOUNDED `page.evaluate('1')`, AND THE BOUND IS THE WHOLE THING.** Playwright's
  `evaluate` has **no timeout**, which this repo already recorded on 2026-08-17 when four keep-warm
  wedges could not say which await hung and `evaluateWithin` was built. **The first draft of this
  probe forgot it and hung for ever** — a detector that can hang takes the watchdog with it.
- **THREE MEASUREMENTS, in the container, against the reproduction `scripts/leak-repro.mjs` makes:**
  1. **The bounded evaluate IS a working wedge detector** — a wedged page times out every time while
     a healthy one answers in a millisecond.
  2. **`page.close({ runBeforeUnload: false })` released 1,052 mappings (2.06 GiB) in 86 ms** on a
     page whose main thread would not answer a single CDP call.
  3. **`page.reload({ timeout: 8000 })` on the SAME page HUNG past its own timeout** and had to be
     killed at 70 s. **Close, not navigate** — a reload asks the renderer to do something and a
     wedged renderer does nothing.
- **`runBeforeUnload: false` IS LOAD-BEARING FOR THE SAME REASON.** An unload handler runs on the
  thread that is wedged, so asking for one is how the close inherits the hang it exists to end.
- **VALIDATED END TO END AGAINST THE REAL REPRODUCTION, using the SHIPPED exports rather than a
  copy** (`node scripts/leak-repro.mjs wedge-and-fetch 30 --fix`): `peak = 233 <<< CLIMBING`, then
  `probe=wedged strikes=3 act=recycle`, then `mappings 233 -> 0 in 2525ms <<< CURED`. **The verdict
  refuses `CURED` unless the run CLIMBED first** — releasing nothing proves nothing, which is the
  rule `rc-probe.mjs --concurrent-mint` learned by publishing a race that never raced.
- **IT IS FIRST IN THE TIMER, AND THE ORDER IS THE DESIGN.** A page close costs one RC page load;
  the `HUNG_MS` and ramp arms cost the RC SESSION (~11 minutes, measured). Giving the expensive
  arms first refusal spends a session on something a close fixes. **And the thing it destroys is
  already dead**: a wedged resident page answers no CDP, so `checkAndReport` cannot read it and
  `readLiveToken` cannot reach `window.__camphawkRcToken`.
- **THE TOKEN IS PERSISTED FIRST, bounded at 2 s** — the same `persistLiveToken` call, for the same
  reason, that `reportAndBail` and the runner's preemption path make. The live token lives in PAGE
  memory and dies with the page (2026-08-30).
- **A REJECTION IS NOT A WEDGE.** "Target closed" and "Execution context was destroyed" reject
  INSTANTLY and mean the page is CHANGING, which is the healthy case; counting them would rack up
  three strikes during an ordinary reopen and recycle a page that was never wedged. Only silence
  counts, and an inconclusive reading neither strikes nor clears.
- **THREE STRIKES, NOT ONE.** A single miss is a GC pause, a heavy paint, or a same-site tab loading
  Okta on the shared main thread. **The renewal is the case to survive and it is measured**: it
  stalls the LOOP for 46-71 s across 133 tab closes while the resident renderer goes on answering
  CDP throughout — which is how the heap trail samples it every 10 s during healthy renewals. So a
  healthy renewal produces `alive` readings and never reaches a strike.
- **THE RECYCLE BUDGET ESCALATES RATHER THAN LOOPING** (`WEDGE_MAX_RECYCLES` 3, per browser life).
  Three fresh pages that all wedge is not a page fault, and a cheap action repeated for ever is the
  crash-loop shape `supervise.ps1` stops loudly for. Past the budget it hands over to the bail,
  whose diagnostics are worth more than a fourth attempt.

**IT BOUNDS THE LEAK. IT DOES NOT ELIMINATE IT, AND THE MODULE'S OWN HEADER SAYS SO.** The
production burst maps 16,384 sections in **≤34 s**, and a detector that must first observe
unresponsiveness cannot beat all of that — at three strikes and a 10 s cadence it acts at ~30 s,
so a fast burst still completes. What it changes is the DURATION: today a wedged page holds its
32 GiB until the 120 s ramp arm or the 12-minute `HUNG_MS` arm kills the whole browser, and now it
is released in seconds by closing a page nothing can use anyway. **Do not write this up as the leak
being fixed.** The true cure is to stop RC's SPA running unattended for hours, and parking the
resident page is already REFUSED for a different and still-valid reason (`checkAndReport`'s
localStorage rule would silence `autocart.rc_session` and the phone alarm permanently).

- ~~**UNPROVEN IN PRODUCTION, and that is the honest state.**~~ **IT FIRED ON 2026-09-17 AT
  09:50:17 UTC — see "IT FIRED" below**, which is the reading this bullet's "HOW TO READ THE FIRST
  FIRING" was written for, and it matched line for line. Struck rather than deleted because the
  prediction is what makes the firing legible, and because the platform caveat below it is
  UNCHANGED: every measurement above is still a
  container-local Chromium against a synthetic wedge. **It is BOT-SIDE, so it is inert until the
  box updates** — confirm with `bot-ask git-status`, never `autocart.bot_version`. **HOW TO READ
  THE FIRST FIRING:** a `♻` line in `logs\rc-keepwarm.log` naming the wedge, then
  `closed the wedged page in Nms`, then the loop reopening — with **no** `✗ RAMP` and no `✗ WEDGED`
  beneath it. A `request-counts` event with `reason: 'wedge-recycle'` carries what that page was
  asking for; the counter resets on the reopen, so it is the only record.
- **THE LEVER FOR THE FIRST FIRING IS `restart-rc`, NOT A TEST HOLD.** A forced restart makes a
  COLD browser loading RC's home page — the shape the 02:0x cluster turned out to be — and it is
  **2-for-2** against a 10% pooled base rate, with no campsite locked, no password submitted and
  no Okta precondition. The warm-up route is 3-in-7 and spends a password submission from an
  address that has eaten a twelve-hour block. **Pace forced restarts at ~15 minutes**:
  `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves the RC pair dead.
- **THE SERIES IS THE CORROBORATING INSTRUMENT HERE, NOT THE PRIMARY ONE.** The ~32 GiB commit
  step still happens — the burst completes in ≤34 s, faster than any detector — but a ramp cleaned
  up at ~30 s can fit **entirely between two two-minute samples**, leaving one elevated row or
  none. **Do not read a quiet `chromium_memory_samples` as the arm not firing**; read the log and
  `bot_events` first. What the series should show if it does fire is a peak **below the 3,000 MB
  the bail arm has been capping at**, and a return to baseline within about one tick rather than
  after ~2 minutes.
- **TWO PREDICTED FAILURE MODES, WRITTEN DOWN BEFORE THE FIRST RUN SO THEY CAN BE FALSIFIED.**
  1. ~~**A FLAPPING PAGE NEVER REACHES THREE STRIKES** … untested in both directions.~~
     **ANSWERED 2026-09-17 OUT OF DATA ALREADY IN `bot_events`, AND NOT BY AN EXPERIMENT.** The
     mechanism stands as written — one `alive` reading resets the counter, by design, and the
     repair would be a decaying counter — but **no production reading supports a flapping wedge
     and three independent instruments point against it.** Joining every `phase: ramp` memory
     dump against the `ramp-scan` for the same event, which nobody had done:
     ```
     ramp dump            ms   lead_pid  lead_shmMB   walk TARGET   verdict
     09-07 09:04:03Z     234       7316           2          9912   DIFFERENT renderer
     09-09 04:43:42Z   20011       9472           5          7644   DIFFERENT renderer
     09-10 19:18:21Z   20003      11628           8         11912   DIFFERENT renderer
     09-11 05:28:53Z   20000       1864          12         14676   DIFFERENT renderer
     09-11 11:00:18Z     479       4996          18             -   no walk to join
     09-15 15:16:09Z   15367       1012          10          5720   DIFFERENT renderer
     ```
     - **THE RAMPING RENDERER CONTRIBUTED TO NONE OF THEM, FIVE FOR FIVE.** Every dump's lead is
       a different pid from the walk's target, holding 2-18 MB of shared memory — a healthy peer,
       not a renderer holding 16k mappings. That is the `target-silent` shape, and it is now
       countable rather than anecdotal.
     - **AND THE LEAD PID WAS THE WEAK FORM OF THAT CLAIM. THE TARGET IS ABSENT FROM THE WHOLE
       DUMP, AND FOUR OF THE FIVE DUMPS COVER THE REST OF THE GENERATION EXACTLY** — parsed out
       of each event's own `MDPROC` and `CHROME` lines rather than off the lead:
       ```
       ramp dump          dump pids in the walk's list      walk TARGET   target in dump?
       09-07 09:04Z       0 of 7      <- generation mismatch        9912   no
       09-09 04:43Z       7 of 7                                    7644   no
       09-10 19:18Z       6 of 7                                   11912   no
       09-11 05:28Z       8 of 8                                   14676   no
       09-15 15:16Z       8 of 8                                    5720   no
       ```
       So `target-silent` is measured four times rather than argued from one lead pid, and the
       09-07 VOID is confirmed as the one genuine **generation mismatch** (zero overlap — the
       bail had already replaced that browser). **The 6-of-7 is not a story**: one dump pid
       outside the walk's list is a process born or reaped between two scans a minute apart.
     - **AND THE WEDGED RENDERER IS ABSENT ON WINDOWS, NOT PRESENT-AND-EMPTY — WHICH IS A
       PLATFORM DIVERGENCE FROM THE PROBE THAT SETTLED THIS.** `dump-wedge-probe.mjs` measured,
       on Linux, that the coordinator gives up on a silent child and **emits a process dump for
       it anyway, carrying ZERO allocators** — the reading that made "our fold dropped it" the
       fix. On the box the target is simply not in `MDPROC` at all, and **`emptyPids` is `[]` on
       every post-fix dump** (09-10, 09-11, 09-15 — the three taken after the fold was taught to
       record empty processes). So **`cause: 'target-empty'` has never fired in production and
       cannot be relied on**; the honest production cause is `target-silent` by absence, which is
       what `dumpJoinReading` already returns.
       - **THE CONCLUSION IS UNTOUCHED AND ONLY THE MECHANISM MOVES: there is no allocator data
         either way.** Do not read this as reopening the dump — it is the same closed question
         with a Windows-shaped answer, and it is the third time a finding validated in the dev
         container has not transferred verbatim to 149/Windows.
     - **FOUR OF THE FIVE SPENT 15-20 SECONDS WAITING.** `no answer in 20000ms` three times and
       `Chromium refused the dump (success: false)` at 15,367 ms once — the coordinator's own
       ~15,050 ms give-up. **Those are LOWER bounds on unbroken silence, not measurements of it:
       the instrument stopped asking, the renderer did not start answering.**
     - **THE DIRECT EVIDENCE IS THE ALLOC TRAIL, because it alone probes at this arm's cadence.**
       It samples on the same watchdog tick every 10 s, and on 2026-09-09 11:30 it read
       `EMPTY — that renderer answered no CDP call at all` **over a whole 165-second browser
       life**. A page that answered one probe in three cannot produce that line.
     - **AND `VMTHREAD` IS FOUR-FOR-FOUR at 100% of a core** (1,203 ms of a 1,200 ms window, main
       thread `Running`). A thread pinned in a tight native loop does not intermittently service
       CDP, which is the mechanism under all three readings.
     **SO THE CURE NEEDS 30 SECONDS OF CONTINUOUS SILENCE AND THE EVIDENCE SAYS IT LASTS MINUTES.**
     Stated at its limit: this retires flapping as a PREDICTED failure, on five joined events; it
     is not a guarantee about an event nobody has watched with this arm armed.
     - **AND THE ONE APPARENT PRODUCTION COUNTER-EXAMPLE IS NOT ONE — I ALMOST PUBLISHED THE
       ONE-SIDED VERSION.** `rc-keepwarm.mjs`'s own ramp-arm comment records that on 2026-09-05 a
       ramp ran to 8,879 MB while *"the renderer kept answering `Performance.getMetrics` all the
       way up"*, which is why the ramp arm's condition A was inert and `HUNG_MS` ended that ramp
       instead. Read at face value that is a responsive renderer during a ramp, i.e. a
       `probeResidentPage` reading of `alive` and a cure that never fires. **`heapProbe` really is
       attached to the RESIDENT page** (`attachHeapProbe(ctx, page)` on the line after
       `residentPage = page`), so the target was right and the objection was real.
     - **IT DIES ON WHICH THREAD SERVICES THE CALL, AND THAT IS NOW MEASURED WITH A CONTROL**
       (`scripts/cdp-thread-probe.mjs`, Chromium 141/Linux):
       ```
       CONTROL healthy page              WEDGED main thread in a microtask loop
         page.evaluate(1)      answered    page.evaluate(1)        SILENT >2000ms
         Performance.getMetrics answered   Performance.getMetrics  ANSWERED
         Runtime.getHeapUsage  answered    Runtime.getHeapUsage    SILENT >3000ms
         Memory.getDOMCounters answered    Memory.getDOMCounters   SILENT >3000ms
       ```
       **`Performance.getMetrics` DOES NOT NEED THE MAIN THREAD.** So the 09-05 line is not
       evidence that the main thread was running, and it is not a counter-example — **it is the
       explanation of why condition A was blind**, which that comment records as never
       established. `page.evaluate` is `Runtime.evaluate`: it runs JavaScript, so it is
       main-thread-bound by construction, and of the four it is the only one that is both
       main-thread-bound and cheap. **The cure's probe is the right call for a stated reason
       rather than by luck.**
     - **THE PROBE REFUSES A VERDICT IT HAS NOT EARNED, AND BOTH ARMS WERE FIRED BEFORE IT WAS
       TRUSTED** — a method already silent on a HEALTHY page (`THE QUESTION WAS NEVER REACHED`),
       and a wedge that did not take (`evaluate` answered when it should not have). A probe
       nobody has seen fail proves nothing; that rule cost `--concurrent-mint` a published race
       that never raced.
     - **PLATFORM CAVEAT, because this file has been burned by it twice:** 141/Linux against a
       149/Windows box. What transfers is the THREADING of a CDP domain, which is architectural.
       **Do not read a byte count out of that probe.**
     - **IT LIVES IN `scripts/`, NOT `scripts/auto-cart-bot/`, AND THAT IS DELIBERATE.**
       `CH_BOT_CODE_AT` is `git log -1 -- scripts/auto-cart-bot`, so a file there makes
       `autocart.bot_version` report the box as missing bot-side code — and the honest response
       to that warn is a box update, **which ends the RC session**. `leak-repro.mjs` is out of
       that directory for the same reason and says so.
  1b. **AND A THIRD ONE NOBODY PREDICTED: `WEDGE_MAX_RECYCLES` CANNOT BIND, SO THE
     CRASH-LOOP PROTECTION DOES NOT EXIST (found by reading, 2026-09-17).** Three facts, each
     read in source rather than inferred:
     - `wedge = { strikes: 0, recycles: 0, … }` is reset **on every browser reopen**
       (`rc-keepwarm.mjs`, beside `browserLifeSince` and `memDump`), with a comment choosing
       that deliberately — *"the recycle budget has to start over or three recycles across a
       long night would retire the arm permanently."*
     - **every recycle PRODUCES a reopen.** `recycleWedgedPage` closes the page precisely so
       that whatever the loop awaits rejects with "Target closed" and the existing reopen path
       runs; that is the arm's own stated design and why it needs no code to rebuild a browser.
     - therefore `recycles` is **0 every time `wedgeDecision` is consulted**, and
       `recycles >= maxRecycles` is unreachable. **`WEDGE_MAX_RECYCLES` and the `escalate`
       branch are inert in production.**
     **THE UNIT TEST PASSES BY SUPPLYING A VALUE PRODUCTION CANNOT** — it calls the pure
     function with `recycles: WEDGE_MAX_RECYCLES` directly — and the guard two tests along
     **REQUIRES the reset** (`resets.length >= 2`). So one guard asserts the branch works while
     its sibling pins the thing that makes it unreachable: the fix-present-and-inert shape and
     the `held-offer-scope` shape at once, in the same file.
     **WHAT IT COSTS, STATED AT ITS SIZE:** a page that wedges immediately on every fresh
     browser recycles → relaunches → wedges → recycles for ever, with nothing escalating to the
     bail whose diagnostics are the whole point of escalating. `supervise.ps1`'s
     five-exits-in-ten-minutes rule cannot catch it either, because the process never exits.
     Reachable during an RC outage, which is a state this file records three times.
     ~~**RECORDED, NOT FIXED.**~~ **FIXED THE SAME DAY**, once forcing a ramp turned out to be
     unavailable and the wait had nothing left to spend. The repair is exactly the one named
     here — a counter that survives a reopen and **DECAYS** — as `decayedRecycles` +
     `WEDGE_RECYCLE_DECAY_MS` (30 m) in `page-wedge.mjs`, read at the DECISION site rather than
     only at the reset so a long-lived healthy browser hands the budget back without needing a
     reopen to do it. **A count with no timestamp is NOT decayed**: that is an absent reading
     about WHEN, and a budget whose job is stopping a loop fails safe by being preserved.
     - **THE WINDOW IS BOUNDED BY TWO MEASURED NUMBERS RATHER THAN CHOSEN.** Below, it must
       clear one episode (`WEDGE_PROBE_EVERY_MS` x `WEDGE_STRIKES` ~ 30 s) or the budget decays
       between the strikes that make one and can never reach three. Above, it must stay under
       the **shortest observed gap between ramps — 2.3 h over eleven onsets across four days**
       — or two unrelated ramps accumulate against each other and the arm retires on events
       that had nothing to do with one another.
     - **AND A PRE-EXISTING GUARD REQUIRED THE BUG, which is why this could not be a quiet
       edit.** *"the strike and recycle state resets per browser life"* pinned the zeroing
       literal by exact expression, so the fix could not be made without it going red — the
       `held-offer-scope` shape. **Inverted with the reason written in, not relaxed**, and the
       half it was right about is kept and asserted separately: strikes MUST still reset,
       because they describe a page that no longer exists.
     - Nine mutations, each asserted to APPLY and each caught — including the reset zeroing the
       budget (the bug verbatim), the decision reading the raw field (fix-present-and-inert),
       an undateable budget cleared, the recycle forgetting to stamp its time (the opposite
       failure: a budget with no clock is permanent), the window pushed past 2.3 h, and strikes
       carried across a reopen. **Guards under `src/`, in neither of `worker-deploy.yml`'s
       `paths:` lists — read, not remembered — so it fires no worker deploy. Bot-side, so it is
       inert until the box updates.**
  2. **THE ARM IS SILENT ON THE HEALTHY PATH, so "ran and found the page alive" and "never ran"
     write the same nothing.** That is the house shape, accepted here only because the
     discriminator is free: the arm runs unconditionally on every tick while not bailing, so
     **`bot-ask git-status` showing the new sha rules out "never ran"** without a log line. What
     it cannot separate is `alive` from `inconclusive`; that is worth one line only if a later
     firing is genuinely ambiguous.
##### IT FIRED — 2026-09-17 09:50:17 UTC, ON A GENUINE BURST WEDGE, AND NO RAMP FOLLOWED
**First production firing. `wedge-recycle` events, all time: 1 at the moment this was written —
2 by that evening, and 3 by 2026-09-18; see "IT FIRED A SECOND TIME" and "A THIRD TIME" below.** Against the predictions written
before it, the log is a line-for-line match — the `♻`, the close, the reopen, and **no `✗ RAMP`
and no `✗ WEDGED` beneath it**:
```
09:39:39  the previous keep-warm's last line — the process then stopped, with no bail line
09:41:07  [stop-all] "nothing running."  →  start-all launches a fresh generation
09:42-48  … profile busy (rc-keepwarm) — the dead process's UNRELEASED lock, timing out
09:49:35  RC loaded and STAYING OPEN — token source: live
09:50:15 ♻ no answer in 3 consecutive probes — recycling the resident page
09:50:17   token on the way out: timeout
09:50:17   closed the wedged page in 596ms — the loop reopens from here
09:50:18   ✗ could not open a renewal tab: Target.createTarget … the browser may be unwell
09:50:19 ⚠ the RC window was closed — reopening it
09:50:37 RC loaded and STAYING OPEN — token source: none
09:50:50 ⚠ RC SESSION IS DEAD … okta session GONE (404)
```
- **IT WAS A GENUINE BURST WEDGE, NOT A PAGE STILL LOADING.** The `request-counts` event carries
  **30,631 asks on `futurebookingstartsendsdates` in a browser 44.6 SECONDS OLD**, `distinct: 16`,
  `statuses: {}` — ~687/s, inside the recorded 738-848/s band, and the answer-less branch for the
  **fourth** time. That is the young/cold-load BURST population exactly.
- **AND THAT POPULATION IS BACK AFTER 46.5 HOURS**, which was its longest recorded absence against
  a prior maximum of 37.8h. The 09-17 reading that called it "outside the recorded range" needed
  no explanation after all; it simply had not arrived yet.
- **NO RAMP. `commit_used_mb` 6,631 → 7,924 → 6,938; `rc_mb` peaked at 220 MB**; no `ramp-scan`,
  no `bail:ramp`, no `mem-dump` with `phase: ramp`. **DO NOT CLAIM THE CURE PREVENTED ONE.** A
  burst at full rate costing nothing is a documented, OBSERVED outcome — 2026-09-05 09:47 ran
  19,008 hits in 120 s on a browser 0 m old with the series flat at 208-227 MB. This event cannot
  separate *the page was closed before the mapping completed* from *this burst was never going to
  map anything*, and the burst/leak decoupling says both are real.
- ~~**THE CLOSE TOOK 596 ms, WHICH IS INDEPENDENT CORROBORATION.** Against **8-16 ms across 430
  healthy production closes** and 86-2,532 ms for the container's wedged closes, it is squarely in
  the wedged band — so the page really was wedged, measured by something that is not the probe.~~
  **THE CORPUS CONTAINED ITS OWN REFUTATION AND THE CITATION QUOTED AROUND IT (2026-09-17).**
  `8-16 ms` is min/median/p95; **that same corpus's MAX is 628 ms**, written down in the entry
  being cited. So 596 ms is not above the healthy range — it is **below its maximum**, and the
  comparison cannot discriminate. Struck rather than deleted, because "independent corroboration"
  is exactly the phrase a later reader quotes.
  - **THE DISTRIBUTION IS BIMODAL WITH NOTHING IN THE MIDDLE, WHICH IS WHY IT LOOKED
    DISCRIMINATING.** Over **435** tab-closes: min 8, p50 14, p90 15, p95 16, **p99 22** — and
    then **four** at 602 / 608 / 625 / 628. **Nothing between 22 ms and 602 ms.** So a 596 ms
    close IS unusual (4 in 435); what it is not is unique to a wedge.
  - **AND THE FOUR SHARE A TRIP TYPE RATHER THAN A FAULT: every one is a renewal whose trip ran
    11,413-11,711 ms**, i.e. the `no-signin-control` band that never reaches Okta. Split on trip
    length: trips **>=20 s** (n=416) average **14 ms**, max **22**; trips **<20 s** (n=19)
    average **139 ms**, max **628**. **They are not clustered in time either** — 09-08 17:34,
    09-09 18:32, 09-17 03:13, 09-17 04:29 — so this is not the box's 09-17 network trouble.
  - **CANDIDATE, LABELLED: `closeMs` measures how BUSY the page is, not whether it is wedged.**
    An 11-second trip closes a tab 11 seconds old, still loading RC's SPA; a 69-second trip closes
    one that has been through Okta and back. **The wedge-recycle's page was 40 seconds old and in
    a 30,631-request burst**, so it fits the young-and-busy population — which is what the request
    counter already said. That makes 596 ms **consistent with the burst**, not a second and
    independent line of evidence.
  - **WHAT STILL CARRIES THE WEDGE IS UNAFFECTED**, and it is the two bullets below: the browser
    context was already CLOSED one second later (`Target.createTarget` failed), and `primeToken`
    had answered a main-thread `page.evaluate` ~25 seconds earlier before the page went
    permanently silent. Neither depends on `closeMs`.

**THREE THINGS NOBODY PREDICTED, AND THE SECOND IS THE ONE THAT SETTLES THE FALSE-POSITIVE
QUESTION.**
1. **`token on the way out: timeout`** — `persistLiveToken` is bounded at 2 s and was defeated by
   the very wedge it runs before. **A page too wedged to answer a probe is too wedged to hand over
   its token.** The bound did its job; what is not available is the token. Do not "fix" this by
   lengthening it — an unbounded persist inherits the hang and delays releasing the profile lock,
   which is what loses a cart at 08:00.
2. **THE BROWSER WAS UNWELL INDEPENDENTLY OF OUR CLOSE.** One second later `browserContext.newPage`
   failed with `Target.createTarget`, and the loop's own check found the context **already
   CLOSED**. Closing one page of a persistent context does not close the context, so the browser
   was going down on its own. That is the strongest single fact against reading this as a false
   positive on a page still rendering RC's WebGL map.
3. **THE PAGE WAS FORTY SECONDS OLD.** Loaded 09:49:35, three strikes by 09:50:15 — so probes began
   failing about ten seconds after load. The 3 × 10 s design is the whole reason it acted at 30 s
   rather than instantly.

**AND THE PAGE ANSWERED A MAIN-THREAD EVALUATE MOMENTS BEFORE IT WENT SILENT, WHICH IS THE
STRONGEST FACT AGAINST THE FALSE-POSITIVE READING.** `token source: live` is `primeToken` →
`readLiveToken` → `evaluateWithin`, i.e. `page.evaluate`, i.e. `Runtime.evaluate` — **the same
main-thread-bound call the cure's probe makes**. `primeToken` polls for up to 15 s and returns
what it has at the deadline, so the last known-answering moment is somewhere in
**09:49:20-09:49:35**, and the first silent probe is ~09:49:45. **The page went from answering to
permanently silent inside about twenty-five seconds, bounded.** A page merely busy with RC's
initial WebGL render does not answer `Runtime.evaluate` and then stop; it has not answered yet.

**AND `token source: none` ALONE WOULD NOT HAVE ESTABLISHED THAT THE SESSION WAS LOST** — that is
exactly the reading `readLiveToken`'s own comment says collapses "no token" into "we could not
tell". What settles it is that the REPLACEMENT browser is demonstrably healthy: a baseline memory
dump answered **in 229 ms** at 09:53:31, and `okta session GONE (404)` is an HTTP answer rather
than an evaluate. Two instruments that do not share the wedged page's failure mode.

**AND THE CURE IS A WEDGE DETECTOR, WHICH IS A CAPABILITY NOTHING HAD BEFORE.** Until now a wedge
was only ever INFERRED — from a ramp, or from `HUNG_MS` firing twelve minutes later. This is the
first time one has been observed **directly, and in the absence of a ramp**. So the reading it
buys is new: **a burst can wedge a page without producing a 32 GiB mapping.**
- **CAUSALITY IS NOT ESTABLISHED, AND THE KNOWN MECHANISM RUNS ONE WAY.** `statuses: {}` over
  30,631 asks is 30,631 **rejected** fetches, and `blink::RejectedPromises::HandlerAdded` is
  driven by promise rejection — so the burst feeding the spin is the documented chain. Which came
  first is not in this event, and *"the page wedged and the SPA's retry loop is what a wedged page
  does"* fits it just as well. **Do not write one in.**
- **IT ALSO MEANS THE CURE'S EVENTS ARE NOW THE ONLY CENSUS OF WEDGES.** A wedge the cure wins
  produces no `bail:ramp`, no `ramp-scan` and no `mem-dump` — so counting `wedge-recycle` rows is
  the only way anyone will ever know how often this happens. **A quiet `bot_events` is no longer
  evidence that the box is quiet.**

**AND IT IS THE FIRST PRODUCTION CONFIRMATION OF THE REOPEN MECHANISM, which is not the one the
module's own header claims.** `⚠ the RC window was closed — reopening it` is the explicit
`!ctx.pages().length || page.isClosed()` check at the top of the 1-second loop — the line recorded
as load-bearing-by-accident, written for "somebody tidying up closed the visible window". Nothing
propagated out of a caught await; the check is what saw it, and the loop was back on a fresh page
in **twenty seconds**.

**THE COST, STATED PLAINLY — AND THE COUNTERFACTUAL WITH IT.** The session went `src=live` →
`src=none` and Okta went ALIVE (exp 21:29:33) → **GONE(404)**, so a real user hold releasing at
15:00 UTC now needs `maybeAutoLogin`'s full password variant at T−30.
- **The cure did not lose a token that was otherwise recoverable.** The token lived in page memory
  (`src=live` is the capture hook reading RC's own outbound header, which is per-page), the page
  was wedged, and the only alternative was `HUNG_MS` closing the same browser **eleven minutes
  later** and losing the same token.
- **`idx` — Okta's session cookie — IS ABSENT from the new profile's list** (`DT, [opaque], ln,
  [opaque], luf_*, JSESSIONID`), where the 2026-08-19 census had it. **Whether it is session-scoped
  and cannot survive a browser generation change, or simply reached its absolute cap, is NOT
  established.** It matters: the first reading would mean every `restart-rc`/`stop-all` costs the
  OKTA session and not merely the token — which `restart-rc.ps1` already asserts in its own output
  (*"the RC session is GONE until maybeAutoLogin runs"*) without anyone having named the mechanism.
  **That wording is ambiguous and is NOT evidence either way**: "the RC session" may mean the
  token, which certainly dies with the page.
  - **WHAT THE PROFILE DOES SAY: persistent cookies survive a generation change and `idx` did
    not.** `DT` came back with **527,588 minutes** on it (~366 days) and `luf_*` with 42,538
    (~29.5 days), read off the new browser — so the on-disk jar is intact and a persistent `idx`
    would have been in it. The 2026-08-19 census listed `idx` while a session was live; today's
    lists it nowhere while the session is dead.
  - **THE DISCRIMINATOR COSTS NOTHING AND ARRIVES BY ITSELF — do not build an experiment for it.**
    `maybeAutoLogin` restores Okta at T−30. **The next browser generation change after that
    answers it**: Okta still ALIVE across a `restart-rc`, an update's `stop-all` or a cure-driven
    reopen ⇒ `idx` is persistent and 09:50 was the absolute cap; Okta GONE again ⇒ `idx` is
    session-scoped and **every restart costs the Okta session**, which is a materially higher
    price than the box's own scripts currently put on one.

**AND THE DENOMINATOR IS A MEASUREMENT NOW, NOT AN ESTIMATE — IT IS ONE FIRING IN EIGHTEEN
BROWSER LIVES.** `mem-dump` with `phase: baseline` fires once per browser life about three minutes
in, so counting them counts lives. Since the cure reached the box at 2026-09-16 21:50:59 UTC there
are **17 baselines, every one a distinct lead pid**, plus the wedged life that died at 0.7 min and
never reached its baseline.
```
09-16 21:56 … 04:05   SIXTEEN lives in 6h11m   <- the forced-restart campaign and the box update
09-17 04:05 → 09:41   ONE life, 5h34m          <- old-population band, and it did not ramp
09-17 09:49 → 09:50   0.7 min                  <- the wedge
09-17 09:53 …         the current browser, pid 9740
```
- **`request-counts` IS A BAD CENSUS OF BROWSER LIVES AND `mem-dump baseline` IS A GOOD ONE.**
  Only **two** `request-counts` rows exist across those eighteen lives — one `teardown` and the
  `wedge-recycle`. So **sixteen of eighteen lives ended in a way that ran no `finally`**: a killed
  process, not a teardown. Anyone sizing anything per-browser-life off `request-counts` will be out
  by an order of magnitude.
- It also tightens the false-positive claim: **seventeen lives ran three minutes or more with no
  firing**, which is the same fact as "~2,400 probes with no run of three" counted by subject
  instead of by tick.

**TWO FREE READINGS RODE ALONG.**
- **THE BLIND PER-PROCESS SCAN CLEARED WITH THE GENERATION CHANGE.** `rc_mb` was NULL through
  09:38, read **`rc=0 procs=0`** from 09:41:11 (the scan RAN and found none of ours — the third
  state the `C|` count exists to keep apart) and real figures from 09:51. So the 14-hour blindness
  was about the browser generation, and a restart ended it. That was recorded as a free experiment
  riding on work that was happening anyway; it answered.
- **`[stop-all] nothing running.` WAS CORRECT HERE, NOT BLIND** — `rc=0 procs=0` at 09:41:11 and
  no orphan-sweep line at 09:49:34 both say the old browser was already gone. **Do not file this
  as another elevation-blindness sighting.**

**WHAT KILLED THE PREVIOUS KEEP-WARM AT ~09:40 IS NOT ESTABLISHED — do not write one in.** What
bounds it: it stopped logging at 09:39:39 with **no bail line**, its browser was gone by 09:41:11,
`restarts.log` carries no stop entry for it, and **its profile lock was never released** (eight
minutes of `profile busy` until `STALE_MS` expired at ~09:49:39). A clean exit releases that lock
and the crash handlers added on 2026-08-30 release it too, so this was neither — which points at a
hard kill or a fault that ran no handler. The box did **not** update (`git-status` reads
`HEAD 6fc7292 on master`, unchanged) and `auto-update.log` shows the guard **correctly refusing
every run** that night — `SKIP - a hold releases in 5.3h`.



##### IT FIRED A SECOND TIME AT 17:44:39, ON THE BROWSER A BOX UPDATE CREATED — SO THE COUNT IS TWO
The entry above is written around one firing and calls the true-positive half **n=1**. It is
**n=2 within eight hours**, and the second one arrived free, on work that was happening anyway.
```
17:44:17  the box applies 637316e (update.bat -> stop-all -> start-all)
17:44:39  wedge-recycle — 25,828 asks on futurebookingstartsendsdates, statuses {}
          commit flat 7,450-7,550 MB throughout; no ramp-scan, no bail:ramp
```
- **THE SIGNATURE IS THE SAME ONE, TWICE.** 30,631 answer-less asks at 09:50 against 25,828 here
  — both on a cold RC home-page load in a browser under a minute old, both with `statuses: {}`,
  both with every other path on the page answering normally. **That is the burst population, and
  it is now the only population the cure has ever fired on.**
- **SO A BOX UPDATE IS A FORCING LEVER FOR THIS WEDGE, AND IT COSTS NOTHING EXTRA.** `stop-all`
  plus `start-all` is exactly the cold generation change `restart-rc` produces — which this file
  already records as 2-for-2 at forcing the burst population — and an update performs one
  anyway. **`restart-rc` is refused by the harness classifier**, so for a session with no human
  present, **the update is the only reachable version of that lever.** Do not schedule an update
  FOR this; do read the events after every one.
- **NEITHER FIRING WAS FOLLOWED BY A RAMP, AND THAT IS STILL NOT EVIDENCE THE CURE PREVENTED
  ONE.** A burst at full rate costing nothing is a recorded, observed outcome (2026-09-05 09:47:
  19,008 hits in 120 s on a browser 0 m old, series flat at 208-227 MB). Two firings, two
  quiet series, and the counterfactual is unavailable in both.
- **WHAT IT DOES BUY IS THE FALSE-POSITIVE HALF, DOUBLED.** Two firings across ~30 browser lives,
  both on a page demonstrably in a 25-30k answer-less burst, and not one firing on an ordinary
  renewal, warm-up or auto-login trip.


##### IT FIRED A THIRD TIME, ON THE NEXT BOX UPDATE, AND `wedge.silent` ANSWERED THE FLAPPING PREDICTION (2026-09-18)
Two firings became three on the update that shipped the rec.gov reconnect fix — **so a box update
is 2-for-2 at forcing this wedge**, which is the entry above holding rather than a new claim.
```
15:19:02  start-all brings up a cold browser (update.bat -> stop-all -> start-all)
15:19:04  memory sample: commit 7,644 -> 9,488 MB, max_type renderer   <- ~2s of browser age
15:19:36  wedge-recycle  ageMs 34,566  distinct 16  strikes 3  silent 3  closeMs 538
          17,622 asks on futurebookingstartsendsdates, statuses {}
15:21:05  commit back to 7,715 MB.  No ramp-scan, no bail:ramp.
```
- **`silent 3` WITH `strikes 3` IS THE FIRST DIRECT ANSWER TO THE FLAPPING FAILURE MODE.** That
  prediction — a page answering one probe in three holds its 32 GiB for ever and never reaches the
  threshold — was retired on **five joined memory dumps arguing the silence lasts minutes**, which
  is an argument. `silent === strikes` is the reading: **every silent probe went straight into the
  run of three and not one `alive` reading reset the counter.** Two for two (09-17 17:44 reads the
  same pair), on the only two firings that carry the field.
- **THE BROWSER AGE IS 34,566 ms AGAINST 09-17's 34,538 — twenty-eight milliseconds apart.** That
  is not the leak being punctual; it is `start-all` producing the same cold RC home-page load each
  time, and the cure acting at its own fixed `WEDGE_PROBE_EVERY_MS x WEDGE_STRIKES` (~30 s) plus
  the load. **The reproducibility belongs to the LEVER, not to the wedge.**
- **`closeMs 538` CORROBORATES THE CORRECTION RATHER THAN THE WEDGE.** The healthy corpus's own
  MAX is 628 ms over 435 closes, so 538 sits **below** it — consistent with the finding that
  `closeMs` tracks how BUSY the page is (this one was in a 17.6k-request burst), not whether it is
  wedged. **Do not quote a close time as evidence of a wedge**; that reading was struck once
  already.
- **THE COMMIT STEP IS NOT EVIDENCE THE CURE PREVENTED A RAMP, AND IT IS THE TEMPTING READING.**
  Commit rose 1,844 MB and came back — but the sample that caught it is at ~2 s of browser age and
  **the peak between it and the next sample two minutes later is UNOBSERVED**, which is the
  standing rule that any figure taken while a ramp is in progress is a lower bound. A burst at
  full rate costing nothing is a recorded, observed outcome (2026-09-05 09:47). **Three firings,
  three quiet series, and the counterfactual is unavailable in all three.**
- **THE ANSWER-LESS BRANCH IS FOUR FOR FOUR.** 17,622 asks on one RDR path with `statuses {}` —
  no 2xx, no 401, no `failed` — while every other path on the page answered. Still the fourth
  branch of `loopAnswerReading`, still only ever on that path, still **not** to be re-linked to
  the leak.

##### AND THE LOG CARRIES TWO MORE THINGS: THE REOPEN, AND A BLIP THAT DELETES `tab-close` ROWS
Pulled at 10:20 with `tail-log rc-keepwarm:400`, which still reached back to 09:29 — the colon is
what made the firing and the two hours after it readable in one call.

**THE REOPEN MECHANISM FIRED IN PRODUCTION FOR THE FIRST TIME, AND IT IS THE BORROWED ONE.**
```
09:50:17   closed the wedged page in 596ms — the loop reopens from here
09:50:18 renewing the session — the app holds no usable token (src=none)
09:50:18   x could not open a renewal tab: browserContext.newPage: Protocol error
           (Target.createTarget): Failed to open a new tab — the browser may be unwell
09:50:18 check failed: page.evaluate: Target page, context or browser has been closed
09:50:19 (warn) the RC window was closed — reopening it        <- the explicit isClosed() check
09:50:21   alloc trail: resident renderer armed
09:50:37 RC loaded and STAYING OPEN — token source: none
```
CLAUDE.md records that `recycleWedgedPage`'s own header describes a mechanism that **does not
exist** (every page-touching await in the loop is individually `.catch()`ed, so nothing propagates
out), and that what actually reopens is the `if (!ctx.pages().length || page.isClosed()) break`
at the top of the 1-second loop — a line written months earlier for *"somebody tidying up closed
the visible window"*. **That line is what ran, two seconds after the close, and the browser was
back with a loaded page in twenty.** The reasoning was traced in source and is now observed.

**A BOX NETWORK BLIP DELETES A `tab-close` ROW, AND IT IS INVISIBLE IN `bot_events`.**
```
10:00:46 renewing the session — the app holds no usable token (src=none)
10:00:46   renew failed: page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.reservecalifornia.com/
10:00:56   okta session unknown
10:00:56   (could not report session health: fetch failed)
10:00:56   (could not store the tab-close event: fetch failed)
```
`ERR_NAME_NOT_RESOLVED` is DNS failing **on the box**, not RC refusing us — and `camphawk.app` was
unreachable in the same second, which is what settles it: two different hosts, one instant.
- **SO A TRIP RAN AND `bot_events` HAS NO ROW FOR IT.** The table's gap across this period is
  **04:31:56 → 10:12:03, 340 minutes**, and at least one renewal demonstrably happened inside it.
  **That gap is an UPPER BOUND on the stand-down, never a measurement of it.**
- **IT IS A SECOND EXCEPTION TO A RULE THIS FILE STATES WITH ONLY ONE.** The recorded rule is that
  no `tab-close` is positive evidence no trip ran, *"with one exception: a process KILLED mid-trip
  runs no `finally` and emits nothing"* — and that one is separable, because a bail emits its own
  `request-counts` and `ramp-scan`. **A network blip emits nothing in either stream**, so it is the
  worse of the two and it was not on the list.
- **THE DISCRIMINATOR IS FREE AND RETROSPECTIVE: THE MEMORY SERIES' CADENCE.** `bot.mjs` is a
  different process and posts every two minutes, and it lost the same tick —
  `09:59:18 → 10:02:59` is **221 s** against a steady 120 either side. So a blip WIDENS a gap in
  `chromium_memory_samples` while deleting a row outright in `bot_events`. **Before reading a
  `tab-close` gap as a stand-down, diff the sample timestamps across it.**
- **AND IT RESCUES THE 2026-09-11 OVERNIGHT READING RATHER THAN WEAKENING IT.** That entry treats
  ten hours of `bot_events` silence as proof the token never lapsed, corroborated by *"312 samples
  across the same window"*. Mere presence would not have been enough — **the cadence is what rules
  a blip out**, and at 312 samples in ten hours it is unbroken.

**OKTA'S ABSOLUTE CAP LAPSED INSIDE A 21-MINUTE BRACKET: ALIVE at 09:29:33 (`exp 21:29:33`, i.e.
the rolling +12.0000h our own probe refreshes), GONE(404) at 09:50:50.** The bracket contains both
the ~09:40 keep-warm death and the cure, and **neither is implicated** — the recorded finding is
that the cap runs on its own schedule and our probing cannot move it. It does not pin the cap's
origin either, because when that session was established is not in this window. Recorded as a
bracket, not a mechanism.


##### A WORKING CURE SILENCES EVERY OTHER RAMP INSTRUMENT — read that as success, not regression (2026-09-17)
Read out of the box's own `6fc7292` rather than reasoned: the watchdog timer's arms are, in
order, the **mem-dump stall trigger** (line 2959, `stalledMs > MEM_DUMP_STALL_MS`, 90 s), **the
cure** (2986), **`HUNG_MS`** (3022, 12 min) and **the ramp bail** (3049, 120 s stall + 3,000 MB).
So the cure precedes both exits — which is the ordering it needs — **and it also precedes the
only thing that fires the ramp dump.**
- **THE CURE ACTS AT ~30 s AND EVERY OTHER RAMP INSTRUMENT NEEDS 90-120 s.** A firing closes the
  page, the loop reopens, `lastTick` advances and `stalledMs` resets — so **no `mem-dump` with
  `phase: ramp`, no `bail:ramp`, and no `request-counts` with `reason: 'bail:ramp'`** for an
  event the cure wins.
- **AND `ramp-scan` GOES TOO, THOUGH IT IS A DIFFERENT PROCESS.** `bot.mjs` triggers the region
  walk off `RAMP_SCAN_MB` (3,000) / `RAMP_SCAN_COMMIT_MB` (9,000). The 32 GiB mapping lands in
  ≤34 s, so the COMMIT bar may still be crossed — but `rc_mb` is private bytes, which climb over
  ~10 minutes, so a page closed at 30 s plausibly never reaches 3,000 MB. **Expect the walk to
  become rare or absent.**
- **SO A WORKING CURE MAKES THE BOX GO QUIET IN EXACTLY THE WAY "NOTHING IS HAPPENING" LOOKS.**
  The ONLY positive evidence of a firing is the `wedge-recycle` event and the log lines beneath
  it. **Do not read the disappearance of `bail:ramp`, `mem-dump phase=ramp` or `ramp-scan` as an
  instrument regressing** — check `wedge-recycle` first, and remember that a `bail:ramp` and a
  `wedge-recycle` for one event are mutually exclusive by construction.
- **THE DUMP IS NO LOSS, AND THAT IS MEASURED RATHER THAN CONSOLING.** All four stored `ramp`
  dumps are `target-silent`: a wedged renderer contributes **zero allocator dumps** at every
  level, settled off-box by `dump-wedge-probe.mjs`. The instrument the cure pre-empts is the one
  that has never been able to answer.
- **WHAT IS GENUINELY LOST IS THE REGION WALK'S CONFIRMATION**, which is twelve-for-twelve on the
  same signature and needs no repeating. **If a walk is ever wanted again, the way to get one is
  to raise `WEDGE_STRIKES` deliberately for a run** — not to wonder why the walks stopped.

- **AND A PROBE THAT KEEPS ANSWERING THROUGH A RAMP WOULD BE A FINDING, NOT A BROKEN ARM.** It
  would mean the mapping happens while the resident page is still responsive to CDP, against the
  09-09 VMTHREAD reading (main thread `Running`, 1,203 ms of a 1,200 ms window, four for four) and
  against `alloc trail [resident]: EMPTY` over a whole 165 s browser life. **Expected not to
  happen** — a wedged main thread is per-renderer and same-site pages share it — which is exactly
  what makes it worth recording if it does.

##### AND THE REQUEST COUNTER IS BLIND TO A WEDGED PAGE — measured, and it may be the "quiet ramps"
Found while building the above, and it was not the thing being looked for: with a page wedged and
demonstrably making **hundreds** of fetches — the mappings climbing 2 MiB at a time is the proof —
**`page.on('request')` and `ctx.on('request')` both reported ZERO.**

- **SAME CAUSE AS EVERY CDP INSTRUMENT BEFORE IT.** Playwright's request events route through the
  page's own target, which is serviced on the main thread, which is the thread that is wedged. The
  09-09 VMTHREAD reading named that dispatcher; this is one more instrument on the wrong side of it.
- **IT IS A CANDIDATE EXPLANATION FOR THE QUIET RAMPS, and is labelled as one.** Two recorded ramps
  carried the full 32 GiB signature beside a counter reading **20 and 6 lifetime requests**
  (09-11 05:28, 09-10 17:53), and the burst/leak decoupling rests on exactly those. **If the
  counter goes blind the moment the page wedges, a "quiet" ramp is a ramp we could not see the
  traffic of** — which would mean the decoupling is weaker than seven sightings make it look.
- **NOT ESTABLISHED. Measured in-container on a synthetic wedge; never confirmed against a
  production ramp**, and the two are different browsers on different platforms — the trap that
  burned the native sampler twice. **Do not rewrite the decoupling entries on this.** What would
  settle it is a `request-counts` event from a `wedge-recycle`, which is why the arm emits one.
- It also sharpens the standing page-scoped-counter gap (workers and throwaway tabs are invisible):
  a **third** blindness, and the only one of the three that arrives exactly when a reading matters.

##### TWO DEFECTS THE MUTATION RUN FOUND, AND ONE WAS IN THE GUARD ITSELF
- **A HUNG SUITE REPORTS `# fail 0` WITH EVERY TEST `cancelled`.** Deleting the probe's
  `Promise.race` does not FAIL the bounded-probe guard — it HANGS it, node:test cancels the suite,
  and anything counting failures reads a pass. **That included the mutation harness**, which
  reported the mutation as SURVIVING with a straight face. The structural assertion that would have
  caught it sat AFTER the await that hangs, i.e. was unreachable. **An assertion placed after a call
  that can hang is not an assertion**; it goes first now, the test's own call is raced so a hang
  arrives as a failed assertion, and the harness treats `fail 0` beside `cancelled > 0` as a hang
  rather than a catch. ~30th time a guard here has anchored on the wrong thing.
- **`tsc` CAUGHT WHAT THE SUITE COULD NOT, AND A PLAIN `@param` DOES NOT FIX IT.** TypeScript infers
  a destructured signature from the **defaults**, and `wedgeDecision`'s `reading` deliberately has
  none — so the one property the whole decision turns on was absent from the type and the ROOT
  tsconfig rejected every caller. **`@param {object} [o]` with `[o.reading]` properties was tried
  first and changed nothing**; it needs a named `@typedef`. Third time the typecheck has been the
  thing that noticed.
- **AND THE HARNESS'S OWN `git checkout -- <file>` DELETED AN UNCOMMITTED FIX — TWICE IN ONE
  SESSION, which is the fifth and sixth recorded times.** It reverts to HEAD, and HEAD did not
  have it. **Commit before mutating** is written down, was read this session, was RECORDED here
  after the first occurrence, and was broken again forty minutes later.
  - **THE SECOND ONE FAILED IN THE DANGEROUS DIRECTION AND THAT IS THE PART WORTH KEEPING.** The
    first cost a round trip and announced itself (the typedef was simply gone). The second
    reverted the *subject* of the mutation run — so two mutations reported **`DID NOT APPLY`**
    and a third reported **`ok … failed`** over a file that no longer contained the code under
    test. **A harness that reverts uncommitted work reports its own damage as a result about the
    guards**, and both readings were wrong: nothing had survived and nothing had been caught.
  - The tell is the one the harness cannot give you: `git status --short` after the run, and the
    suite failing on a tree it says is clean.

#### AND TWO CORRELATIONS THAT DID NOT SURVIVE THEIR OWN CONTROLS (2026-09-09)
Recorded because both are the obvious next thing to check, and re-deriving them costs an evening.
- **rec.gov CARTING: MARGINAL, AND NOT SIGNIFICANT AFTER CORRECTION.** 3 of 9 cart episodes fall
  within 15 min of a ramp; a **day-shift permutation** (which preserves hour-of-day on both
  sides) put 0 of 18 shifts at or above that, so p ~ 0.05 — against five tests run that evening.
  **And the family split forbids a direct mechanism**: every ramp is the `rc` family, `recgov`
  reads 0 MB at ten of twelve ramp samples and its ordinary 138 MB baseline at the other two, and
  rec.gov carting runs in a different Chromium, on a different profile, in a different process.
  The one viable indirect story — contention making a marginal Okta trip slow, since duration
  tracks cost six for six — **predicts long renewal trips near those carts and they are
  ordinary**: 68-71 s against a median of 68,841 ms over 161 closes. One of the three also has a
  browser replacement, so the cart may be acting through that rather than at all.
- **THE rec.gov KEEPALIVE: NO ASSOCIATION, AND THE FIRST ANSWER WAS AN ARTIFACT.** `keepSessionsWarm`
  opens a rec.gov Chromium every 30 minutes and the sampler marks it `source='bot-keepalive'`, so
  it looked like the obvious common cause. An ANALYTIC base rate ("one pass every 30 min, so
  nearest is uniform on [0,15]") gave 8 of 26 against 3.5 expected, p ~ 2.7% — **and it was wrong
  by about 4x.** Keepalive samples arrive in BURSTS, median inter-sample gap **1 minute**, so the
  null is nothing like that. Against an EMPIRICAL control (6,536 ordinary ticks outside any ramp)
  the effect disappears, and at +/-5 min ramps sit BELOW the control rate (35% vs 41%).
  **Compute a base rate from the data, never from the cadence a thing is supposed to run at.**
- **A THIRD READING WAS CIRCULAR AND WAS DROPPED BEFORE IT WAS REPORTED.** "Browser age at onset"
  read 0-2 minutes for all 26, which looks like a law. `max_pid` is the largest process by private
  bytes, and the ramping renderer BECOMES the largest at the onset — a pid that did not exist a
  minute earlier — so its first-seen IS the onset by construction. The column measured nothing.
  Browser age is not recoverable from the memory series; `request-counts` carries it, at teardowns
  and bails only.

### THE METHOD WAS THE PROBLEM, NOT THE LEAK (2026-09-08) — asked "why do we keep missing things?"
The owner's question after four missed ramps, and it is answerable with counting rather than
feeling. **The weeks did not go into the leak. They went into the TRIGGER.**
```
09-07 02:03  the memory reading was about the browser that had just died   trigger
09-07 20:42  the bail arm raced the dump away on the same tick             trigger
09-08 02:03  no sampler tick landed between the two thresholds             trigger
09-08 07:47  the grace stopped holding the instant the dump STARTED        trigger
```
- **THE INSTRUMENT HAS NEVER FAILED WHEN IT WAS ALLOWED TO RUN.** Six baselines, 209-332 ms,
  ownership edges resolving on Linux **and** on Windows. Four ramps, 5-28 hours apart, were
  spent debugging the plumbing that decides when to fire it.
- **AND THREE INSTRUMENTS WERE RETIRED AS STRUCTURALLY BLIND, EACH PREDICTABLY.** The heap
  trail (`JSHeapUsedSize` excludes external memory — documented), Track A (1-74 MB against
  8-9 GB, because the sampling profiler does not see `MapViewOfFile`), the RAM arm (sixteen-plus
  consecutive ramps; untouched commit never lowers free RAM, which the pagefile figures said
  on day one). **All three were knowable before a line was written.**
- **THE STRUCTURAL REASON: `alloc-trail-probe.mjs` and `mem-dump-probe.mjs` drive a real
  Chromium to validate the INSTRUMENTS, and nothing anywhere drove the TRIGGER.** So the ramp
  was the test, and the test costs a day.

#### FOUR CHANGES, AND THE FIRST TWO ARE THE ONES THAT MATTER

**1. THE STALL TRIGGER — the reading is taken BEFORE the worst moment, not at it.**
`MEM_DUMP_STALL_MS` (90s), checked in the timer **before every arm**, calling
`maybeMemoryDump(null, 'ramp')` — **which consults no file at all.** `Date.now() - lastTick` is
a local number this timer sets: never UNKNOWN, never stale, never about another browser, and it
cannot be crossed between two samples. **That retires all four failure modes at once, because
none of them can reach a trigger that reads nothing.**
- **THIS REPO ALREADY KNEW THE ANSWER AND HAD APPLIED IT TWICE.** The memory sampler, the heap
  trail and the RAM trail were all built on *"a series replaces an observation that can only be
  taken at the worst possible moment"*. **The rule was never applied to the dump**, which stayed
  one observation at the worst moment gated on a two-minute-old file written by another process.
- **90s IS MEASURED, NOT CHOSEN.** The longest renewal in forty recorded tab-closes is **71.5s**
  and the bail arm needs **120s**, so the window is 71.5→120 and 90 sits in it: it fires on no
  ordinary trip and three ticks before the exit.
- **THE BUDGET IS PER STALL EPISODE, NOT PER BROWSER LIFE**, and that is the half that stops the
  fix creating the failure it removes: a once-per-life budget lets one unusually slow healthy
  trip spend the slot and leave the real ramp with nothing. The ramp flags reset when the loop
  ADVANCES — guarded on `inFlight`, and **the baseline flag is deliberately untouched** because
  that one is a control and resetting it per stall makes the control noise.
- **The threshold and the grace are both KEPT.** Each wins a case this does not: a sample that
  does land in the threshold gap, and a dump still in flight when the bail arrives.

**2. `ramp-arm-probe.mjs` — THE TRIGGER PATH, DRIVEN OFF-BOX, IN SECONDS.** The arm reads four
inputs and **three are forgeable**: `stalledMs` is a local number, the memory figure is a FILE
WE WRITE, and only the CDP calls need a real browser. So the 09-08 07:47 conditions reproduce in
a container with no ramp — which is why they were never tested.
- **IT DOES NOT RE-IMPLEMENT THE DECISION.** `rampBailDecision`, `rampDumpGrace` and
  `takeMemoryDump` are the real exports; the glue's SHAPE stays pinned structurally in
  `rc-mem-dump.test.mts`. A rig asserting the shape would be asserting a copy.
- **IT ANSWERED THREE THINGS NO UNIT TEST CAN REACH, and one of them was an assumption in the
  fix that shipped an hour earlier.** A real dump takes **~390 ms** (so the healthy path still
  spends exactly one tick); **`inFlight` really is still set when the reporting callback
  resolves** — i.e. `.finally` does wait for the `.then` chain and the hold really does cover
  the POST, which was reasoned and not measured; and a dump against a **closed browser returns
  in 1-2 ms**, so it cannot strand the in-flight flag for the life of a browser.
- **A FAST DUMP CANNOT CATCH THE BUG, WHICH IS WHY THE SLOW SCENARIO EXISTS.** At 390 ms the
  broken grace and the fixed one behave identically. The scenario that reproduces 09-08 forces a
  dump **slower than one tick** — a property of a struggling browser that a container cannot
  produce — while leaving the DECISION real. **Verified: with the `dumpStarted && !dumpInFlight`
  hold reverted the probe exits 1 and names the line; with the grace put back under the dump's
  timeout it exits 1 and names that.** A probe nobody has seen fail is a probe that proves
  nothing.
- **AND NOTHING RUNS THE PROBES, so a guard now checks the two ways they go quietly dead** — a
  syntax error, and the `playwright-core` import somebody "fixes" to match its neighbours. It
  asserts **per file**, so a probe deleted or renamed fails rather than shrinking the loop to
  zero and passing.

**3. PREDICT THE READING BEFORE BUILDING THE INSTRUMENT.** Every retired instrument above was
blind for a reason that was documented at the time. The rule is one line in the header before
any code: **"on the known 9 GB event, this reads N."** If N is ~0, do not build it.
`MEM_DUMP_STALL_MS` carries the first worked example — it states where it fires on the known
event (90s, three ticks before the exit, on a browser that answered a dump in 209 ms) **and
where it fires on the healthy path (nowhere: the longest trip is 71.5s)**. A rule with a worked
example beats a guard that a comment can satisfy.

**4. READ CHROMIUM'S SOURCE INSTEAD OF THE BOX WHERE THE QUESTION ALLOWS IT.** The 2 MB is a
SIGNATURE and Chromium is open source; nobody had looked. Two fetches:
- **`gpu::SharedMemoryLimits::mapped_memory_chunk_size` is 2,097,152 bytes** — not "about 2 MB",
  **the same number** as the walk's 32,778 MB / 16,387 = 2.0000 MB.
- `MappedMemoryManager` holds **one `gpu::Buffer` — one shared region, one `MapViewOfFile` — per
  chunk**, in the RENDERER, as pagefile-backed anonymous shared memory. Every column of the walk
  matches: exact size, one allocation base per region, `commit/mapped`, anonymous, READWRITE,
  renderer.
- **Its free path is the interesting half**: `FreeUnused()` reclaims blocks **whose tokens have
  passed**, and `max_allocated_bytes` defaults to **`kNoLimit`**. A ramp is by definition a
  renderer whose loop has stopped advancing, and RC's resident page runs a **WebGL ArcGIS map**,
  so there is a command buffer under load — and 09-04 established the ramp is in the RESIDENT
  renderer, not the trip's.
- **DISCARDABLE MEMORY IS WEAKENED ON THE SAME EVIDENCE, FOR FREE**:
  `client_discardable_shared_memory_manager.cc` allocates **4 MB** segments (1 MB low-end), not
  2. One of the three named candidates narrowed with no ramp and no box.
- **IT IS A CANDIDATE AND IS LABELLED ONE.** Three mechanisms have been guessed at on this leak
  and each cost a session. What makes this one worth recording is that it is **falsifiable in
  one line of the next ramp dump**: `gpu/mapped_memory` at ~32 GB confirms it;
  `gpu/mapped_memory` absent or small does not.

**5. `mapped-memory-repro.mjs` — IT DID NOT REPRODUCE, AND THAT IS NOT A REFUTATION.** Three
load shapes against a real Chromium: large uploads, thousands of small allocations, and a
renderer kept BUSY for twenty seconds while the dump was taken from the browser process. **The
2-4M bucket did not move on any of them** and GPU shared memory stayed at tens of MB.
- **SwiftShader, a different GPU stack and a synthetic load are three reasons the mechanism
  could be real on the box and absent here**, and the probe says so in its own verdict rather
  than printing a refutation. **Do not quote it as one.**
- **WHAT IT DID ESTABLISH IS WORTH MORE THAN THE NEGATIVE:** `gpu/mapped_memory` **is a name the
  dump emits** when `MappedMemoryManager` holds memory — observed, 16 MB attributed under it in
  the first run. So the candidate above is a **one-line read** on the next ramp dump rather than
  an argument. And a healthy WebGL renderer under load holds **tens of MB**, so the box's 32 GB
  is not what a busy command buffer normally does.
- **THE FIRST LOAD SHAPE WAS WRONG AND THE SIZE IS WHY.** 16 MB texture uploads produced ONE
  16 MB chunk, because chunk size is `max(default, the request)` — so a big request never
  produces the 2 MB signature. The box's uniform 2.0 MB means **many allocations each under
  2 MB**. Recorded because the obvious load is the misleading one.

- ~~**BOT-SIDE, so it is inert until the box updates.**~~ **MERGED AS #302 AND ON THE BOX
  (`c0b222c`, 2026-09-08 20:5x UTC, confirmed by `bot-ask git-status`).** Worker deploy green,
  3/3 shards, 10s heartbeat, health 17 of 19. Struck rather than deleted — "inert until the box
  updates" is the sentence a later reader quotes as a task.
- ~~**And the stall trigger fires on the next stall over 90 seconds, which is far more often
  than a ramp: the first evidence that it works arrives without waiting for one.**~~
  **WRONG, AND MEASURED WRONG THE NEXT DAY. A STALL OVER 90 SECONDS HAS NEVER HAPPENED OUTSIDE
  A RAMP.** Across **133 recorded tab-closes the longest trip is 71,552 ms and NOT ONE exceeds
  90,000** — the ordinary renewal sits at 68-71s, run after run. So the trigger fires on ramps
  and on essentially nothing else.
  - **THAT IS THE DESIGN WORKING, AND IT IS ALSO THE CLAIM FAILING.** No false positives means
    a slow-but-healthy trip can never spend the ramp's slot, which is exactly what the
    per-episode budget was for. What it does NOT buy is early evidence: **the trigger still
    needs a ramp to be exercised at all**, same as everything before it. What actually changed
    is that the trigger PATH is testable off-box in seconds (`ramp-arm-probe.mjs`); the READING
    still waits for an event.
  - **Struck rather than deleted because it is the optimistic half that gets quoted.** It was
    written into a summary within a day of the data that refutes it, and the data was already
    in `bot_events` at the time — one query, never run. The house shape: a claim about how
    often something fires, made without counting how often the thing fires.

### THE RDR LOOP IS A LOAD-TIME BURST AT ~800 REQ/S, NOT A 150/S POLL (2026-09-06)
The request counter's first loud reading was written up as *"18,392 requests in two minutes"*.
**Both events carry an `ageMs`, and it changes the size of the problem by an order of
magnitude.** Two events in 113, both to
`rdapi.reservecalifornia.com/api/webaccessfacility/futurebookingstartsendsdates`:
```
09-05 16:47 teardown   ageMs 25,750   19,008 of 19,025 lifetime, ALL inside the window   -> 738 req/s
09-05 19:14 bail:ramp  ageMs 135,097  18,392 of 18,409 lifetime, 5,596 in the last 120s
                         => 12,796 in the first 15.1s                                    -> 848 req/s
```
- **IT IS A BURST AT PAGE LOAD AND IT IS OVER IN SECONDS.** Both events sit in the first 15-26
  seconds of a browser's life, and in event B the rate collapses from ~848/s to ~47/s once the
  first fifteen seconds pass. **"18,392 in two minutes" (≈153/s) is the average of a burst and
  the quiet after it**, and it is the figure the next reader would size a fix against.
- **~800 REQUESTS A SECOND FROM THE RESIDENTIAL IP THAT HAS EATEN A 12-HOUR BLOCK ONCE.** That
  is the risk, and it is not the leak: the 09-06 03:29 ramp carried **4 lifetime requests on its
  busiest path** and the identical 32,779 MB signature. Confirmed unrelated, twice.
- **IT IS CONDITIONAL, AND WHAT GATES IT IS NOT ESTABLISHED — do not write one in.** Two of 113
  events over fourteen days. The 09-05 15:1x series is a runner-preemption window with a
  teardown every ~10.7 seconds — about a hundred browser lives — and **not one of them burst**
  (`GetCMSContentDetail=3`, `settings=2`, `websitesettings=2`). Whatever distinguishes a
  bursting load from a quiet one is the question, and both bursts are cold RC home-page loads
  (`config.json`, `load/enterprise`, the arcgis css, `distinct: 16`) while the quiet ones are
  not. **That is a correlation over two events.**
- **THE COUNTER CANNOT ANSWER "WHY", AND THE MISSING FIELD IS THE STATUS.** `page.on('request')`
  sees the path and never the answer, so **a retry loop against a 401 and an SPA asking 19,000
  times on purpose are the same reading** — and they need opposite fixes. This file has carried
  *"a retry loop in RC's SPA against a token that expired"* as a candidate since 2026-08-17 and
  it is still untested. **The next instrument is counting by (path, STATUS)** off
  `page.on('response')` — a status code is not a credential and none of the
  never-collect-a-field-you-must-filter rules touch it. **NOT BUILT.**
- **DO NOT REACH FOR BLOCKING IT FIRST.** Intercepting RC's own requests on the resident page —
  the page whose session an 08:00 cart depends on — to stop traffic whose cause is unknown is
  the change that trades a rate-limit risk for a missed cart. Name the cause, then decide.
- **AND THE BURST IS INVISIBLE UNLESS A TEARDOWN HAPPENS TO FOLLOW IT.** The counter reports at
  a teardown, a bail or a hung close; a burst that fires at load and ends fifteen seconds later
  is only ever seen because the browser happened to be torn down soon after. **Two observations
  is a floor on how often this happens, never a count.**

#### A THIRD BURST, BIGGER, AND THE STATUS IS COUNTED NOW (2026-09-07)
The 09-07 02:03 bail carried **≥49,237 hits in 120s / 75,195 lifetime** on
`futurebookingstartsendsdates`, on a browser **three minutes old** — against 18,392 and 19,008
before. So it is three events in fifteen days, not two, and the largest by a factor of two and a
half.
- **THE `≥` IS THE INSTRUMENT SATURATING, AND THE REAL FIGURE IS UNKNOWN.**
  `REQUEST_WINDOW_CAP` is 50,000 entries and the window held 49,237, so the two-minute count is
  a **lower bound that is within 2% of its own ceiling** — quote it as a floor, never as a rate.
  Raising the cap costs per-request objects in the one process suspected of allocating
  gigabytes; the honest fix is per-second buckets (120 × 200 counters, exact and bounded) and
  it is **NOT BUILT**.
- ~~**The next instrument is counting by (path, STATUS) … NOT BUILT.**~~ **BUILT 2026-09-07.**
  `page.on('response')` and `page.on('requestfailed')` feed a **LIFETIME** status count per path
  — no second rolling window, because the RATE is already answered by `recent` and the question
  here is the MIX; a parallel window would double the per-request objects held by the suspect
  process. `loopAnswerReading` (`src/lib/bot-events.ts`) turns it into the sentence, and the
  readout prints it under the loop verdict.
- **A REQUEST WITH NO ANSWER IS ITS OWN FINDING**, which is why `requestfailed` is counted and
  the readout prints the asks against the answers. **49,000 asks and 200 answers is a third
  story again**, and without the gap it reads as a 200 loop with a small denominator.
- **ABSENT IS NOT EMPTY.** A row written by a bundle older than this carries no `statuses` key
  at all and reports as `not-reported`. Rounding that to "nothing came back" would report every
  historical burst as a finding, falsely — the house shape, in the instrument built to end a
  different instance of it.
- **HOW TO READ THE NEXT BURST.** `401`/`403` dominant ⇒ a **retry loop against a rejection**,
  and the fix is the auth state it retries with — **not blocking the requests**. `2xx` dominant
  ⇒ RC's SPA **asking on purpose and being served**, and the fix is the request pattern. Mostly
  `failed` ⇒ Chromium refusing them, which is a third investigation. No dominant code ⇒ the
  readout says so and names nothing, because a spread is not a story.
- **IT STILL SAYS NOTHING ABOUT THE LEAK, and the 09-07 event is why that holds.** That ramp had
  the biggest loop yet AND the same 32 GB mapping as the 09-05 20:29 ramp, whose counter was
  **flat** (0 in 120s, 109 lifetime). Independent in both directions, now three times over.
- **BOT-SIDE, so it reads `statuses not reported` until the box updates.**

##### IT ANSWERED ON ITS FIRST BURST, AND THE ANSWER IS NONE OF THE THREE (2026-09-08)
The status counter reached the box and the very next burst used it. **69,060 asks on that one
path and NOT ONE answer of any kind** — no 2xx, no 401, no `failed`:
```
50000 in 120s   69060 lifetime  .../webaccessfacility/futurebookingstartsendsdates   {}      <- no answers
    0 in 120s       2 lifetime  .../webaccesscustomer/empty/shoppingcart             401x2
    0 in 120s       2 lifetime  https://www.reservecalifornia.com/config.json        200x2
    0 in 120s       1 lifetime  .../webaccesscustomer/load/enterprise                401x1
```
- **THE COUNTER IS DEMONSTRABLY WORKING IN THE SAME EVENT**, which is what makes the empty map
  a reading rather than a gap: every other path in the same snapshot carries a code, and the
  09-07 20:42 event shows `failed` being counted too (`200x4 failedx1` on split.io's SSE). So
  `{}` is not "we did not look".
- **`{}` AND `null` ARE DIFFERENT AND THE INSTRUMENT KEEPS THEM APART.** The 09-07 event —
  taken by a box that predated the counter — stores `null` per path and renders *"this bundle
  does not report statuses"*. The absent-reading rule, honoured on its first live test.
- **AND THE READOUT REACHED THE VERDICT ITSELF**, without anyone editing it: *"nothing came
  back for any of the 69060 ask(s) — Chromium is not being answered at all, which is neither of
  the two candidates and is its own finding."* That is the fourth branch, and it was written
  into `loopAnswerReading` before there was an event to render it against.
- **SO THE THREE READING RULES ABOVE ALL MISS.** It is not a retry loop against a rejection
  (no 401/403), not an SPA being served (no 2xx), and not Chromium refusing them (no `failed`).
  **A CANDIDATE, LABELLED AS ONE:** requests issued faster than the connection pool can drain
  and queued in the renderer — ~800/s against six sockets per host — which would leave tens of
  thousands neither answered nor failed. **Nothing tests that yet**, and three mechanisms have
  been guessed on this box's problems, each costing a session.
- **DO NOT RE-LINK IT TO THE LEAK.** The same 09-08 ramp carried both, and 09-07 20:42 carried
  the same 32 GB mapping with a **flat** counter. Independent in both directions, four times
  over now.

#### AND ITEM 3 — "THE SESSION DIES WITHIN ~2 MINUTES OF EVERY QUEUE" — IS INSTRUMENTED AND UNANSWERED (2026-09-06)
Checked in source rather than waited on. **The instrument shipped 2026-09-03 and every outcome
of the yield now speaks**, including a fourth that did not exist when the four deaths were
recorded: `already-stored-stale` — storage holds a DIFFERENT token from the live one, i.e.
*this fix's own defect surviving inside it*, **reported and deliberately not acted on** (over-
writing a key RC's own SDK owns, on the release-critical path, wants its own evidence).
- **NO FAILING QUEUE HAS HAPPENED SINCE.** The only queue after it (09-04, `#L034`) reported
  `already-stored` — *"storage already held the token — nothing to write"* — which is the fix
  behaving correctly on a healthy session and says nothing about the failing case. **It cannot
  be answered without a queue; there is nothing to build.**
- **AND WHAT IS KILLING THE SESSION TODAY IS A DIFFERENT MECHANISM, so do not read one as the
  other.** As of 09-06 the box is dead for 2h+ with **no hold queued at all**: `okta session
  GONE (404)`, seven consecutive failed renewals, backoff at 30m. That is the ordinary
  between-releases state — the token lives ~1h and `maybeAutoLogin` restores it at T−30 — and
  **the printed remedy (`rc-login.bat`) force-kills the Chromium the token lives in**, which is
  the 2026-08-16 07:33 cry-wolf shape. Nothing is at risk and no human errand is warranted.

#### AND IT DID IT AGAIN, BY A DIFFERENT ROUTE — A SIGHTING FROM YESTERDAY (2026-09-06)
Reading the hold readout while waiting on CI: `#L003` at Leo Carrillo failed at the 09-05
release, and the verdict line read *"THE SITE DID OPEN (**T+-64337s**, seen by the poller) and
we did not get it — somebody else carted it first. This is a race we lost."*
- **-64,337 seconds is seventeen hours and fifty-nine minutes BEFORE the release.** The caller
  hands over the delta between the pair's `watch_site_alerts` row and the release, and
  **`last_alert_at` is one mutable column per (watch, site) — the LAST alert, not a history** —
  so it sits wherever it happens to sit relative to any given release. The `ORDER BY
  last_alert_at ASC LIMIT 1` reads as picking the earliest of many and is a no-op over one row.
- **THE DOUBLE SIGN WAS THE TELL**, and the test for it is one line. `T+${n}s` with a negative
  `n` is a formatting bug that was carrying a false finding.
- **THE FIX IS NOT `>= 0`, BECAUSE RC RELEASES EARLY.** `rc-583`'s measured flip bracket is
  **(−2.2s, −0.2s] — entirely before T**, so a sighting a second or two ahead of the release IS
  the release. The window is **`RELEASE_SIGHTING_WINDOW_S = 15`**, the same lead the cart burst
  opens on and for the same measured reason. Outside it the reading is reported as what it is —
  *"the only sighting on file is 18h BEFORE this release … no competitor is implied"* — at
  `info`, because nothing about it says anything went wrong.
- **THE DECISION LIVES IN THE PURE FUNCTION, not in the caller's SQL.** Narrowing the query
  would put the same 15 seconds in two places, which is how `nextHoldRelease` came to disagree
  with `dueHolds`; and the function is the half that has tests.
- Six mutations, each verified to APPLY and to fail — including the window back to `>= 0` (the
  version that looks obviously right and discards the sharpest evidence there is), the window
  widened to a day, the double sign restored, and the pre-window reading downgraded to silence
  or promoted to `warn`.
- **Two of the guards failed on their first run and both were the COPY, not the logic**: the
  new text said *"Not a race we lost"* and tripped the assertion that the phrase must not
  appear at all, and a 16-second delta rendered as `0m BEFORE this release`, which reads as a
  rounding artifact rather than a duration. Both are what a reader sees at 08:15.


### THE ONSET IS A 35 GB COMMIT STEP, THE TAB HAS ITS OWN RENDERER, AND THE INSTRUMENTS FOR BOTH ARE BUILT (2026-09-04)
Asked what to do about the leak — more tests, Track B, or other. Read the memory series around
every onset since 09-01 before answering, and it changed the answer.

**EVERY RAMP HAS THE SAME FIRST SAMPLE, ELEVEN FOR ELEVEN.** From `chromium_memory_samples`,
the two-minute `bot` series, at the onset tick (UTC):
```
09-04 12:01:02  procs 9   rc   306 MB  renderer 118   commit  7,609 / 17,150   free 10,712
09-04 12:03:07  procs 10  rc 3,624 MB  renderer 3,061 commit 40,458 / 40,854   free  6,794   <- ONE tick
09-04 12:13:08  procs 10  rc 9,368 MB  renderer 8,322 commit 47,265 / 48,061   free  3,967
09-04 12:15:13  procs 7   rc   207 MB  renderer 57    commit  7,355 / 31,580   free 11,022   <- replaced
```
- **COMMIT JUMPS ~7.5 GB → ~40-46 GB INSIDE ONE TWO-MINUTE TICK, while the rc family's private
  bytes account for ~3.5 GB of it.** Then both climb together at ~450 MB/min to ~52 GB / ~9.4 GB
  and the browser is replaced. So **~35 GB of commit appears at the onset and is attributed to
  nothing the series can see** — the series sums PRIVATE bytes over OUR chrome.exe. Same shape
  on 09-01 09:03, 09-01 18:13, 09-02 09:03, 12:42, 15:53, 09-03 04:19, 14:30, 16:28, 09-04 00:49
  and 12:03. The 09-04 note above ("commit goes to 47 GB for 9 GB of Chrome — unexplained")
  was reading the peak; the step is at the onset, and it is a STEP, not a climb.
- **THE COMMIT LIMIT CHASES IT** (17,150 → 40,854 → 48,061 MB and back to 31,580), which is the
  system-managed pagefile growing to satisfy a real commit charge. Windows does not grow the
  pagefile for a reservation; something asked for 35 GB of commit and got it.
- **THREE READINGS FIT AND THEY HAVE DIFFERENT FIXES — do not write one in.** A pagefile-backed
  shared section a renderer created (private bytes never count those; Chromium's mojo, GPU and
  discardable-memory buffers are all sections); kernel pool (no process owns it); or
  `Win32_OperatingSystem`'s virtual-memory figures being a proxy that does not mean what the
  column says. The `memory` command's full scan separates them and has only ever run when a
  human typed it.

**THE RENEWAL TAB GETS ITS OWN RENDERER — the shared-renderer hypothesis is OUT.** `rc_procs`
rises by one to three at every renewal, ramping or not (09-04 13:47: 8 → 9 → 11 → 8 across a
renewal that did not ramp; 09-04 12:03: 9 → 10 at an onset), and the ramping renderer is a NEW
pid at the onset on every event checked. ~~So PR #142's cure is aimed at the right renderer~~
**WRONG WITHIN THE HOUR — see "THE INSTRUMENTS FIRED" below: the tab's renderer stayed FLAT and
the ramp was the RESIDENT page's renderer.** The tab has its own renderer; the ramp is not in
it. The rest of this paragraph stands as the reasoning that was tested and lost. The memory was
not being handed back because **a renderer outlives the trip by ten minutes**
— which is either the renewal's body timing out step by step (its bounded waits sum to several
minutes) or `await tab.close()` never returning. **The keep-warm's own trail said a NON-ramping
renewal on 09-04 held its tab for 741 seconds**, which is direct evidence the body alone can
take twelve minutes; it does not say what a ramping one does.

**`await tab.close().catch(() => {})` WAS UNBOUNDED AT ALL THREE SITES** (renewal, auto-login,
warm-up). Playwright launches Chromium with the hang monitor off, so a renderer that will not
run its unload handlers is never force-killed on our behalf, and a close against one can wait
for ever. A close that hangs for ten minutes and a body that takes ten minutes end the same way
in the series — a browser replacement — and differ only in one number nothing recorded.

**BUILT (this PR), THREE INSTRUMENTS AND ONE TABLE:**
1. **`bot_events` (migration 075, APPLIED)** — kind + jsonb detail + capped text, allow-listed
   kinds, NUL-stripped. `src/lib/bot-events.ts`; the rc-holds route stores `body.event` before
   the hold work. Readout: `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`.
2. **`scripts/auto-cart-bot/tab-close.mjs` — `closeTabBounded`.** Every throwaway tab closes
   under `TAB_CLOSE_MS` (30s); a close that does not return is given up on, logged loudly, and
   asks the resident loop for a recycle (`takePendingRecycle`, read beside `oktaTrip`, AFTER the
   runner's preemption). **Every close is reported** as a `tab-close` event with `tripMs`,
   `closeMs`, `hung`, `ramMb` — hung or not, because the healthy baseline is what makes a bad
   number readable. `worker/tab-close.test.mts`, nine guards.
3. **`scripts/auto-cart-bot/ramp-scan.mjs`.** The first periodic sample that reads the rc family
   past `RAMP_SCAN_MB` (3,000) makes `bot.mjs` run a full scan ONCE (20-min cooldown, one per
   ramp) and store it as a `ramp-scan` event: OS commit from the sampler's own class, the
   perf-counter commit and **kernel pool** figures (`Win32_PerfRawData_PerfOS_Memory`, wrapped),
   the pagefile, **private bytes summed over EVERY process** (the discriminator: near the commit
   figure ⇒ process-attributable, read TOP; far below ⇒ shared sections or kernel), and per
   chrome.exe on our profiles: type, private, working set, virtual size, pool charges, **handle
   count** (a renderer holding tens of thousands of handles is holding sections). At the onset
   the box is at ~40% commit and PowerShell still spawns; at 99% it does not.
   `worker/ramp-scan.test.mts`, thirteen guards. Twelve mutations across the three, each
   verified to APPLY and caught. **Seven existing guards broke over unchanged behaviour** —
   they pinned `await tab.close()` by expression, and the change made the close STRONGER.
   Re-anchored on the bounded call (not a character window) and each re-verified to fail
   against a bare close restored at its site. Twenty-somethingth time.
- **BOT-SIDE, so inert until the box updates.** Then: the next ramp (every 5-6 h) yields one
  `ramp-scan` row and the next renewal yields `tab-close` rows. **HOW TO READ THEM:** `hung:
  true` or `closeMs` in minutes ⇒ the close was the ten minutes and the recycle now ends it
  early; `closeMs` in milliseconds beside `tripMs` in minutes ⇒ the BODY is slow and the fix
  is inside `renewSession`'s waits. In the scan, `ALLPROC privateSumMB` against `OS
  commitUsedMB` is the first line to read.
- **TRACK B IS STILL THE CURE FOR THE RENEWAL PATH and still needs the owner's word.** Nothing
  here cures anything: the bounded close shortens a ramp only if the close is what was holding
  it, and the scan names the 35 GB only. What changed is that Track B no longer waits on Track A
  (which can never answer) and that two cheaper hypotheses are being measured first.

#### THE INSTRUMENTS FIRED WITHIN TWO MINUTES OF THE BOX UPDATING, AND THEY REVERSE THE PARAGRAPH ABOVE (2026-09-04 22:19–22:36 UTC)
The box moved to `1e947ee` at 22:19:47. The keep-warm reopened its browser at 22:19:38; a ramp
began before 22:20:13; the renewal ran 22:20:41–22:21:17; the loop then stalled and the 12-minute
wedge watchdog killed the process at 22:31:51. Every instrument built today reported, and the
memory series bracketed the whole event.
```
22:19:39  procs 7  rc   308  max gpu 14812   96 MB   commit  8,438      <- reopened 22:19:38, "token source: live"
22:20:13  procs 7  rc 1,912  max renderer 2648 1,589 commit 46,596      <- BEFORE the renewal (22:20:41)
22:21:40  procs 8  rc 3,741  renderer 2648  3,408    commit 48,117      <- the renewal tab is the 8th process
22:31:46  procs 8  rc 9,014  renderer 2648  8,683    commit 53,452
22:31:51  ✗ WEDGED — stalled 634s in "reporting session health" — exit 1, supervisor restart
22:33:51  procs 9  rc   299                          commit  7,400      <- new browser
```
- **THE TAB CLOSE WAS NEVER THE PROBLEM — 16 MILLISECONDS.** First `tab-close` event: `renewal ·
  tripMs 48,047 · closeMs 16 · hung false`. Hypothesis 1 above is dead on its first reading.
- **THE RAMPING RENDERER WAS THE RESIDENT PAGE'S, NOT THE TAB'S — the paragraph above has it
  backwards.** pid 2648 held 1,589 MB at 22:20:13, twenty-eight seconds before the renewal
  started and before its tab existed (the process count went 7 → 8 only at 22:21:40). The
  alloc trail says the same from the other side: `[renewal] −4 MB over 640s` (the tab's
  renderer was FLAT) while `[resident]: EMPTY — that renderer answered no CDP call at all`.
  **So PR #142's throwaway tab IS aimed at the wrong renderer for this event**, which is what
  the 08-25 trail entry suspected and today's "the tab gets its own renderer" paragraph
  wrongly closed. The tab does get its own renderer; the ramp is not in it.
- **WHAT ENDS A RAMP IS THE WEDGE WATCHDOG, MEASURED.** `Stalled in: reporting session health
  (634s in that step)` — `checkAndReport(ctx, page)` drives the RESIDENT page, whose renderer
  had stopped answering, so the loop parked there until `HUNG_MS` (12 min) bailed the process.
  That is the ten-to-twelve-minute ramp duration this file has puzzled over since 08-17: it is
  `HUNG_MS`. Not the size guard (the loop never reached it), not the post-Okta recycle. The cost
  of every bail is the session (`token source: none` after the restart) and a renewal.
- **THE RAMP SCAN NAMES THE 35 GB, TO A CLASS.** Stored at 22:21:47 (rc family 3,741 MB):
  ```
  OS   commitUsedMB=48132   ALLPROC privateSumMB=8469 (220 processes)   gap 39,663 MB
  PERF poolNonpagedMB=310   poolPagedMB=432     <- the kernel's share is under 750 MB
  PAGEFILE allocatedMB=32955 currentMB=7        <- 40 GB committed and 7 MB of it ever paged
  CHROME pid=2648 renderer privateMB=3509 pagedPoolKB=66580 handles=18705 threads=20
  CHROME pid=1228 renderer privateMB=39   pagedPoolKB=778   handles=276
  ```
  **The commit is in no process's private bytes and not in the kernel pools, and it has never
  been touched** (7 MB of pagefile in use against 40 GB charged). That is the signature of
  **pagefile-backed shared-memory SECTIONS, committed but unwritten** — the one class of
  allocation that private bytes never count, that the RAM arm can never see (untouched pages
  cost no RAM), and that the sampling profiler cannot see (Track A, retired). The ramping
  renderer holds **18,705 handles against ~250 for a healthy one, and 66 MB of paged pool
  against 0.8 MB** — section objects are handles charged to paged pool. **CANDIDATE, arithmetic
  only, not measured: ~18,700 regions of ~2 MB ≈ 37 GB ≈ the gap.** What creates them is not
  named; a per-request data pipe in a request loop fits the shape and nothing has counted the
  resident page's requests.
- **THE TRIGGER CANDIDATE MOVED, AND IT IS NOT OURS.** The renewal logged `the app holds no
  usable token (src=none)` at 22:20:41, sixty-three seconds after `token source: live` at
  22:19:38. A token that vanishes from a page nobody touched is the 08-09 finding: RC's own
  okta-auth-js `autoRenew` fires a hidden `authorize?prompt=none`, fails, and DELETES the
  tokens. That round trip ran in the resident renderer at exactly the moment it began to ramp.
  Twelve minutes later OUR click-through Okta trip in a fresh browser's throwaway tab renewed
  the session (`✓ renewed by authorize: none → 3580s`) for **−89 MB and no ramp**. **Candidate,
  labelled as one**: the SPA's own silent renewal is what ramps, and it ramps the page it runs
  in. It is consistent with 08-19 (four of our Okta trips, no ramp) and with the hourly silent
  re-mints that succeed without ramping — a FAILING silent renewal may be the specific case.
- **WHAT THIS DOES TO THE PLAN.** Track B (replay OUR trip over `ctx.request`) removes a trip
  that did not ramp tonight and leaves the resident page's own trips alone — **it may be the
  wrong lever**, which is the reason it was held back, confirmed from the other direction.
  Two cheaper next steps, neither built, both bot-side:
  1. **Count the resident page's requests** (`page.on('request')`, path counts only, never a
     body) and print the top paths in the wedge bail and the ramp scan. If the 18.7k handles
     are a request loop, the count says so in one line.
  2. **Bail sooner.** The resident renderer answering no CDP call for 60s while the rc family
     is past 3 GB is a ramp in progress; `HUNG_MS` waits twelve minutes. A bail at two minutes
     costs the same session the twelve-minute one costs and leaves ~7 GB less on the box.
     **Not the RAM arm** — untouched commit never lowers free RAM, which is why it has sat out
     sixteen consecutive ramps.
  Blocking `prompt=none` on the resident page is the obvious cure and has a known cost: the
  silent self-renewal that works most hours is the same mechanism. Measure (1) first.
- **AND THE RENEWAL'S "did NOT ramp" VERDICT WAS PRINTED OVER A 723 MB LOSS.** The net trace's
  three-way verdict uses a higher threshold than `NATIVE_ALLOC_RAMP_MB`, so the same trip was
  called "not a ramp" on one line and stored as a ramp reading on the next. The RAM delta was
  the resident page's, not the tab's — both instruments bracket the wall clock, not the target.

#### ~~THE NEXT TWO ARE DESIGNED AND NOT BUILT~~ — BUILT 2026-09-05, see the section after this one
**Struck the day after it was written, and kept because the anchors below are what the build
followed.** Both instruments shipped in the next section; read that for what is live and how to
read the first firing. The three "do not" rules at the end are unchanged and were obeyed.

Written so a fresh session builds from anchors that were checked in source at `a852a32`,
rather than re-deriving them. **Both are bot-side** (`scripts/auto-cart-bot/`), so nothing
here is live until the box updates (`requestBotUpdate`, confirmed by `bot-ask git-status`,
never by `autocart.bot_version`). Neither cures anything; they name the trigger and shorten
the ramp.

**1. THE RESIDENT-PAGE REQUEST COUNTER** — a pure module (`rc-request-count.mjs`) plus wiring.
- **Attach `page.on('request', …)` where `residentPage = page` is assigned** (`rc-keepwarm.mjs`,
  inside `warmResident`'s try, just after `ctx.pages()[0] ?? ctx.newPage()`), so it is
  re-attached on every reopen — a browser life is a new context. Playwright delivers subframe
  requests on the same event, and that is load-bearing: okta-auth-js's `prompt=none` renewal
  runs in a hidden iframe, and it is the trigger candidate.
- **Key = `origin + pathname`, and REUSE the normaliser `okta-net-trace.mjs` already has** (its
  header says why: Okta's callback carries `code=` in the query, and this repo published one on
  2026-08-09). Never the query, never a header, never `response.body()` — buffering a payload
  into this process on a page suspected of moving gigabytes is the cure arriving as the disease.
- **Two windows, because a loop is a RATE**: lifetime-of-browser counts and a rolling two-minute
  count per path. Cap distinct paths (~200; past the cap count under `<other>`) so a path with an
  id baked into it cannot grow the map for ever.
- **Print the top ten by two-minute count in THREE places**: `reportAndBail` beside
  `describeAllocTrail` (every bail arm), the teardown flush (`flushAllocRamps({ final: true,
  describeIfEmpty: true })` at the end of `warmResident`), and on a hung close. Post the same
  as a **`request-counts` bot event** — add the kind to `BOT_EVENT_KINDS` in
  `src/lib/bot-events.ts` (`worker/bot-events.test.mts` pins the list by value) and render it in
  `scripts/bot-events-readout.mts`. From the timer, `reportBotEvent` is fire-and-forget; from a
  bail it must be **awaited and bounded** the way `flushAllocRamps` is (a 4s race), or
  `process.exit` kills the POST that carries the one reading the arm exists for.
- **Do not try to join it to the ramp scan.** The scan runs in `bot.mjs` and cannot see the
  keep-warm's counter; the `at` timestamps in `bot_events` line the two up.

**2. THE TWO-MINUTE BAIL** — a NEW arm in the watchdog timer (`const renew = setInterval(…)` in
`warmResident`), placed AFTER the WEDGE arm and BEFORE the RAM arm. **Both existing arms stay
exactly as they are**; `HUNG_MS` must go on tolerating a full unattended sign-in.
- **Condition A — the resident renderer has answered no CDP call for `RC_KEEPWARM_RAMP_STALL_MS`
  (default 120 s).** The signal already exists and needs no new request: `sampleHeap` returns
  `null` on `no answer in 2000ms` (`TRAIL_TIMEOUT_MS`, `rc-heap.mjs`), so `heapTrail` simply
  stops growing — read the age of its newest sample. **Requires `heapProbe` and at least one
  prior sample; otherwise the condition is UNKNOWN and the arm stands down.** An empty trail is
  "never answered", which is the fresh-launch state, not a ramp. The throwaway tabs have their
  own renderers (measured 09-04), so a live Okta trip does not silence the resident page — this
  arm cannot fire on a working sign-in the way the RAM arm did on 08-19.
- **Condition B — the rc family is past `RC_KEEPWARM_RAMP_MB` (default 3000, the threshold
  `ramp-scan.mjs` already uses).** **THE TIMER MUST NOT SPAWN**: `rcFamilyMb()` runs PowerShell,
  and spawning is what fails first at high commit (see the `LOW_RAM_MB` comment). The
  non-spawning source is the reading `bot.mjs` already takes every two minutes: have the
  sampler's `post` (`createSampler({ post: … })` in `bot.mjs`) also write the sample to a file in
  the bot directory (`.memory-latest.json` — `{at, rcMb, maxPid, maxType}`, written to a temp
  name then `renameSync` so a reader never sees half a file), and read it in the timer with
  `readFileSync` — a file read is not a spawn. **Age-gate it: a reading older than ~5 minutes is
  UNKNOWN → stand down.** `os.freemem()` cannot serve here: untouched commit never lowers free
  RAM, which is exactly why the RAM arm has sat out sixteen consecutive ramps.
- **BOTH CONDITIONS, ALWAYS** — the rule the RAM arm was written under. A silent renderer alone is
  RC's app tier failing to render for five minutes (observed 08-31 and 09-02); a big family alone
  is a ramp the loop may still be advancing through, which the size arm in the loop body handles
  once the loop returns. Neither alone earns spending the session.
- **Action: go through `reportAndBail` exactly like the other two arms** — heap facts, both
  trails, the alloc flush awaited and bounded, the request counts, then `bail` (release the
  profile lock, `process.exit(1)`) — under a line naming the arm:
  `✗ RAMP — resident renderer silent Ns, rc family N MB (reading Ns old)`. **The cost is the same
  session the twelve-minute bail costs today**; what it buys is a two-minute ramp instead of
  twelve, ~7 GB less commit on the box, and the request counts taken at the onset rather than at
  the peak.
- **Three things NOT to do, each recorded as having cost a working repair**: do not lower
  `LOW_RAM_MB` (08-19); do not put the check in the loop body (structurally unreachable during a
  ramp — the size arm's whole history); do not "simplify" the two arms into one.
- **Guards.** `worker/keepwarm-recycle.test.mts` already pins `WATCHDOG_MS ≤ 15s`, the RAM arm's
  both-conditions rule and the `LOW_RAM_MB` bounds, and `envDefault` there has misread a
  threshold TWICE (`60_000`, then `40 * 60_000`) — read it before adding constants. Extend with,
  each mutation-verified to APPLY and to fail: the new arm is in the TIMER and not the loop body;
  it requires both conditions; it stands down on an unknown (no file, stale file, empty trail);
  it sits between the WEDGE and RAM arms; it goes through `reportAndBail`; `bot.mjs` writes the
  file atomically from the sampler's post; the counter is attached at the resident-page site and
  keys on `origin + pathname` with no query. **Commit before mutating.** `worker/**` guards fire
  a worker deploy on merge — expected; check `poller.shards` after.
- **HOW TO READ THE FIRST FIRING.** A `✗ RAMP` line at ~2 minutes with a `request-counts` event
  whose top two-minute path is Okta's `/oauth2/v1/authorize` or an RC `/SSO/` endpoint at
  hundreds of hits ⇒ **a request loop, and the trigger is named** — then blocking `prompt=none`
  on the resident page is the cure to weigh (known cost: the silent self-renewal that works most
  hours is the same mechanism). Flat counts (tens, spread across RC's ordinary API) ⇒ the sections
  are not per-request and the next candidate is Chromium's own handling of the occluded window,
  which is a different investigation. **Either answer is a reading; "no bail fired" is not** —
  the box needs a ramp (every 5-6 h) after the update, and the readout says which arm ended it.

#### BOTH ARE BUILT — the request counter and the two-minute bail (2026-09-05)
Built from the anchors above, every one checked in source at `98809e5` before a line was
written, and each held. **Bot-side, so inert until the box updates** — confirm with
`npx tsx scripts/bot-ask.mts git-status`, never `autocart.bot_version`.

**1. `scripts/auto-cart-bot/rc-request-count.mjs`.** Attached at `residentPage = page`, so a
reopen gets a fresh counter and "lifetime" is the life of that browser. Keys are `origin +
pathname` through the net trace's own `safeUrl` — the counter has no scrubber because it has
nothing to scrub: no query, no header, no body, ever. Lifetime and rolling two-minute counts,
200 distinct paths then `<other>`, and the window is bounded in entries too — an overflowed
count is printed as `≥N`, a floor, because a loop hot enough to overflow it is exactly the case.
**Printed in three places and posted as a `request-counts` bot event from each**, with
`reason` saying which: the bail (full ten lines, POST awaited inside the same bounded race as
the alloc flush — `process.exit` kills an unawaited POST), the teardown (ONE compact line, since
it fires on every reopen into a 16k `tail-log`; the event carries the full top ten), and a hung
close. **Measured against a real Chromium before shipping:** seven `fetch`es from inside an
iframe were counted on `page.on('request')`, which is what makes okta-auth-js's hidden
`prompt=none` frame visible, and a `?code=` on every URL reached no key.

**2. `scripts/auto-cart-bot/ramp-bail.mjs` + a THIRD arm in the watchdog timer**, after WEDGE
and before RAM, both of which are byte-for-byte as they were and pinned that way (`HUNG_MS`
12 min, `LOW_RAM_MB` 2000). Condition A is the age of the heap trail's newest sample — `sampleHeap`
returns null on `no answer`, so the trail stops growing and its age IS the silence; no probe or
an empty trail is UNKNOWN (fresh launch). Condition B is the rc family read from
**`.memory-latest.json`**, which `bot.mjs`'s sampler now writes on every sample, before the POST,
as a temp name then `renameSync`; older than five minutes or carrying no figure is UNKNOWN. **The
timer still never spawns and this arm never reads `os.freemem()`** — untouched commit does not
move it, which is why the RAM arm sat out sixteen ramps. Both conditions, always; any UNKNOWN
stands down; it goes through `reportAndBail` like the other two, under
`✗ RAMP — resident renderer silent Ns, rc family N MB (reading Ns old)`. Defaults
`RC_KEEPWARM_RAMP_STALL_MS` 120s, `RC_KEEPWARM_RAMP_MB` 3000 (the same bar `ramp-scan.mjs`
triggers on, pinned equal so the two readings describe one event),
`RC_KEEPWARM_RAMP_READING_MAX_AGE_MS` 5 min.

**Guards.** `worker/rc-request-count.test.mts` (14) and eight `RAMP:` tests appended to
`worker/keepwarm-recycle.test.mts`. **Nineteen mutations, each asserted to APPLY and each
caught** — the arm moved below the RAM arm, `&&` → `||`, the age gate removed, an empty trail
read as silent, `bail` called directly, the file written after the POST, the key keeping its
query, the counter never attached, the bail dropping its POST, the cap removed, the readout
dropping the section, a non-atomic write, the kind not allow-listed, the teardown printing the
full block, the window never pruning, a hard-coded memory figure, `HUNG_MS` shortened,
`LOW_RAM_MB` lowered, and stale memory treated as known. **Two existing guards broke over
unchanged behaviour and were re-anchored, not relaxed**: `warmup-sampler` pinned
`await Promise.race([` as the 400 characters before the flush (the flush now shares that race
with the request-counts POST), and `chromium-memory` pinned `post()`'s FIRST statement (the file
write now precedes it). Each re-verified failing against the regression it exists for.

**MERGED AS #277 (`04c613b`) AND ON THE BOX SINCE 2026-09-05 03:26 UTC** — `git-status` read
`HEAD 04c613b`, the worker deploy went green with 3/3 shards held and a fresh heartbeat, the new
keep-warm logged `alloc trail: resident renderer armed` and `token source: live` at 03:26:26, and
`bot.mjs` restarted the same second with no `could not write` line while the memory series went
on posting. **`REQUEST COUNTS: 0` at 03:33 is the expected state, not a miss**: the update's
`stop-all` kills the keep-warm rather than tearing it down, so the first event arrives at the
first reopen (a profile yield, a recycle, or a bail), and the first `✗ RAMP` needs a ramp.

**HOW TO READ THE FIRST FIRING.** `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`
has a REQUEST COUNTS section; read the `bail` rows first, teardowns are the baseline. In
`logs\rc-keepwarm.log` a `✗ RAMP` line at ~2 minutes says the arm fired — **and the WEDGE arm
not firing at 12 is the same fact from the other side.** A `request-counts` event whose top
two-minute path is Okta's `/oauth2/v1/authorize` or an RC `/SSO/` endpoint at hundreds of hits
⇒ **a request loop, trigger named**, and blocking `prompt=none` on the resident page is the cure
to weigh (known cost: the silent self-renewal that works most hours is the same mechanism).
Flat counts (tens, spread across RC's ordinary API) ⇒ the sections are not per-request and the
next candidate is Chromium's own handling of the occluded window. **Either is a reading; "no
bail fired" is not** — the box needs a ramp after the update (every 5-6 h). Three ways the arm
can stay silent through a real ramp, each visible: the box has not updated (`git-status`); no
`.memory-latest.json` yet (the sampler writes one within two minutes of `bot.mjs` restarting);
or the renderer kept answering CDP while it ramped, in which case the heap trail keeps growing
and the twelve-minute wedge still ends it — that would itself be a finding, and the request
counts arrive at the teardown regardless.

#### IT FIRED, AND THE THIRD OF THOSE THREE IS WHAT HAPPENED (2026-09-05)
The paragraph above names three ways the arm could stay silent through a real ramp. **The third
one came true within hours of it being written**, and the same morning answered the question the
request counter was built for.
```
07:30       ramp onset, resident renderer, browser 676m old (launched at the 03:26 UTC update)
07:31:28    ramp-scan triggers: rc 3203 MB, commit 47,823/48,577, free RAM 7,244
07:41       peak 8,879 MB
07:42:00    bail — request-counts {reason:'bail', 0 in 120s / 197 lifetime, 78 paths}
```
- **THE REQUEST COUNTER ANSWERED FLAT, AND THAT RETIRES A CANDIDATE THIS FILE ASSERTED THREE
  TIMES.** Zero requests in the 120s before the bail; **197 across the browser's ENTIRE eleven
  hours**; the busiest paths are Split's feature-flag SDK (`splitChanges` 27, `memberships` 20,
  `auth` 18, `sse` 14) and Okta (`userinfo` 13, `authorize` 11, `token` 11). **Eleven authorize
  calls in eleven hours is the ordinary hourly renewal, not a loop.** The readout's own verdict:
  *"flat: the busiest path had 0 hits in 120s. The sections are NOT per-request; the next
  candidate is Chromium's own handling of the occluded window — a different investigation."*
  So the ~18,700 handles are not one-per-request, and "network/IPC buffering in a request loop"
  is finally tested rather than asserted.
- **THE ARM DID NOT FIRE. TWELVE MINUTES IS `HUNG_MS` TO THE MINUTE**, so the WEDGE arm ended it
  — while condition B had been satisfiable since 07:31. Condition A was **CDP silence on the
  resident renderer**, and that renderer went on answering `Performance.getMetrics` all the way
  to 8,879 MB. An instrument gated on a signal that does not change during the event: the same
  shape as every retired instrument above, in the arm built to escape them.
- **WHICH ARM FIRED CANNOT BE READ BACK, AND THAT IS THE SECOND DEFECT.** All three arms posted
  `reason: 'bail'`, and `tail-log`'s 16,000-character window had rolled — because the hold
  runner preempted the profile every ~11 seconds through its retry window, so the teardown ran
  about **a hundred times in twenty-one minutes**, each printing a compact request-counts line
  and an alloc-trail line. **The instrument buried the event it was built to explain.** The
  arithmetic is the evidence here, not a log line.
- **FIXED (this change): condition A is now the LOOP'S OWN STALL** — `Date.now() - lastTick`,
  the same clock the wedge and runaway arms read, never UNKNOWN, and the signal both observed
  ramps actually produced (634s in `checkAndReport` on 09-04, the full twelve minutes on 09-05).
  **Both-conditions survives the swap deliberately** and this is not the RAM arm's rule being
  weakened: the loop-body size guard already acts on `rcFamilyMb` alone at 1,500 MB and can
  RECYCLE, which is cheaper than the exit this arm spends, so this arm exists only for the case
  that guard cannot reach. Each arm now names itself (`reason: 'bail:ramp'`), and a teardown on
  a browser that lived under `TEARDOWN_MIN_MS` (60s) reports nothing but is **counted forward**
  (`+N short reopen(s) not reported`) — silence and suppression must not read the same.

##### AND NAMING THE ARM MADE THE READOUT COUNT ZERO BAILS (2026-09-06)
The line above is the fix; this is what it broke one file over. `scripts/bot-events-readout.mts`
classified `request-counts` rows with `reason === 'bail'`, an EQUALITY test, and the arms now
post `bail:ramp`. So from #280 until 2026-09-06 **no bail was ever counted as one.**
- **THE SUMMARY READ `0 at a bail` WITH TWO REAL BAILS PRINTED UNDER IT** — verified by running
  it, not by reading the code. Both 09-05 bails fell through to `other`.
- **AND THE ORDERING IS THE MORE EXPENSIVE HALF, because the count at least looks wrong.** The
  section header promises *"Bails first — they are the reading taken during a ramp"*; `other`
  renders LAST, so the only readings taken DURING a ramp printed at the bottom, below the
  teardowns the same header calls the baseline. `docs/NEXT-SESSION.md` tells the next session to
  *"read the `bail` rows first, teardowns are the baseline"* — followed literally against a
  summary saying zero, that reads as **the arm never fired**, on the one instrument the leak
  investigation now depends on.
- **THE HOUSE SHAPE, AND THE SECOND TIME IN TWO DAYS FROM THE SAME COMMIT.** An absent reading
  standing in for a negative. #280 also had to teach the readout that a bail is not a teardown;
  what it did not do was move the classifier with the vocabulary it changed.
- **ONE CLASSIFIER NOW, AND THAT IS THE ACTUAL REPAIR.** There were TWO filters — `byReason` and
  a separately hand-written `!['bail','hung-close','teardown'].includes(...)` for `other` — which
  is how they drifted apart while each looked right. `requestCountReason` in `src/lib/bot-events.ts`
  is the single definition and both buckets derive from it.
- **`bail:` AND NOT `bail`.** A bare prefix would sweep in a future `bailout`; the bare word
  `'bail'` stays matched because pre-#280 rows carry it and are real bails. Miscounting in the
  other direction is the same error wearing different clothes.
- `src/lib/bot-events-reason.test.mts`, **eight mutations, each verified to APPLY and to fail** —
  the equality test restored, the prefix widened, the bare word dropped, unknowns swept into
  `bail`, the readout reverting to its own equality filter, `other` becoming a second list, and
  the bails rendered after the baseline. **The ordering mutation had to be redone**: the first
  version DELETED the bail render loop, so it tripped the "all three loops present" assertion
  instead of the ordering one — a catch that proves nothing about the rule it claims to guard.
- **GUARDS UNDER `src/`, NOT `worker/`**, checked against `worker-deploy.yml`'s `paths:` rather
  than remembered: `scripts/**` and `src/lib/bot-events.ts` are in neither list, so **this
  restarts no poller.**

#### EVERY BAIL WAS ALSO SPENDING THE RC SESSION (2026-09-05)
`bail()` wrote the abnormal-exit marker, printed the breadcrumb, released the profile lock and
exited. **It never wrote the token down.** `readLiveToken` prefers `window.__camphawkRcToken`,
the capture hook's copy off RC's own outbound header, which lives in PAGE MEMORY and dies with
the process — so the next process comes up `token source: none`, `planRenewal` waits out its
floor, and the measured recovery is ~11 minutes. **A bail at 07:53 therefore cost a cart, not
merely a browser**, and the two-minute arm above would have made bails MORE frequent.
- `persistLiveToken(residentPage)` now runs **first and bounded at 2s**. It is the same one call
  the runner's preemption path has made since 2026-08-30 for the identical reason.
- **FIRST, not last.** Everything else in that block is a reading about a process that is about
  to die; this is the only step with product value, and on a ramping renderer each diagnostic
  can spend seconds. Bounded because that renderer may not answer at all, and a persist that
  delays releasing the profile lock past 08:00 has inverted the priority.
- **It is what makes the two-minute arm safe to want.** A bail that costs a browser is an
  inconvenience; a bail that costs the session is a hazard, and it was the second one.

#### PARKING THE RESIDENT PAGE OFF RC'S SPA — PROPOSED, AND REFUSED BY THE CODE (2026-09-05)
The 08-17 entry closes this with *"the idle tab is measured innocent … **Do not revisit without
new evidence**"*, and 09-04 supplied exactly that evidence: the renderer that grows is the
RESIDENT page's, and the throwaway tab's read `-4 MB over 640s`. Both halves of the old
rejection are now known wrong. **So it was revisited, and it fails for a different reason that
nobody had reached.**
- **`checkAndReport` cannot report a dead session from a parked page.** The branch is explicit:
  `if (live === false && source === 'localStorage')` → *"A FAILURE ON A localStorage TOKEN
  PROVES NOTHING. That copy is not what the app sends, so a 401 from it is our stale read, not
  RC's verdict."* Park the page and `source` is `localStorage` **for ever**, so the verdict is
  permanently INCONCLUSIVE — and that verdict is what drives `autocart.rc_session`, the 07:40
  pre-flight and `holdAtRisk`'s phone alarm. **Parking silences the alarm, quietly.**
- Making it work needs the meaning of the most safety-critical verdict in the system to change
  ("the SPA is parked, so localStorage IS authoritative"). That is a deliberate change with its
  own guards, not a memory experiment.
- **Recorded so the next reader does not spend the same hour.** The prohibition stands, and its
  reason is now the health verdict rather than the innocence of the idle tab.

#### WHAT THE NEXT RAMP ANSWERS, AND WHAT TO STOP DOING
- ~~**Expect `✗ RAMP` at ~2 minutes and `reason: 'bail:ramp'`.**~~ **IT FIRED, WITHIN TWO AND A
  HALF MINUTES OF THE BOX UPDATING** — peak **3,702 MB against 8,879 MB** twelve hours earlier,
  two minutes against twelve, and the wedge did not fire, which is the same fact from the other
  side. The arm is proven. If a later ramp ends at twelve minutes instead, condition B is the
  one standing down and `.memory-latest.json` is where to look.
- **The remaining unexplained fact is the ~35-40 GB of commit that belongs to no process's
  private bytes and is not kernel pool.** Every instrument so far has looked at private bytes,
  the JS heap, free RAM or renderer allocation sites, and the memory is in none of them. The one
  measurement that could name it is a **committed-region walk of the ramping renderer** —
  `VirtualQueryEx` bucketed by `MEM_PRIVATE`/`MEM_MAPPED`/`MEM_IMAGE` with a region-size
  histogram, from `ramp-scan.mjs`'s existing 3 GB trigger so it never spawns at the peak.
  ~~**Not built**, and it is the only instrument still worth building.~~ **BUILT 2026-09-05 —
  see "THE WALK IS BUILT" below.** Struck rather than deleted: "not built" on the instrument
  everything else is waiting for is exactly the sentence a later reader quotes as a task.
- **DO NOT build Track B.** It replaces the renewal's Okta trip, and that trip is measured flat
  (`[renewal] -4 MB over 640s`). It was already doubly weakened; this is the third reason.
- ~~**`~18,700 handles × 2 MB ≈ 37 GB` IS ARITHMETIC, NOT A MEASUREMENT.**~~ Still arithmetic,
  and it now has four data points and a tighter form that does not rest on the handle count at
  all — see "THE 32 GB IS ONE FIXED MAPPING" directly below. Struck rather than deleted because
  the caution was right and the reader who acts on it would now skip the finding.

#### THE 32 GB IS ONE FIXED MAPPING, AND THE REQUEST LOOP IS NOT THE CAUSE — FOUR FOR FOUR (2026-09-05)
The new arm fired on its first ramp, and its `request-counts` event named a loop:
**18,392 of 18,409 lifetime requests on `rdapi.reservecalifornia.com/api/webaccessfacility/futurebookingstartsendsdates`**,
~46/s, on a browser two minutes old. I nearly wrote that up as the trigger. **It is not**, and
the four `ramp-scan` rows say so in one column.

| ramp (PT) | peak `rc` | requests | ramping renderer `virtualMB` | pagedPool | handles |
|---|---|---|---|---|---|
| 09-04 15:21 | 3,741 | — | **3,727,549** | 66,580 KB | 18,705 |
| 09-04 19:34 | 4,776 | — | **3,727,556** | 66,591 KB | 19,379 |
| 09-05 07:31 | **8,879** | **197 in ELEVEN HOURS** | **3,727,556** | 66,579 KB | 18,698 |
| 09-05 12:13 | 3,702 | **18,409 in two minutes** | **3,727,550** | 66,554 KB | 17,005 |
| *healthy renderer, same scans* | 16-78 | | **3,694,7xx** | 767-810 KB | 210-397 |

- **THE RAMPING RENDERER'S VIRTUAL SIZE EXCEEDS A HEALTHY ONE'S BY 32,780 MB, AND THE FOUR
  READINGS AGREE TO WITHIN 7 MB.** That is not growth, it is **one fixed ~32 GiB mapping**. It
  is present in the ramp with 18,392 hits on one path and in the ramp with 197 requests in
  eleven hours, so **a loop cannot be the cause of an event it is absent from.** The 09-05 07:31
  reading is the counter-example and it was taken by the same instrument on the same day.
- **AND THE OTHER DIRECTION IS NOW MEASURED TOO — A LOOP WITH NO RAMP (2026-09-05 09:47 PT).**
  The entry above rests on a ramp with no loop. The teardown at 09:47:06 PT is its mirror:
  **19,008 hits on `futurebookingstartsendsdates` in 120 seconds**, on a browser 0m old — and
  `chromium_memory_samples` across that whole window reads **227 MB, then 209, 208, 208**, with
  no ramp-scan triggered because the family never came near the 3,000 MB bar. **A loop running
  at full rate cost nothing.** So the two are independent in BOTH directions, and the decoupling
  no longer rests on a single counter-example. **Do not soften this back to "probably not the
  cause"** — it is measured twice, from opposite sides.
- **THE LOOP IS STILL WORTH FIXING AND IS STILL A SEPARATE FIX.** ~19,000 requests in two
  minutes to one RDR endpoint is our residential IP, which has eaten a 12-hour block once. That
  is the reason to act on it; the memory is not.
- **AND THE COMMIT STEP IS THE SAME MAPPING SEEN FROM THE OS.** Both 09-05 events step in ONE
  two-minute tick: 7,513 → 47,823 MB (07:29→07:31) and 9,096 → 43,356 MB (12:12→12:13), while
  the rc family moves only 290 → 3,203 and 313 → 1,885. **~35-40 GB of commit against ~2-3 GB
  of private bytes, and a 32 GB mapping sitting in the renderer's address space.** The pagefile
  grows to match and reports `currentMB=56` / `peakMB=198` — i.e. **40 GB charged and under
  200 MB ever written to disk**, which is what a committed-but-largely-untouched mapping looks
  like. The private bytes then climb at ~450 MB/min as the pages are actually touched.
- **SO THE SEQUENCE IS: map ~32 GB at once, then write into it steadily until something kills
  it.** Every instrument that has ever been pointed at this measured the SECOND half — private
  bytes, the JS heap, free RAM, allocation sites, request counts — which is why five of them in
  a row reported nothing. The first half happens between two samples and shows up only as a
  step.
- **A LOOP IS STILL WORTH FIXING ON ITS OWN.** 18k requests in two minutes to one RDR endpoint
  is our residential IP hammering ReserveCalifornia, which is the address that has eaten a
  12-hour block. It is a separate problem with a separate fix, and it is not this one.
- **THE HANDLE ARITHMETIC NOW LINES UP, AND IS STILL NOT A MEASUREMENT.** The handle count
  exceeds a healthy renderer's by ~16,700 and 32,780 MB / 16,700 ≈ **2.0 MB each** — the shape
  of ~16k pagefile-backed sections of 2 MB. `HandleCount` counts every kind of handle, so this
  is a coincidence that fits, not evidence. **What settles it is the committed-region walk**
  (`VirtualQueryEx` bucketed by `MEM_PRIVATE`/`MEM_MAPPED`/`MEM_IMAGE` with a size histogram),
  which would show one 32 GB region or ~16k 2 MB ones and name its type. **BUILT 2026-09-05**,
  and it was always a yes/no question rather than a fishing trip.
- **ONE CANDIDATE, LABELLED AS ONE, AND IT IS NOT NEW — it is the one this file already had
  left over.** "Chromium's own handling of the occluded window." RC's home page loads
  `js.arcgis.com/4.30/...` and renders a WebGL map, and GPU transfer / shared-image buffers are
  exactly the 2 MB pagefile-backed segment shape. **Nothing tests it yet.** Do not write it in
  as the mechanism; three mechanisms have been guessed on this leak and each cost a session.
- **AND IT DOES NOT REOPEN PARKING THE RESIDENT PAGE.** That is refused by `checkAndReport`'s
  localStorage rule, which is a different objection and still holds.

#### THE WALK IS BUILT — IT ASKS THE PROCESS, AND IT REFUSES RATHER THAN ANSWERING SMALL (2026-09-05)
`ramp-scan.mjs` now ends in a `VirtualQueryEx` walk of the ramping renderer's whole address
space, off the existing 3 GB trigger. It emits `VMWALK` / `VMREGION` / `VMHIST` / `VMTOP`, and
between them they answer the two questions the four scans left: **ONE ~32 GB region or ~16k of
2 MB** (the histogram), and **MEM_MAPPED or MEM_PRIVATE** (the region totals).
- **IT WALKS A CONTROL BESIDE THE TARGET, AND THAT IS NOT A NICETY.** 32,780 MB is a
  *difference*; with one term, *"the ramping renderer holds a 32 GB mapping"* cannot be told
  from *"every renderer does"*. Target = the largest by private bytes, which at the trigger IS
  the ramping one (3,061 MB against ~100 MB for everything else in the same scan); control = an
  ordinary renderer. **Selected inside PowerShell**, so nothing is interpolated in from Node —
  the fixed-script rule that file has had since it was written.
- **EVERY WAY IT CAN FAIL PRINTS ITSELF.** A 32-bit host (which can only see a 32-bit slice of
  a 64-bit address space), a failed `Add-Type`, a refused `OpenProcess` — each is a line naming
  itself, and **none of them yields an empty region list**, which would read as *"there is no
  32 GB mapping"*. That is the absent-reading-as-a-negative shape this file has paid for more
  than any other, and here it would retire the investigation with a false negative.
- **A TRUNCATED WALK SAYS SO ON THE HEALTHY PATH TOO** (`regions=`, `iters=`, `capped=`), or a
  floor and a total read identically.
- **IT GOES LAST IN THE SCRIPT.** `execFile` hands back the stdout it buffered even when it
  kills the child on timeout, so every reading above it is already printed and safe; a walk
  that hangs costs the walk and nothing else. Timeout 45s → 90s for the `csc.exe` compile plus
  two walks, and still under the sampler's own two-minute cadence, so the worst case is one
  skipped tick, once per ramp.
- **IT QUERIES AND NEVER READS.** No `ReadProcessMemory`, no minidump — region metadata only.
  Same rule as the multi-GB heap snapshot and `response.body()`: an instrument that copies the
  memory it measures into this process is the cure arriving as part of the disease. And a
  renderer's pages are RC session material, i.e. a field we would then have to filter.
- **THE READOUT REFUSES A VERDICT THAT DOES NOT DOMINATE, and rendering a fixture is what
  caught that.** Without the share gate the leading bucket was named whatever it carried, so
  the CONTROL — an ordinary renderer with 18% in one bucket — was told it held *"a SWARM of
  per-object shared-memory sections"*. A verdict that fires on every input fires on the one
  process whose whole job is to be normal. It also prints the target-minus-control **EXCESS**
  on one line: two blocks and a reader doing the subtraction is how a control stops working.
- **HOW TO READ THE FIRST ONE.** `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`.
  A handful of regions carrying the bulk ⇒ **ONE mapping**, and the question becomes what maps
  a single 32 GB region. Thousands of equal ones ⇒ **per-object shared-memory sections**, and
  the ~16,700 excess handles stop being arithmetic. `commit/mapped` vs `commit/private` says
  which side of the shared/private line it is on. **Compare the EXCESS with the OS commit step
  in the same scan** — if they agree, the walk has named the 35 GB.
- **BOT-SIDE, so it is inert until the box updates**, and then it needs one ramp. Ramps arrive
  every ~5 hours in the day (09-04 15:21, 19:34; 09-05 07:31, 12:13 PT) and about twelve
  overnight. `npx tsx scripts/bot-ask.mts git-status` is what says the box has it —
  **never `autocart.bot_version`**, which COALESCEs and can show a stale sha beside a live
  heartbeat.
- `worker/ramp-scan.test.mts`, eleven mutations, each grep-verified to APPLY and each caught.
  **One guard was wrong at baseline and it is the recorded shape:** the 32-bit refusal was
  pinned by a 120-character proximity window from `Is64BitProcess`, which reached the ADD-TYPE
  refusal on the next line — so deleting the one it names passed. Anchored on the literal that
  carries both the flag and the sentence. **And one of the mutations did not apply** (it moved
  a line that was not the walk), which is a green proving nothing; redone so it genuinely
  reorders the script.

#### IT ANSWERED ON ITS FIRST RAMP: 16,387 MAPPED SECTIONS OF 2 MB (2026-09-05 20:29 PT)
The box took `2ecaca8` at 01:10 UTC and the walk fired on the next ramp, ~2h20m later. **The
32,780 MB is a SWARM, it is `mapped`, and the handle arithmetic this file has carried as
"arithmetic, not a measurement" for two days is now a measurement.**
```
TARGET  pid=16004 renderer privateMB=4587  regions=81143  capped=False
  committed 37680 MB across 49056 region(s) — image 310 · mapped 32852 · private 4518
  2-4M      32779 MB across 16387 region(s)   <- 87% of the committed bytes
  64K-1M     2375 MB across 18179 region(s)
  handles=19002   pagedPoolKB=66586
CONTROL pid=8712  renderer privateMB=16    regions=898
  committed   403 MB across   635 region(s) — image 310 · mapped 84 · private 9
  handles=213     pagedPoolKB=770
EXCESS 37277 MB   vs the OS commit step of ~40 GB in the same scan
```
- **THE CLASS IS SETTLED: `commit/mapped`, 16,549 regions / 32,852 MB against the control's
  74 / 84 MB.** Pagefile-backed shared-memory sections, which is exactly what the pagefile
  figures predicted from the other side — this scan reads `allocatedMB=33992, currentMB=0,
  peakMB=0`: **34 GB charged and not one byte ever written.** That is why private bytes, free
  RAM, the JS heap and the sampling profiler were all blind to it, five instruments in a row.
- **A SWARM, NOT ONE MAPPING — and that was a real fork.** The readout's own reading rule said
  a handful of regions ⇒ ask what maps a single 32 GB region; thousands of equal ones ⇒
  per-object sections. It is **16,387 regions in the 2-4M bucket**, so the second branch, and
  the first is dead. `32,779 MB / 16,387 ≈ 2.0 MB` — the figure that was inferred from
  `~16,700 excess handles × 2 MB` on 09-05 and correctly labelled a coincidence that fits.
  Handles are 19,002 against 213, an excess of ~18,789 against 16,387 regions: **the two
  independent counts agree.**
- **THE PRIVATE HALF IS THE CLIMB, AND IT IS THE SMALLER HALF.** `commit/private` is 4,518 MB
  — the ~450 MB/min of pages actually being touched, which is all the memory series ever saw.
  The 32.8 GB it never saw is the mapping arriving in one step at the onset.
- **WHAT CREATES THEM IS STILL NOT ESTABLISHED — do not write one in.** What is now known is
  that something in that renderer holds ~16.4k live two-megabyte pagefile-backed sections and
  does not release them. Candidates, none tested: Chromium's discardable shared memory (which
  allocates in segments and is exactly this shape), shared-image/GPU transfer buffers, or mojo
  data pipes. **RC's home page renders a WebGL ArcGIS map** and that candidate is unchanged by
  this — it is now a much better-aimed question, not an answer. Three mechanisms have been
  guessed on this leak and each cost a session.
- **THE REQUEST LOOP IS NOT IT, CONFIRMED FROM A THIRD DIRECTION.** This ramp's counter was
  **flat** — `0 in 120s / 109 lifetime` on a browser 125 minutes old — and it carried the same
  32,779 MB in the same bucket as the 12:14 PT ramp that ran 18,392 requests on one RDR path.
  Same signature, opposite traffic.
- **THE RAMP ARM ENDED IT AGAIN**: `bail:ramp`, peak **4,915 MB** against 8-9 GB before the arm
  existed, and the twelve-minute wedge did not fire.
- **AND #280's TWO-MINUTE BAIL DOES NOT STARVE THE 3 GB SCAN — the worry was real and it is
  settled twice over.** The arm now cuts a ramp at ~2 min and ~3.7 GB where it used to run
  twelve minutes to 9 GB, so it could in principle exit before the scan's threshold was
  crossed. It cannot: `RAMP_SCAN_MB` and `RAMP_MB_DEFAULT` are both **3000 and pinned equal**,
  and the bail reads the very `.memory-latest.json` the sampler writes, so the bail cannot
  become eligible before the scan has already triggered. The scan also runs in `bot.mjs`, which
  the bail — which exits the keep-warm — does not kill. **Empirically: the 12:14 PT bailed ramp
  produced a scan, and this 20:29 one produced a scan AND the walk.**
- **ONE READING CAVEAT, so nobody chases it.** The CONTROL prints its own verdict line —
  *"70% … in the 16-256M bucket, 3 region(s): ONE mapping"* — which is the share gate
  describing an ordinary renderer's normal reservations, not a finding about the control. **The
  EXCESS line is what carries the comparison**; the per-process verdicts are there to be read
  against each other.

#### THE WALK CANNOT NAME AN OWNER, SO ASK CHROMIUM (2026-09-06) — built, not yet fired
The walk answered *what* the 32 GB is and there is no Windows API that answers *who asked for
it*: a pagefile-backed anonymous section has no name and no creator recorded. Chromium knows.
`Tracing.requestMemoryDump` at `detailed` level makes every process emit its allocator dumps —
`malloc`, `v8`, `partition_alloc`, `discardable`, `gpu`, `skia`, `mojo`, `shared_memory` — and
an OWNERSHIP GRAPH: `base::SharedMemoryTracker` emits one `shared_memory/<guid>` dump per
mapping, and whichever subsystem owns that mapping adds an edge to it.
- **BOTH BRANCHES ARE ANSWERS, and that is why it is worth taking on the reading that
  attributes nothing.** `shared_memory` ≈ 32 GB with ~16k dumps in the 2-4M bucket ⇒ the
  sections ARE base shared memory and the owner column names the subsystem. `shared_memory`
  in the tens of MB, beside a process the walk says holds 32 GB of `commit/mapped` ⇒ they are
  **not** base shared memory, which eliminates discardable, mojo and the GPU transfer path
  **together** and points outside Chromium's tracked allocators. The readout prints the second
  verdict as loudly as the first, and a mutation deleting it is caught.
- **THE BUCKETS ARE THE WALK'S BUCKETS, boundaries included** — `-lt` on the first two and
  `-le` after, mirrored from `ramp-scan.mjs`'s PowerShell. The whole point is that "16,387
  regions in 2-4M" and "N mappings in 2-4M" describe one population or visibly do not; nearly
  the same boundaries would make that comparison a guess.
- **MEASURED BEFORE IT WAS WRITTEN, and the measurement does not reach the box.** Against a
  real Chromium: **~200 ms** end to end, and thirty WebGL texture uploads came back attributed
  to `gpu/transfer_memory` — i.e. the edges resolve and name a real subsystem.
  `scripts/auto-cart-bot/mem-dump-probe.mjs` is that check, kept and re-runnable, and it
  **refuses a verdict** on every path where the question was not reached. **THAT IS LINUX AND
  THE BOX IS WINDOWS**, which is the native sampler's exact burn — validated in the dev
  container, symbolization absent in production. What a green probe establishes is that the
  instrument reads a real trace; **whether the 2 MB sections go through
  `base::SharedMemoryMapping` at all is precisely the open question**, so a small
  `shared_memory` total is the second branch above and not the instrument failing.
- **WHERE IT FIRES, and every clause was decided by something already recorded here.** From
  the watchdog TIMER, never the loop body (a check in the body is unreachable during a ramp —
  four times in this file). From the SAME `memory` reading and the SAME `>` comparison the
  RAMP arm just made, so the dump and the bail cannot land on different sides of one event.
  **BEFORE the bail rather than inside it**: the ramp arm needs a 120s stall on top of the same
  threshold, so this runs ~2 minutes ahead of the exit — which is what gives a fire-and-forget
  POST time to land and keeps a multi-second diagnostic off the path that releases the profile
  lock. Fire-and-forget with an in-flight flag, like the heap trail beside it.
- **A BASELINE AND A RAMP READING PER BROWSER LIFE**, because 32 GB is a DIFFERENCE — the same
  reason the walk grew a control. The baseline waits `MEM_DUMP_BASELINE_AFTER_MS` (3 min) so it
  describes a browser that has actually loaded RC; the ramp reading never waits.
- **A REFUSAL DOES NOT SPEND THE PHASE.** Tracing already started, a browser that will not
  answer, `success: false` — each is named in the log and leaves the phase retryable, because a
  refusal is not a reading. An empty `shared_memory` total and "we could not ask" point in
  opposite directions.
- **TWO DEFECTS THE GUARDS FOUND, and neither was reachable by reading the code.**
  1. **The cleanup `Tracing.end` was unbounded.** A browser already established as not
     answering hangs it, `takeMemoryDump` never resolves, and the caller's in-flight flag never
     clears — so the instrument would fire once per browser life and report nothing ever after.
     **A hang inside the cleanup of a bounded operation is a hang.** `MEM_DUMP_CLEANUP_MS`.
  2. **`jsonb` DOES NOT PRESERVE OBJECT KEY ORDER** — it re-sorts by key LENGTH. The roots were
     stored size-sorted as an object and came back
     `malloc · discardable · shared_memory · partition_alloc`, printing the 32 GB allocator
     THIRD where a reader takes the first as the largest. They are an ARRAY now. **Caught by
     inserting a fixture row, rendering the real readout and reading it**, which is the only
     way a formatting bug ever is — the same method that caught the RAM trail printing its
     oldest value against its newest timestamp.
- **AND CHROMIUM'S OWN `shared_memory` ROOT RIDES BESIDE OUR SUM**, with the readout printing a
  warning only when they disagree. Two views of one population, so a gap is a fold that missed
  mappings — the only cross-check available on Windows, where the probe cannot run.
- **AN EXISTING GUARD CAUGHT A NAME COLLISION, AND IT WAS RIGHT TO.** The browser-life marker
  was called `browserOpenedAt`, which is the AGE RECYCLE's variable —
  `keepwarm-diagnosis.test.mts` fails on that token by name because that feature was built,
  measured useless the same night and removed. Renamed rather than the guard narrowed: a
  variable with that name in this file is exactly how a reversed decision gets re-taken by
  somebody who never read why.
- **`git checkout --` DESTROYED THE RENAME MID-MUTATION-RUN, for the fourth recorded time.**
  The revert goes to HEAD, and HEAD did not have it. **Commit before mutating** — it is written
  down, it was read this session, and it still happened.
- `worker/rc-mem-dump.test.mts`, **23 mutations, each asserted to APPLY and each caught. Two
  survived the first round and both were the guards, not the code**: every fixture had either a
  good hex size or no attrs at all, so `hexBytes` returning **0** from its unparseable branch
  was unexercised; and the readout guard matched `NOT base shared memory` — a line the mutation
  did not touch — so deleting the small-reading verdict left it green. **A guard that matches a
  neighbouring sentence is measuring the neighbour.**
- **AN ABSENT PROCESS IS NOT A SMALL ONE, and that is the one false elimination this
  instrument can manufacture.** The dump is COORDINATED by the browser process and each child
  contributes its own, so a renderer that will not answer is **missing** from the result rather
  than reported as empty — and a lead process with a small `shared_memory` total would then be
  read as "the sections are not base shared memory" when the ramping renderer simply never
  spoke. Every process that DID answer is named with its pid, the readout says to check that
  pid against the region walk's TARGET for the same event, and the small-reading verdict names
  the hazard before it names the conclusion.
- **IT FIRED ON THE BOX THE SAME DAY, AND THE WINDOWS HALF OF THE CAVEAT IS CLOSED.** The
  mini-PC took `5399000` at 07:56 PT and the first baseline landed at **07:59:33 — 332 ms, 8
  processes, and `gpu/transfer_memory — 5 MB across 13`.** So on Windows the dump arrives, the
  per-process folding works and **the ownership edges resolve to a named subsystem**, which is
  precisely what the Linux probe could not establish and what the native sampler's burn made
  worth doubting. The lead on a healthy box is the **GPU process**, not a renderer, which is
  the expected shape when nothing is ramping — and the `2-4M` bucket already holds one 2 MB
  mapping, so that size is ordinary in small numbers and it is the COUNT that will matter.
- **WHAT IS STILL OPEN IS THE ONE THING ONLY A RAMP CAN ANSWER**: whether the ramping
  renderer's 16.4k sections appear in `shared_memory` at all. Both branches remain answers.
- **BOT-SIDE, so it was inert until the box updated**, and it still needs a ramp. Confirm the
  sha with `npx tsx scripts/bot-ask.mts git-status`, **never `autocart.bot_version`**.
- **HOW TO READ THE FIRST ONE.** `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts`,
  MEMORY DUMPS section, `ramp` phase first and the `baseline` from the same browser under it;
  `--all` prints the per-process roots, histogram and owners. **Check the lead pid against the
  ramp-scan's walk for the same event** — a dump of a healthy renderer says nothing, and the
  pid is the join key. `discardable/segment` at ~32 GB would be the answer this whole
  investigation has been reaching for; `(no ownership edge)` at ~32 GB means base shared memory
  holds them and nothing in Chromium claims them, which is a third finding and a new question.

##### IT FIRED ON A RAMP AND MEASURED THE WRONG BROWSER (2026-09-07) — the join says NO
The line above says the open question is *"whether the ramping renderer's 16.4k sections appear
in `shared_memory` at all"*, and tells you to **check the lead pid against the ramp-scan's walk
for the same event**. The first ramp dump arrived on 2026-09-07 and that check answers **no**:
```
02:03:24  ramp-scan   walk TARGET pid 9912 renderer — 31,407 MB commit/mapped in 15,663 regions
                      (the browser process that generation is pid 3836)
02:03:46  bail:ramp   the keep-warm exits; that whole browser generation dies
02:04:0x              supervise.ps1 restarts it; a NEW browser comes up
02:04:03  mem-dump    phase=ramp, 7 process(es): 7316 2960 6376 13324 10176 7660 14400
                      lead 7316 (CrBrowserMain) — shared_memory 2 MB across 35 mapping(s)
02:07:03  mem-dump    phase=baseline, lead 7316 — THE SAME LEAD PID, three minutes later
```
- **ZERO OVERLAP WITH THE RAMPING GENERATION, and the baseline is what proves it.** 9912 is
  absent, 3836 is absent, and the `ramp` dump's lead is the same pid the BASELINE reports on the
  browser that replaced them. The box log has that browser announcing itself at `09:04:08` UTC
  (`Leave this browser window ALONE`), i.e. 02:04:08 PT. **The dump is of the browser that came
  up after the bail**, and it is a healthy one.
- **SO IT ELIMINATES NOTHING.** The readout's small-reading verdict — *"the sections are NOT base
  shared memory, which eliminates discardable, mojo and the GPU transfer path together"* — is
  rendered over this row and **must not be quoted**. This is the exact false elimination
  `rc-mem-dump.mjs` names in its own text, arriving on the instrument's first firing.
- **THE CAUSE IS THE READING, NOT THE DUMP.** `.memory-latest.json` is written by `bot.mjs` on a
  2-minute cadence, totals the whole rc FAMILY, and is accepted up to **five minutes** old. A
  bail kills the browser and the supervisor restarts within seconds, so the newest sample on
  disk is still the dead generation's — 39s old, `rcMb 3414`, comfortably inside the age gate —
  and `maybeMemoryDump` reads `3414 > 3000` and fires `ramp` against a browser five seconds old.
  **Fresh is not the same as ABOUT THIS BROWSER**, and nothing was checking the difference.
- **THE BAIL ARM HAD THE SAME EXPOSURE AND A WORSE OUTCOME.** It needs a 120s stall on top of the
  same threshold — and a fresh browser can stall that long, because RC's app tier has needed five
  minutes to render (recorded three times) — while the dead generation's reading is still under
  five minutes old. It would then **exit the process over a browser that no longer exists**, and
  `supervise.ps1` stops loudly after five exits in ten minutes. Never observed; structural.
- **FIXED ONCE, IN `readLatestMemory`**, because both arms read the same object one arm apart and
  that invariant is pinned. `notBefore` is the current browser's start (`browserLifeSince`, set
  where `residentPage` is assigned): a sample taken before this browser existed cannot be about
  it, so it is UNKNOWN and **both arms stand down** — the rule they already follow everywhere.
  It costs at most one sampler cadence against a five-minute gate, a ramp that takes ~10 minutes
  to peak, and a bail that needs 120s of stall on top, so nothing real is lost.
  - **AFTER the age check**, so a genuinely stale reading keeps the more general reason; what is
    left on this branch is the dangerous case, fresh and about the wrong browser.
  - `memDumpBrowserSince` is renamed **`browserLifeSince`** because it is no longer the dump's
    alone. `browserOpenedAt` stays reserved — that is the removed age recycle's name, and
    `keepwarm-diagnosis.test.mts` still fails on the token.
  - **BOT-SIDE, so the false ramp dump can recur until the box updates.** Until then, join on the
    pid before reading any `ramp` row.
- **A MUTATION SURVIVED, AND IT IS THE HOUSE SHAPE IN A GUARD WRITTEN THE SAME HOUR.** The marker
  check was `code.indexOf('browserLifeSince = Date.now();')` — which also matches the TAIL of
  `if (!browserLifeSince) browserLifeSince = Date.now();`, a marker that latches on the first
  browser and gates every reopen after it against the wrong life. **The pre-existing sibling in
  `rc-mem-dump.test.mts` had the identical weakness and passed against the same mutation.** Both
  pin the unconditional assignment (`/\n\s*browserLifeSince = Date\.now\(\);/`) now. Pin the
  statement, not a token inside it.
- **AND THE WORKER TYPECHECK CAUGHT WHAT THE TESTS COULD NOT**: `notBefore = null` infers as type
  `null`, so every numeric call site was an error `tsc` on the root config never sees. That is
  `tsconfig.worker.json` doing the job it was added for.
- **HOW TO READ THE NEXT ONE.** A `ramp` dump is trustworthy by construction once the box has
  this — but **make the join anyway**: the dump's `MDPROC` pids against the ramp-scan's walk
  TARGET for the same event. A ramp dump whose process set does not contain the walk's target is
  void, whatever its numbers say.

##### ONE CAPTURE THAT ENDS ON EITHER BRANCH (2026-09-08) — stop paying a ramp per question
Raised by the owner, and it is the right criticism: every instrument so far has answered ONE
question and cost a round trip of five to twenty-eight hours. The 09-07 event is the cost in
miniature — a dump that measured the wrong browser bought a whole cycle and eliminated nothing.
So the next ramp now answers **both** remaining branches, and the readout reaches the verdict
rather than handing a reader a to-do.
- **THE JOIN IS DONE, NOT REQUESTED.** `dumpJoinReading` matches the walk's TARGET pid against
  the dump's own `MDPROC` list within a 30-minute window (both ride the same 3 GB trigger and
  landed 39 seconds apart on 09-07) and **suppresses the shared-memory verdict entirely** when
  they disagree. Rendered against the real 09-07 rows it now prints `VOID: the walk's target is
  pid 9912 and the dump answered for 7316, …` in place of *"only 2 MB of tracked shared
  memory"* — the sentence one edit away from retiring three candidates on nothing. **`no-walk`
  is deliberately NOT `void`**: no walk to join against is an absence and still leaves the
  manual check available, which is a different sentence.
- **`VMMAP2M` — DISTINCT `AllocationBase` COUNT, AND IT IS FREE.** The field is already in the
  `MEMORY_BASIC_INFORMATION` the walk reads and was being discarded. 16,387 regions over 16,387
  bases is 16k separate `MapViewOfFile` calls against 16k sections; 16,387 over four bases is a
  handful of large mappings carved into 2 MB views. **Different bugs, different fixes, and the
  histogram cannot tell them apart.** Same for the protection histogram (`VMPROT`).
- **`VMNAME` — IS THERE A FILE BEHIND THEM?** `K32GetMappedFileNameW` over a **bounded** sample
  (64; one call per region would be 16k calls on a box already at 40% commit). Anonymous is what
  `base::SharedMemory`, discardable segments and mojo data pipes all are, so it hands the
  question to the dump's owner column; a NAMED one names the creator outright and needs nobody's
  cooperation. **That is the branch that could end this in a single reading.**
  - It needs `PROCESS_VM_READ`, so the walk asks for **0x410 first** and falls back to the two
    narrower rights — a refusal costs the NAMES and never the walk. **`access=` is printed on
    the healthy path too**: a census that could not run and one that ran and found every region
    anonymous are opposite readings that render identically without it, and here the
    absent-reading-as-a-negative would retire the only branch that names a creator for free.
  - The band is the histogram's `d 2-4M` bucket **exactly** (`>= 2097152 -and <= 4194304`), so
    `VMMAP2M regions` and `VMHIST d` are one population and a reader can diff them. A band that
    merely looked similar would make two lines about one bucket disagree by design.
- **THE THREE VERDICTS ARE PURE FUNCTIONS** (`dumpJoinReading`, `mappedSwarmReading`,
  `mappedNameReading` in `src/lib/bot-events.ts`), for the reason `closeReasonReading` and
  `loopAnswerReading` are: inline in the readout, the branch that says VOID is reachable only
  from a real ramp, and a branch that has never run is how `closeOnToken` shipped wrong for six
  days. `src/lib/leak-capture.test.mts`, **fourteen mutations, each verified to APPLY and to
  fail.**
  - **ONE SURVIVED AND IT IS THE HOUSE SHAPE: deleting the name-census RENDER left every guard
    green** — the functions were perfect and nothing printed them. Pinned structurally now.
    Seventh instance of fix-present-and-inert.
  - **AND A GUARD OF MY OWN ANCHORED ON THE DECLARATION**: `SHM_ANSWER_MB` appears at the top of
    the readout, so an `indexOf` on the bare name made the ordering assertion true whatever the
    branches did. Anchored on `>= SHM_ANSWER_MB`. Caught by running it.
- **AN EXISTING GUARD BROKE OVER THE IMPROVEMENT AND WAS UPDATED, NOT RELAXED.**
  `rc-mem-dump.test.mts` pinned the literal instruction *"Join on the pid"* — the request this
  change replaces with an answer — so it now pins `dumpJoinReading(` and the void branch, and
  was re-verified failing against both regressions. **It touches `worker/**`, so merging this
  fires a worker deploy and restarts all three pollers**; read `paths:`, do not infer.
- **WHAT THIS STILL CANNOT CAPTURE, stated so nobody plans around it:** the ALLOCATING CALL
  STACK. Naming it on Windows needs ETW with symbols for `chrome.dll`, which the box does not
  have, and a trace of a process committing 40 GB is the multi-GB-snapshot mistake in a third
  costume. Chromium's ownership edges are the practical substitute, which is what the dump is.

#### THREE FIGURES IN THIS FILE THAT CANNOT ALL BE TRUE (2026-09-05)
Read before quoting any of them.
- **GROWTH RATE is quoted four ways**: ~2,400 MB/min (08-17), ~400 MB/min over eleven minutes
  (08-23, which explicitly revises the first), ~840 MB/min (08-24), ~450 MB/min (09-04). The
  08-17 figure came from a 2-minute sampler bracketing a shorter event and survives verbatim in
  later summaries. **The eleven-minute climbs are the better-sampled ones.**
- **WHAT ENDS A RAMP had three incompatible accounts** — a browser replacement, the size arm
  firing on the next iteration, and the wedge bail. **Settled 09-04 and again 09-05: it is
  `HUNG_MS`.** The earlier events were never instrumented well enough to say, and their
  `gpu-process` pid changes are consistent with a wedge bail plus a supervisor restart.
- **EVERY COMMIT PERCENTAGE FROM 08-22 TO 08-28 IS AN ARTIFACT.** The system-managed pagefile
  grows as fast as the commit is taken, so the limit chases the used figure and the ratio pins
  near 100% all the way up and back down. 82%, 88%, 89%, 95%, 99% and 100% are **not comparable
  to each other**. Use the absolute figures and check the limit column.

**THE VERIFY RUN LOST ONE REAL-DB TEST TO A CONCURRENT CI SUITE, AND CI ON MASTER IS RED FOR
THE SAME REASON.** `expire-holds` → *"a requested hold whose release passed long ago is failed"*
returned 0 rows once and passed 6/6 alone; the diff cannot reach that code. The docs-only
merge of #276 fired the Verify suite **twice at once** (the master push at 02:43:27Z and the
branch push at 02:43:48Z), overlapping the start of this session's local verify; both CI runs
failed (25 and 21) and the one failure name inside the log window is *"once the window has
closed, a cart failure IS final"* with `'already-failed'` — the signature this file already
records for two suites on one database. **A merge produces two pushes and therefore two runs;
`docs/LANES.md`'s rule covers it and nobody can serialise GitHub's own pair.** A second
candidate for the expire-holds row, recorded not chosen: Fly's own `expire-holds` timer runs
the same predicate over every row every 60s and would fail the fixture first, after which the
test's scoped UPDATE matches nothing — the `reclaimLapsedHolds` test-versus-production shape,
one function over.

**`rc_release_readings` (migration 076, APPLIED) + `--record`.** The daily release-window
Routine (**`trig_01MDTcr2WFDqX6dCsi7gVDPG`** — the id changed on 09-05, see above; 07:56 PT
through 09-11) now records one row per
facility — the BRACKET (latest still-locked, earliest free), never a midpoint; `split_brackets`
for a non-atomic facility; NULL for an absence; nothing at all for a run that never reached the
question. Readout: `NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-release-readout.mts`. The Routine's
prompt carries `--record` and says to report the `recorded N facility row(s)` line. The
independent disabler (`trig_01FtjDWmMS8PvGQ8z1TSYbHQ`) is unchanged and may still be inert;
the measurement Routine's own self-disable on 09-12 is the load-bearing stop.

**THE iOS BUILD WAS NEVER MISSING — THE PHONE HAS NOT INSTALLED IT.** Three entries in this file
and `docs/NEXT-SESSION.md` said a fresh iOS build was the highest-value non-code action. `iOS ·
TestFlight` #12 built and shipped on **2026-08-29** with RevenueCat compiled in
(`docs/STOREKIT-PLAN.md`), the same day as Android build 25. The 09-01 trace reading `[ios build
1.0 (21)]` means the iPhone was still running the 08-09 binary, not that no newer one existed.
Nothing native-side has changed since 08-29 (`git log` on `codemagic.yaml`, `capacitor.config.ts`,
`package.json`, `ios/`, `android/` since then: #231 and #248, both pre-build). **The action is
to install TestFlight #12 on the iPhone and check the build number in the next hand-off trace**,
not to run Codemagic. Struck where it was claimed.

### THE STAND-DOWN LOG FLOODED THE WINDOW SOMEBODY READS AT 08:00 (2026-09-16)

Found while arming the page-wedge cure for its first production firing, and it directly
threatens that reading. **With a real hold queued, `rc-keepwarm.log` is 86% one countdown.**
Measured off the box rather than estimated — `bot-ask tail-log rc-keepwarm`, spanning
23:22:24 to 23:57:52 UTC:

```
72 of 79 timestamped lines          are "stood down" repeats
6,192 of 7,218 characters          are those two sentences
  ~174 chars/min of pure flood      -> a 16,000-char tail-log window covers ~92 minutes
7 lines in 35 minutes               are about anything else
```

- **THE MECHANISM IS A DEDUPE THAT COMPARES THE SENTENCE.** `autoLoginSkip` and `warmupSkip`
  each kept `last` and skipped a repeat — and the reasons that fire while a release is
  queued carry a minute count (`the release is 922m away`), so no two consecutive lines are
  ever equal and **nothing collapsed for as long as a hold existed.**
- **THE FILE CONTAINED THE RULE *AND* EXEMPTED THE NEIGHBOUR BY ASSERTION.** `renewal-schedule.mjs`
  had already paid for this, and its header says why it needed a different mechanism:
  *"It compares the STATE and not the sentence — **`autoLoginSkip`'s reasons are constant
  strings**, while every reason here carries a minute count."* True of most of them. **False
  of the two that fire whenever a release is queued**, and of three more inside the lead.
  Same shape as the duplicate-facility story and unit 45719: the refutation was sitting in
  the file, one function away.
- **`autoLoginSkip`'S OWN HEADER STATES THE COST IT WAS INCURRING** — *"1,440 identical
  entries a day and the log would become unreadable — which is its own way of hiding the
  answer."* It is the same sentence either way: a log that hides the answer by flooding and
  one that hides it by printing nothing are one failure.
- **WHAT IT COSTS IS THE POST-MORTEM, WHICH IS WHEN THIS IS READ.** `tail-log` returns the
  last 16,000 characters, so the readable window fell from most of a day to ~92 minutes, and
  the flood does not stop at T−30 — the warm-up's `inside the ${critical}m lead` sentence
  ticks through the release window too. **`bot_events` is unaffected** (a wedge recycle
  writes a `request-counts` row with `reason: 'wedge-recycle'`, in Postgres), which is why
  this degrades a reading rather than losing one.
- **FIXED BY KEYING ON THE STATE, using the primitive that already existed.**
  `makeSkipLogger` is imported into `rc-keepwarm.mjs` already; both loggers now take
  `(key, reason)`, and `warmupWindowOpen`/`warmupPlan` return a `key` beside `why` — the
  same contract `planRenewal` has had since 2026-08-18. **Measured: 780 asks a minute apart
  collapse to one line**, and 150 asks walking from T−150 into the lead collapse to one.
- **THE KEY CARRIES THE RELEASE**, so a NEW hold re-prints once rather than being swallowed
  by the state it happens to share with the old one. A key built from a `why` would be the
  bug wearing the fix's clothes, and a mutation for it is caught.
- **`makeSkipLogger.reset()` EXISTS BECAUSE AN ATTEMPT IS A STATE CHANGE THE KEY CANNOT
  SEE.** The key is built from the gate's inputs and says nothing about whether we went on to
  sign in; `rc-keepwarm.mjs` clears both loggers immediately before it spends one, and that
  behaviour predates the key. **Found by grep, not by review** — two `lastWarmupSkip = null`
  / `lastAutoLoginSkip = null` lines four hundred lines from their declarations, which a
  rename would have left dangling in a file nothing typechecks.
- **MY OWN VERIFICATION GREP COULD NOT SEE THREE OF THE CALL SITES, AND THE NEW GUARD IS WHAT
  FOUND THEM.** The conversion checked for remaining single-line `autoLoginSkip('` calls and
  reported NONE — while three long ones put their argument on the next line, so the pattern
  could not match the thing it was looking for. The guard counted 8 keyed against 11 calls.
  **Then the guard had the same defect one level up**: it demanded the key immediately after
  the paren, which is a guess about layout rather than a rule about the code. It is
  whitespace-tolerant now. Same lesson as `rehearsal.test.mts`'s character window, twice in
  one change.
- **TWO OF THE THREE ARE VOLATILE TOO** (`the token covers this hold (50m left...)`), so the
  flood continues inside the lead — bounded to ~30 lines per release rather than ~900, which
  is why it had never been noticed.
- **GUARDS: `session-coverage.test.mts`'s existing "every auto-login gate names itself, and
  repeats collapse" was RE-ANCHORED, NOT RELAXED** — it pinned `lastAutoLoginSkip` by name,
  which was true and insufficient, and it now asserts the logger is a `makeSkipLogger`, that
  every call passes a key, that **no key carries the countdown**, and that the reset survives.
  Plus four new tests in `autologin-warmup.test.mts` and one in `renewal-schedule.test.mts`.
  **Twelve mutations, each verified to APPLY and each caught**, including the sentence
  comparison restored, a key dropped, a key made volatile, `warmupSkip(win.why)`, either
  reset deleted, two plan branches sharing a key, and `makeSkipLogger` comparing the reason.
- **DEPLOY: the broken guard is in `worker/`, so merging fires a worker deploy and restarts
  all three pollers.** Unavoidable — that is where the guard lives. **And the box cannot take
  the bot-side half tonight anyway**: the 02:00–05:00 PT quiet window is shut by the 6h
  release gate while a real hold sits at 08:00, so the fix reaches the mini-PC on the
  following night's window. Merging is therefore worth nothing operationally until after the
  release, and costs a poller restart — so it waits.

### THE KEEP-WARM DIED SILENTLY AND THE LOCK OUTLIVED IT BY EIGHT MINUTES (2026-09-16)

Found while waiting for the page-wedge cure's first firing, and it is not the cure. From the
box's own log, with a real user's hold queued for the next morning:

```
23:57:23 ♻ RC session kept warm — token exp in 51m; okta=ALIVE
   [ six minutes of nothing but stand-downs — the loop was ADVANCING ]
00:04:00 RC session keep-warm every 20m — profile ...          <- A NEW PROCESS
00:05:00 … profile busy (rc-keepwarm) — retrying in 30s, NOT a dead session
00:06:30 … profile busy (rc-keepwarm)     [x5, ninety seconds apart]
00:11:33   alloc trail: resident renderer armed                <- the lock finally went stale
00:11:54 RC loaded and STAYING OPEN — token source: none       <- the session went with it
```

- **IT PRINTED NOT ONE WORD ABOUT DYING**, and that rules out most of the candidates rather
  than merely failing to name one. No `✗ RAMP`, no `✗ WEDGED`, no `♻ recycling`, no
  `Releasing the profile`. **`supervise.ps1` merges stderr into the log**
  (`& cmd /c "$Command" 2>&1 | ... Add-Content`), so an unhandled throw would have left a
  stack — there is none. And it was **not** a `stop-all`/`restart-rc`: `stop-rc.ps1` deletes
  the stale lock file, and the lock survived. **THE CAUSE IS NOT ESTABLISHED. Do not write one
  in.** What is established is that the process exited, `supervise.ps1` restarted it in ~60s,
  and `rc_procs` read **0** for three consecutive samples — the Chromium went with it.
- **`restarts.log` IS THE ONE FILE THAT WOULD NAME THE EXIT CODE, AND IT WAS `EBUSY` BOTH
  TIMES IT WAS ASKED.** `supervise.ps1` writes `exited code=$code after {N}s` there. The
  Windows file-locking contention this file already records — *"contention PEAKS during a
  stop"* — made the record unreadable at exactly the moment it was worth reading. The
  supervisor was fixed to RETRY its writes; **the READER in `bot-commands.mjs` was not** — so
  the one record that could have named the cause was unreadable for the whole diagnosis.
  - **FIXED: `readTextFileRetrying`**, six short attempts with jitter, and a give-up that says
    **CONTENTION** rather than a bare `EBUSY` (which reads as a broken command rather than as
    "ask again"). **`await`, never a busy-wait** — this runs inside `bot.mjs`, which answers
    the hold feed every couple of seconds, and blocking that loop to read a log would trade a
    diagnostic for the thing being diagnosed. **Only lock errors are retried**: a missing file
    fails on the first try, because `logs\auto-update.log does not exist` is itself a reading
    that has proved a script never ran.
  - **AND THE FIRST VERSION WAS INERT, CAUGHT BY ITS OWN MUTATION RUN.** Reverting `tail-log`
    to the bare `readTextFile` passed all three behavioural tests, because they call the
    retrying function directly. Ninth instance of fix-present-and-inert; pinned structurally
    now.
- **THE LOCK COSTS `STALE_MS` OF DEAD SESSION ON EVERY SILENT DEATH, BY CONSTRUCTION.** A
  holder renews its lock on a timer, so a lock only reads free ten minutes after the last
  renew. Observed: dead at ~00:03, takeable at 00:11:33 — **eight and a half minutes with no
  RC session at all**, and the recovery then came up `token source: none`.
  - **THE PID IS IN THE LOCK FILE AND THE LINE THREW IT AWAY.** `profileLockHolder` returns
    `{owner, pid, at}`; the message printed the owner alone. So *"mid-pass, fine"*, *"the
    holder died and we are waiting out STALE_MS"* and *"a live holder is wedged"* — three
    states needing three different responses — printed the identical sentence. That is the
    complaint already recorded against `rc-check.bat`, in a second file.
  - **FIXED IN THE MESSAGE ONLY** (`profileHolderNote` in `profile-lock.mjs`, so it is
    importable and testable — `rc-keepwarm.mjs` starts the keep-warm on import): it now
    carries the owner, **the pid** and **the age**. A missing field is omitted and a bad date
    renders nothing rather than `held NaNs`.
  - **TAKING A DEAD PID'S LOCK IMMEDIATELY IS THE REAL FIX AND IS DELIBERATELY NOT MADE.** It
    would buy back those eight minutes — and it is a change to the mutual-exclusion primitive
    whose whole job is that two Chromiums never open one `user-data-dir`, which is the
    corruption case. That is a decision with its own evidence, not a drive-by.
- **AND THE LINE SAID "retrying in 30s" WHILE THE REAL GAP WAS NINETY.**
  `waitForProfileLock(PROFILE_DIR, LOCK_OWNER, 60_000)` spends its own timeout before the
  `sleep(30_000)`, so the cadence is their SUM — observed at 00:05:00, 00:06:30, 00:08:00,
  00:09:30, 00:11:00. **A three-fold understatement in the one sentence somebody reads while
  the RC session is down and they are deciding whether to intervene.** Both waits are named
  constants now and the printed number is DERIVED from both, so it cannot drift again;
  `worker/profile-lock.test.mts` fails on the literal.

#### AND THE REPLACEMENT BROWSER HIT 1,592 MB IN TWENTY-ONE SECONDS, WITH 120,732 LISTENERS
```
00:11:33   alloc trail: resident renderer armed
00:11:54 ✗ RC Chromium at 1592 MB (limit 1500) — RECYCLING the browser.
00:11:58   JS heap 114 MB, nodes 59, docs 1, listeners 120732, layout 15
           — JS heap is only 7% of 1592 MB, so it is NOT the JS heap
```
- **THE SIZE ARM CAUGHT IT, AND THE WEDGE ARM CORRECTLY DID NOT.** The size guard lives in the
  loop BODY and is only reachable while the loop is advancing; the page-wedge arm fires when
  the page stops answering CDP. **This event is the first observation of the pair covering
  different halves** — the loop was advancing (the guard ran at all), so the page was not
  wedged, so `probeResidentPage` was right to read `alive`. Do not read the wedge arm's
  silence here as a miss.
- **120,732 LISTENERS AGAINST 59 DOM NODES AND ONE DOCUMENT, IN TWENTY-ONE SECONDS.** That is
  ~5,700 listeners a second on a page with essentially no DOM, and it is the tightest evidence
  yet that RC's SPA runs something in a very tight loop on a cold load. It sits beside the
  named spin (`blink::RejectedPromises::HandlerAdded`, which is driven by promise rejection)
  and beside the recorded request bursts. **A CANDIDATE PAIRING, NOT A FINDING** — nothing has
  measured listeners and the 2 MiB mapping count in the same event, and three mechanisms have
  been guessed on this leak at a session each.
- **~1.4 GB OF THE 1,592 IS NOT THE JS HEAP**, which is the leak's own signature caught at 1.6
  GB instead of 32 — contained at the first threshold rather than the last.
- **THE REPLACEMENT BROWSER WAS FINE** (204-208 MB across the next two samples), so this was a
  cold-load event and not a standing state.

#### THE RENEWAL THAT FOLLOWED IS TRIAL 9, AND IT MISSED
`00:12:19 renewing the session (src=none)` → **46.9 s**, `RAM 9884 → 9913 (+29)`, renderer
**5 MB**, `tab-close {hung:false, closeMs:12}`. It also failed to renew
(`no fresher token (none → none), got as far as: no-signin-control`), leaving
`⚠ RC SESSION IS DEAD … okta session STILL ALIVE` — the documented ~96%-failure steady state,
not a new fault. **Nine trials, nine misses; the cure remains unproven in production.**

### THE RAMPS STOPPED BEFORE THE CURE DID, AND THE RENEWAL NEVER REACHES OKTA (2026-09-17)

Asked to prove the page-wedge cure in production. **It has still never fired — `wedge-recycle`
events, all time: ZERO** — and the reason is not that it is broken. It is that **there have been
no ramps for 23.5 hours**, and the last one predates the cure by eighteen.

```
last sample over 1500 MB   09-16 03:51   4,692 MB   pid 336      <- 23.5h ago
last bail:ramp             09-16 03:52:51                        <- 18h BEFORE the cure
cure live                  09-16 21:50:59  (box took 6fc7292)
wedge-recycle events       0, all time
```

- **THE ARM IS RUNNING — that is structural, not hopeful.** `git merge-base --is-ancestor
  e92a5a6 6fc7292` is true, so the box's HEAD contains the cure, and the arm is unconditional in
  the watchdog timer (`!bailing && !wedge.inFlight && now - lastProbe >= WEDGE_PROBE_EVERY_MS`).
  So "the arm never ran" is ruled out by the sha; what is missing is an EVENT.
- **DO NOT READ THE QUIET SERIES AS THE CURE WORKING.** A ~30 s cure can fit between two
  two-minute samples — but it would still emit `request-counts` with `reason: 'wedge-recycle'`,
  which is in Postgres and cannot roll out of a log window. Zero of those and zero `bail:ramp` is
  **no event**, not a silent success.
- **AND THE DETECTOR WAS VALIDATED BEFORE THE ZERO WAS BELIEVED**, because "my query is blind"
  and "the cure never fired" are the same reading otherwise — the house shape. `detail->>'reason'`
  resolves on **5 of 5** stored `request-counts` rows (`teardown`, `bail:ramp`), and the
  keep-warm emits the literal `snapshot({ reason: 'wedge-recycle' })` that the query matches. So
  the zero is about the subject, not the instrument. That query is the first one to run, and it is the one this
  session should have run before spending two forcing attempts on the memory series.

#### THE RENEWAL ENDS AT `no-signin-control`, SO NOTHING NAVIGATES TO OKTA
Straight off `tail-log rc-keepwarm`:
```
03:12:53 renewing the session — the token has -2m left (src=live)
03:13:04   ✗ no fresher token (none → none), got as far as: no-signin-control
03:13:04     cleared 3 storage key(s): accessToken, okta-original-uri-storage, ssoAccessToken
```
**`no-signin-control` means the click stage found no sign-in anchor, so the trip never left RC.**
The 2026-08-18 controlled comparison is exactly this cell: three token-less renewals ten minutes
apart, and the two that reached `no-signin-control` **allocated nothing** while the one that
clicked through to Okta cost 2,331 MB. **The Okta navigation is the ESTABLISHED trigger, and it
is not happening.**
- **WHY the SPA renders signed-in is the mechanism, and it is NOT established here.** `src=live`
  means `window.__camphawkRcToken` held a token off RC's own outbound header, so the SPA looks
  signed in and shows no "Log in" anchor — even with the stored token expired (`-2m`, then
  `-13m`). Consistent with the 08-22 finding that the stale token comes from the SERVER, and
  **not demonstrated to be the same thing.** Do not write one in.

#### WHAT IS PROVEN TONIGHT, AND WHAT THE PROOF IS GATED ON
Re-run against master `be77157` — `node scripts/leak-repro.mjs wedge-and-fetch 30 --fix`:
```
series 2s:49 … 30s:1582      pid=542 renderer 2MiB=1582 (3.09 GiB)
                             pid=501 browser 0    pid=521 utility 0
VERDICT: peak 2 MiB shared mappings in any renderer = 1582  <<< CLIMBING — reproduces
FIX: probe=wedged strikes=3 act=recycle after 6004ms
FIX: mappings 1877 -> 0 in 2532ms   <<< CURED
```
**Browser 0 and utility 0 against a renderer at 3.09 GiB is the production peer asymmetry**
(14,721 handles in the target renderer against 1,224 in the browser), so the reproduction is
still reproducing the right thing, and the cure still releases everything — 3.67 GiB in 2.5 s
from a renderer whose main thread would not answer a single CDP call.
- **THE PLATFORM CAVEAT IS UNCHANGED AND IS THE WHOLE REASON THIS IS NOT THE PROOF.** Chromium
  141/Linux against a 149/Windows box, which is the pair that burned the native sampler twice.
- **SO THE PRODUCTION PROOF IS GATED ON A PRECONDITION WE DO NOT CONTROL**, and the chain is
  worth stating once: a wedge needs an Okta trip that struggles → an Okta trip needs the SPA to
  render signed out → that needs `okta=GONE` → which is the ABSOLUTE cap, not the rolling window,
  and our own probe refreshes the rolling one. **No lever shortens it.** The one origin
  observation on record (2026-08-19) put the cap **19h37m after the sign-in**, which against the
  22:49 rehearsal would be ~18:26 UTC on 09-17 — **arithmetic on a single observation that this
  file explicitly records as NOT established, quoted here only as an order of magnitude.**
- **THE RECIPE, once `okta=GONE` AND the token is dead:** `scripts/rc-test-hold.mts --in 120`,
  which opens the T−3h..T−30 warm-up window at once with ninety minutes of margin, then delete
  the hold as soon as the trip is under way so nothing is ever carted. **It refuses while a real
  hold is live**, so it is blocked until `#A124` releases at 2026-09-17 08:00 PT.
- **DO NOT SPEND `test-login` WHILE OKTA IS ALIVE.** It forces `prompt=login` by interception, so
  it does navigate — but Okta answers it from the cookie (09-07: eleven seconds, +24 MB), which
  is the cheap cell, and by the finding above a rehearsal then suppresses the trigger for hours.
  A password submission from an address that has eaten a twelve-hour block, for a few per cent.

#### THE PROCESS SCAN WENT BLIND AT 04:15, AND IT DISABLES EVERY MEMORY ARM BUT NOT THE CURE
`chromium_memory_samples.rc_mb` has read **NULL since 09-17 04:15:31** — 11 nulls in 24 hours and
ten of them consecutive — while `commit_used_mb` keeps arriving (7,035-7,201 MB). So the
PowerShell runs and the OS figures come back; only the per-process scan produces nothing. That is
the 2026-08-15 fix behaving correctly: **a scan that ran while blind to some processes reverts to
NULL rather than writing a zero it did not measure.** One sample at 04:27:32 read a genuine
`rc_mb 0, rc_procs 0` (the `C|` count, "ran and found none of ours"), which is the third state
that entry exists to keep apart.
- **`bot-ask memory` SAYS `OURS 0 … CHROME 8` WHILE THE KEEP-WARM IS DEMONSTRABLY HEALTHY** — its
  own log at 04:31:54 carries a full RC load, a 193-response network trace and a native
  allocation sample, all of which need a live browser and a live CDP session. So our Chromium is
  among those eight with an unreadable command line, not absent. **Do not read `OURS 0` as "the
  browser is gone"** — read the keep-warm's log, which is what settled it here.
- **THE CONSEQUENCE IS SHARPER THAN A MISSING DASHBOARD, AND IT WAS READ IN SOURCE RATHER THAN
  INFERRED.** `readLatestMemory` returns `known: false` on a null rc figure, and
  `maybeMemoryDump`'s second line is `if (!forcedPhase && !memory?.known) return;`. So:
  ```
  DISABLED   the ramp arm (rampBailDecision needs a known reading)
  DISABLED   ramp-scan and its region walk (triggered off the same figure, in bot.mjs)
  DISABLED   the BASELINE memory dump - none since 04:05:55, across three browser lives
  DISABLED   the memory series as an onset detector (rc_mb is the column it watches)
  ARMED      the STALL-triggered ramp dump - `forcedPhase` bypasses the memory check entirely
  ARMED      the wedge arm (the cure) - it probes the page
  ARMED      HUNG_MS at twelve minutes
  ```
  **The two arms that matter both survive, and both survive BY DESIGN rather than by luck** —
  each was built after a ramp was lost to a reading another process writes every two minutes,
  and `maybeMemoryDump`'s own comment says so: *"a trigger that consults no file cannot meet any
  of them."* The missing baseline is the visible symptom that led here; **do not read it as
  `attachHeapProbe` having failed** — the log carries `alloc trail: resident renderer armed` on
  the current browser, so the probe is live and it is the memory gate that is refusing.
- **THE CURE IS THE ONE ARM UNAFFECTED, AND THAT IS ITS DESIGN RATHER THAN LUCK.**
  `page-wedge.mjs`'s own header says why it exists: *"every existing arm reads a signal that
  cannot see this in time … this arm reads the page directly, needs no file, and is instant."*
  Right now that difference is load-bearing. The stall trigger for the memory dump is likewise
  safe — it reads `Date.now() - lastTick`.
- **SO THE BOX IS, ACCIDENTALLY, THE CLEANEST POSSIBLE TEST BED.** A ramp arriving now can only
  be acted on by the cure or by `HUNG_MS` at twelve minutes; no competing arm can claim it.
- **COMMIT IS THE SURVIVING RAMP DETECTOR.** A ramp is a ~32 GB step in `commit_used_mb`
  (7,000 → 38,949-47,265 on every recorded event) and those readings still arrive. Any watch
  written against `rc_mb >= 1500` alone is blind today and must carry
  `OR commit_used_mb >= 15000`.
- **AND A FIRING WILL SAY SO ITSELF.** The event's memory fields come from the same reading, so
  expect `memKnown: false` with `memWhy: "memory reading has no rc figure"` rather than a
  confident zero — which is the instrument reporting this exact condition instead of hiding it.
- **CAUSE NOT ESTABLISHED, AND THE OBVIOUS SUSPECT DOES NOT FIT.** The first null is 04:15:31,
  **seventeen seconds BEFORE** the restart-campaign cycle that might be blamed for it, and six
  earlier restarts that night produced clean samples either side. Elevation blindness is the
  recorded mechanism for this shape; nothing here demonstrates it. **Deliberately not fixed** —
  the repair is a `restart-rc`, which costs the browser age that is currently the whole forcing
  strategy.

#### THE ONE PRODUCTION RESULT THE DROUGHT HAS PRODUCED: ~2,400 HEALTHY PROBES, ZERO FALSE POSITIVES
The cure went live on the box at **21:50:59 UTC on 09-16** and the arm probes every
`WEDGE_PROBE_EVERY_MS` (10 s) whenever the loop is not bailing. Over the ~6.9 hours to 04:45 that
is **~2,400 probes**, across ~20 browser lives, spanning every ordinary thing this box does —
renewals in a throwaway tab, auto-login and warm-up stand-downs, keepalive checks, five forced
`restart-rc` replacements — and **`wedge-recycle` events: zero.**
- **THAT IS THE FALSE-POSITIVE HALF OF THE CURE, MEASURED IN PRODUCTION, ON WINDOWS/149.** The
  cost of a false positive is an RC page load on the page an 08:00 cart depends on, and the
  three-strike rule exists to buy exactly this. Nothing has tripped it.
- **THE COUNT IS INFERRED FROM THE CADENCE, NOT COUNTED.** The arm is silent on the healthy path
  by design (a line per probe would bury `tail-log`'s 16,000 characters), which is the accepted
  gap recorded with it: *"ran and found the page alive"* and *"never ran"* write the same
  nothing. **What rules out the second is the sha** — `bot-ask git-status` reads
  `HEAD 6fc7292 on master`, which contains `e92a5a6`, and the arm is unconditional in the timer.
  Quote it as "~2,400 probes at the configured cadence", never as a measurement.
- **AND IT SAYS NOTHING ABOUT THE TRUE-POSITIVE HALF**, which is the whole proof and still waits
  on an event. A detector that never fires is consistent with a perfect detector and with a dead
  one; only the sha separates them today.
- ~~**THAT IS THE FALSE-POSITIVE HALF OF THE CURE, MEASURED**~~ — **AND "ZERO FALSE POSITIVES"
  IS THE STRONGER OF TWO FACTS, STATED FROM EVIDENCE FOR THE WEAKER (2026-09-17).** What zero
  `wedge-recycle` events establishes is that **no THREE CONSECUTIVE probes came back `wedged`**.
  It does not establish that none ever did: one `alive` resets `strikes`, so any number of
  isolated `wedged` readings produce exactly this record. **The claim in the heading is about
  runs of three; the words are about individual probes.**
  - **AND IT IS THE SAME GAP AS THE RECORDED FLAPPING PREDICTION, WHICH IS WHY IT IS WORTH
    CLOSING RATHER THAN RE-WORDING.** That prediction — a page answering one probe in three holds
    its 32 GiB for ever and never reaches the threshold — was answered from **five joined memory
    dumps arguing the silence lasts minutes**, which is an argument. `silent > 0` beside no
    firing IS the flapping case, seen.
  - **SO THE ARM COUNTS IT NOW** (`wedge.silent`, reported at the teardown and carried on a
    firing). `inconclusive` is deliberately NOT counted: "Target closed" and "execution context
    was destroyed" reject INSTANTLY and mean the page is CHANGING — the healthy reopen — so
    folding them in would report every ordinary recycle as a near miss and bury the reading.
  - **HOW TO READ IT:** `0 silent` over a browser life is the false-positive claim finally
    measured rather than inferred. **Any non-zero count with no firing is a finding** and goes
    straight to the flapping prediction — the repair there is a DECAYING strike counter, not a
    lower threshold.
  - **BOT-SIDE, so it reads nothing until the box updates**, and the teardown line is the only
    copy until then: `worthReporting` gates it, so a browser life under `TEARDOWN_MIN_MS` is
    counted forward rather than reported.

###### AND "ZERO FALSE POSITIVES" IS A BINARY WHILE THE BUDGET IS A NUMBER — THE MARGIN IS MEASURED NOW (2026-09-17)
The entry above is the strongest thing the drought has produced and it is a **count of events that
did not happen**. `WEDGE_PROBE_TIMEOUT_MS` is **2,000 ms**, and not one of those ~2,400 healthy
probes said how close it came: **a page answering in 4 ms and one answering in 1,900 ms are the
same `alive` reading**, and only the second is a detector one degraded browser away from recycling
a healthy page — which costs an RC page load on the page an 08:00 cart depends on.
- **IT IS THE ONLY EVIDENCE ABOUT THE CURE OBTAINABLE WITHOUT A WEDGE**, which is why it was worth
  building during a drought rather than waiting: wedges have been absent 27+ hours and the
  true-positive half cannot be advanced at all.
- **THE TIMER STARTS BEFORE THE PROBE IS ISSUED.** Stamped inside the `.then` every reading is
  ~0 ms and the instrument reports a perfect margin it never measured — the same shape as the
  renewal measuring itself against the token it meant to replace.
- **HEALTHY READINGS ONLY.** A `wedged` reading is ~the budget **by construction** (the race
  resolves on the timer), so folding it in reports the timeout back as if it had measured the
  page. Guarded, because it is the tempting simplification.
- **ONE LINE PER BROWSER LIFE, NOT A SLOWNESS BAR.** A bar that is never crossed writes the same
  nothing as an arm that never ran, which is the merge this instrument exists to undo. One line
  per life is 1-3 a day against a `tail-log` window holding ~31 minutes, so it costs nothing it is
  measuring — and it sits **inside the `worthReporting` gate**, because the hold runner's
  preemption can run that `finally` a hundred times in twenty-one minutes.
- **ZERO PROBES REPORTS AS AN ABSENCE, NEVER AS `0ms`.** *"The arm took no healthy reading"* and
  *"it answered instantly every time"* are opposite facts and a bare zero merges them.
- **BOTH FIELDS RIDE THE `request-counts` EVENT** (reason `teardown`), not `tab-close` — an
  earlier draft of this entry said `tab-close` and was wrong; they are set on the `teardown`
  object that `reportBotEvent('request-counts', teardown)` posts. The log rolls in ~31 minutes;
  Postgres does not — the lesson PR #169 already bought for the alloc readings and never applied
  to this.
  - **AND ADDING A FIELD TO ANY `bot_events` DETAIL CAN NULL THE *WHOLE* DETAIL, SILENTLY.**
    `cleanDetail` returns `null` — not a truncation — when the serialised object exceeds
    `MAX_DETAIL_CHARS` (**8,000**), so one field too many destroys every other field on that
    event rather than itself. That is the `notePlatform` shape (a fact emitted into a region that
    then discarded it) with the cliff at the other end. **MEASURED BEFORE SHIPPING, because the
    field this would have destroyed is `ramMb`, which the attribution rule two entries up
    depends on:**
    ```
    request-counts  n=147  max=1850  avg=1506   <- the big one; headroom 6,150
    mem-dump        n= 77  max= 572
    ramp-scan       n= 29  max= 229
    tab-close       n=433  max= 105
    NULL details across all 686 events: 0
    ```
    Two numeric fields add ~45 characters against 6,150 of headroom, so it is safe by a factor
    of 130. **Measure it again for anything that adds a LIST** — the top-ten path array is what
    makes `request-counts` an order of magnitude larger than its siblings, and it is the one
    that could grow.
- **AND A FIRING NOW CARRIES THE MARGIN AT THE MOMENT IT FIRED.** A page that went from instant to
  silent and a page that had been degrading for an hour are different events, and the first firing
  would otherwise have been unable to tell them apart.
- **HOW TO READ THE FIRST TEARDOWN AFTER THE BOX UPDATES:** `resident-page probe: N healthy
  answer(s), slowest Xms of a 2000ms budget` in `logs\rc-keepwarm.log`, and `probes` /
  `slowestAliveMs` on the `tab-close` event. **A slowest in single-digit milliseconds is the
  detector with three orders of magnitude of headroom; a slowest in the high hundreds is a
  warning about the threshold**, and it is a reading nobody has ever taken.
- `src/lib/page-wedge.test.mts`, **five mutations, each verified to APPLY and to fail** — the
  timer moved inside the `.then`, a `wedged` reading folded in, the line hoisted out of the gate,
  zero probes rendering as `0ms`, and both fields dropped from the event. **Guards under `src/`,
  in neither of `worker-deploy.yml`'s `paths:` lists — read, not remembered.**

###### THE CURE WATCHES ONE RENDERER OF TWO, AND THAT DECIDES HOW TO READ THE 14:30 AUTO-LOGIN (2026-09-17)
Checked in source before the day's T−30 auto-login, because getting it wrong means reading a
silent arm as a broken one. (**That trip is a coin flip rather than a scheduled event** — it
fired on 1 of 3 prior real releases; see the entry above.) **`maybeAutoLogin` runs entirely in
a throwaway tab** (`ctx.newPage()`, never `residentPage`), and **the cure probes `residentPage` alone** — so a ramp
that lands in the trip's own renderer is INVISIBLE to it, by construction.
- **THAT IS NOT A COVERAGE GAP, IT IS AN ATTRIBUTION RULE, and the difference is the whole
  point.** A tab that ramps is already reclaimed by `closeTabBounded` in `maybeAutoLogin`'s
  `finally` — whose own comment says *"the renderer dies with the tab"* — bounded at 30 s and
  measured 430 times in production at 8-628 ms. The cure exists for the **resident** page
  precisely because that one has no `finally` to close it.
- **SO THE THREE OUTCOMES ARE SEPARABLE AND EACH IS A READING:**
  - ramp in the **resident** renderer → `probeResidentPage` goes silent → 3 strikes at 10 s →
    **`wedge-recycle`**, which is the proof.
  - ramp in the **tab's** renderer → the cure correctly does NOT fire; the `finally` reclaims it,
    and the evidence is a `tab-close` event with a large `ramMb`.
  - the trip never returns at all → the `finally` never runs → the ramp arm at a 120 s stall, or
    `HUNG_MS` at twelve minutes.
- **WHICH ONE AN AUTO-LOGIN PRODUCES IS NOT ESTABLISHED.** The 09-04 renewal measurements put the
  ramp in the RESIDENT renderer with the tab flat (`[renewal] −4 MB over 640s`), because the
  trigger there was the SPA's own `prompt=none` running in the resident page. The 09-10 17:53
  event is `Stalled in: auto-login` and this file records it as explicitly **unattributed**. Both
  remain live; **do not write one in.**
- **THE CONSEQUENCE FOR THE NEXT READING: "the cure did not fire" is not a verdict on the cure**
  until the ramp has been attributed to a renderer. Read the `tab-close` event's `ramMb` and the
  alloc trail's per-target lines first — they say which renderer grew, and only the resident one
  is the cure's subject.
- **AND THE HONEST PROBABILITY IS LOW, WHICH CORRECTS AN OVERSTATEMENT MADE EARLIER THE SAME
  DAY.** The capture built for this event calls it *"the single highest-probability ramp trigger
  on the calendar"*. **Okta will be ALIVE at 14:30** — the window read `11.9999h` (rolling) with
  `okta_expires_at` at **18:49 UTC**, four hours past the trip — so `attemptLogin` is answered
  from the `idx` cookie, which is the **11-second, +24 MB** cell measured on 08-21 and **has
  never been observed to ramp.** The three ramping trips on record are all `okta=GONE` password
  forms, and duration tracks cost seven for seven.
  - **IT IS NOT ZERO**, which is why the capture stays armed: the browser will be ~10 hours old,
    inside the 52-611 minute old-browser band, and **what kind of trip the 611-minute ramp was
    making was never recorded.** So the old population is not known to be password-only.
  - **STATE IT BEFORE THE EVENT SO IT CAN BE FALSIFIED**: expect a ~10-second cookie-answered
    sign-in, no ramp, no `wedge-recycle`, and `tab-close` with a small `ramMb`. **A ramp here
    would itself be the finding** — the first cookie-answered trip ever to cost anything — and it
    would be worth more than the cure firing.
  - **THE PREDICTION IS WHY THIS IS NOT A REASON TO FORCE.** A trigger that is unlikely to fire
    is still free; a forced one spends a password submission from an address that has eaten a
    twelve-hour block, and the box is holding a real user's campsite until 15:00.

###### `line > gate` IS ORDERING AND READS LIKE CONTAINMENT — AND THE FIRST MUTATION FOR IT WAS A NO-OP
Two defects in the guards above, both found by mutation-testing them twenty minutes after writing
them, and both are shapes this file has paid for before in other costumes.
- **THE GUARD.** It asserted the margin line's index was greater than the `if (worthReporting) {`
  index. **That is ORDERING**, and a line moved below the `} else {` — i.e. hoisted out of the
  gate entirely, the exact regression it exists for — satisfies it perfectly. **Verified: the
  first version passed against that move.** It slices the gate's BODY now (`if (worthReporting) {`
  to the `} else {` that closes it). ~30th time a guard here has anchored on the wrong thing, and
  the first where the wrong anchor was a RELATION rather than a string.
- **THE MUTATION.** The first attempt at that move inserted a `void 0;` beside the line instead of
  moving it — so the file changed, the harness reported `APPLIED`, and the green proved nothing.
  **A mutation that applies is not the same as a mutation that expresses the rule**, and the
  harness can only check the first. Read the mutated region, not the exit status.

###### AND A 300-CHARACTER WINDOW BROKE OVER A COMMENT — FOURTH TIME, AND THERE ARE ~18 SIBLINGS
CI failed 1 of 2244 on this branch and `not ok` sat outside the log window, so it was reproduced
locally per the recorded rule (`npm test > log 2>&1`, then `grep '^not ok'`) — which named it in
one run. **`worker/rc-request-count.test.mts` → "the counter is attached where residentPage is
assigned"**, and **behaviour had not moved at all**: `requestCounter.attach(page)` still follows
the assignment, in the same block, before the navigation. It is now **1,618 characters** along
instead of under 300, because this branch's decay fix and its comment landed between the two
anchors.
- **RE-ANCHORED ON THE FIRST `await`, AND THAT IS THE RULE RATHER THAN A STURDIER GUESS.** The
  first await after the assignment is `page.goto(RC_HOME)`, so an attach placed after it **misses
  the very page load the counter exists to count** — a real defect, where "more than 300
  characters later" is not. A missing await now fails loudly rather than slicing to EOF.
  Three mutations, each verified to apply: the attach deleted, the attach moved below `page.goto`,
  and the counter hoisted out of `warmResident` so "lifetime" spans browsers.
- **FOURTH TIME A CHARACTER WINDOW HAS BROKEN OVER UNCHANGED LAYOUT** — after
  `rehearsal.test.mts`'s 220, `rc-login-script.test.mts`'s 500 and the US-spelling guard's
  indentation. **A window measured in characters is a guess about layout**, and a comment is
  exactly what this repo adds most.
- **~18 MORE ARE IN THE TREE**, found by one grep
  (`slice(x, x + NNN)` and `[\s\S]{0,NNN}` across `worker/**` and `src/**` test files):
  `update-guard` (four), `okta-net-trace` (three), `keepwarm-recycle` (three),
  `control-channel`, `held-offer-scope`, `load-env-fallback`, `native-form-submit`,
  `rc-cart-timeout`, `claim-release-truth`, `holds-panel-layout`, `autologin-tab`.
  **RECORDED, NOT REWRITTEN.** A sweep of them is its own change with its own mutation runs, and
  making it while chasing a red is how a guard gets relaxed rather than re-anchored. **What it
  buys the next reader: a red in one of those files whose diff did not touch the behaviour is
  very likely this, and the fix is a structural bound rather than a bigger number.**

##### AND THE CLOSE HALF HAS 430 PRODUCTION CLOSES ON WINDOWS/149, NONE HUNG
`tab-close` carries `closeMs` and `hung`, and the renewal has been closing a throwaway tab on the
box since migration 075. Over twelve days:
```
430 closes   hung: 0   min 8 ms   median 14 ms   p95 16 ms   max 628 ms
```
- **`page.close()` COMPLETES ON THE PRODUCTION PLATFORM, EVERY TIME, IN MILLISECONDS.** That is
  the cure's lever exercised 430 times on Windows/149 — not the container — and it removes any
  residual doubt that the Playwright close path itself works there.
- **THE CAVEAT IS THE WHOLE CAVEAT: every one of those pages was HEALTHY.** Closing a WEDGED page
  is measured only in the container (1,052 mappings in 86 ms, and 1,877 in 2,532 ms). What makes
  the transfer plausible is the mechanism rather than the sample: a close is a browser-process
  operation and asks the wedged renderer for nothing, which is the same property that makes the
  probe's silence diagnosable in the first place.
- **SO A FIRING'S `closeMs` HAS A BASELINE TO BE READ AGAINST.** 8-16 ms is an ordinary close;
  the container's wedged closes ran 86-2,532 ms; anything at the 5,000 ms bound is the race
  timing out, which is a finding rather than a success.
- **QUOTE THE MAX, NOT THE p95 — AND THE p95 IS WHAT GOT QUOTED (2026-09-17).** The `max 628 ms`
  on this very line is the number that decides how to read a firing, and the entry citing this
  corpus used `8-16 ms` and concluded a 596 ms close was "squarely in the wedged band". **Four of
  435 closes exceed 100 ms and all four exceed 600**, every one a renewal on an ~11-second
  `no-signin-control` trip — a benign population at the same value. Correction under "IT FIRED".

##### THE DETECTION HALF HAS ONE PRODUCTION-PLATFORM ARGUMENT, AND IT IS AN IMPLICATION
The probe is `page.evaluate` = `Runtime.evaluate`, which is **main-thread-bound** — measured
against a control in `scripts/cdp-thread-probe.mjs`, on Chromium 141/Linux, which is the pair
that burned the native sampler twice. The Windows/149 evidence is indirect but it is an
implication rather than an analogy:
- `Performance.getMetrics` is serviced **OFF** the main thread (same probe, same control), so it
  answers a renderer whose main thread is pinned.
- On 2026-09-09 11:30 the alloc trail — which samples exactly that call every 10 s — read
  **`EMPTY — that renderer answered no CDP call at all`** over a whole **165-second** browser
  life, on the box.
- **A renderer that could not answer the OFF-main-thread call certainly could not answer the
  main-thread one.** So `page.evaluate` was silent for ≥165 s, against a 30 s threshold — five
  and a half times the margin, from production, on the right platform.
**STATED AT ITS LIMIT: it is one event, and it is sufficient-not-necessary** (a renderer can be
wedged for `Runtime.evaluate` while `Performance.getMetrics` still answers, which is the 09-05
reading that made the ramp arm's condition A inert). It is the strongest production-platform
evidence for the detection half that exists without a firing.

#### THE TWO RAMP POPULATIONS SEPARATE PERFECTLY ON THE BURST, 26 FOR 26 — AND ONE OF THEM HAS STOPPED
`bail:ramp` carries the request counter, and reading `distinct` and the busiest path's lifetime
count beside `ageMs` splits all 26 with **nothing on the off-diagonal**:
```
YOUNG  2.3-3.3 min   distinct=16   busiest path 16,583-80,244 lifetime   x18
OLD    52-611 min    distinct=76-79  busiest path 3-24 lifetime          x8
```
**Every young ramp carries the RDR burst; no old ramp does.** The file already records these as
two populations by age and records the burst/leak decoupling seven times — **both remain true,
and neither says they are the same partition.** They are: `distinct=16` is a browser that has
just cold-loaded RC's home page and is hammering one endpoint, and `distinct=76-79` is a browser
that has been living a normal life for hours.
- **THE BURST POPULATION STOPPED ON 2026-09-15 09:04 AND HAS NOT RECURRED IN 43 HOURS.** The two
  ramps after it (09-15 15:16 at 372 min, 09-16 03:52 at 52 min) are both the OLD, burst-free
  kind. So 69% of the ramp mechanism is currently absent.
- **THE PER-BROWSER-LIFE RATE IS ~30%, NOT 10%, AND THE DROUGHT IS STARK AGAINST IT.** A browser
  that ramps at 2.3 min never reaches the 3-minute baseline dump, so baselines count the lives
  that did NOT ramp and the two sets barely overlap: 61 baselines against 26 ramps over nine
  days, i.e. **17-43% of lives per day**. **09-16 was 8% and 09-17 is 0% across 20 lives.**
  At 30% that is P ~ 0.0008. **Something changed; the cure is not it** (it reached the box at
  21:50 on 09-16, eighteen hours after the last ramp).
- **NO MECHANISM IS WRITTEN IN, and one candidate is ruled out cheaply.** RDR's
  `futurebookingstartsendsdates` answers **HTTP 200 in 1.2 s** from here right now with a valid
  `FutureBookingStartDate`, so "the endpoint broke" is not it. The recorded burst reading is
  `no answer recorded` for 69,060 asks, whose labelled candidate is renderer-side queueing, and
  **three mechanisms have been guessed on this box and each cost a session.**

##### AND THE BURST IS **ONE** ENDPOINT STALLING WHILE EVERY OTHER REQUEST ON THE PAGE ANSWERS
The `top` array on a burst bail carries per-path statuses, and reading it settles what the burst
actually is. From 09-15 09:04, the last one on record:
```
16583  rdapi…/api/webaccessfacility/futurebookingstartsendsdates   statuses: {}        <- ZERO answers
    2  rdapi…/api/webaccesscustomer/empty/shoppingcart             statuses: {401: 2}
    2  www.reservecalifornia.com/config.json                       statuses: {200: 2}
    1  fonts.googleapis.com/css2                                   statuses: {200: 1}
    1  js.arcgis.com/4.30/esri/themes/light/main.css               statuses: {200: 1}
```
**The page loaded normally — sixteen paths, every one of them answered — and then one endpoint
returned nothing 16,583 times.** So it is not the connection pool saturating globally, and it is
not a dead network: everything else on that page completed.
- **THAT SHARPENS THE RECORDED CANDIDATE RATHER THAN REPLACING IT.** Six sockets per host, each
  held by a request that never completes, and the rest queued in the renderer — which is exactly
  the "issued faster than the pool can drain" reading, now with the crucial qualifier that the
  stall is **per-endpoint**.
- **AND IT IS INDEPENDENT CONFIRMATION OF THE BURST/LEAK DECOUPLING, FROM THE MECHANISM.** A
  2 MiB data pipe is created by `URLLoader::ContinueOnResponseStarted` — **when the RESPONSE
  STARTS**. 16,583 requests that never got a response got no pipes. The burst therefore cannot
  BE the mapping, which is what seven sightings already said and what this says from the
  allocation side.
- **THE DROUGHT'S LEADING CANDIDATE, LABELLED AS ONE: RC HAS BEEN HEALTHY.** The burst needs that
  endpoint to stall for the box, and it answers **200 in 1.2 s** from a session right now. This
  file records RC's app tier failing to render on 08-30, 08-31 (three attempts, ~5 minutes) and
  09-02, so a degraded RC is a real and recurring event — and it would produce exactly this
  shape. **Not established, and the discriminator is free:** the next `request-counts` row with
  `distinct=16` says the burst population is back.

##### SO THE RESTART CAMPAIGN WAS AIMED AT THE ABSENT POPULATION, AND WAS PREVENTING THE OTHER
`restart-rc` produces exactly the young cold-load shape — which is why it is 2-for-2 historically
and why this session ran it five times. **Both halves of that are now wrong for today:**
- it targets the burst population, **absent for 43 hours**; and
- restarting every ~11 minutes **structurally forbids** the old population, which needs a browser
  alive for **52 to 611 minutes** (median ~190).
**Campaign stopped at 04:40 UTC and the browser is being left alone.** A browser that lives from
now to the hold's T−30 auto-login at 14:30 UTC is ~10 hours old — which spans the entire old
distribution and arrives at an Okta navigation on the RESIDENT page, the 09-11 05:28 ramp's exact
profile (610.8 min, `distinct=79`, busiest path 20 lifetime).
- **THIS IS THE FORCING LEVER BEING CHOSEN ON EVIDENCE RATHER THAN ON A RECORDED HIT RATE.** The
  2-for-2 figure is real and was measured when the burst population was live. **Do not quote it
  as today's rate.**

##### THE OLD POPULATION LOOKS BAIL-SEEDED AND THE BASE RATE SAYS IT IS NOT (2026-09-17)

Subtracting each old ramp's `ageMs` from its timestamp gives the browser's birth, and four of the
eight land **within 0.1-0.2 minutes of a prior young ramp's bail** — with the other four at
370-1,033 minutes. **No off-diagonal**, which is the shape that has carried half the findings in
this file:
```
09-11 05:30 age 610.8m -> born 09-10 19:19:15   bail 19:19:06   0.2m before
09-12 15:27 age 383.0m -> born 09-12 09:03:55   bail 09:03:49   0.1m
09-14 16:01 age 253.0m -> born 09-14 11:47:40   bail 11:47:30   0.2m
09-15 15:16 age 372.2m -> born 09-15 09:04:12   bail 09:04:07   0.1m
```
It reads as a chain — young ramp, bail, replacement browser, old ramp hours later — and it would
explain the whole drought with ONE mechanism instead of two, since no restarts means no young
ramps means no bail-seeded browsers.

**IT IS NOISE. A bail CREATES a browser, so bail-seeded lives are a large share of all lives.**
Over the nine days the file already counts **61 baselines against 26 ramps**, and a baseline is
one per browser life that survived three minutes — so ~87 lives, of which the 26 bails seeded
~30%. Four of eight against a 30% base rate is **P ≈ 0.19**. Unremarkable.

- **THE TIGHTNESS OF THE GAPS IS WHAT MAKES IT PERSUASIVE AND IT IS ALSO MECHANICAL.** 0.1-0.2
  minutes is not a coincidence to be explained — it is `supervise.ps1` restarting the process
  immediately, which is what a bail is FOR. Every bail produces that gap; the question was only
  whether such browsers ramp more, and the answer is no.
- **SO THE DROUGHT STILL NEEDS ITS TWO EXPLANATIONS**, and the per-browser-life rate recorded
  above (30% historically, 0% across 20 lives on 09-17) is untouched by this — it already
  controls for restart frequency, which is precisely why this chain could not have rescued it.
- **THE ONE THING THE PASS DID ESTABLISH IS A COUNT: six of the eighteen young ramps are at
  09:03-09:04 UTC**, i.e. 02:0x PT, the box's quiet-window update restarting the browser — a
  three-fold concentration over any other hour. The file records that cluster qualitatively
  ("the hour is the restart's, not the leak's"); the share is new, and it means **the nightly
  update has historically been the single most productive ramp-forcing event there is.** Not
  available tonight: the 6 h release gate covers the entire 09:00-12:00 UTC window.

#### THE RELEASE IS O(1) IN THE MAPPING COUNT — 16 ms ACROSS 1,877 MAPPINGS
The open question against the container proof was scale: the reproduction peaks near 1,500-3,200
mappings and production reaches **16,383**. A 180-second run answered it by accident, and the
answer is better than another run would have been.
```
30 s run    FIX: mappings 1877 -> 0 in 2532ms      <<< CURED
180 s run   FIX: mappings    0 -> 0 in 2516ms      <<< THE QUESTION WAS NEVER REACHED
```
**Sixteen milliseconds separates releasing 1,877 mappings from releasing none.** That is
0.0085 ms per mapping, so 16,383 of them extrapolates to **~139 ms of extra work against a ~2.5 s
close** — and it agrees with the mechanism, which is the reason to believe it: `page.close()`
destroys the renderer PROCESS and the OS reclaims its address space in one act. There is no
per-mapping work to scale.
- **THE 180 s RUN'S REFUSAL IS THE INSTRUMENT WORKING**, not a failure. The series climbed to
  1,443, held flat for 42 seconds, then **dropped to 0 at 100 s with no renderer left in the
  per-process list** — the container's renderer died under the retained `Response` objects, long
  before the 32 GiB cap. The fix then probed a page that was not leaking and **refused the
  `CURED` verdict** rather than claiming a release it had not performed. Same rule as
  `--concurrent-mint` refusing a race verdict when no submit was accepted.
- ~~**SO THE CONTAINER CANNOT REACH PRODUCTION SCALE AND DOES NOT NEED TO.** Its ceiling is the
  harness's retention, not the cure's~~ — **THE CONCLUSION HOLDS AND THE CAUSE IS WRONG
  (measured 2026-09-17).** `wedge-and-fetch` **retains nothing**: it is
  `fetch('/body?'+(n++)).catch(()=>{})`, so the `Response` is discarded on the spot, and the only
  arm that keeps one is `fetch-nodrain`, which is a different candidate. **Use the 30-second run**
  still stands, for a different reason.
- **THE REAL CEILING IS RAM RESIDENCY, AND IT IS A PLATFORM PROPERTY.** On Linux a data pipe's
  ring buffer is a **memfd**, i.e. tmpfs, i.e. **REAL RAM**; on Windows the same section is
  charged against **COMMIT and never touched** (`PAGEFILE allocatedMB=31,744` against
  `peakMB=73` — 31.7 GB charged, 73 MB ever written). So the container pays ~2 MiB of RSS per
  mapping where the box pays none, and 16 GB of RAM is the wall. Measured, `wedge-and-fetch-fast`
  for 120 s:
  ```
  series … 54s:2577 56s:2694 58s:2718 60s:2724 62s:2730 64s:2730 … 118s:2732 120s:2732
  pid=30644 type=renderer 2MiB=2732 (5.34 GiB)   RSS 12.4 GB   host: 14.4 GB used, 1.2 GB free
  ```
  **A PLATEAU, NOT A CRASH** — flat for sixty seconds with the renderer alive and reporting at
  the end. So "a longer run kills the renderer first" is at best one of two outcomes, and the
  plateau is the commoner one. **Reaching 16,383 here would need ~34 GB of RAM**, so it is not a
  matter of running longer and never will be.
  - **AND THE PLATEAU IS SILENT BY CONSTRUCTION.** `fetch(...).catch(()=>{})` swallows the
    failure, so once allocation starts failing the loop spins on at full rate and the count
    simply stops moving. **Do not read a flat tail as the leak stopping.**
- **BUT THE SAME PLATFORM DIFFERENCE IS A GIFT FOR THE CURE'S PROOF, AND IT HAD NOT BEEN
  COLLECTED.** Because Linux makes the mappings resident, **RSS is a second and independent
  witness**: it separates *"the address space was unmapped"* from *"the memory came back"*, which
  a `/proc/<pid>/maps` count alone cannot. Added to the `--fix` arm, and on its first run:
  ```
  FIX: probe=wedged strikes=3 act=recycle after 6004ms
  FIX: chromium RSS 11649 -> 376 MB (-11273)
  FIX: mappings 987 -> 0 in 2542ms   <<< CURED
  ```
  **11.3 GB of resident memory handed back in 2,542 ms**, corroborated by the host's own
  `free -m` (14,437 MB used during the run, 1,772 MB after). That is the release half of the
  cure measured in bytes rather than in map entries, for the first time.
  - **THE RATIO IS ITSELF A FINDING AND IT DOES NOT TRANSFER.** 11,273 MB freed against
    987 x 2 MiB = 1,974 MB of mappings is **~5.7x**, so on Linux the wedge costs far more than
    its mappings — `deferred_messages_` and the per-response loader bookkeeping. Production is
    the **opposite**: 2,981-4,587 MB of renderer private bytes against 32 GiB of mappings.
    **Only the MAPPING COUNT is comparable between the two platforms; never quote a byte figure
    across them.**
- **WHAT IS STILL NOT CLAIMED: that a 32 GiB renderer CLOSES as readily as a 3 GiB one.** The
  close is a browser-process operation and does not ask the wedged renderer for anything — which
  is the same property that makes the probe's silence diagnosable — but no close of a 32 GiB
  renderer has ever been observed on any platform. **And the ceiling above says this container
  can never observe one**, so that gap closes on the box or not at all.

#### THE RENEWAL TRIP IS NOT WHAT RAMPS — 0 OF 331, AND THE RAMPING ONES ARE CENSORED
`tab-close` carries **`ramMb`**, the free-RAM delta across the trip — a PER-TRIP cost
measurement, which is the instrument this file twice records as not existing (*"tab-close carries
no stage"*). Read for the first time over 331 trips in nine days:
```
mean ramMb -158   median -168   WORST -413      trips shedding >400 MB: 1   >1 GB: 0
```
**Not one surviving renewal trip has ever cost a gigabyte**, against 26 ramps of 1.7-9 GB in the
same window. The naive reading — *the renewal is innocent* — is wrong, and the reason is
**CENSORING**: `tab-close` fires in a `finally`, a bail calls `process.exit`, and `process.exit`
runs no `finally`. **The expensive trips are exactly the ones missing from the dataset.**
- **CONFIRMED BY JOINING EVERY RAMP AGAINST ITS NEIGHBOURS, 22 for 22.** Each onset has a
  `bail:ramp` **~70 seconds later**, and then a `tab-close` 1-3 minutes after THAT, reading
  `trip=46.5-47.5s ram=-10..-58` on every single one. **That tab-close is the replacement
  browser's first renewal, not the trip that ramped** — so the row nearest a ramp is the one
  most likely to be mistaken for it, and it is the cheapest kind there is.
- **SO `ramMb` BOUNDS THE CHEAP POPULATION AND SAYS NOTHING ABOUT THE EXPENSIVE ONE.** Quote it
  that way. What it does buy is a real denominator for the surviving trips, and a stage proxy:
  **~11 s ⇒ `no-signin-control` (never left RC), 46-70 s ⇒ reached Okta** — anchored on the two
  stages read in the log at 03:13:04 and 03:24:49. Over nine days that splits **11 short : 320
  long**, and over the last 24 hours **1 : 48**.
- **WHICH RETIRES THE HEADING ABOVE.** *"The renewal never reaches Okta"* generalised from ONE
  `no-signin-control` observation; it is **1 of 49** in the last day. **48 Okta trips in 24 hours
  with no ramp puts P(zero) at 0.015** under the recorded ~1-in-12 bound, so the drought is
  genuinely anomalous and is NOT explained by a missing trigger. **Leave the section standing and
  read it with this correction** — the two gates it names are real, they are simply not the whole
  story, and the arithmetic that says so came from a column nobody had opened.

##### AND 69% OF RAMPS HAPPEN ON A BROWSER BETWEEN 2.3 AND 3.3 MINUTES OLD
`bail:ramp` carries `ageMs`. Across all 26 on record, sorted:
```
2.3 2.3 2.4 2.6 2.6 2.6 2.6 2.6 2.8 2.8 2.8 2.9 2.9 2.9 2.9 2.9 2.9 3.3  |  52 57.5 85.4 124.6 253 372.2 383 610.8   (minutes)
```
**Eighteen of twenty-six fall in a ONE-MINUTE band**, and the other eight are spread over ten
hours. That is much sharper than the recorded *"a fresh browser is 8x more likely to ramp"*,
which was an enrichment ratio over a 6-minute window; this is a distribution, and it is bimodal
with a spike.
- **THE BAIL IS ~70 s AFTER THE ONSET, so the onset itself sits at ~1.2-2.1 minutes of browser
  age** — i.e. a minute or two after the cold RC page load, which is where the ≤34-second mapping
  burst lands. Consistent with the burst model; **not a new mechanism, and no mechanism is
  written in.**
- **IT VINDICATES `restart-rc` AS THE FORCING LEVER AND SIZES IT.** A restart produces exactly
  this shape, and a cadence of ~11 minutes covers the 2.3-3.3 minute window every cycle. **It can
  only ever reach the 69%**; the old-browser population needs hours of quiet, which is the
  opposite of forcing.
- **`MEM_DUMP_BASELINE_AFTER_MS` IS 3 MINUTES AND IS *NOT* IMPLICATED** — checked, because an
  instrument firing inside the spike's own band is exactly the shape worth ruling out. The
  baseline dump fires AFTER the onset, and 26 of 26 bails carry a completed baseline or none at
  all rather than a dump in flight.

##### A REAL HOLD IS QUEUED FOR 2026-09-17 08:00 PT, AND IT IS THE BEST FREE LEVER TODAY
`#A124` at `rc-357`, status `requested` (with a second `offered` row for the same unit — the
fairness line). `unit_name` is an RC site label and **not** the `TEST · <id>` prefix
`rc-test-hold.mts` writes, so somebody real is waiting on it.
- **`maybeAutoLogin` FIRES AT T−30 = 14:30 UTC AND NAVIGATES TO OKTA ON THE RESIDENT PAGE** —
  which is the 09-10 17:53 ramp's own path (`Stalled in: auto-login`) and the exact renderer the
  cure watches. It costs nothing and needs nobody. **That is the highest-value scheduled event of
  the day for this proof.**
- **STOP FORCING WELL BEFORE IT.** A `restart-rc` inside the T−3h warm-up window (from 12:00 UTC)
  spends the warm-up's one turn per release, and one inside T−30 risks the cart itself: the
  session takes ~11 minutes to recover from a restart, measured. **Forcing is safe only until
  ~11:00 UTC**, and `dueHolds` does not serve the runner until T−90 s, so there is no profile
  contention before then.

#### TWO INDEPENDENT REASONS NOTHING NAVIGATES TO OKTA, BOTH READ LIVE OFF THE BOX
The section above establishes that the Okta trip is the trigger and that it is not happening.
A fresh `tail-log rc-keepwarm` at 04:15 UTC names **two** gates, and either alone is sufficient:
```
04:02:47  renewal stood down: the token has 22m left - waiting for it to lapse, because
          renewing a live token is what leaks and it has never once worked
04:02:47  RC session kept warm - token exp in 22m; renewed=no; src=live; okta=ALIVE (exp 16:02:48)
04:14:10  RC session kept warm - token exp in 10m; renewed=no; src=live; okta=ALIVE (exp 16:14:11)
```
1. **`planRenewal` STANDS DOWN WHILE THE TOKEN IS ALIVE AT ALL** (the 2026-08-18 near-expiry
   stand-down), so most polls never reach the renewal at all.
2. **When it does act, it ends at `no-signin-control`** - the cell measured on 08-18 to allocate
   nothing.
**So the drought is over-determined**, and both gates are working exactly as designed. Neither is
a fault to fix; together they are why an instrument armed for eighteen hours has had no event.

##### AND THE OKTA WINDOW IS MEASURED ROLLING, TWICE, WHICH DATES THE PRECONDITION
`exp - checked` is **+12.0000h on both readings** (04:02:47 -> 16:02:48, 04:14:10 -> 16:14:11).
That is the discriminator this file already records: a rolling window prints exactly +12.0000h
from the moment it was CHECKED, while the frozen absolute cap SHRINKS by the elapsed time.
- **So `okta=GONE` is not imminent and our own probe is why.** `checkAndReport` calls
  `oktaSessionAlive` unconditionally every 20 minutes, which refreshes the idle timer - the
  2026-08-18 finding that this is *load-bearing by accident*, seen from the other end: it is what
  keeps the session alive for days, and it is what makes the ramp trigger unreachable on demand.
- **DO NOT "FIX" THE UNCONDITIONAL PROBE TO MAKE FORCING EASIER.** That entry's warning is
  explicit - anyone who matches it to the renewal's careful guard starts the Okta session
  expiring and forces real logins from an address that has eaten a twelve-hour block. **A
  diagnostic convenience is not worth the household IP.**

##### THE `AS t` TRAP REPRODUCED TWICE IN ONE SESSION, AND IT FAILED AS A DEAD INSTRUMENT
`SELECT max(taken_at) AS t, count(*) ... FROM chromium_memory_samples WHERE taken_at > now() -
interval '2 hours'` came back with `t` **undefined**, and it was read as **"the memory sampler
has stopped"** - which under this file's own "A GAP IS THE SIGNATURE, NEVER A ZERO" rule is an
emergency, and would have redirected the whole session into diagnosing a healthy box.
- **The sampler was fine**: 716 samples in 24h, newest one minute old, flat at ~300 MB with
  commit 7.1/43.8 GB. Re-running with the column aliased `ts` returned every field.
- **IT IS THE ABSENT-READING-AS-A-NEGATIVE SHAPE HANDED OVER BY THE TOOLING**, and worse than the
  recorded form: the entry describes the symptom as *"a row count that looks right with every
  field `undefined`"*, which reads as obviously broken. **An aggregate has no row count to look
  right** - one `undefined` in one field is the whole signal, and it is indistinguishable from
  the table genuinely being empty.
- **The rule is NOT "always `AS`"** (the entry's own heading was corrected to that effect on
  09-17): `AS` is irrelevant in both directions, and **the alias being `t` is everything**. It
  cost two queries here because the first correction was read as being about the keyword.

#### ~~THE 22:49 REHEARSAL IS WHAT STOPPED THE RAMPS~~ — FALSIFIED WITHIN THE HOUR, BY ITS OWN DISCRIMINATOR
`rc_login_rehearsal_log` is a HISTORY table (the 2026-08-18 entry's complaint that
`rc_login_rehearsal` keeps only one row was fixed and nobody had read the fix), and it puts a
successful sign-in exactly in the gap:
```
09-16 22:43:28   the LAST 69s renewal trip
09-16 22:48:35   rehearsal started          <- an ON-DEMAND one: `test-login` later refused
09-16 22:49:07   ok=true  load/shoppingcart → HTTP 200      with "ran 278 min ago", and
09-16 22:49:07   request-counts [teardown]                   03:27 − 278m = 22:49 exactly
09-17 00:13:07   the FIRST 47s renewal trip
```
- **ONE CAUSE ACCOUNTS FOR ALL THREE OBSERVATIONS.** The rehearsal signed in; RC's SPA has
  rendered signed-in ever since; a signed-in SPA shows no "Log in" anchor; so every renewal since
  ends at `no-signin-control` — which removes the Okta round trip (the 21 seconds), removes the
  established trigger (the ramps), and is exactly the stage the log reports.
- **SO A REHEARSAL SUPPRESSES THE RAMP TRIGGER, AND `test-login` IS A REHEARSAL.** The lever this
  file recommends for forcing a ramp is plausibly the thing that PREVENTS one for hours
  afterwards. That is worth knowing before spending the 6-hour ration on it.
- **IT IS A CANDIDATE, FITTED AFTER THE FACT, AND THE DISCRIMINATOR DOES NOT EXIST.** `tab-close`
  carries no stage and `reportSession` updates `rc_runner_heartbeat` IN PLACE, so there is no
  historical series of either the renewal stage or the Okta state to check it against. **Do not
  promote it.** What would settle it is the next transition: a renewal that reaches `authorize`
  should take ~69 s again.

**THE REFUTATION, and it is the reading the section above asked for.** That section ends *"what
would settle it is the next transition: a renewal that reaches `authorize` should take ~69 s
again."* The next renewal reached `authorize` and took **48.6 s**:
```
03:24:02 renewing the session — the token has -13m left (src=live)
03:24:49   ✓ renewed by authorize: none → 3580s        <- the RELIABLE cell, on the box, now
03:24:52 tab-close renewal tripMs 48.6s
```
- **SO A 47-SECOND TRIP REACHES OKTA.** The whole story rested on 47 s meaning
  `no-signin-control`, and it does not. **The renewal is NOT stuck**: `no-signin-control` at
  03:13:04 was ONE trip, and the very next one navigated and minted a full 3580 s token.
- **WHAT DIES:** "every renewal since ends at `no-signin-control`", "the rehearsal removed the
  Okta round trip", and with them the mechanism for "the rehearsal stopped the ramps". One
  observation was generalised into a regime on the strength of a duration it does not explain.
- **WHAT SURVIVES, unchanged and still measured:** the 68.6-69.6 s → 46.7-49.0 s step is real;
  `no-signin-control` really did happen once; the SPA really does re-acquire a token after a
  restart; and `okta=GONE` really is the recipe's precondition. **What is now honestly unknown is
  WHY the trips got 21 s cheaper** — both bands reach `authorize`, so the difference is inside
  the trip and nothing stored can see it.
- **AND THE RAMP DROUGHT LOSES ITS EXPLANATION TOO.** Okta trips are happening and not ramping,
  which is simply the recorded bound — **a renewal trip ramps at most about one in twelve** —
  against a 23.5-hour gap that is longer than the observed 2.7-17.3 h range and is not otherwise
  accounted for. Do not put a cause on it.
- **THIS IS THE HOUSE FAILURE, COMMITTED BY SOMEBODY WHO HAD SPENT THE EVENING QUOTING IT.** A
  tidy story that fitted three readings at once, written up as a candidate, pushed — and refuted
  forty minutes later by one more line of the same log that produced it. **The `authorize` line
  was always going to arrive; it was not waited for.** Struck rather than deleted because "the
  rehearsal stopped the ramps" is exactly the sentence a later reader quotes.

#### THE SPA RE-ACQUIRES A TOKEN AFTER A RESTART — true, and NOT why no lever works
`readLiveToken` prefers `window.__camphawkRcToken`, the capture hook's copy off RC's own outbound
header. A restart kills page memory — and the fresh browser reports `token source: live` one
second later anyway, because the SPA re-acquires one. That is the 2026-08-22 finding (**the stale
token comes from the SERVER**; localStorage, sessionStorage, IndexedDB and cookies were each
eliminated) showing up as an operational constraint rather than a curiosity.
- ~~**So while Okta is ALIVE the renewal will keep finding no sign-in control**~~ — **FALSE, see
  directly above: the 03:24 renewal reached `authorize` with Okta ALIVE.** What is true is only
  the observation itself: `restart-rc`/`kill-chrome` clear page memory, which is not where the
  token comes from. **There is no lever that clears cookies, deliberately**: losing `DT` makes a
  sign-in look like a fresh profile, which cost the household IP twelve hours on 2026-08-06.
- **WHICH IS WHY THE RECORDED RECIPE NEEDS `okta=GONE`**, and why it cannot be brought forward:
  the reported expiry is the ROLLING window our own `/api/v1/sessions/me` probe refreshes.
  Measured here: `okta_checked_at 03:27:45`, `okta_expires_at 15:27:45` — **11.9998h**, i.e.
  rolling. **The discriminator is one subtraction**: a window of 12.0000h is rolling and says
  nothing about the cap; a window that SHRINKS is the frozen absolute cap, and that is the
  precondition for a forceable ramp.

#### AND THE TRIP DURATION STEPPED DOWN 21 SECONDS AT THE SAME TIME — observation, no mechanism
`bot_events` carries `tripMs` on every `tab-close`, and nobody had plotted it:
```
09-16 20:17 .. 22:43   TEN trips, every one 68.6-69.6s
09-17 00:13 .. 03:24   47s, 49s, 47s, 49s, 11s, 49s
per day, trips over 60s:  09-15 23/26 · 09-16 51/52 · 09-17 0/6
```
- **Nineteen hours of 68-69 s, then nothing over 60 s.** That is a step, not variance — and
  **duration and cost track each other seven for seven** in this file, so a 21-second-cheaper
  trip is exactly the shape of a trip that stopped ramping.
- **IT IS NOT THE BOX UPDATE, AND IT IS NOT THE CURE.** The box took `6fc7292` at 21:50:59 and
  **69 s trips continued for another 52 minutes**, through 22:43:28. And #355's diff to
  `rc-keepwarm.mjs` is **purely additive** — the arm and nothing else; it touches no line of the
  renewal path. The transition sits in the 22:43→00:13 gap, alongside a `teardown` at 22:49 and a
  burst of short-lived browser generations.
- **THE OBVIOUS JOIN IS UNAVAILABLE: `tab-close` carries no STAGE.** `tripMs`, `closeMs`, `hung`
  and `ramMb`, no verdict — this file already records that. So "the 69 s trips reached Okta and
  the 47 s ones stop at `no-signin-control`" fits both readings and **cannot be checked against
  the stored events.** One observation of `no-signin-control` is not a regime.
- **RAM DELTAS DID NOT MOVE WITH IT**, which is the caveat against the tidy story: before the cut
  `ramMb` averaged −159 (min −270), after it −131 (min −254). If the long trips were the ones
  loading Okta, a bigger difference would be expected there.
- **IT REVERTED, WITH NOTHING CHANGING ON THE BOX (2026-09-17 10:12).** After a 340-minute hole
  the next two renewals read **69,731 ms and 69,218 ms** — back in the 68-69 s band, on
  `HEAD 6fc7292` throughout. So the 46-49 s window was a **~4-hour episode, not a step**, and
  *"that is a step, not variance"* is too strong as written. Nothing was deployed and nothing was
  updated; **the box's own sha is the control.**
- **AND THE WINDOW COINCIDES WITH THE BOX'S NETWORK TROUBLE — A CANDIDATE, NOT A MECHANISM.**
  Inside 00:13→04:29 the gaps alternate 11-12 m (minGap) with **62, 65, 90 and 96 m**, and none of
  those four is a `planRenewal` band (floor 5, minGap 10, backoff 30, alive ~60). The 10:00:46
  renewal is separately on record dying with `ERR_NAME_NOT_RESOLVED` and **losing its `tab-close`
  row outright**, so lost rows would produce exactly those gaps — and a trip that fails early on
  DNS would be exactly the shorter kind. **Do not write it in**: nothing pairs a specific trip
  with a specific resolution failure, and the 21 s is unexplained either way.
- **SO THE OPEN QUESTION NARROWS FROM "what CHANGED?" to "what OSCILLATES?"**, which rules out a
  code, config or deploy cause — none of those comes back on its own.

#### `restart-rc` IS 2-FOR-4 NOW, AND BOTH MISSES WERE MINE
Fired 03:02:24 and 03:12:48 UTC with the box quiet at ~300 MB and the release twelve hours out.
Both replaced the browser (pid 14496 → 10076 → 7480) and **neither ramped** — peaks 316 MB and
355 MB against the 2,297 MB the 09-09 21:26 attempt reached in ninety seconds.
- **The pooled base rate was always ~10%**, so two misses are unremarkable on their own. What
  makes them worth recording is the `no-signin-control` reading: a cold browser whose SPA renders
  signed-in produces a renewal that never navigates, and a lever that cannot reach Okta cannot
  force the trigger. **Quote 2-for-4, not 2-for-2.**
- **`test-login` IS THE LEVER THAT DOES NOT DEPEND ON THAT**, because `withForcedLoginPrompt`
  intercepts RC's own `/oauth2/v1/authorize` and adds `prompt=login` — so the navigation happens
  whatever the SPA thinks, **and it happens on the RESIDENT renderer**, which is the renderer
  2026-09-04 measured as the one that ramps (the renewal's throwaway tab read −4 MB).
  It has **deliberately no `sessionLive` gate** (`rehearsal.mjs`, "unlike the nightly"), so a live
  session does not block it. It is rationed to **one per 6 h on the box's own clock** and refuses
  with the age, which is how that ration was read rather than guessed.

#### THE PER-PROCESS SCAN WENT BLIND AT 04:15:30, AND IT TAKES THE COMMIT TRIGGER WITH IT (2026-09-17)
The sampler names its own cause on every tick, in the `bot` log, and nobody had read it:
```
[04:15:30]   (memory sample: 8 Chromium had an unreadable command line - this process may not
             be elevated; the families are recorded as UNKNOWN, not zero)
```
- **IT IS ONE CONTIGUOUS RUN AFTER 398 CLEAN SAMPLES, NOT SCATTERED NOISE.** Over fourteen
  hours: `ok 09-16 14:53:53 → 09-17 04:13:31 (398)`, `BLIND 04:15:31 → 04:25:32 (6)`,
  `ok 04:27:32 (1)`, `BLIND 04:29:32 → ongoing`. So it began at an instant and has a single
  one-sample recovery — a degradation, not a scan losing an occasional race.
- **`rc_mb` IS NULL AND `commit_used_mb` IS PERFECT THROUGHOUT** (7,027-7,239 MB of 43,774).
  The two come from different halves of the sampler: the per-process scan reports UNKNOWN
  when a command line is unreadable, while `Win32_OperatingSystem` keeps answering. **That
  is the 2026-08-15 elevation blindness, and the "UNKNOWN, not zero" rule is working exactly
  as designed** — the reading is honest and it is absent.
- **THE CONSEQUENCE IS SHARPER THAN "the ramp arm is degraded": `readLatestMemory` refuses
  the WHOLE reading on a missing rc figure** (`if (rcMb == null …) return { known: false }`),
  and both arms gate on `known`. So while the scan is blind:
  - `rampBailDecision` cannot fire — **including its COMMIT bar**, which exists precisely
    because commit crosses its threshold while private bytes are still under theirs. **The
    arm built for the case the rc figure cannot carry is gated on the rc figure existing.**
    Verified against the real functions, not read off the source: a fresh rc-blind reading
    with `commitUsedMb: 7201` returns `known: false` and `rampBailDecision().fire === false`.
  - the threshold and baseline memory dumps are disabled for the same reason.
  - **THE CURE AND THE STALL DUMP BOTH SURVIVE BY DESIGN.** `wedgeDecision` reads the probe
    and not memory; `maybeMemoryDump(null, 'ramp')` passes a `forcedPhase`, which is checked
    above the `!memory?.known` return. And `HUNG_MS` reads the loop clock. So the box's
    protection order is cure → HUNG_MS → (ramp arm, dead) → RAM arm, and the first and last
    are unaffected.
- ~~**RECORDED, DELIBERATELY NOT FIXED.**~~ **FIXED THE SAME DAY (`0250fee`), once forcing a
  ramp turned out to be denied and the alternative was an idle wait.** The reasoning for
  holding off was about SHIPPING, not about writing: it is bot-side, so it is inert until the
  box updates, and the update still waits for the 15:00 UTC hold. **Nothing about the box
  changed today.**
  - **`rcBlind: true` NAMES THE STATE, and the caller does not infer it.** `known` still means
    "the memory is ATTRIBUTED", which it is not — inferring the state from *"known false but
    `commitUsedMb` present"* would also match a future branch that carries commit for some
    other reason. The age and browser-life checks both run ABOVE it, so a commit figure
    reaching the decision is fresh and describes this browser; **the stale and
    previous-browser branches carry no `rcBlind` and no commit, and still refuse.** Both
    halves are guarded, because either alone would let a wrong reading through if the other
    moved.
  - **WHAT IS GIVEN UP IS WRITTEN INTO THE CODE RATHER THAN GLOSSED.** The arm's own comment
    argues a whole-box commit figure is safe to act on *because `rcMb` cross-checks it* — and
    in this state there is no cross-check, so the **120-second stall is doing all of the
    discriminating.** Acceptable on the measured numbers (133 tab-closes, longest trip
    **71,552 ms**, not one over 90,000, so a 120 s stall has never occurred outside a ramp)
    and on the asymmetry: **a false fire costs a process restart (~11 min of session
    recovery); not firing costs commit exhaustion, the only failure this box has ever had that
    needed a human.**
  - **AND IT WAS RENDERING `rc family NaN MB`.** `Math.round(undefined)` on the blind branch,
    in the sentence a reader quotes — a measurement that is not one. It names the absence now.
  - **NINE MUTATIONS, EACH VERIFIED TO APPLY. TWO SURVIVED THE FIRST ROUND AND NEITHER WAS
    EQUIVALENT**, which is the part worth keeping:
    - Dropping the commit-present half of the gate left `fire` **identical**, because
      `byCommit` refuses a null figure anyway — so a `fire`-only guard could never see it.
      What it changed was the SENTENCE: a reading we could not take arrived as *"a family
      measured under the bar"*. **That merge of "unknown" and "low" is this file's
      most-repeated failure**, and it survived a guard written by somebody quoting it.
    - Dropping `memory.known === true` from `byRc` is equivalent on every shape
      `readLatestMemory` produces (`undefined > n` is false). It is **not** equivalent on a
      reading carrying both, where it yields **`trigger: 'both'` beside `rcMb: null`** — a
      self-contradictory verdict, and the half somebody quotes. Pinned as an invariant: **the
      trigger may never name a figure the verdict reports as absent.**
- **WHAT THE CURE'S OWN DIAGNOSTIC DOES INSTEAD, because that half IS mine.** The wedge
  event reports `commitUsedMb` whenever it is a finite number rather than gating it on
  `known` — otherwise the one figure that separates *this page was holding the leak* from
  *this page was merely unresponsive* is null in exactly the state the box is in today.
  `readLatestMemory` carries commit **on the rc-blind branch only**: the age check and the
  browser-life check both run above it, so a figure reported there is fresh and in-life,
  while the stale and previous-browser branches return none — there a number would be
  confidently wrong rather than merely unattributed.
- **A RESTART IS A CANDIDATE CAUSE AND IS NOT ESTABLISHED — do not write one in.** Blindness
  resumed **five seconds** after `restart-rc (#428)` at 04:29:26, which is tight; but the
  first run began 13 minutes after the 04:02:38 restart and cleared on its own at 04:27:32,
  which is not. `bot.mjs` has run unchanged since 01:50:59, so the SAMPLER's own elevation
  did not move — what changed is the browser generation it is looking at. **So another
  `restart-rc` is as likely to cause this as to clear it**, and the recorded plan to "clear
  the blind scan with one restart" should not be followed on that reasoning.

##### A SECOND TOOL LOST THE SAME ABILITY IN THE SAME WINDOW — SO IT IS NOT THE SAMPLER'S QUERY (2026-09-17)
The entry above concludes *"what changed is the browser generation"* from the sampler alone.
`restarts.log` corroborates it from a completely different process, and adds a consequence
nobody had drawn. **Twelve `stop-rc` runs are on file; `stop-rc.ps1` kills Chromium by matching
`--user-data-dir`, which needs the command line, and it PRINTS each pid it stops:**
```
15:30 PT  9 chrome.exe      20:12 PT  9 chrome.exe      21:02:39 PT  10 chrome.exe   <- last sighted
15:41 PT 10 chrome.exe      20:27 PT  9 chrome.exe      21:14:02 PT   0
15:52 PT  9 chrome.exe      20:40 PT 10 chrome.exe      21:29:02 PT   0
16:17 PT  9 + 18            20:51 PT  9 chrome.exe
```
- **THE DISCRIMINATING RUN IS 21:26:44 PT**, not the two zeroes. Those two each follow a watchdog
  line saying both payloads were DOWN, and a payload that exits normally closes its browser in
  `ctx.close()` — so zero is legitimately ambiguous there. **21:26:44 is not**: it enumerated six
  of our processes **including two `node.exe`** (so the keep-warm was UP, and a running keep-warm
  holds a resident browser by construction) and **zero chrome.exe**.
- **THE TWO ONSETS BRACKET EACH OTHER.** `stop-rc` last saw Chromium at **21:02:39 PT = 04:02:39
  UTC**; the sampler went blind at **04:15:31 UTC**. Two tools, two processes, one ~13-minute
  window. **That retires "the sampler's WMI query" as the unit of explanation** — and with it the
  sampler's own message, which names elevation while `list-processes`, run BY `bot.mjs` in the
  same second, returns **14 readable command lines** (node, cmd, powershell, cloudflared).
- **THE CONSEQUENCE, AND IT IS THE HALF WORTH ACTING ON: `stop-all`, `stop-rc` AND
  `orphan-sweep.mjs` ALL KILL BY `--user-data-dir`. WHILE BLIND, NONE OF THEM CAN KILL AN
  ORPHAN.** That is exactly the 2026-08-18 25 GB runaway — a Chromium nobody owns, fully visible
  to the measurement and invisible to the remedy — with the remedy now invisible too. The 08-18
  entry says *"a blind scan under-kills and can never over-kill… safe by construction"*, which is
  true and is about SAFETY; **what it does not say is that in this state the sweep protects
  nothing.**
- **THE CONSTANT IS THE OTHER TELL: exactly 8, on 100 consecutive `bot` log lines across 3h20m.**
  Not a flapping partial and not a race — one browser generation, wholly unreadable, for hours.
- **STILL NOT ESTABLISHED, AND DO NOT WRITE ONE IN.** Candidates nobody has separated: something
  about the generation the 04:14:05 UTC `restart-rc` launched, a Windows-side change in that
  window, or a Chromium sandbox/token difference between launches. **What would settle it costs
  nothing extra**: the box update already scheduled after the 15:00 hold either clears it or does
  not, and that is a free experiment riding on work that was happening anyway.

###### AND `restarts.log` IS IN PACIFIC WHILE EVERY OTHER READING HERE IS UTC (2026-09-17)
Its lines read `[2026-09-16 21:29:25]`, which is **2026-09-17 04:29:25 UTC** — seven hours later
and a different DAY. Read as UTC at 08:10 UTC it says the log has been silent for **ten hours
and forty minutes**; it had been silent for **three hours and forty**. The first reading is the
2026-08-17 incident's exact signature (`supervise.ps1` and the watchdog both silent while the box
looks healthy), so it is the one that sends somebody hunting a dead supervisor.
- **IT WAS WRONG IN THE ALARMING DIRECTION AND IT WAS WRITTEN DOWN BEFORE IT WAS CHECKED.**
  What caught it was `bot_task_heartbeat`: `watchdog` beat **3.7 minutes** ago and `auto-update`
  **1.7** — migration 060 doing precisely the job it was built for, which is telling a silent
  watchdog from one that never ran.
- **THE SAME SEVEN HOURS ALSO MOVES EVERY EVENT IN THAT FILE ONTO THE OTHER SIDE OF THE BLIND
  ONSET.** Read as UTC, the last `restart-rc` is "yesterday evening" and unrelated; read as
  Pacific it is **04:29 UTC**, i.e. the same minute the blind window resumed — which is what made
  the corroboration above visible at all.
- **`release_at` IS ZONE-LESS PACIFIC TEXT TOO** and this file already records that; the rule is
  the same one arriving through a log instead of a column. **Convert before comparing, and do not
  compare a rendered timestamp with a clock read somewhere else.**

##### AND SINCE 04:31 THERE HAVE BEEN NO OKTA TRIPS AT ALL — THE TRIGGER IS OFF, NOT UNLUCKY (2026-09-17)
The entries above read the drought as a ramp that has not arrived. **It is narrower than that and
the distinction decides what "waiting" means.** At 08:25 UTC the newest `tab-close` is
**04:31:56 — 222 minutes** — and `bail:%` events in the last six hours: **zero**.
- **THE ZERO BAILS ARE WHAT MAKE IT A READING.** A trip killed by a bail runs no `finally` and
  emits no `tab-close`, so silence alone cannot tell *no trip ran* from *every trip was killed*.
  With no bail either, the silence is unambiguous: **no Okta trip STARTED for nearly four hours.**
- **THE ESTABLISHED TRIGGER IS THE OKTA NAVIGATION** (08-18's controlled comparison: three
  token-less renewals ten minutes apart, only the one that clicked through cost anything). No
  navigation, no ramp — so the drought is not bad luck around a live trigger, it is an absent one.
- **AND THE CAUSE IS THE HEALTHY REGIME, WHICH IS THE IRONY WORTH WRITING DOWN.** `planRenewal`
  stands down while the token is alive at all, and RC's SPA has been silently re-minting since
  ~04:32 — observed directly in the keep-warm's own keepalives, `renewed=no; src=live` with the
  token going **1m → 41m → 21m → 1m → 40m** across 06:29-07:49, two re-mints and zero renewals of
  ours. **The self-sustaining regime removes our Okta trips, and our Okta trips are the trigger.**
- **SO "WAIT FOR A RAMP" IS REALLY "WAIT FOR THE SELF-RENEWAL TO LAPSE".** What ends it is Okta's
  ABSOLUTE cap: once Okta is GONE the SPA cannot re-mint, the token dies, and our renewal resumes.
  The reported window is **rolling** (`okta_expires_at − okta_checked_at` = 12.0000h, refreshed by
  our own unconditional 20-minute probe), so the cap is invisible until the window stops rolling —
  which is exactly the signal the capture watch already fires on.
- **AND TODAY'S ONE SCHEDULED TRIP CANNOT HELP THE CURE EVEN IF IT RAMPS.** `maybeAutoLogin` at
  T−30 runs in a **throwaway tab** and the cure probes **`residentPage` only**, so a ramp there is
  invisible to it by construction and correctly so — `closeTabBounded`'s `finally` already reclaims
  that renderer. **The honest prediction for the day is therefore that the cure does not fire**,
  and that is a statement about the trigger rather than about the cure.
- **DO NOT READ THE QUIET AS THE CURE WORKING.** It has never fired; `wedge-recycle` events remain
  zero, all time. A cure that silences every other ramp instrument and a trigger that is switched
  off produce the same empty tables, which is why the discriminator is `bot_events` for a
  `tab-close` — **present and quiet is the SPA carrying the session; absent is nothing happening.**

#### AND THIRTEEN OKTA NAVIGATIONS SINCE THE BOX TOOK THE CURE HAVE PRODUCED ZERO RAMPS
Every `tab-close` since 2026-09-16 21:50:59 UTC, when the box took `e92a5a6`:
```
15 closes, 0 hung, 9-628 ms.  13 with a trip over 20s, i.e. a real Okta round trip:
  7 x renewal    68.6-69.6s   (09-16 21:52 → 22:43)
  5 x renewal    46.7-49.0s   (09-17 00:13 → 03:24)
  1 x auto-login 45.2s        (09-17 04:31)
```
- **COMMIT IS FLAT ACROSS THE 45.2-SECOND AUTO-LOGIN** — 7,064 → 7,201 → 7,046 MB either
  side of it. A ramp charges ~32 GiB in ≤34 s, so commit alone answers the question the
  blind `rc_mb` cannot: **that trip did not ramp.** Same for the twelve before it.
- **SO THE DROUGHT NOW SPANS ~25 HOURS AND AT LEAST 13 OKTA TRIPS**, on top of the 18 hours
  that preceded the cure reaching the box. **None of it is creditable to the cure** — the
  last ramp was 03:51:47 UTC on 09-16, eighteen hours before the box had the code.
- **`commit_used_mb` IS THE INSTRUMENT THAT STILL WORKS WHILE THE SCAN IS BLIND**, and it is
  what makes these thirteen readable at all. Read it, not `rc_mb`, on a blind day.

#### THE 04:31 AUTO-LOGIN WAS MY OWN `npm test`, AND IT IS THE SECOND OBSERVED INSTANCE
`maybeAutoLogin` acts only inside `AUTOLOGIN_LEAD_MIN` (30) of a real release, and the only
release on the books is **15:00 UTC** — ten and a half hours later. A live `npm test` run was
in flight at 04:31:56. That is the documented numeric-fixture trap:
`worker/health-hold-counts.test.mts:148` inserts `cartedHold(REAL, 5)` where `REAL = '0'`, a
`carted` row releasing five minutes out, and `'0'` satisfies `REAL_UNIT`'s `^[0-9]+$`.
- **IT DID NOT SPEND THE REAL HOLD'S LOGIN BUDGET, which is the alarming reading and is
  false.** `autologin-budget.mjs` is keyed on the RELEASE, and the fixture's release is a
  different one, so the two attempts protecting the 15:00 cart are untouched.
- **What it did spend is an unattended Okta password trip from the household address**, which
  is the reason the budget exists at all. Second sighting after 2026-09-10 17:53.

#### THE CURE'S THREE LEGS ARE MEASURED ON ONE PAGE NOW, WITH THE CONTROL THAT MATTERS (2026-09-17)
The cure's production case has never occurred, so **the transfer argument is what carries it** —
and its legs were measured on three different pages: `leak-repro.mjs` (a wedged page maps 2 MiB
shared regions and gives them back on close), `cdp-thread-probe.mjs` (a wedged page answers
`Performance.getMetrics` and NOT `Runtime.evaluate`), and ~2,400 healthy production probes.
The first two share a wedge construction and the joint claim followed **"by construction"**,
which is the reasoning this file has been burned by. `scripts/cure-end-to-end.mjs` measures all
three on ONE page in ONE run, through the SHIPPED exports:
```
healthy  : evaluate answered, probe alive/alive/alive, strikes 0, 0 mappings
wedged   : evaluate SILENT >2000ms, getMetrics answered   <- production's own signature
the cure : 3 strikes -> recycle, 243 -> 0 mappings in 520ms
```
- **THE SIGNATURE IS THE LOAD-BEARING HALF.** `Runtime.evaluate` silent while
  `Performance.getMetrics` answers is what production shows on Windows/149 — `alloc trail
  [resident]: EMPTY — that renderer answered no CDP call at all` over a whole 165-second browser
  life, taken by the heap trail, which samples `Performance.getMetrics`. So the page the cure
  was measured releasing mappings from is in the state the box's ramping renderer is in.
- **THE CONTROL ARM CAUGHT A REAL DEFECT IN THE SCRIPT'S OWN FIRST VERSION.**
  `probeResidentPage` takes a **NUMBER**; the first version passed `{ timeoutMs: 2000 }`, which
  coerces to ~0 — so every probe timed out instantly and read `wedged`, **on the healthy page
  too**. That run printed a confident pass and proved nothing whatever about the detector. **A
  healthy page must accrue NO strike**, and it is the FIRST refusal checked: a cure that fires
  on a responsive page costs an RC page load every thirty seconds and reads in the event stream
  exactly like the cure working.
- **THE REFUSAL WAS FIRED, NOT ASSUMED.** `CURE_PROBE_MS=1` reproduces that defect and exits 1
  quoting the healthy page's own readings. Four arms: a non-discriminating probe, a page never
  wedged, a decision that never reached `recycle`, and a count that never climbed.
- **AND READING THE EXIT CODE THROUGH A PIPE REPORTED 0 OVER A REFUSAL** — `… | tail -6; echo $?`
  is `tail`'s status. The recorded rule, paid for again in the same hour it was being applied.
  Redirect to a file.
- **PLATFORM, STATED IN THE HEADER: 141/Linux, memfd-backed, against 149/Windows,
  pagefile-backed.** What transfers is the MECHANISM — `kTotalMappedSizeLimit` and
  `kLargerDataPipeAllocationSize` are cross-platform, and **which PROCESS services a CDP domain
  is architectural**: `page.close` is `Target.closeTarget` to the BROWSER process, which is why
  it answers in 520 ms against a renderer that will not run a line of JavaScript, and why
  `page.reload()` on the same page hung past its own timeout. **Do not quote a byte count from
  here as a production figure.**
- **`cdp-thread-probe.mjs` WAS NEVER IN THE PROBE-ROT GUARD** — measured and written up the same
  day, and the guard's list stopped at five. Both it and the new script are in it now, with both
  mutations (a probe removed, the import "fixed" to bare `playwright`) verified caught.

**SO WHAT IS AND IS NOT PROVEN, STATED PLAINLY.** The mechanism is proven with controls both
ways. The detector is proven live on the box (~2,400 probes, **no run of three** — see the
correction under that entry: individual `wedged` readings were never counted and are now) and its
wedge-silence half is corroborated by production's own alloc trail. The release half rests on
the browser-process/renderer split, which is architectural, plus 430 healthy Windows closes
showing that call path is sound there. **What remains unproven is a single end-to-end firing in
production — and that needs a wedge, and wedges have been absent for 25+ hours across at least
13 Okta navigations.** The cure cannot be credited with that absence: the last ramp was eighteen
hours before the box had the code.

#### THE OLD-BROWSER POPULATION IS STILL RUNNING, AND ITS AGE BAND IS 52-611 MINUTES (2026-09-17)
The burst population's disappearance is recorded; the other one's cadence never was, and it is
what decides whether waiting is worth anything. Every `bail:ramp` on record, split on `ageMs`:
```
OLD browser (distinct 76-79, busiest path 3-24 lifetime requests)   8 ramps
  09-06 03:29  124.6 min     09-11 05:30  610.8 min     09-15 15:16  372.2 min
  09-08 03:42   85.4 min     09-12 15:26  383.0 min     09-16 03:52   52.0 min
  09-10 17:53   57.5 min     09-14 16:00  253.0 min
BURST (distinct 16, busiest path 16,583-80,244)                    18 ramps
  ... 09-13 06:44, 09-14 09:04, 09-14 11:47, 09-15 09:04  <- and then nothing
```
- **THE OLD POPULATION FIRES ABOUT ONCE EVERY 1-2 DAYS AND THE LAST WAS 09-16 03:52** — which
  is also **the last ramp of any kind**, 25 hours ago. So one is due, and the thing that has
  actually stopped is the burst half.
- **THE AGE BAND IS 52 TO 611 MINUTES, median ~190.** A browser younger than that has never
  produced one; a browser is inside it for about ten hours.
- **SO EVERY `restart-rc` RESETS THE ONLY CLOCK THAT CAN STILL FIRE.** The recorded reasoning
  for stopping the campaign was that it targeted the absent population; the numbers say it did
  something worse — the restart puts the browser back to age zero, which is the one age at which
  the surviving population never fires. **Five forced restarts is five times the clock was
  reset.** Leaving the box alone is not passive here; it is the experiment.
- **THE CURRENT BROWSER STARTED AT OR AFTER 04:29:26** (`restart-rc (#428)` — a kill leaves no
  teardown, so there is no `ageMs` to read and the start time comes from the command log). It
  enters the band at **~05:21 UTC** and is inside it through the hold's **14:30 UTC** T−30
  auto-login, which is itself an Okta navigation on a ~10-hour-old browser — the 09-11 611-minute
  ramp's exact profile.
- **READ `commit_used_mb`, NOT `rc_mb`, WHILE THE SCAN IS BLIND.** Baseline is ~7,040 MB of
  43,774; a ramp charges ~32 GiB in ≤34 s and takes it to 35-47 GB. `rc_mb` has been NULL since
  04:15:30 and cannot see one.

#### THE CURE'S REOPEN DOES NOT WORK THE WAY ITS OWN HEADER SAYS, AND THE REAL MECHANISM IS BORROWED (2026-09-17)
`recycleWedgedPage` closes the page "precisely so that whatever the loop awaits rejects with
`Target closed` and the existing reopen path runs". **Read against the loop, that mechanism does
not exist** — and the reopen is guaranteed by something better, written months earlier for an
unrelated reason.
- **EVERY PAGE-TOUCHING AWAIT IN THE RESIDENT LOOP IS INDIVIDUALLY `.catch()`ED** —
  `readLiveToken`, `maybeAutoLogin`, `maybeWarmupLogin`, `maybeRehearse`, `oktaSessionAlive` and
  `checkAndReport` all swallow and continue — and **a page close leaves the CONTEXT untouched**,
  so nothing propagates out of the loop at all.
- **WHAT REOPENS IS AN EXPLICIT CHECK AT THE TOP OF A 1-SECOND LOOP:**
  ```js
  if (!ctx.pages().length || page.isClosed()) { log('⚠ the RC window was closed — reopening it'); break; }
  ```
  `break` → the `finally` (`ctx.close()`, `clearInterval(renew)`) → `warmResident`'s OUTER
  `for (;;)` relaunches. **Reopen latency is ~1 second plus whatever await was in flight**, and
  it is bounded on every path: an in-flight `renewSession` on a throwaway tab is 45-70 s, and an
  unbounded await on the wedged page rejects at the close and lands in the outer `catch`, which
  reaches the same `finally`. Every route ends in a relaunch.
- **AND WITHOUT THAT CHECK THE CURE WOULD BE A ZOMBIE-MAKER, WHICH IS THE PART TO KEEP.**
  `probeResidentPage` returns `inconclusive` on a closed page (`page.isClosed()`), so **no strike
  accrues and the cure cannot re-fire**; the loop keeps advancing, so **`HUNG_MS` cannot fire
  either**. The keep-warm would spin for ever against a dead page with no session — strictly
  worse than the wedge it replaced, and nothing anywhere would say so.
- **SO A LINE WRITTEN FOR "somebody tidying up closed the visible window" IS NOW LOAD-BEARING
  FOR A FEATURE IT PREDATES.** That is the shape this file records more than any other, and it
  is pinned now rather than left to be re-derived: `src/lib/page-wedge.test.mts` asserts the
  check exists, that it BREAKS rather than continues (a `continue` is the zombie with an extra
  keyword), and that it sits AHEAD of the caught awaits — below them it still works, but
  `readLiveToken` would fail a full iteration first and `checkAndReport` reports that as a dead
  SESSION. A second guard pins the premise — that those awaits DO swallow — so the two cannot
  drift apart and quietly make the reasoning wrong.
- Three mutations, each verified to apply and to fail: the `isClosed()` test deleted, `break`
  turned into `continue`, and `checkAndReport` made to propagate.
- **I NEARLY FILED THE OPPOSITE FINDING.** Reading the caught awaits first, the obvious
  conclusion is that the cure strands the keep-warm — which would have been reported as a
  release-critical defect in the thing under test. The explicit check is forty lines below where
  the reading stopped. **Trace to the loop's own top before concluding a close cannot be seen.**

#### "THE OLD POPULATION HAS NO BURST" IS A CLAIM ABOUT THE RESIDENT PAGE, NOT THE RENDERER (2026-09-17)
The `bail:ramp` counters were read for `distinct` and `ageMs` and never for `recentTotal`, which
is the field that changes what the other two mean. All eight old-browser ramps:
```
09-16 03:52  age 52.0m   distinct=76  recent=4  lifetime=95
09-15 15:16  age 372.2m  distinct=79  recent=0  lifetime=168
09-14 16:00  age 253.0m  distinct=79  recent=0  lifetime=170
09-12 15:26  age 383.0m  distinct=79  recent=0  lifetime=175
09-11 05:30  age 610.8m  distinct=79  recent=0  lifetime=196
09-10 17:53  age  57.5m  distinct=78  recent=0  lifetime=185
09-08 03:42  age  85.4m  distinct=78  recent=0  lifetime=110
09-06 03:29  age 124.6m  distinct=79  recent=0  lifetime=109
```
- **SEVEN OF EIGHT MADE ZERO REQUESTS IN THE 120 SECONDS BEFORE THE BAIL**, and 95-196 across a
  browser life of 52-611 minutes — about one request every two to six minutes. **The resident
  page is IDLE when this population ramps.**
- **BUT THE COUNTER IS ATTACHED TO THE RESIDENT PAGE ONLY** (`requestCounter.attach(page)`), and
  every Okta trip runs in a **throwaway tab** — which, because `signin.reservecalifornia.com`
  and `www.reservecalifornia.com` share an eTLD+1, is **the same renderer process**. So the
  traffic that could drive a promise-rejection storm in the renderer that ramps is **exactly the
  traffic this counter cannot see.**
- **SO THE DECOUPLING'S OLD-POPULATION LEG IS WEAKER THAN RECORDED.** "A busiest path of 3-24
  lifetime requests" is not "this ramp had no burst" — it is "no burst **on the resident
  page**", and the renderer's own traffic is unmeasured. The decoupling's other leg is
  untouched: young ramps carry 16k-80k requests on one path and produce the same 32 GiB as
  events whose counters are flat, which is a statement about the same instrument on both sides.
  **Do not quote the old-population leg as independent evidence.**
- **AND `distinct` IS NOT AN INDEPENDENT AXIS — it is a proxy for age.** A cold load touches 16
  paths; a browser that has been up for hours of keepalive checks has touched 76-79. The two
  populations were described as separating on `ageMs` AND `distinct` with nothing off-diagonal;
  those are one axis read twice. **The BURST is the discriminating fact.**
- **IT ALSO SHARPENS WHY 14:30 IS THE SHOT.** The old population ramps on an idle resident page
  in a browser 52-611 minutes old — which is a renderer doing nothing until a tab navigates
  through Okta in it. The hold's T−30 auto-login is exactly that, on a browser that will be
  ~10 hours old.
- **CLOSING THE BLIND SPOT IS `context.on('request')` RATHER THAN `page.on('request')`** — a
  context event covers every page in it, which is the recorded one-line fix for the same gap in
  the leak's own accounting. **NOT DONE**: it is bot-side, so it needs a box update, and an
  update resets the browser age that is currently the experiment.

#### THE REGION WALK IS THE MOST EXPENSIVE INSTRUMENT HERE AND ITS OUTPUT IS STORED NOWHERE (2026-09-17)
Reading all eight old-browser ramps' stacks was one query away and returned nothing, and the
reason is not that the walk did not run. **`bot_events`' `ramp-scan` detail stores
`vmwalk: true` — a four-character BOOLEAN saying the walk completed** — beside `rcMb`, `maxPid`,
`maxType`, `trigger`, `complete`, `ramFreeMb` and the three thresholds. **There is no text
field, on any of the 29 stored scans, and no sibling table**: `bot_events` has exactly four
kinds (`tab-close` 433, `request-counts` 147, `mem-dump` 77, `ramp-scan` 29).
- **SO EVERY WALK FINDING IN THIS FILE CAME FROM A LIVE `tail-log`** — the 16,385 regions, the
  allocation-base count, the protection histogram, the anonymous name census with its
  file-backed control, `VMTHREAD`'s spinning main thread, `VMSTACK`'s `chrome.dll+0x18096c6`,
  `VMSPAN`. Each was read by somebody who happened to be looking within the window before
  `tail-log`'s 16,000 characters rolled.
- **AND THE ONES NOBODY WATCHED ARE GONE FOR EVER.** Eight old-browser ramps happened; **two**
  have a recorded stack, and they disagree (JIT-dominant at 57.5 min, `HandlerAdded`-dominant at
  611 min). That is precisely why the age split is labelled a LABEL rather than an established
  variable — **and the other six readings existed and were not kept.** The question cannot be
  settled from stored data at any point in the future.
- **IT IS EXACTLY THE FAILURE PR #169 FIXED FOR THE ALLOC READINGS AND NEVER FOR THE WALK.**
  That change moved attributions into Postgres because *"the 2026-08-23 ramp attributions were
  lost to a 16,000-character `tail-log` window"*. The walk spawns PowerShell, compiles C# and
  sweeps a whole address space — the costliest thing this investigation does — and it reports
  into the one place that cannot keep it.
- **THE FIX IS THE SHAPE ALREADY IN THE FILE**: store the walk's text on the `ramp-scan` event,
  capped and NUL-stripped like every other `bot_events` detail. **NOT DONE** — it is bot-side, so
  it needs a box update, and an update resets the browser age that is currently the experiment.
  **Do it in the same update as `context.on('request')`**, which closes the counter's own blind
  spot and has the identical cost.
- **UNTIL THEN, READ `tail-log rc-keepwarm` WITHIN MINUTES OF A `ramp-scan` EVENT.** A
  `ramp-scan` row in `bot_events` is a receipt that a reading existed, not the reading.

#### THE BOX'S `wedge-recycle` EVENT IS NEARLY EMPTY, AND THE LOG THAT CARRIES THE PROOF ROLLS IN 20 MINUTES (2026-09-17)

The arm's reachability is now traced rather than argued from the sha. In the box's own
`6fc7292` source the probe sits at code line 2240 of the watchdog timer, **between the 90 s
stall trigger and `HUNG_MS`**, gated on nothing but
`!bailing && !wedge.inFlight && now - lastProbe >= WEDGE_PROBE_EVERY_MS` — no `return` at the
timer's statement level precedes it, and it is **above** the `let memory` block at 2293, which
is the second confirmation that the blind scan cannot reach it. The import is at line 104, so
the module loads or `rc-keepwarm.mjs` does not start at all, and the process is beating. **The
fix-present-and-inert check passes**, by three independent routes.

**WHAT THE TRACE ALSO FOUND IS THAT THE FIRING WILL BARELY SPEAK FOR ITSELF.** The box emits:

```js
void reportBotEvent('request-counts', requestCounter.snapshot({ reason: 'wedge-recycle' }));
```

**The request counts and the reason. Nothing else.** `closeMs`, `tokenKept`, `strikes` and the
three memory fields are in the version this session wrote and are NOT on the box — deliberately,
because a box update resets the browser's clock to zero and the surviving ramp population's band
starts at 52 minutes. So the durable record of the first firing is a bare counter snapshot, and
**everything that says the cure WORKED — the `♻` line, `token on the way out`, `closed the wedged
page in Nms`, and the absence of a `✗ RAMP`/`✗ WEDGED` beneath it — exists only in
`logs\rc-keepwarm.log`.**

- **AND THAT LOG ROLLS IN ABOUT TWENTY MINUTES, MEASURED.** `tail-log` returns the last 16,000
  characters, and the keep-warm prints **two stand-down lines every 60 seconds**
  (`auto-login stood down: the release is Nm away…` and `warm-up stood down: …`), which is
  ~150 chars/minute of pure repetition. A 60-line read at 05:25 reached back to **04:57** — 28
  minutes, and that window is mostly the two repeating lines. **PR #358's skip dedupe is the fix
  and it is bot-side**, so it buys nothing until the box updates, which is the thing being
  deliberately avoided.

###### AND THE WINDOW WAS NEVER 16,000 CHARACTERS — IT IS EIGHTY LINES, AND `:400` IS FREE (2026-09-17)
Eight places in this file say `tail-log` "rolls at 16,000 characters", including the entry
directly above. **Read in `bot-commands.mjs` rather than remembered: the handler slices
`DEFAULT_TAIL = 80` LINES first, and `MAX_OUTPUT = 16_000` is a SECOND cap applied after.** The
binding constraint on every log reading this repo has ever taken is the line count, and the
argument accepts an override — `tail-log <name>:<n>`, `Math.min(400, …)` — that **nothing has
ever passed.**
- **MEASURED THE SAME MINUTE, BOTH WAYS.** `tail-log rc-keepwarm` returned 07:19:07 → 07:57:32
  (**38 minutes**); `tail-log rc-keepwarm:400` returned 06:29:30 → 07:58:32 (**89 minutes**, 188
  lines, truncated by `MAX_OUTPUT`). **One colon is 2.4x the evidence**, and it needs no box
  update — the parsing has been on the box since the command was written.
- **THE SIGNAL-TO-NOISE IS 5 IN 188.** Across those 89 minutes exactly five lines carry
  information, all of them the 20-minute keepalive; the other 183 are the two stand-down lines.
  **So the ceiling with `:400` is ~89 minutes of wall clock and ~5 useful lines** — which is why
  #358's dedupe is still the real fix rather than a tidy-up: it does not widen the window, it
  raises what the window CONTAINS, and at this ratio that is the difference between 89 minutes
  and days.
- **THE ENTRY ABOVE CONTAINS ITS OWN REFUTATION AND IT WAS READ PAST.** *"A 60-line read at 05:25
  reached back to 04:57"* — somebody passed a LINE COUNT, watched it decide the window, and wrote
  the constraint up as characters in the same sentence. Same shape as unit 45719 and the
  duplicate-facility story, in a paragraph six lines long.
- **WHAT IT COST: one wrong conclusion, immediately.** A default read at 07:56 showed the log
  starting at 07:19 and was about to be written up as *the keep-warm restarted at 07:19 and
  truncated its log* — a `Tee-Object` theory with a plausible mechanism, a plausible consequence
  (the current browser is 38 minutes old, not 3.5 hours, so it is OUTSIDE the old-browser band)
  and no truth in it whatever. **Reading the handler is what stopped it.**
- **THE CAPTURE WATCH ASKS FOR `:400` NOW.** Nothing else in the repo calls `tail-log`
  programmatically, so that is the whole blast radius.
- **SO THE CAPTURE MONITOR IS LOAD-BEARING, NOT A CONVENIENCE.** It polls `bot_events` every
  90 s and pulls `tail-log rc-keepwarm` the moment a `wedge-recycle` or a ramp appears. 90 s of
  detection plus a bot-ask round trip is ~2.5 minutes against a 20-minute window — comfortable,
  and it is the only thing standing between a firing and a firing nobody can read.
- **THE TRADE WAS TAKEN DELIBERATELY AND IS WORTH RESTATING.** Updating the box would put all
  six fields into Postgres where nothing can roll them — and would cost the RC session plus the
  52 minutes the browser has already aged into the band. At one ramp every 6-26 hours the update
  is cheap in expectation and the reading is better; what decides it the other way is that the
  monitor already closes the gap, and the session is release-critical with a real user hold at
  15:00 UTC. **If the monitor ever dies, that calculus inverts** — re-arm it or update the box.

**AND THE DROUGHT IS AT THE LONG END OF ITS OWN DISTRIBUTION.** Commit ramps over 15 GB:
09-15 09:03, 09-15 15:16 (+6.2 h), 09-16 03:51 (+12.6 h), then nothing for **25.6 hours**. The
observed gap range is 6-26 h, so this is the tail rather than a new regime — **do not write the
drought up as the cure working; the cure has never fired.**


#### THE DROUGHT IS THE SILENT SELF-SUSTAINING REGIME, AND FORCING IS NOT AVAILABLE TO ME (2026-09-17)

The cure has still never fired, and the reason is now read off three instruments rather than
guessed. **26.1 hours since the last ramp, against an observed gap range of 2.3-18.6 h** — so
the drought is past the recorded maximum and wanted an explanation. (That range is the
four-day recount at the 1,500 MB onset bar; the entry above quotes 6-26 h at the 15 GB commit
bar over a shorter window. **They are different bars, not a contradiction** — quote the bar.)

**THE FIRST CANDIDATE — "no Okta trip, therefore no trigger" — IS HALF RIGHT AND THE HALF THAT
IS WRONG IS THE ONE I NEARLY PUBLISHED.** `bot_events` carries **33 `tab-close` events in 30
hours**, so trips have been firing constantly. What it also carries is where they stop:
```
09-16 17:39 -> 22:43   ELEVEN trips, every one 68.3-69.6s
09-17 00:13 -> 04:31   EIGHT trips, 11.4 / 11.5 / 45.2 / 46.7 / 46.9 / 48.6 / 48.6 / 49s
09-17 04:31 -> now     NOTHING, 1.5 hours
```
- **THE 21-SECOND STEP-DOWN IS NOW WELL SAMPLED** — eleven trips at ~69 s, a clean break, then
  eight at <=49 s. That entry was one observation and is now nineteen. **Duration and cost track
  each other seven for seven**, so a regime of 47-49 s trips is a regime of cheap trips.
- **AND EVEN THE 69 s BAND DID NOT RAMP.** It ran 17:39-22:43 on 09-16 with nothing. The last
  ramp predates all nineteen.
- **THE SILENCE SINCE 04:31 IS THE SELF-SUSTAINING REGIME, READ IN THE KEEP-WARM'S OWN LOG:**
  `token exp in 2m` at 05:29:26 and `token exp in 41m` at 05:49:26 with **`renewed=no`** —
  the SPA re-minted it, unaided. `planRenewal` stands down while a token is alive, so there is
  no Okta trip to be the trigger. **That regime has been measured to run TEN HOURS.**

**SO WAITING IS WAITING FOR A REGIME TO END, AND THE OLD-BAND EXPERIMENT HAS ALREADY BEEN RUN
AND LOST — TWICE, OVERNIGHT.** `request-counts` carries `ageMs` at every graceful teardown:
```
09-16 03:00:46  teardown    browser lived 704.2 min   <- no ramp
09-16 22:49:07  teardown    browser lived   7.1 min
```
**704 minutes is the longest browser life on record and it produced nothing**, and hourly peak
commit has been **7,200-7,800 MB for 26 straight hours** with one 45,175 spike at 09-16 03:00.
So "let a browser age into the 52-611 minute band" is not an experiment waiting to run; it is
an experiment that ran to the top of the band and failed.

**AND THE ONE LEVER LEFT IS NOT AVAILABLE IN THIS SESSION.** `restart-rc` — 2-for-4, cheap, no
campsite, no password, and the recipe whose cold RC home-page load IS the young-population shape
— is refused by the harness as *Interfere With Workloads*. It is a permission denial, not a
technical failure, and it is not to be worked around. **So a session with no human present
cannot force a ramp at all**, and the honest state is that the cure's production proof waits on
an event nobody here can produce.
- **`test-login` IS NOT A SUBSTITUTE, and it is the tempting one.** It navigates on the RESIDENT
  renderer, which is the right renderer — and with Okta ALIVE it is answered from the cookie in
  **eleven seconds**, which is the cheap cell and has never ramped. `window_h` read **11.9997**
  all session, i.e. the ROLLING window our own probe refreshes, so the expensive cell is not
  reachable either.

**THE BLIND SCAN MAKES THIS THE CLEANEST TEST BED THE BOX WILL EVER BE, WHICH IS AN ARGUMENT
FOR SPENDING AN EVENT RATHER THAN SAVING ONE.** `rc_mb` has been NULL since 04:15:31, so
`readLatestMemory` returns `known: false` and **the ramp arm and both memory dumps are
disabled** — the cure is first in the timer and uncontested, with only `HUNG_MS` behind it at
twelve minutes. That state is not durable (it cleared for one sample already), so a ramp
arriving while it holds is worth more than one arriving later.
- **IT CLEARED AT 09:41:11 UTC AND THE WINDOW IS SHUT (2026-09-17).** So the ramp arm,
  `ramp-scan`, the region walk and the baseline memory dump are all **re-enabled** — the 11:39:47
  `mem-dump (baseline) in 314ms` is that working. **Do not plan around the clean test bed**; it
  lasted about five hours and nobody established what ended it, exactly as nobody established
  what started it.
  - **AND I FIRST DATED IT 10:33, WHICH IS THE THREE-STATE TRAP THIS FILE RECORDS, COMMITTED BY
    SOMEBODY READING THE ENTRY THAT RECORDS IT.** 09:41:11 is the first sample with a real
    reading; it reads **`rc_mb=0 procs=0`**, which is the `C|` count saying *"the scan RAN and
    found none of ours"* — true, because the old browser was already gone. 10:33 is merely the
    first sample with a browser to count. **`NULL` = we could not look; `0` = we looked and there
    was nothing; a number = we looked and here it is.** Reading the recovery off the first
    non-zero row dates it three quarters of an hour late and silently discards the one sample
    that proves the instrument came back before the subject did.
  - The run was not unbroken either: one lone `rc_mb=0 procs=0` at **04:27:32** sits between two
    NULL stretches (04:15:31 and 04:29:32). **A blind scan that recovers for one tick and goes
    blind again is not the same as a steady outage**, and nothing explains either edge.

#### AND A `Monitor` CANNOT CARRY A LOAD-BEARING WATCH — IT EXPIRES AT 30 MINUTES BY CONSTRUCTION
This file recorded, hours earlier and in my own words, that *"the capture monitor is
load-bearing, not a convenience"* and that *"if the monitor ever dies, that calculus inverts"*.
**The monitor then died on schedule** — `Monitor expired after 30m with no events delivered` —
because **`timeout_ms` is capped at 1,800,000 ms**. So a watch built that way is guaranteed to
lapse repeatedly, and every re-arm leaves a gap in which a firing can land and its log can roll.
- **THE RIGHT SHAPE IS A BACKGROUND BASH TASK WITH A TERMINATING CONDITION**, which has no cap
  and exits exactly once when it has something to say. The watch script already exits on each of
  its terminal signals, so it was a `Monitor` only by habit.
  - **VINDICATED THE SAME DAY: a background bash task caught the 12:00 CAPTCHA.** It slept to two
    fixed wall-clock times, pulled `tail-log rc-keepwarm:400` and the surrounding `bot_events`
    rows, and completed — so the day's most consequential reading survived a session restart that
    had already killed one `Monitor`. **The evidence path held because the watch had no timeout to
    expire.**
- **THE COST OF GETTING THIS WRONG IS THE WHOLE EVIDENCE PATH**, because the box's
  `wedge-recycle` event carries only the request counts and the log rolls in ~31 minutes
  (measured again today: a 70-line read at 06:00 reached back to 05:29, and all but four lines
  of it were the two stand-down lines PR #358 exists to dedupe).

### THE COMMIT RESIDUAL: THE PAGEFILE TRACKS, AND OPTION B IS OFF (2026-09-11)

The four options under "THE RESIDUAL IS COMMIT" turn on one precondition — **is 665 MB of spare
PRESSURE or TRACKING?** Settled from `chromium_memory_samples` alone, and the answer is
**TRACKING**, decisively enough to retire option B.

- **THE LIMIT GROWS ON ESSENTIALLY EVERY SAMPLE OF EVERY BURST AND NEVER ONCE STALLS WHILE USED
  CLIMBS.** Traced at sample resolution over four events; the shape is the same every time:
  ```
  09-10 04:23:08   used  7,108   limit 17,150   head 10,042
  09-10 04:25:09   used 38,596   limit 39,810   head  1,214   <- limit GREW
  09-10 04:26:09   used 40,175   limit 40,840   head    665   <- limit GREW
  09-10 04:26:45   used 40,882   limit 41,871   head    989   <- limit GREW
  ```
  The two "limit FLAT" samples in the whole corpus (08-31 04:17:35, 09-04 22:27:46) both still
  had positive headroom and the limit grew again on the next sample.
- **THE FASTEST GROWTH IS +30,902 MB IN 33 SECONDS (55,650 MB/min), FINISHING 1,456 MB AHEAD** —
  and three separate events show ~28-31 GB inside a single ~33 s sample interval, each ending
  1,000-1,456 MB ahead. **The burst is <=34 s. Windows keeps pace with exactly that, measured.**
  So the handover's *"if growth ever fails to keep pace with a <=34-second burst, that IS the
  2026-08-12 failure"* has its answer: it does not fail, on any recorded event.
- **SO THE 665 MB IS THE LEAD WINDOWS KEEPS WHILE GROWING, NOT THE DISTANCE TO A WALL.** The real
  margin is to the pagefile's own maximum — and **that maximum is not readable here at all**:
  `Win32_PageFileSetting` has no rows when system-managed, which is why `bot-ask memory` has a
  branch for it. The documented rule is 3x RAM, which on 15.7 GB would put the ceiling near
  62.8 GB against a peak used of 46,807 — **inference, not a measurement; do not quote it as one.**
- **AND THE LIMIT HAS REACHED 60,432 MB, not the 47.9 GB every earlier entry lists.** The
  handover's four limits (36.7 / 39.8 / 45.5 / 47.9 GB) are a slice of a range that runs to 59 GiB.
  Quoting the top of a sampled range as the top of the range is how the margin looked thin.
- **THE INSTRUMENT'S OWN SENTENCE ASSERTED THE REFUTED MECHANISM, AND IT IS THE EXPENSIVE ONE.**
  `bot-ask memory` printed *"system managed (Windows grows it lazily, which is what loses a
  burst)"* — a mechanism written into the diagnostic, contradicted by the series it sits beside,
  **and the single sentence most likely to send somebody to `fix-pagefile.ps1 -Apply`, which costs
  a REBOOT and with it the RC session.** Corrected in `bot-commands.mjs` with the measurement.
  Same family as the tidy-story-as-fact failures this file records; this one was in the tool.

#### AND WINDOWS HAS ALREADY DONE OPTION B BY ITSELF — THE PAGEFILE SETTLED (2026-09-11)
**Since 2026-09-10 12:40 UTC the commit limit has been a CONSTANT 47,870 MB across 913 samples**
— one distinct value, no oscillation, no shrink-back — where before it swung between 17,150 idle
and 55,788 during a burst, several times a day.
- **So the pagefile now sits at 31 GB permanently and a burst needs NO growth at all.** Idle
  headroom is **40,902 MB** instead of 10,042, and the two ramps since the settle ran at
  1,063 MB and 6,182 MB of spare without the limit moving once.
- **That is precisely what a fixed pre-allocated pagefile would buy, delivered for free and
  without a reboot.** It is the second independent reason B is off.
- **WHY IT SETTLED IS NOT ESTABLISHED — do not write a mechanism in.** What matters is the
  consequence: **it is NOT durable.** A reboot resets the pagefile to its small initial size and
  the oscillation resumes, so this is a reason not to spend a reboot rather than a permanent fix.

#### THE BAIL ARM HAS A COMMIT TRIGGER NOW (option A) — and what it CANNOT do
`writeLatestMemory` dropped `commitUsedMb`/`commitLimitMb`, which `memory-sample.mjs` had
computed all along — so the bail arm, in a different process whose timer must never spawn
PowerShell, had no way to see the one figure that moves during the burst. Two fields through the
file, one condition, one log line.
- **BACKTESTED OVER THE 19 ONSETS IN THE SEVEN DAYS TO 09-11: earlier on 11 of them by a median
  77 s (max 162 s), NEVER later, taking a median 1,984 MB off the peak commit (max 7,009).** On
  the 48 h to 09-11 it caps the peak at 44,354 MB instead of 46,807, i.e. the tightest headroom
  against the settled 47,870 limit goes **1,063 -> 3,516 MB**. That independently reproduces
  `ramp-scan.mjs`'s own recorded backtest of the same bar ("earlier on 11 of them by 60-162 s,
  never later"), from a different direction.
- **THE BAR IS IMPORTED, NEVER COPIED.** `RAMP_SCAN_COMMIT_MB` (9000) is already backtested over
  6,266 samples — median commit 7,213 MB, only THREE between 9,000 and 12,000 — and the two arms
  must not disagree about which EVENT they see, the rule that already pins `RAMP_SCAN_MB` and
  `RAMP_MB` equal. `ramp-scan.mjs` has no top-level side effects, so importing it starts nothing.
  A guard fails if `rc-keepwarm` grows a commit bar of its own.
- **WHAT IT CANNOT DO, AND THE HONEST HEADLINE: at the sample where it first fires, commit is
  ALREADY 35,794-48,444 MB — the mapping is complete.** The full ~32 GiB step is present at the
  FIRST elevated sample on every event, while `rc_mb` is still 1,688-3,452. **Nothing that reads
  a file another process writes every two minutes can ever catch the burst.** A is one sampler
  tick less of the private-byte tail, and that is all it is.
- **BOTH-CONDITIONS SURVIVES, AND THE STALL IS WHAT MAKES A WHOLE-BOX FIGURE SAFE TO ACT ON.**
  Commit is shared with the owner's own desktop, so commit alone could be about something that is
  not Chromium — but across 133 recorded tab-closes the longest trip is 71,552 ms and not one
  exceeds 90,000, so a 120-second stall is very nearly diagnostic of a ramp by itself.
- **ABSENT IS UNKNOWN AND MUST NOT FIRE.** A box on an older build writes no commit field, and
  the negated form `!(commit < bar)` would fire on EVERY tick of one — the trap `ramp-scan.mjs`
  names at its own commit trigger. Defended twice (the writer normalises to null, and JSON cannot
  carry a NaN), which is why the naive mutations SURVIVE and the two that remove either defence
  are caught. **A surviving mutation is not always a weak guard; check whether a second defence
  is what absorbed it.**
- **THE DUMP PATH IS UNTOUCHED, checked rather than assumed.** The 90 s stall trigger already
  forces `maybeMemoryDump(null, 'ramp')` before every arm, and the bail needs 120 s — so the dump
  is always requested first and a second bar on the bail cannot race it.
- **EXERCISED OFF-BOX, WITH NO RAMP.** `ramp-arm-probe.mjs` replays the real 09-10 04:25:09
  reading (rc 2,366 under the bar, commit 38,596 over it) against a real Chromium and asserts the
  trigger, plus the older-box case. Nine mutations, each verified to APPLY and to fail.

##### AND THE PROBE'S `fail()` DID NOT FAIL — three real breaks reported as exit 0 (2026-09-17)
The commit-bar ungating (`readLatestMemory` carrying commit on the rc-blind branch) had one
untested link: the **real writer into the real reader into the real decision, on the blind
shape**. Scenario 1c drives it, and three mutations that genuinely break that chain were each
**detected, printed with the correct diagnosis, and reported as `exit 0`**.
```
let verdict = 1;
const fail = (msg) => { console.log(`x ${msg}`); };   <- logs; records NOTHING
...
verdict = ok ? 0 : 1;                                  <- reads a flag `fail` never sets
```
- **HALF THE ARMS SET `ok = false` BESIDE THEIR `fail()` AND HALF DID NOT**, so the file's
  correctness depended on every future arm remembering a second statement. Scenario 1b — the
  commit bar's own guards — was one of the halves that did not. **Fixed as a CLASS**: `fail()`
  sets its own flag and the verdict reads it. Fixing the instances would have left the next arm
  exposed, which is exactly how this one got in.
- **IT IS THE HOUSE SHAPE INSIDE THE INSTRUMENT BUILT TO ESCAPE IT.** `ramp-arm-probe.mjs`
  exists because the trigger path was only ever tested by waiting for a ramp; a probe that
  cannot fail a build is the same defect one level up — it runs, it reports, and a green proves
  nothing. **Same family as `status = 'sent'` meaning only "Twilio returned 2xx".**
- **THE TELL IS AVAILABLE AND CHEAP: read the EXIT CODE, not the output.** Every one of those
  three runs printed `x the blind chain did not fire ...` followed by `x THE TRIGGER PATH DOES
  NOT HOLD` — the diagnosis was perfect and the status code said pass. **A mutation harness that
  greps for a failure STRING would have caught it and one that reads `$?` would not**, which is
  the opposite of the usual advice and is why the guard pins the pairing rather than the output.
- `worker/rc-mem-dump.test.mts` pins `fail()` recording, the verdict reading what it records,
  and the flag starting clean — three mutations, each verified to APPLY and to fail. It is
  structural because **the defect is invisible from a passing run**: a probe with a broken
  `fail()` and a probe with nothing to report write the identical output.
- **AND THE HARNESS DESTROYED THE FIX MID-RUN, FOR THE SEVENTH RECORDED TIME.** `git checkout --`
  after the first mutation reverted the still-uncommitted `fail()` repair, so the next two
  reported `!! ANCHOR NOT FOUND` against a file that no longer contained the code under test.
  **Commit before mutating** — written down five times in this file, read this session, and
  broken by the person reading it.

- **`tsconfig.worker.json` CAUGHT WHAT THE SUITE COULD NOT.** The JSDoc `@returns` on
  `readLatestMemory`/`rampBailDecision` is what TypeScript reads, so the new fields were invisible
  to the type checker until it was updated — eight errors the tests were perfectly happy with.
- **IT COSTS NO FORCED BOX UPDATE, WHICH IS MOST OF WHY IT WAS WORTH DOING.** It is bot-side, so
  it arms `CH_BOT_CODE_AT` and the `autocart.bot_version` warn — **and the box updates itself in
  the 02:00-05:00 PT quiet window**, which is how it took `a68a6d2` overnight on 09-11. So this
  lands free and **no RC session is spent**. Do not press "Update now" for it; confirm arrival
  with `bot-ask git-status`, never `autocart.bot_version`.

#### THE REAL LEVER IS THE NUMBER OF OKTA TRIPS, AND IT IS ARITHMETIC (2026-09-11)
A is aftermath. What actually decides how often the box takes a 32 GiB commit charge is how often
we navigate to Okta, and that is measured:

    renewal trips        229 over 164.6h = 33.4/day
    gap bands            backoff(30m) 123 · minGap(10m) 69 · alive(~60m) 7 · other 29
    failure-band gaps    192 of 228 = 84%
    onsets               18 over the same window = 2.62/day
    RAMP RATE            18 onsets / 229 trips = 1 in 12.7

- **EACH SUCCESSFUL REPAIR COSTS ABOUT 2.6 RAMPS.** 229 attempts bought **7** successes, so a
  repair costs ~33 attempts, and 12.7 attempts cost one 32 GiB burst. That is the trade, stated
  as a ratio rather than as a feeling.
- **THE BACKOFF IS FLAT AND NEVER ESCALATES.** `RENEW_BACKOFF_GAP_MS` is 30 min after 3 failures
  and stays 30 min for ever, so a persistent failure — which is what it is, by the module's own
  comment: *"when that cookie is gone every attempt will fail identically"* — is retried ~28
  times a day indefinitely. Escalating 30 -> 60 -> 120 -> 240 takes that to **10/day**, i.e.
  total trips 33.4 -> ~15/day and ramps **2.62 -> ~1.2/day**.
- ~~**NOT BUILT, AND IT IS NOT A DRIVE-BY.**~~ **BUILT AND MERGED 2026-09-20 (PR #371, `f6e74c4`).**
  Struck rather than deleted: "not built" on the one lever this entry identifies is exactly the
  sentence a later reader quotes as a task. The reasoning for the caution still stands and was
  obeyed — `planRenewal` is bot-side, it repairs a session between releases, and the SPA's
  silent re-mint is an OBSERVATION of RC's behaviour rather than a guarantee, so the ladder
  **holds at a 4h ceiling for ever rather than stopping**: six discoveries a day at the very
  worst, never zero.
  - **THE COST THIS BULLET NAMED IS WHAT `noteLiveToken` CLOSES.** A `maybeAutoLogin` success
    does not call `recordRenewal`, so `failures` stayed high and a fresh lapse would start at
    the escalated gap rather than at `minGap` — harmless under a flat backoff and silent and
    backwards under an escalating one. The keep-warm now resets the counter on a positively
    live token, **before** `planRenewal` reads it. `leftS <= 0` is deliberately NOT live: a
    three-day-old corpse decodes fine and keeps coming back (2026-08-19), so treating it as
    evidence would reset the counter on exactly the pathology the backoff exists for.
  - **RE-MEASURED 2026-09-20, AND THE REGIME HAD MOVED AGAIN:** 252 renewal trips over 167.5h
    = **36.1/day**, backoff band 190, failure-band **90%**, median gap **31.5m**. The 09-11
    reading above says 33.4/day and 84%; a reading taken six hours before this one said 255 /
    36.4 / 93%. **The ladder's shape does not depend on the number; the ~16/day projection
    does**, and that projection is arithmetic on the observed mix rather than a measurement.
  - **MERGED IS NOT LIVE, AND THE TWO ARE A DAY APART HERE.** `scripts/auto-cart-bot/**` is
    bot-side, so the ladder changes nothing about the running keep-warm until the mini-PC takes
    an update — **confirm arrival with `bot-ask git-status`, never `autocart.bot_version`**
    (it COALESCEs, so a stale sha can sit beside a live heartbeat). The merge DID fire a worker
    deploy, because `worker/**` is the first entry in `worker-deploy.yml`'s `paths:` and the
    branch carries two files under it: `Deploy worker (push)` and `Verify` both completed
    **success** on `d337e61`, and the fleet read **3/3 shards held**, heartbeat 1s, capacity
    8/12 — off `/api/health/status`, which is the authority rather than the deploy tick.
  - **AND THIS BULLET READ "open, not merged" FROM THE MOMENT IT LANDED.** It arrived on master
    inside **#372 at 15:53 UTC**; **#371 merged at 16:31**, thirty-eight minutes later, and the
    line was not corrected until ~17:10. It was accurate when written and wrong for most of its
    life — the same shape as every struck-through "NOT BUILT" above it, arriving inside the
    correction written to prevent one. **A state claim about a PR has a shelf life of minutes;
    read `pull_request_read` before quoting one** — this one was quoted out of a compaction
    summary and would have been re-reported as outstanding work.
- **AND EVEN THAT IS A REDUCTION IN FREQUENCY, NOT A CURE.** Every remaining ramp still charges
  the full 32 GiB in <=34 s. There is no lever on our side of the allocation; the only thing that
  changes per-event cost is Chromium's, and it is compile-time.

### THE FORCED KEEPALIVE SAMPLE NEVER RAN, AND THE BOX HAD BEEN ON STALE CODE FOR FOUR HOURS (2026-08-15)
`d85bc19` made `keepSessionsWarm` take its own memory reading, because the rec.gov Chromium
family lives ~5 seconds twice per 30-minute cycle and the 2-minute series samples it
essentially never. On 08-15 a real keepalive pass ran — `users.autocart_verified_at` moved at
05:31:27 and 05:32:15 UTC, 48s apart, which is its own 15-45s stagger, and only
`reportConnected` writes that column, after `withBrowser` returns — and **not one of the 250
rows in `chromium_memory_samples` carried `source = 'bot-keepalive'`.**
- **The cause was none of the three obvious ones. The RUNNING CODE was four commits old**, on a
  box whose checkout was current — the 08-14 trap again, by a new route. `e6a7ebf` contains
  **zero** occurrences of `bot-keepalive`, so the process could not take a forced sample at all.
- **FOUR INDEPENDENT INSTRUMENTS AGREED, and one of them had said so in plain English for
  hours.** (1) The keepalive fires on a fixed `setInterval` from process start, and 05:31:27 /
  06:01:27 fit **03:01:23 + 30m·n** exactly — seven consecutive fits — while the post-update
  process started 05:12:23 predicts 05:42:23 and 06:12:23, neither of which happened. (2) The
  sampler's in-memory interval phase is unbroken from 03:01:24, i.e. `last` never reset.
  (3) `rc_runner_heartbeat.bot_commit` read **`e6a7ebf`** against a `git-status` of `c1bd875`.
  (4) `autocart.bot_version` read *"mini-PC is on e6a7ebf; web is on 8a05308 — and it is MISSING
  bot-side changes."* **Nobody read it**, because its own next sentence explained the drift away.
- **`stop-all` SAID "nothing running." TWICE WHILE A WHOLE GENERATION WAS RUNNING.** Its filters
  are all `$_.CommandLine -and ...`, and an unelevated WMI query reads `$null` for a process in
  another security context — so an ELEVATED generation counts as **zero**, not as unkillable.
  The early return `if ($before -eq 0) { "nothing running."; exit 0 }` then fired **before the
  blind note and the broker-port check**, i.e. the one path where "I found nothing" is least
  trustworthy skipped both checks that exist to say so. Fixed: both are functions now, called
  from both paths, port check first, and the quiet path says *"nothing VISIBLE to stop"* when it
  was blind. **The port check alone would have stopped this dead** — 8787 was bound throughout,
  so `exit 1`, `start-all`'s `:stuck` branch, and the `taskkill` line printed for the human.
- **THE ELEVATION IS THE ROOT, AND IT IS WIDER THAN THE 08-14 NOTE SAID.** That note recorded
  "a `broker.mjs` started from an elevated prompt". It is the **whole 03:01 generation**: the
  proof is that `list-processes`, run by `bot.mjs` itself, prints the command line of broker pid
  15440 — the very process `stop-all` reported it could not read. Two components, one box, one
  instant, opposite views, decided only by elevation.
- **SO THE BOX CANNOT BE FIXED REMOTELY, AND THAT IS STRUCTURAL.** "Update now" is a no-op
  (`HEAD` is already at the target, so the guard has nothing to do), `restart-rc` goes through
  the same unelevated stop, and the watchdog has logged nothing since — consistent with it
  seeing all four payloads as healthy, which they are. **The fix is a human: an ELEVATED prompt,
  `mini-pc\stop-all.ps1`, then `start-all.bat` UNELEVATED** — elevated again just reloads the gun.
- **`autocart.bot_version`'s detail asserted a cause it cannot know.** `boxSha` is
  `git rev-parse HEAD` computed once **at process start**, so it reports the RUNNING code: an old
  sha means either the update has not been applied (self-heals) or it was applied and nothing
  restarted onto it (**never** self-heals). It named only the first. It names both now, plus the
  discriminator — `git-status` reads the checkout at the moment you ask. **Severity deliberately
  unchanged**; drift is normal for part of every day and turning it red is the cry-wolf failure.
- **THE SAME BLINDNESS WAS IN THE MEMORY SAMPLER, AND IT LEFT A ROW BEHIND.** At 05:12:24 the
  short-lived unelevated process stored `rc 0 procs, 0 MB` while pid 8844 was alive on both
  sides of it — the elevated process reported NINE at 05:11:52 and again at 05:13:51. Same
  filter, seconds apart, opposite answers, elevation the only variable. `C|` separates "found
  none of ours" from "never ran"; **"ran and could not see" is a THIRD state that reports
  identically to the first**, and the readout counts a zero as evidence and a null as nothing.
  The PowerShell emits `B|<count>` now, from the SAME `Get-CimInstance` filtered twice (two
  calls would make the ours/blind pair two readings a second apart, which is not a pair), and a
  scan that matched none of ours **while blind to some** reverts to null. **A PARTIAL reading
  keeps its numbers on purpose** — nulling it would delete real processes to express a doubt,
  and on a box where the owner's own browser runs as another user it would erase every reading
  for ever; the log line carries the doubt and says which way the row went.
- **The rec.gov family therefore remains sampled ZERO times** — see the entry above for why 175,
  now 250, consecutive `recgov 0` rows are the EXPECTED reading and not a lead. The instrument
  built for that family has still never run.
- Guarded in `worker/update-guard.test.mts` (reachability from the quiet path, order, one
  definition each, defined-above-use, and severity) and `worker/bot-version.test.mts`. Verified
  failing against six regressions including the restored early return and the port check present
  but dropped from the quiet path — the inert-fix shape that passes review.

### The nightly RC login rehearsal (migration 054, 2026-08-11)
Three consecutive 08:00 holds failed and **all three failed AT LOGIN**. Every one was found
at 07:30 with twenty minutes to act, because the release was being used as the test. **It
is not the test; it is the exam.** `--test-login` could always have proved this — it was
never scheduled, so it only ever ran when somebody already suspected a problem.
- At 20:00 PT the keep-warm drops its **token only** (never the cookies — the `DT` device
  cookie is what stops a login looking like a fresh profile, and losing it is what cost 12h
  of IP block on 08-06) and runs the SAME body as `--test-login`, extracted into
  `runLoginRehearsal` so the two cannot drift. Result → `rc_login_rehearsal` →
  `autocart.rc_login`.
- **The gates are the design**, in `scripts/auto-cart-bot/rehearsal.mjs`: the rehearsal
  hour only, once per 20h, never within 6h of a release, never when the feed is
  unreachable, and **never when the session is LIVE** — `attemptLogin` short-circuits on
  `isLive()`, so it would return ok without exercising one line of the sign-in. **A pass
  that proved nothing is worse than a skip, because it reads as evidence.**
- **AND IT WALKED INTO THE BANNER TRAP ON ITS FIRST NIGHT.** It cleared the token, reloaded,
  got "not live", went hunting for a sign-in form — and RC's SPA re-authenticated in
  between, so there was no form and it reported the login as broken, quoting RC's *"You
  have a reservation arriving on today's date"*. **That banner is only ever rendered to a
  SIGNED-IN user.** It is evidence of success, and that is the SECOND time it has been read
  as the obstacle (the first, 2026-08-09, drove a dead-session verdict, two alarm calls and
  my telling the owner to sign in by hand over the session that carted a site fifteen
  minutes later). `attemptLogin` re-asked `isLive()` after the page load for exactly this
  reason; it just did not ask again at the OTHER exit — the one a mid-flight
  re-authentication lands on. It now returns `provedNothing` → recorded as **inconclusive**.
- **THAT RE-AUTHENTICATION IS ITSELF A LOOSE END — and pulling it found a real bug.**
  See "THE RENEWAL WAS MEASURING ITSELF" immediately below.

### THE RENEWAL RUNS ON THE BOX — CONFIRMED 2026-08-16 01:53 UTC
Read straight off `tail-log rc-keepwarm`, from a genuinely token-less profile:
```
01:52:18 renewing the session — the app holds no usable token (src=none)
01:53:05   ✓ renewed by authorize: none → 3580s
01:53:19    renewal stood down: the token has 59m left
```
**`none → 3580s` is the strongest form this evidence could take.** The `before` was NOT a
token, so "the previous token was put back" is not available as an explanation — a restored
stale copy carries its OLD expiry, which is exactly what the failures below show. A full
3580s is a fresh mint, by the CLICK stage, with no credential typed. The ration then works in
the other direction fourteen seconds later. **The reliable cell of the 2x2 is proven in
production.**

#### THE NEAR-EXPIRY CELL FAILS, AND THE DOCUMENTED READING OF `none` IS WRONG
Twice within fifteen minutes, on the same box, the same night:
```
02:43:31 renewing the session — the token has 9m left (src=live)
02:44:29   ✗ no fresher token (554s → none), got as far as: none — the previous token was put back
02:44:29     cleared 3 storage key(s): accessToken, okta-original-uri-storage, ssoAccessToken
02:54:40 renewing the session — the token has -2m left (src=live)
02:56:27   ✗ no fresher token (-115s → none), got as far as: none
02:56:27     cleared 2 storage key(s): accessToken, ssoAccessToken
```
- **`got as far as: none` WITH `okta=ALIVE` ON THE ADJACENT LINE.** The handover said "`none`
  repeatedly is a dead Okta session, and that is the honest negative the design wants". **That
  reading is falsified.** Okta was alive for both attempts (`exp 2026-08-16T13:53:31` printed
  in the same second). So `none` means the click found no control OR the round trip produced
  nothing — it does NOT license a conclusion about the Okta session. Do not read it as one.
- **The second attempt ran on an ALREADY-DEAD token (`-2m`) and still failed**, which is the
  cell the schedule was extended to cover. So the extension fires correctly and the underlying
  re-mint still does not happen from this state.
- **The two clears emptied DIFFERENT key sets** — 3 keys including `okta-original-uri-storage`,
  then 2. That is the `okta-` sweep finding something once and nothing the next time, and it is
  a fact worth having rather than a tidy story: whatever the SPA rebuilds between attempts is
  not stable.
- **The token was NOT restored by the renewal.** `03:01:33 renewal stood down: the token has
  59m left` is the rehearsal's doing, not the schedule's — see immediately below. Attributing
  that recovery to the renewal would be the third time this file credited a repair to the
  wrong mechanism.

### THE LOGIN REHEARSAL PASSED — FOR THE FIRST TIME IN ITS LIFE (2026-08-16 03:00 UTC)
```
03:00:33 ── nightly login rehearsal: proving the bot can still sign itself in ──
03:00:34 Session before the test: DEAD — RC rejected the token (401)
03:00:34   cleared 0 key(s): (none)
03:00:40     → clicked a:has-text("Log in") → signin.reservecalifornia.com
03:00:40     → Okta skipped the email step — it remembers this account
03:00:44 ✓ the bot can still sign itself in — tomorrow morning has a session behind it
```
**The entry below says the instrument has produced exactly one verdict in its life and that
verdict was "I proved nothing". It has produced a second, and it is a PASS.**
`autocart.rc_login` reads *"the bot signed in unattended 6m ago"*.
- **It fired at 20:00 PT, its own hour**, with the release 12h out — comfortably past the 6h
  gate — so all four gates were satisfiable and it ran. That is the first time the schedule
  has been observed working end to end.
- **It was NOT a banner-trap false pass.** `Session before the test: DEAD — RC rejected the
  token (401)` is RC's own answer, and the clear reported `0 key(s)` because the profile was
  already empty — so a credential really was submitted and the sign-in really was exercised.
  That is precisely the distinction `provedNothing` exists to draw.
- **`Okta skipped the email step — it remembers this account`** is the `DT` device cookie
  earning its keep, and the reason the "never lose the profile" rule is not superstition.
- **AND IT IS WHAT RESTORED THE SESSION**, not the renewal — the 59m token at 03:01:33 comes
  from this login. Two repairs ran within twenty minutes of each other and only one worked;
  crediting the wrong one is how a broken mechanism keeps its reputation.

### THE LOGIN REHEARSAL HAS NEVER PASSED, AND IT DID NOT FIRE ON 08-12
Observed 2026-08-12 22:29 PT, with three holds queued for the next morning.
`rc_login_rehearsal` holds **one row**: `ran_at` 2026-08-11 20:02 PT, **`ok` NULL**,
`skipped_why` = *"inconclusive — RC re-authenticated from the live Okta session before the
form hunt"*. So the instrument has produced exactly one verdict in its life and that verdict
was "I proved nothing" — which is the banner trap being caught correctly, not a fault.
- **Tonight's 20:00 PT window then passed with `ran_at` unmoved**, i.e. nothing attempted it.
  Cause NOT established, and do not guess one into this file — the four gates (the 20:00
  hour, once per 20h, never within 6h of a release, never when the session is live) all look
  satisfiable at 20:00 on 08-12, so the answer is somewhere else.
  **Two of those four are now arithmetically ruled out (2026-08-13):** the last run was
  08-11 20:02 PT so the gap at 20:00 on 08-12 was ~24h against a 20h minimum, and the
  release was 12h out against a 6h minimum. Only `sessionLive === true`, an unreachable
  feed, or the process not being alive during hour 20 remain.

- **AND THE REASON IS UNRECOVERABLE, BY A BUG IN THE INSTRUMENT'S OWN BOOKKEEPING
  (found + fixed 2026-08-13).** `maybeRehearse` gates its skip-record on one variable so a
  skip is written once a night instead of on every poll through the hour. That variable
  held the **hour number** (`rehearsedThisHour = hour`) and was **never reset** — so it
  latched at 20 for the life of the process, and the first night the hour was reached was
  the *only* night that could record anything. Every night after it, a skip wrote nothing
  and logged nothing.
  - So **"a gate stood it down, and here is which one" and "the process never reached
    20:00" produce the identical evidence: silence.** That is the house failure shape
    (`status = 'sent'` meaning only "Twilio returned 2xx"; `claimBotCommands` returning
    `[]` for both "nobody asked" and "the query threw") — this time inside the watchdog's
    own watchdog, which is why 08-12 cannot be diagnosed retroactively and 08-14 onward can.
  - Fixed with `rehearsalSlot()` in `rehearsal.mjs` — a **Pacific date**, null outside the
    rehearsal hour. A date cannot latch: tomorrow's window has a different key. Keyed on
    Pacific and not UTC deliberately, or the slot would roll at 17:00 PT, mid-evening, and
    disagree with `pacificHour()` across a DST boundary.
  - `worker/rehearsal.test.mts` verified failing against **both** halves: a latching slot,
    and the caller reverting to the bare-hour comparison — *the fix present but inert*,
    which is `6006428` and the `--claimed` omission, and the version that passes review.
  - **This is bot-side code, so it needs an `update.bat` or a quiet-window update to reach
    the box** — and the 02:00–05:00 window is shut while holds are `requested`. It changes
    nothing about whether a cart fires; it only makes the next silent night explain itself.
- **IT IS NOT THE 2026-08-10 WEDGE, and that is the distinction that matters at 07:30.** That
  failure was the keep-warm going silent for ten hours and taking `maybeAutoLogin` down with
  it. Here the keep-warm reported **45 seconds** before the reading, so the loop is alive and
  the 07:30 sign-in still runs. A missing rehearsal costs the ADVANCE WARNING, not the repair
  — check the keep-warm's report age before treating the two as the same event.
- The health line reads *"no rehearsal has PASSED in 26h27m"*, which is accurate and easy to
  misread as a regression: nothing has ever passed, so there is no green to have lost.

### THE RENEWAL QUESTION IS ANSWERED (2026-08-15 evening) — and the answer is "stop renewing"
The corrected clear reached the box (`d72fb2e`) and produced the first honest reading. Read
straight off `tail-log rc-keepwarm`, twice, an hour apart:
```
20:08:53 token has 9m left (src=live) — renewing by reload
20:09:19   ✗ no fresher token after the reload (565s → 540s) — the previous token was put back
20:09:19     cleared 3 storage key(s): accessToken, okta-original-uri-storage, ssoAccessToken
21:08:36 token has 9m left (src=live) — renewing by reload
21:09:02   ✗ no fresher token after the reload (553s → 528s) — the previous token was put back
```
- **`renewByReload` DOES NOT WORK, and this reading is finally entitled to say so.** The
  clear now reaches the `okta-` namespace and names what it emptied, so the negative is real
  rather than an artifact of clearing the wrong keys. The token still comes BACK 25s older,
  so **a persisted copy survives all three keys** — not sessionStorage-vs-localStorage
  guesswork, a fact forced by the measurement. Where it lives is still unknown; the
  remaining candidates are IndexedDB, a cookie, or a key name nothing has looked for.
- **THE `okta-` PREFIX ASSUMPTION WAS HALF RIGHT.** The sweep ran and found exactly ONE
  `okta-` key — `okta-original-uri-storage`, which is a redirect breadcrumb, not a token
  store. So okta-auth-js is **not** keeping tokens under `okta-` in this profile, and the
  three-way prediction in the old handover ("more than 2 keys ⇒ honest negative") needs that
  qualification: it listed three, but the third was not a token.
- **RC ISSUES NO REFRESH TOKEN AT ALL** — the single most useful line in the log, and it
  changes the shape of the problem:
  ```
  grant: {"hasRefreshToken":false,"expiresIn":3600,"scope":"openid profile email"}
  ```
  There is nothing to silently refresh WITH. Every "make the token renew itself" plan was
  reaching for a mechanism RC does not hand out. Stop looking for one.
- **BUT THE BOOTSTRAP RE-MINTS, WITH NO CREDENTIAL TYPED**, and that is the path forward:
  ```
  19:18:57  ✓ already signed in — RC re-authenticated before any form appeared,
            so no sign-in was exercised — token now 59m, needs 21m (covered)
  ```
  **59 minutes is a FULL-LIFETIME token, which is what separates this from the 08-11
  confound**: a restored stale copy would carry its old expiry (that is exactly what
  20:09:19 shows — 540s). A fresh hour means RC minted a new one from the live Okta cookie.
  The Okta session runs ~12h (`okta=ALIVE (exp 2026-08-16T10:09:03)` against a 22:09
  reading), so within that window a bootstrap costs nothing and needs nobody.
- **SO THE AUTOMATION ANSWER IS: DON'T RENEW THE TOKEN, RE-RUN THE BOOTSTRAP.** That is
  `attemptLogin`, which already short-circuits into the line above when the Okta session is
  alive. What is missing is only its SCHEDULE — today it fires at T−30 of a real release, so
  between releases the token dies and stays dead (the `⚠ RC SESSION IS DEAD … okta=ALIVE`
  lines, hours of them). Nothing is broken there; nothing is trying.
- **`renewByReload` should NOT be deleted on this reading.** It is the instrument that
  produced it, it now reports honestly either way, and its restore guard means a failed
  attempt costs nothing. Retire it when a bootstrap-on-a-schedule is proven, not before.

### WHY THE RELOAD FAILED: A PLAIN LOAD IS NOT THE BOOTSTRAP — THE CLICK IS (2026-08-15, later)
The section above is right that the reload does not renew and right that the bootstrap does.
It is wrong about **why**, and the correction is the whole fix. "RC will not renew" was never
the finding available; **nothing was asking it to.**
- **THE 2x2 IS COMPLETE, off one evening of `tail-log rc-keepwarm`, and every cell is
  reproduced:**

  | | token present, short | no token at all |
  |---|---|---|
  | **plain load** | no re-mint (4x: 18:18, 18:25, 20:08, 21:08) | no re-mint (2x: 18:46, 22:22) |
  | **sign-in click** | not observed to work (1x, see below) | **59m token (2x: 19:18, 22:26)** |

  The negative controls are the valuable half and they were sitting in the log all along:
  `RC loaded and STAYING OPEN — token source: none` at 18:46:50, then **thirty minutes and
  two twenty-minute checks** with `okta session STILL ALIVE` and nothing appearing. A plain
  navigation, from a genuinely token-less profile, against a live Okta session, produces
  nothing. Then `19:18:38 clicked a:has-text("Log in")` → `19:18:57 token now 59m`.
- **MECHANISM, and it follows from the pair rather than preceding it:** with no token in
  storage RC's SPA renders signed-out and simply sits there — it issues no `/authorize` of
  its own. The sign-in control starts the authorization-code flow; Okta answers it from the
  `idx` cookie without showing a form; RC exchanges the code for a fresh hour. `renewByReload`
  cleared correctly and then did the one thing that cannot work. **The clear was necessary
  and never sufficient.**
- **`hasRefreshToken:false` stands and is unaffected.** There is nothing to *silently
  refresh* with, and there never was. What re-mints is a full authorization-code round trip
  that costs no credential because Okta already knows the device. Do not read this entry as
  reopening the refresh-token question.
- **SO THE FIX IS TWO STAGES AND A SCHEDULE, NOT A NEW MECHANISM.**
  `renewByReload` is now **`renewSession`** (renamed, because a name describing half of what
  a function does is what this file keeps paying for) and runs the reload, then — only if the
  reload produced nothing — the click. **The result says WHICH stage minted the token**:
  `reload` would mean the SDK's own bootstrap has started working and this can be simplified
  back down, `authorize` is the expected success, and `no-signin-control` is separated from
  `none` because they need different responses.
- **THE ONE OBSERVED CLICK FAILURE IS THE KNOWN WEAK CELL, and it is the near-expiry one.**
  At 18:22 `attemptLogin` dropped a live-but-short token, and the SPA went on rendering its
  signed-in banner — so no `a:has-text("Log in")` anchor existed, `button:has-text("Login")`
  matched something else, and nothing was started. That is the surviving-persisted-copy
  finding showing up from the other end. **Expect the near-expiry path to fail sometimes;**
  the token then expires, the profile becomes token-less, and the reliable cell takes it on
  the next pass. Cost is minutes, not the night.
- **`worker/renewal-schedule.test.mts` decides WHEN** (`scripts/auto-cart-bot/renewal-schedule.mjs`),
  and the case it adds is the one the old loop refused outright:
  - The old condition was `left != null && left > 0 && left < RENEW_BEFORE_S`, i.e. act on a
    nearly-dead token and **never** on an already-dead one. Defensible clause by clause and
    wrong as a whole: a signed-out profile is where a re-mint is both **free** (nothing to
    clear, nothing to restore) and worth most. **It cost ninety dead minutes in one evening**
    — 18:47→19:18 and 21:29→22:25 — both repaired only because somebody happened to queue a
    hold, since `maybeAutoLogin` was the sole caller.
  - Rationed on **its own terms, not the login's**: a floor (5m) honoured whatever changed, a
    gap (10m) for repeating an unchanged state, a backoff (30m after 3 consecutive failures)
    that **never becomes a stop** — a gate that switches itself off for good is the
    `.camphawk-ready` bug. A re-mint is not a login: no credential is submitted, no form is
    filled, and the CAPTCHA that stops `attemptLogin` lives on the password form this never
    reaches. It therefore does NOT spend the one-attempt-per-release budget.
  - **The ration lives at MODULE scope.** `warmResident` reopens its browser every time the
    hold runner wants the profile — ten times in four hours on 08-15 — so state inside that
    loop would bound nothing at all.
  - **Okta is probed only when there is a token to lose.** `/api/v1/sessions/me` refreshes
    Okta's own idle timer, so asking on every attempt extends the very window whose length
    we are trying to learn. The probe guards the DESTRUCTIVE clear; with no token there is
    nothing to clear, so it guards nothing and is skipped. The attempt is self-diagnosing —
    a dead Okta session lands on the form and reports `stage: 'none'`.
- **`maybeAutoLogin` IS DELIBERATELY UNTOUCHED.** It remains the release-critical path with
  its own budget at T−30. This is a background improvement; if it were also the release
  repair, one bad night of renewals would spend the ration that protects an 08:00 cart.
- **The dedupe keys on a STATE, not on the sentence** — every stand-down reason carries a
  minute count that changes on every 60s ask, so `autoLoginSkip`'s direct string comparison
  would collapse nothing and print 1,440 lines a day. It also had to MOVE into the tested
  module: as six lines in `rc-keepwarm.mjs` it was pinned by a regex on its own shape, and a
  mutation reinstating the volatile comparison **from inside the body** matched that shape
  and passed. A source scan cannot see through a function it can only pattern-match.
- **27 mutations, each asserting the mutation applied.** Two are worth keeping: the one above,
  and `clickSignInControl`'s extraction tripping `rc-autologin.test.mts`'s **pinned export
  list** — which is the "an existing guard pinned it by name" rule working as designed, and
  the list is pinned precisely so adding to it is a decision with a written reason.
- **BOT-SIDE, so none of this is live until the box updates.** `autocart.bot_version` is a
  hint; `git-status` through `bot_commands` is what answers "did it land?". **Nothing here is
  proven until the log shows `✓ renewed by authorize` on the box** — the evidence above is
  two hand-triggered reproductions of the mechanism, not one run of the schedule.

### THE RENEWAL WAS MEASURING ITSELF (2026-08-12) — the keep-warm question is REOPENED
`renewByReload` has been reporting "RC will not renew" since it shipped, and **it was never
asking RC anything.** From the box's own log:
```
00:06:09 token has 10m left (src=live) — renewing by reload
00:06:10   ✗ reload did NOT mint a fresher token (575s → 575s)
```
**One second, and `before === after` to the second.** A navigation plus an SPA bootstrap
plus an OIDC round trip cannot happen in a second, and a real failure does not hand back the
identical number — that is the same token being read straight back.
- **Mechanism, established from the code, not guessed:** the function deleted
  `window.__camphawkRcToken` (our own captured copy) and left **localStorage** alone. That
  is the copy okta-auth-js decides from, so with a still-valid token there the SDK issues no
  `/authorize` at all; the app then makes its first API call with that same token, the
  capture hook records it as `source: 'live'`, and `primeToken` returns it instantly. **The
  renewal was measured against the very token it was supposed to replace.**
- **The counter-evidence was in the same night's log.** The login rehearsal clears
  `ssoAccessToken`/`accessToken` and reloads — and RC re-minted a token from the live Okta
  session within seconds, **no credential typed**. So the BOOTSTRAP path works; it is the
  SDK's background `autoRenew` that does not. Clearing storage is what chooses between them.
- **`idx` IS in the profile now** — `DT, ln, [opaque], luf_*, idx, JSESSIONID`. That is
  Okta Identity Engine's session cookie, and "no `sid`, no `idx`" is what the whole
  "nothing to keep warm" verdict was built on. It appeared once `keepSignedIn()` started
  being ticked. The failure line meanwhile blamed *"the Okta cookie may be gone"* with
  `okta=ALIVE` on the adjacent line — **a diagnosis contradicted by the field next to it.**
- **What is now true:** the evidence for "RC will not renew" was worthless, and there is one
  positive observation that it will. That is **not** a solved keep-warm — one observation is
  not a measurement, and this file has been burned twice by treating one for the other. The
  fixed code makes the next attempt a real test and reports honestly either way; it should
  answer within a token lifetime of reaching the box.
- ~~**IT ANSWERED ON 2026-08-15, AND THE ANSWER IS NO.**~~ It ran and it failed:
  ```
  14:43:53 token has 10m left (src=live) — renewing by reload
  14:44:19   ✗ no fresher token after the reload (578s → 552s) — the previous token was put back
  ```
  **It was NOT a real test either, and the heading above is left struck through because
  believing it was is the mistake.** `after` is not null — a token came BACK, 26 seconds older
  than the one dropped, i.e. the same token. A navigation wipes JS memory and
  `window.__camphawkRcToken` was deleted, so **it can only have come from another PERSISTED
  copy**. That is forced by the measurement, not inferred.
- **THE CAUSE: `ssoAccessToken`/`accessToken` ARE RC'S OWN COPIES, NOT THE SDK'S.** okta-auth-js
  namespaces its own store under `okta-` and that is what it decides from on boot, so clearing
  two keys of the blob left the SDK holding the token and handing it straight back — no
  `/authorize`, nothing asked of RC at all. `rc-probe.mjs` had recorded the same fact from the
  other end months earlier: *"the whole session lives in localStorage, and copying that blob
  DOES carry the login"*. **The clear was reasoning about two keys of a session that lives in
  many.**
- **SO THE TWO CLEARS NEVER DISAGREED — THEY WERE THE SAME INCOMPLETE CLEAR.** This entry
  previously called the disagreement "the whole open question" and said nobody had diffed them.
  Diffed 2026-08-15: the rehearsal's clear was a THIRD hand-rolled copy of the identical two
  `removeItem` calls. **So the 08-11 "RC re-minted from the live Okta session with no credential
  typed" observation is CONFOUNDED** — an incomplete clear produces exactly that appearance,
  because the app comes back signed in on a token that never actually left. Nobody recorded
  whether it had a FRESH expiry, so it cannot be told apart after the fact.
- **THAT IS THE 08-12 BUG IN A SECOND COSTUME**, and it is the reason to be careful here: the
  original was "the renewal measured itself against the token it meant to replace", and this is
  "the evidence FOR renewal was produced by the same failure to delete it". Two of the three
  observations this file has treated as proof that RC will renew are now unusable. The third
  (the mobile app probe, 08-13) went through a different code path and is untouched.
- **WHAT IS ACTUALLY KNOWN: nothing either way.** Do NOT record "RC will not renew" — no clear
  that reached the SDK's storage has ever been tested. Do NOT record that it will. The clear is
  correct now (`dropStoredToken` covers `okta-` too, with an exact-restore snapshot) and it
  **reports the key names it emptied**, so the next run on the box is the first real reading.
  If a failure ever lists only the two RC keys again, the `okta-` prefix assumption is what
  needs revisiting.
- **`maybeAutoLogin` stays exactly as it is** until renewal is *proven*. A renewal that
  works is what would retire it; a renewal that is merely plausible is not. (Reinforced
  2026-08-15: it is now the ONLY thing standing between a queued hold and a missed cart.)
- **The clear is DESTRUCTIVE, so the fix is guarded three ways** — never on an explicit
  `alive: false` from Okta (`null` is "we could not tell" and still attempts, or one hiccup
  disables renewal forever), judge on a token that is genuinely *different* rather than
  merely live, and **restore the exact keys that were emptied and reload** if nothing
  fresher arrives, so the worst case is no worse than doing nothing.
  `worker/rc-token-renew.test.mts` was verified failing against all four regressions.

### "The auto-login has had its turn" was said 15 minutes early (2026-08-12)
`autocart.rc_session` read **fail** at **T−34** with *"the auto-login has had its turn — run
mini-pc\rc-login.bat"*, while `maybeAutoLogin` had not run at all. It ran at ~T−31 and signed
in unattended. **Anyone acting on that sentence would have driven to the box over a session
that repaired itself four minutes later** — the 08-09 cry-wolf, a second time, in the one
check the 07:40 pre-flight reads.
- **ONE CONSTANT WAS DOING TWO JOBS.** `RC_SESSION_CRITICAL_MIN` (45) is when a dead session
  starts to MATTER; it is not when the repair is spent, which cannot be sooner than the login
  runs (`RC_AUTOLOGIN_LEAD_MIN`, 30). The alarm gate learned this on 08-09 and gates on
  `ALARM_AFTER_MIN` (25) plus a definitive `auto sign-in failed`; the health check kept the
  naive version, **directly beneath the long comment explaining the lesson it was breaking**.
- `RC_SESSION_REPAIR_SPENT_MIN` is that number, **shared with the alarm** so the page and the
  phone cannot disagree about whether a repair is pending. A reported failure outranks the
  clock, as it does for the alarm.
- Also replaced a bare `30` in the message string with `RC_AUTOLOGIN_LEAD_MIN` on the web
  side. That sentence is read by a human deciding whether to intervene.
- `worker/autologin-lead.test.mts` pins the two windows apart and requires the spent window to
  equal the alarm's; verified failing against both the 45-minute constant and the old
  expression. **Ruled out first:** `d1ab782` already carried lead 30, so this was NOT the
  two-halves-deploy-by-different-routes gap.

### RC WENT BLANK IN THE BOT'S BROWSER, AND IT WAS THE CHROMIUM PROFILE (2026-08-14)
Reported as *"RC login isn't working"* and *"white screen"*. ReserveCalifornia's app mounted,
showed its own spinner, and never finished — in the bot's Playwright Chromium only. The
owner's normal Chrome, **same machine, same IP**, loaded it fine. `rc-autologin` reported
*"could not find the Log in link — RC may have reworded it"*, which is a CONSEQUENCE: a page
that never renders has no link in the DOM. It cost most of a day.
- **THE ANSWER: the `.rc-bot-profile` directory.** Renaming it and letting the keep-warm
  build a fresh one rendered RC completely, with **"Log in / Sign up"** present in the header
  — which is what `a:has-text("Log in")` matches, so the auto-login's selector was never
  wrong either. **WHAT in that profile did it is UNKNOWN**: it survived deleting `Cache`,
  `Code Cache`, `Service Worker` and `Local Storage`. The old directory is kept as
  `rc-profile-old` and is the only copy of the evidence — do not delete it without looking.
- **SIX THEORIES DIED FIRST, and they are worth keeping so they are not re-run.**
  NOT RC redeploying (their bundle's `last-modified` is 12 Aug and the bot carted against
  that exact build on 13 Aug). NOT a service worker (`/service-worker.js` and `/sw.js` both
  404→403; there isn't one). NOT the JS syntax (the most modern feature in the bundle is
  `Object.hasOwn`, Chrome 93+). NOT Playwright moving (the lockfile pins 1.61.1 both sides of
  the update that straddles the last working cart). NOT the WAF (the failure screenshot is
  RC's own spinner, not an Access Denied page or a challenge). NOT the token-capture hook.
- **`scripts/auto-cart-bot/rc-diag.mjs` IS WHAT SETTLED IT**, and the reason is the 2x2. Its
  first version launched a throwaway profile with NO capture hook and rendered perfectly —
  which read as proof the profile was guilty and **proved nothing**, because it differed from
  the bot in TWO ways at once. Same confound as "2-segment messages get filtered" when the
  real variable was the link domain. `--capture` and `--real-profile` change one thing each.
- **THREE OF MY OWN CONCLUSIONS WERE WRONG ALONG THE WAY**, all from evidence that looked
  solid:
  1. *"A fresh profile is still white."* **That test never ran.** Every
     `ren .rc-bot-profile rc-profile-old` was typed from `C:\Users\Tyler` and answered
     *"The system cannot find the file specified"*, so the "fresh" profile was the old one.
     **Use absolute paths on that box; a failed `cd` is silent and the next command lies.**
  2. *"`RC loaded and STAYING OPEN` proves the page is fine."* It means **navigation
     resolved**, nothing more. I reversed a correct diagnosis on it.
  3. *"Seven chrome.exe with two unquoted = two instances, so an orphan holds the lock."*
     `kill-chrome` cleared all seven, the keep-warm reopened ONE browser, and the shape came
     back **identical**. Seven processes with two unquoted entries is simply what a single
     healthy Chromium looks like.
- **`exitCode=21` from `launchPersistentContext` means PROFILE IN USE**, not a crash. It is
  the correct answer when the keep-warm holds the profile, and `--real-profile` needs the
  pair stopped. **The watchdog fights that** — it restarts the RC pair within 5 minutes, so a
  test that needs them down needs the task disabled (`schtasks /Change /TN "CampHawk
  watchdog" /DISABLE`, which needs an ELEVATED prompt), or an approach that does not hold
  them down at all. Renaming the profile and letting `start-all` rebuild it is that approach.

### A Chromium ate 41 GB of COMMIT, and nothing could kill it remotely (2026-08-12)
The first real `memory` reading answered the question `fix-pagefile` was waiting on, and the
answer was **consumption, not the ceiling**: one `chrome.exe` on our profiles at **9.4 GB**,
growing **~395 MB/min**, with COMMIT at **99% of 50 GB**. Killing that single pid took commit
to **21% of 35 GB** and freed ~41 GB — Windows then shrank the lazily-grown pagefile back.
- **It reached 7.9 GB in 46 seconds** of the keep-warm starting. That is not ordinary growth.
- **`restart-rc` could not clear it** — it killed 2 of the instance's 9 processes. So the one
  remote lever for a runaway browser did not reach it, and it took a person typing `taskkill`
  into a phone. Hence **`kill-chrome`** (`rc` / `recgov` / `all`), which kills by profile
  family, re-checks, names survivors and clears the RC profile lock.
- **STILL UNDIAGNOSED, and I twice guessed the profile wrong.** The RC profile path is
  `…\auto-cart-bot\.rc-bot-profile`, so it contains BOTH patterns `memory` and `restart-rc`
  match on — the two cannot be compared that way. Attribute it on the next occurrence with
  evidence, not by reading regexes.
- `fix-pagefile` is **not** the fix and would have masked this. Pagefile peak was 0.4 GB
  against 34 GB allocated: commit was going to reservations, not paging.
- **`memory` CAN ATTRIBUTE IT NOW (2026-08-14), which it could not before.** It reported a
  count and a total and nothing else, so the leak was unattributable *by construction* — the
  guessing above was the only option the tool left. It now prints, per Chromium, the
  **`--user-data-dir` in full** plus pid and private MB, and totals per family. **Order is
  load-bearing:** `.rc-bot-profile` is tested BEFORE `auto-cart-bot` because it sits inside
  it, and the general test first would file every RC process under rec.gov — the exact
  misattribution being fixed. The directory only, never the command line: Chromium argv
  carries URLs, and a field you would have to filter is better not collected.
- **AND `kill-chrome recgov` WAS KILLING THE RC PROFILE TOO.** `--user-data-dir=\S*auto-cart-bot`
  matches `…\auto-cart-bot\.rc-bot-profile`, so the lever you reach for *precisely because*
  `restart-rc` leaves rec.gov alone would have ended the live RC session. Negative lookahead
  now, rather than matching the `profiles\` subdirectory, so an overridden `PROFILES_DIR`
  cannot quietly turn it back into "everything". Having three scopes is only worth something
  if two of them are survivable at 07:50. `worker/chromium-attribution.test.mts` pins both,
  verified failing against the restored scope and against the reversed family order.
- **NOT REPRODUCED THIS SESSION, and the readings say why.** 2026-08-14 05:06Z: COMMIT **13%
  of 57.7 GB**, `OURS 0`, **`CHROME 0` — no Chromium on the box at all**, because the RC pair
  were REPLs and never launched one (see the `restart-rc` entry). So there was nothing to
  measure, and a second reading five minutes later would have measured the same nothing.
  **Do not read "no leak observed" as "no leak"** — the growth RATE across two readings is
  still the signature, and it still needs an occurrence.

### THE CHROMIUM LEAK IS RECORDED NOW, BECAUSE IT CANNOT BE CAUGHT BY HAND (migration 059, 2026-08-14)
The prescribed remedy — two `memory` readings five minutes apart, because the growth RATE is the
signature — was run and produced a clean, confident, **useless** answer: the same 8 pids in both
readings, 312 MB → 264 MB, about **−9 MB/min**, COMMIT 16% of 57.7 GB.
- **Every process sampled was on `.rc-bot-profile`, and NO rec.gov process existed at all**
  (`CHROME 8` = `OURS 8`). `keepSessionsWarm` in `bot.mjs` opens a rec.gov Chromium per enrolled
  user **every 30 minutes** and closes it, so the family that has never been ruled out is
  **EPISODIC** and a five-minute window has ~1 chance in 10 of containing one. Two manual readings
  are not merely risky here, they are structurally unlikely to sample it — which is why three
  attempts have produced three non-answers. **A family with no processes running has been ruled
  out of NOTHING**, and reading that reading as "it did not reproduce" is the whole trap.
- **"Keep-warm" NAMES TWO DIFFERENT THINGS**, and that is a plausible part of why the family was
  guessed wrong twice: `rc-keepwarm.mjs` (RC session) vs `keepSessionsWarm()` inside `bot.mjs`
  (rec.gov keepalive). The 08-12 note *"7.9 GB in 46 seconds of the keep-warm starting"* does not
  say which, and they are different profile families.
- **So `bot.mjs` samples every 2 min and POSTs it** on the feed POST it already makes →
  `chromium_memory_samples`. Readout `scripts/chromium-memory-readout.mts`. Hosted in `bot.mjs`
  because the RC pair have died twice while it stayed healthy (08-11; the 08-14 REPL morning).
  **Server-side and not a log file, by measurement:** on 08-12 the keep-warm's log FROZE through
  Windows file locking while the process went on reporting to the server perfectly.
- **The verdict pairs on `max_pid`.** A rec.gov family total going 0 → 900 MB is usually a browser
  that did not exist in the first sample; subtracting those is a coincidence with units on it, and
  without the rule it would report a leak on every keepalive pass for ever. **Refuses a verdict
  under 10 comparable pairs**, counting pairs it could compare rather than rows fetched.
- **A GAP IS THE SIGNATURE, NEVER A ZERO.** Sampling spawns PowerShell, and spawning is exactly
  what fails at 99% commit — the `supervise.ps1` failure IS that failure — so the series ENDS
  rather than peaking. And "NO LEAK IN THIS WINDOW" never becomes "there is no leak".
  - **AND THE GAP AT THE END WAS THE ONE IT COULD NOT SEE (fixed 2026-08-14).** `worstGapMin`
    measured the longest hole BETWEEN two samples, so a series that simply STOPS — which is
    exactly the shape above — had no gap at all: every sample a tidy two minutes apart, and a
    box that died mid-ramp at 03:00 printing the same `NO LEAK IN THIS WINDOW` as a box sitting
    idle. The house shape, inside the instrument written to catch it. `seriesEnded` is measured
    against `now` (injected, so the function stays pure), and **`lastCommitPct` is what tells a
    crash from a bot that was merely stopped** — ending at ~16% is an update or a switched-off
    box, ending at 90% is the crash. It is ADDITIVE: "it climbed AND THEN the series stopped"
    is the strongest reading this table can produce, and overwriting the growth verdict with
    the silence would discard the half that names the family.
- **SIZE IS A SECOND QUESTION, AND THE RATE RULE CANNOT ANSWER IT (2026-08-14).** The 08-12
  process reached 7.9 GB in **46 seconds** — faster than the 2-minute cadence — so that ramp is
  invisible here: it appears as a pid that did not exist last time, already enormous, and the
  `max_pid` pairing rule correctly refuses to call it a rate. So the readout could print
  `NO LEAK IN THIS WINDOW`, or `NOT ENOUGH DATA`, over a 7.9 GB browser **sitting in its own
  table**. `BIG_PROCESS_MB` (1500, against measured normals of 40-114 MB) reports it as
  `OVERSIZED PROCESS`. A measured rate still leads — two readings of one process is the
  stronger evidence — and size corroborates it. **Size is deliberately NOT gated on
  `MIN_COMPARABLE_PAIRS`**: that threshold gates a RATE, and refusing to name a multi-GB
  browser for want of pairs would be the instrument declining to report what it exists to find.
  The peak is the LARGEST reading in the window and never the newest, so a spike `kill-chrome`
  or a closing keepalive browser has already cleared is still attributed.
  - **That last rule survived its first mutation test.** Every fixture happened to put its
    biggest process in the final row, so "largest" and "last" were indistinguishable and the
    mutation passed the whole suite. A guard written from the shape of the bug can be wrong
    about the rule — same lesson as `site-mute.test.mts` failing at baseline.
- **No alarm on it, deliberately.** A warn at ~70% COMMIT (while `kill-chrome` still works and the
  box is still reachable) is the obvious next step and should be decided on the series, not before.
- **THE SAMPLER RECORDED A ZERO IT HAD NOT MEASURED, ON ITS FIRST DAY (2026-08-14).** The box
  reached `60d9b98` and samples began every two minutes exactly as designed — **and every row
  said `rc 0 procs, 0 MB` while the `memory` command, interleaved seconds apart on the same box
  through a BYTE-IDENTICAL filter, reported NINE Chromium on `.rc-bot-profile`.** The commit
  figures in those same rows were right (`10277 MB` against the command's `10.0 GB`), so
  PowerShell ran and only the process scan came back empty.
  **The empty scan is not the bug; the ZERO is.** `memory-sample.mjs`'s own header states the
  rule it broke — an absent reading returns nulls, never zeros — and it had been applied to the
  `M|` line and not to the scan. That is the SAME half-application as the `op_Addition` rollup
  below: **twice, in the two instruments built to attribute this one leak.**
  - Counts start `null`; a zero is written only when the scan proves it ran.
  - PowerShell emits **`C|<count>` BEFORE the loop**, because "found none of ours" and "never
    completed" were the same evidence and **both are real** (08-14 had a window with genuinely
    zero of our browsers). It also localises the failure: `C|9` with no `P|` means the loop
    broke, no `C|` at all means PowerShell stopped before it.
  - **stderr is read and logged.** It was discarded, so the one line explaining the empty scan
    was thrown away at the point it was produced.
  - **WHY the scan returns nothing is NOT established — do not guess it into this file.** The
    filters are identical, so it is about how the sampler invokes PowerShell rather than what
    it asks. The `C|` line answers it on the next reading.
  - **Two mutations survived the first round**: deleting the `C|` line from the PowerShell, and
    emitting it after the loop. Every parse test feeds `parseSample` a hand-written string, so
    the parser and the thing producing its input could drift apart silently — and there is no
    PowerShell on the machine this repo is written from. Guarded mechanically now.

- **TWO INSTRUMENTS WERE LYING, both the house shape.** `memory`'s per-family rollup kept
  `@(count, mb)` in a hashtable and threw `op_Addition` once per process on **every run it ever
  made** — printing `FAMILY rc 0 process(es), 0 MB` over a profile holding 312 MB, while the
  per-process list above it was correct. `rc 0 MB` reads as the RC family being innocent, on the
  one line you compare across two readings. And `kill-chrome` called everything it found after its
  3-second re-check `SURVIVED` — long enough for the supervisor to have opened a NEW browser, so a
  clean kill plus healthy recovery printed the same words as a kill that reached nothing (the
  08-12 "7 before, 7 after"; the pids were different every time, i.e. it had worked). It diffs pid
  sets now. Both fixed by the idiom already working three lines away, not by a second guess.

#### THE SAMPLER CAN NEVER PRODUCE A VERDICT ON THE REC.GOV FAMILY (2026-08-15)
The series ran clean for 175 samples and reported `recgov 0` in **every one of them**, and the
readout says so in a warning: *"NO recgov process was running at any point in this window."*
That reads as "the episodic family still has not been sampled — keep waiting". **Waiting cannot
work, and the reason is arithmetic, not luck.**
- **MEASURED, from the box's own `bot` log against the sample timestamps.** `keepSessionsWarm`
  fires on a fixed 30-minute interval from `bot.mjs` start, so the window is predictable:
  ```
  [04:01:23] interval fires (03:01:23 start + 30m + 30m)
  [04:01:27] ♻ tyl***: rec.gov session kept warm     <- +4s
  [04:01:49] ♻ cam***: rec.gov session kept warm     <- +26s, after the 15-45s stagger
  ```
  Samples ran at 03:59:34, **04:01:35**, 04:03:35. The one sample inside the window landed in
  the GAP between the two browsers — the first had closed at ~04:01:27, the second had not yet
  opened. Same shape at 03:31:23 (`+4s`, `+25s`).
- **So each keepalive browser exists for a few SECONDS**, twice per 30-minute cycle: on the
  order of **10-20 seconds of browser per 1800**, under 1% coverage. Across the ~13 cycles in
  the series that predicts one or two catches, so **zero out of 175 is unremarkable and is NOT
  evidence of anything.** Do not read the readout's warning as a lead; it is the expected
  reading.
- **THE STRUCTURAL HALF DOES NOT DEPEND ON THAT ESTIMATE, and it is the finding.** A verdict
  needs a RATE, the rate rule pairs two samples **of the same `max_pid`**, and the cadence is
  two minutes — so a rate requires the process to live longer than two minutes. **These live
  about five seconds.** A NORMAL keepalive browser therefore cannot produce a rate verdict
  from this instrument *rarely*; it cannot produce one **at all**. The recorder built precisely
  because "the rec.gov family is episodic and manual readings miss it" has the same blind spot
  it was built to remove — narrowed from a five-minute window to a two-minute one, and the
  family is five seconds wide.
- **THAT IS NARROWER THAN IT READS, AND THE FIRST DRAFT OF THIS ENTRY OVERSTATED IT.** It said
  "a rec.gov LEAK cannot produce a rate verdict at all", and that does not follow: a process
  that is actually leaking **persists** — the 08-12 one grew for minutes and reached 9.4 GB —
  and a browser that lives minutes gets sampled and paired like any other. **The periodic
  series is NOT blind to a sustained runaway.** What it cannot see is the family's **normal
  baseline** (still unknown, and abnormal is not recognisable without it) and a ramp that
  begins and ends inside one short life. The correction is left visible rather than quietly
  rewritten, because "the instrument is blind to rec.gov" is exactly the tidy sentence that
  gets quoted later as a reason to stop looking.
- **`OVERSIZED PROCESS` is the one thing that could still speak**, because it is a single
  reading and is deliberately not gated on the pair count. That is a real partial answer: the
  08-12 event held 7.9 GB, so a recurrence would be reported *if a sample happened to land on
  it* — still under 1% per cycle, and only once it is already enormous.
- **RULED OUT FIRST, so it is not re-run:** the sampler is **not** misfiling recgov as rc.
  `classifyProfile` tests `.rc-bot-profile` BEFORE `auto-cart-bot` — the correct order, with the
  trap named in its own comment — and `PROFILES_DIR` defaults inside `auto-cart-bot`, so the
  PowerShell filter matches the rec.gov profiles as written. The attribution is sound; the
  CADENCE is the problem.
- **The 08-12 note is what makes this expensive rather than academic.** It says the process
  *"reached 7.9 GB in 46 seconds of the keep-warm starting"* — and CLAUDE.md already flags that
  "keep-warm" names two different things. If it was `keepSessionsWarm`, then the one family the
  instrument cannot measure is the family the only measured event points at.
- **THE FIX IS TO SAMPLE FROM WHERE THE EVENT IS, not to poll faster.** `keepSessionsWarm`
  knows exactly when its browser is open — it opened it. A sample taken inside that block
  catches it every time, at two samples per cycle instead of a 1-in-100 chance, and needs no
  new cadence and no extra PowerShell on an idle box. Same rule as `rc-keepwarm` posting its own
  verdict instead of a watcher inferring it, and as the RcReport channel: the process that knows
  is the process that reports.
- **BUILT 2026-08-15.** `createSampler`'s returned function takes `{ force, source }`;
  `keepSessionsWarm` calls it with `source: 'bot-keepalive'` inside its `withBrowser` callback.
  Two readings per cycle instead of ~0. Three properties are load-bearing and each is pinned by
  a test verified failing:
  - **It is AWAITED.** The scan runs in a separate PowerShell process, so an unawaited call
    lets `withBrowser` close the context first and the sample measures the absence it was
    added to see. `void` instead of `await` is a one-character version of this fix that looks
    right and records nothing.
  - **It is INSIDE the browser block.** Moved after it, same result.
  - **A forced sample does NOT reset the interval clock.** If it did, a keepalive would push
    the periodic series out by two minutes twice an hour — and a periodic sample landing just
    after a forced one is the ONLY way this instrument ever pairs two readings of a keepalive
    browser, which happens exactly when that browser failed to close, i.e. the runaway case.
    Resetting the clock would delete the case worth catching.
  - A forced sample lost to an in-flight read **says so in the log**: the interval can afford a
    skipped tick, but a forced one is the only sighting of a five-second browser and a silent
    miss reads as "the family was not running".
  - **`bot.mjs`'s `post()` had `source: 'bot'` bound as a constant**, so forwarding the source
    was part of the change; left alone, every forced reading would land in the series it exists
    to be told apart from. Pinned too — it is the third inert-fix shape here.
- **IT WORKS, AND THE REC.GOV FAMILY HAS A BASELINE FOR THE FIRST TIME (2026-08-15).** After a
  quiet-window update reached the box at ~09:00 UTC, `chromium_memory_samples` carries rows
  with `source = 'bot-keepalive'` — **two per 30-minute cycle**, at off-beat timestamps
  (13:01:19 and 13:01:48 against a periodic series on :07 and :35), which is the 15-45s stagger
  between the two enrolled users. `families observed` finally reads `rc, recgov`.
  **rec.gov: 7-9 processes, 134-145 MB, FLAT across nine consecutive cycles.** That is the
  number 175 consecutive `recgov 0` rows could not produce, and it is the first evidence about
  the family the 08-12 event pointed at.
  **It is a baseline, NOT an exoneration.** A steady ~140 MB says the ordinary keepalive
  browser does not leak; it says nothing about the 7.9-GB-in-46-seconds event, which by
  construction still cannot be caught by a 2-minute cadence unless a sample happens to land on
  it. `OVERSIZED PROCESS` remains the only thing that would report that.
- **A DIAGNOSTIC CAN BE MARKED STARTED AND NEVER ARRIVE.** Three `memory` commands were stamped
  `started_at = 04:01:24.014` — all three identical, i.e. one hand-out — and **the box's log
  shows no `? diagnostic` line for any of them** while the same log shows #87, #88 and the
  keepalives either side. `bot.mjs` was demonstrably alive throughout (samples every two minutes,
  and it answered the next command). `claimBotCommands` stamps `started_at` **as it hands them
  out**, so a response lost in flight leaves a command permanently "picked up, no answer yet" —
  which is the state CLAUDE.md already records as indistinguishable from a wedged command. Worth
  knowing before reading that state as the box being stuck.

### The box ran out of COMMIT, and both diagnostics looked the other way (2026-08-12)
`supervise.ps1` could not start a shell at all — *"the paging file is too small"*, then an
`OutOfMemoryException`. **A supervisor that cannot launch a shell cannot restart anything**,
so the process whose whole job is bringing the keep-warm and hold runner back failed at the
one moment it exists for, and silently, because it is the thing that would have reported.
- **It is COMMIT (RAM + page file), not disk.** `disk-free` answered 404 GB the same night,
  which reads as "not a space problem" and sends the question the wrong way. Windows could
  not *grow* a system-managed page file fast enough for a burst.
- **`list-processes` cannot see the culprit by construction** — it matches our node and
  PowerShell scripts only, so every Chromium (resident RC tab, rec.gov per-user profiles,
  any orphan a force-kill left) is invisible. Those are the large ones.
- **`memory`** reports RAM, commit against the limit, page file allocated/peak + whether it
  is system-managed, our Chromium count and private total, and the top 12 by private bytes.
  Ours is matched on our profile dirs — the same rule `stop-all` kills by — so the owner's
  own browser is only ever a count. Commit comes from `Win32_OperatingSystem`'s *Virtual*
  figures, not a perf counter: counter names are localised and the classes can be disabled.
- **`mini-pc\fix-pagefile.ps1`** reports by default, `-Apply` writes. Sizes derive from the
  box's own RAM (initial 1.5x floor 16 GB, max 4x floor 32 GB), it turns automatic
  management off FIRST (it otherwise overrides the write and ignores it silently), and it
  **reads the setting back**. It never reboots — the change is not live until one, and a
  restart ends the RC session exactly like `update.bat`.
- **Raising the ceiling is not reducing what sits under it.** "Chromium is the biggest
  consumer" is an inference from what runs, not a measurement; the first `memory` reading
  decides whether consumption also has to come down.
- **A `.ps1` trap now guarded mechanically:** a backtick continues a line only as the LAST
  character before the newline — one trailing space and it escapes the space, the statement
  ends there, and the parse error surfaces well below the cause. Invisible in every editor,
  and there is no PowerShell on the machine these files are written from.

### 2026-08-10 08:00 MISSED — a WEDGED keep-warm held the Chromium profile
South Carlsbad `#42` was `requested` and never carted. The runner was alive, tried on
every pass, and said exactly why: **`Chromium profile held by rc-keepwarm`**. The 046
machinery worked — this was one command to diagnose, against six hours of guessing on
08-07. Three of the four locked units were still free at 08:11 and were bookable by hand.
- **The keep-warm hung at ~04:48 UTC and held the profile lock for ten hours** without
  running its loop. `maybeAutoLogin` lives INSIDE the keep-warm, so no 07:45 sign-in
  either; the Okta session had expired at 04:35 UTC.
- **A STALE VERDICT IS NOT A DEAD ONE, and only dead rings the phone.**
  `autocart.rc_session` read *"RC accepts the session for 10h23m, checked 37401s ago,
  STALE"* — level `warn`. `holdAtRisk` fires on a session reported dead, so a verdict ten
  hours old with a hold 45 minutes out rang nothing and the 07:30 pre-flight showed amber.
  The "unknown is not healthy" rule was applied to the VERDICT and not to its AGE.
- **Profile preemption is cooperative and a wedged holder never cooperates.** The runner
  drops `.camphawk-profile-wanted` and waits 60s for the keep-warm's loop to notice; the
  lock's staleness handling only covers a CRASHED holder, not a hung-but-alive one.
- **`rc-check.bat` is reassuring in exactly the fatal case.** Its step 2 printed
  *"profile busy (rc-keepwarm) — skipping this pass, NOT a dead session"*, which is true
  and useless: it cannot tell "mid-pass, fine" from "wedged for ten hours". Only
  `rc-login.bat` clears it (kills by command line, deletes the lock).
- **Nothing watches the watcher.** Ten hours of silence from a process that reports every
  20 minutes should be an alarm on its own, independent of its last verdict.
- **Timing note, not a conclusion:** `bf271dd` deployed at 04:50:17Z, ~2 min after the
  keep-warm's last report. A deploy blip should log and retry, not wedge a loop — but an
  unhandled rejection on a failed POST would do exactly this, and that would make ANY
  network blip fatal. Unproven either way; worth ruling out before blaming the process.

### The auto-login lead is T−30 now, and "covered" is DERIVED (2026-08-11)
`RC_AUTOLOGIN_LEAD_MIN` 15 → **30**. The ceiling is arithmetic, not taste: a login at T−L
mints a ~60-minute token, and the bot needs it to **RELEASE at up to T+15** (the user has
the whole cart hold to tap claim, and `remove/cartentry` runs on the bot's session), so
`T−L+60 ≥ T+15` → **L ≤ 45**. At 30 the token still has 30m at the cart — twice the cart
hold — and a human gets 30 minutes to answer the phone, find a computer and sign in. **The
extra fifteen minutes are for a HUMAN, not for the bot to retry**; one attempt per release
stands, because repeated logins from this address are what cost 12h of IP block on 08-06.
- **`AUTOLOGIN_MIN_TOKEN_MIN` was a flat 20 and that was ALREADY WRONG at L=15.** "Covered"
  has to mean alive through the **release**, not through the cart: at 20 the bot sees a
  token with 21 minutes left, calls the hold covered, skips its ONE login, carts at T−0
  with ~6 minutes of token and then **fails the claim** — the user taps "I'm ready" and
  nobody releases the unit. Reachable by signing in by hand an hour before a release, i.e.
  exactly what the 07:30 pre-flight asks for. Now `LEAD + CART_HOLD_MIN + AUTOLOGIN_MARGIN_MIN`
  — the margin was a literal 5 until 2026-08-30 and is 15; a literal here became a SECOND,
  disagreeing copy of it the moment the live calculation's margin moved.
- **`ALARM_AFTER_MIN` 12 → 25 must move WITH the lead.** It is the fallback branch (the
  keep-warm reporting nothing at all); a login that fails still rings at once on the
  `auto sign-in failed` branch. At 12 against a lead of 30 it satisfies "inside the lead"
  and buys an **18-minute silence** in the only window where someone can act — so the test
  asserts *how far* inside (≤8m), not merely that it is.
- **THE TWO HALVES DEPLOY BY DIFFERENT ROUTES**: `ALARM_AFTER_MIN` is on Vercel (instant on
  a `master` push), `AUTOLOGIN_LEAD_MIN` is mini-PC code (needs `update.bat`). In the gap
  the alarm fires at T−25 while the login still waits for T−15 — **the 2026-08-09 cry-wolf
  bug exactly.** Land them together.
- `worker/autologin-lead.test.mts` holds the inequality: the constants live in three files,
  two languages, and `rc-keepwarm.mjs` cannot import `RC_CART_HOLD_MINUTES` from
  `limits.ts`, so it carries a copy the test pins. Verified against five regressions.

### UNATTENDED LOGIN WORKS — first clean production run, 2026-08-10 18:35Z
`rc-test-login.bat` ran the real `attemptLogin` from a genuinely signed-out state and got
`token exp in 60m; okta=ALIVE (exp 2026-08-11T06:35:53)` — a full-life access token AND a
12-hour Okta session, i.e. `keepSignedIn()` ticked the box. `session_live_since` and
`session_since` both moved, so it was a real transition, not a reconfirmation.
**This is the first time the path has succeeded unattended.** The three "failures" on
08-09 were the missing already-signed-in branch, not the login. A dead session is
therefore no longer automatically a human errand — but `maybeAutoLogin` still gets ONE
attempt per release and a CAPTCHA is still a full stop, so the human fallback stays.

### The RC keep-warm was never renewing anything (2026-08-08)
It opened a tab for **8 seconds every 20 minutes**. RC's SPA renews its Okta token on its
own timer somewhere inside the token's ~1h life, so the odds of that tab being open when
the renewal fires are **8s in 20min — under 1%**. It was not renewing the session; it was
observing it occasionally and reporting a token nothing had ever extended.
- **The measurement is what exposed it.** `session_since` / `session_live_since`
  (migration 047) record when the verdict CHANGED, not when it was last checked — the
  latter is overwritten on every 20-minute reconfirmation, so a session that died at 05:30
  and was probed at 13:40 read as "dead, 0 minutes ago". First real reading: **1h20m from
  sign-in to death**, about one access token.
- **THE "~8 HOUR SESSION CAP" I WROTE HERE WAS WRONG.** Two earlier figures (~9h, ~8.4h)
  were not measurements — nobody looked in between, so they bounded when we NOTICED. The
  first actual measurement falsified the hypothesis within hours of my writing it down.
  Do not reason from "when we noticed" again; that is what 047 exists to prevent.
- **The fix: the page stays open.** `warmResident()` holds the profile with RC loaded
  continuously; the 20-minute tick is now only a liveness check and measurement, not the
  keep-alive. A real user's browser stays open, and so does this one.
- **That needed the profile lock to grow PREEMPTION.** A permanent holder and a short-job
  holder cannot share a plain mutex — the runner would time out every time, at 08:00:00,
  on the one job that matters. The runner drops `.camphawk-profile-wanted`, the keep-warm
  sees it within a second, closes and releases; the runner works, clears the flag, the
  keep-warm reopens. Still exactly one Chromium on the profile. A stale request expires on
  its own — a requester that dies must not stand the keep-warm down forever.
- **Two ways a resident tab silently buys nothing**, both fixed: Chrome **throttles timers
  in background/occluded windows** (so the tab looks healthy and renews as little as the
  8-second visit did — launched with the three backgrounding flags disabled), and a
  **visible window gets closed** by anyone tidying up (it is headful because RC
  fingerprints headless Chromium; the loop now notices a dead context and reopens).
- **VERDICT IN, 2026-08-09: THERE IS NOTHING TO KEEP WARM.** The resident tab did not save
  it, and the silent-auth plan was built and then abandoned on the evidence. Three
  instruments agreed: the profile holds **no Okta session cookie at all** —
  `signin.reservecalifornia.com` carries only `DT` (device id), `ln` (remembered username),
  `luf_*` (last factor) and a `JSESSIONID` that dies with the browser. **No `sid`, no
  `idx`.** RC's own bundled `okta-auth-js` fires `authorize?prompt=none` on its autoRenew
  timer, finds nothing to authenticate against, fails, and **deletes the tokens** — which is
  precisely the log we captured. So `prompt=none` was never going to work for us either: the
  challenge does live on the credential form and not on a cookie exchange, but there is no
  cookie to exchange. **The access token IS the session, and it lasts ~60 minutes.**
  > **BOTH LEGS OF THIS HAVE NOW FAILED (2026-08-12).** The premise is false — `idx` is in
  > the profile, and has been since `keepSignedIn()` started being ticked. And the
  > corroborating evidence, `renewByReload` never producing a fresher token, was a broken
  > measurement that never cleared the storage the SDK reads. **Do not cite this paragraph
  > as settled** — see "THE RENEWAL WAS MEASURING ITSELF" above. What survives is the
  > narrower, still-true finding: the SDK's background `autoRenew` fails and deletes the
  > tokens. What is now open is whether a BOOTSTRAP with empty storage renews, which is a
  > different code path and the one observation we have says yes.
- **Therefore: obtain a token shortly before the hold.** `rc-autologin.mjs` +
  `maybeAutoLogin` sign in ONCE, within `RC_AUTOLOGIN_LEAD_MIN` (15) of a real release,
  only when the current token genuinely will not cover it, **one attempt per release
  forever** (tracked by release time, so a failure can never become a loop), and a CAPTCHA
  is a full stop that wakes a human rather than a slower retry. The guards are the design:
  a login is the act that got the household IP blocked for 12h on 08-06 — but that was
  repeated logins **from fresh profiles**, and the `DT` cookie in the persistent profile is
  the thing that tells Okta this is a machine it has seen before. Every failure path reports
  so the 07:30 pre-flight and a push tell the owner to sign in themselves; **losing a hold
  because we did nothing is recoverable, losing the household IP is not.**
- **The password lives in `credstore.mjs` (DPAPI, CurrentUser), NOT in `.env`.** Two more
  lines beside `AUTOCART_TOKEN` was very nearly what shipped and would have been wrong: the
  file is git-ignored but readable by every process on the box, and this machine is
  routinely screen-shared. Saved once with `mini-pc\rc-save-password.bat` (echo muted for
  the same reason). `credentials()` is not exported, and `worker/rc-autologin.test.mts`
  asserts that plus every line the plaintext may appear on.
- **The first `--save-login` ECHOED THE PASSWORD** (reported 2026-08-09, fixed same day).
  It created a `readline` for the email prompt and left it OPEN while reading the password
  raw — and readline in terminal mode echoes every keypress itself. `setRawMode(true)`
  silences the TTY driver, not another library listening on the same stream. Reproduced
  under a pty before fixing, which also exposed a second bug: the old handler compared the
  whole CHUNK to `'\r'`, so a PASTED password (one buffer) fell through and was stored with
  a trailing carriage return. Hand-typed input was fine; pasted was silently wrong. It now
  asks twice, because a hidden field with no confirmation makes a typo undiscoverable until
  07:45, where it reports "check the password" — indistinguishable from a real change.
- **AN OKTA SESSION EXISTS NOW, AND THAT REOPENS A CLOSED QUESTION (2026-08-09 21:40 PT).**
  The first successful `--test-login` reported `okta=ALIVE (exp 2026-08-09T16:36:23)` — a
  200 from `/api/v1/sessions/me` with a **~12-hour expiry**. Every earlier reading was
  `okta=GONE(404)`, which is what "THERE IS NOTHING TO KEEP WARM" below was built on.
  **The likeliest cause is the tick-box:** the ported login calls `keepSignedIn()`, and the
  hand-rolled one never did — every previous session was established without "Keep me
  signed in", so of course Okta issued nothing persistent. The human `--login` path only
  *asks* a person to tick it.
  **ANSWERED THE SAME NIGHT — AN OKTA SESSION IS NOT ENOUGH.** Measured across four
  20-minute passes: `exp in 60m → 40m → 20m → gone`, `renewed=no` throughout, a perfectly
  linear countdown to the token's ~60-minute life. At 05:44Z keep-warm reported, in its own
  words: **"no token at all — signed out; okta session STILL ALIVE — the silent renew is
  failing, not the login"**. That branch re-primes before judging, so it is not the
  stale-token mistake, and it asks Okta directly rather than inferring.
  **So the conclusion below STANDS, but its REASON was wrong.** It said there was nothing
  to renew against; there now demonstrably is — a live Okta session with a 12h rolling
  expiry — and RC's app still fails to exchange it for a new access token, then deletes the
  token it had. The blocker was never the missing session. That narrows the diagnosis
  rather than reopening it: `prompt=none` fails for some other reason (origin, PKCE state,
  third-party-cookie policy in an automated Chromium), and finding out is real work with no
  guarantee. **`maybeAutoLogin` remains the mechanism, not a fallback.**
  Caveat worth keeping: `oktaSessionAlive()` reads `/api/v1/sessions/me`, which itself
  refreshes Okta's idle timer — so the rolling 12h window may be us extending it, not RC.
- **`rc-autologin.mjs`'s sign-in is PORTED FROM `rc-probe.mjs`, and reinventing it cost two
  failed runs (2026-08-09).** The probe signed in unattended and carted on 08-06; the new
  module was then written from scratch, four hundred lines from a working implementation in
  the same directory, and hit the same walls the probe had already documented. **Before
  touching the login flow, read `rc-probe.mjs`'s `signIn()`.** The differences that mattered:
  **Enter BEFORE the button** (Okta disables Next mid-transaction, so a click reports
  success and does nothing — this file had it backwards); the email step is **flaky, not
  blocked**, so three rounds with a **reload** between, which clears a half-finished
  transaction; **"Keep me signed in"** was never ticked; **Okta's error banner**
  (`[role="alert"]`, `.okta-form-infobox-error`) was never read, so "check the password" was
  a guess from which timeout expired rather than RC's own words; the email was `fill()`ed
  and never read back; and a **DOM-click fallback** separates "Okta refused us" from
  "Playwright could not hit the button". Not ported: the probe's willingness to continue —
  one login per release still stands, and a wrong password or CAPTCHA stops dead.
- **`mini-pc\rc-test-login.bat` proves it works BEFORE the morning it matters.** It clears
  the localStorage token **only** — never cookies, and do not sign out via RC's own menu
  either: the `DT` cookie is the device identity, and losing it makes the login look like a
  fresh profile, which is the exact shape that got the IP blocked. Then it runs the real
  `attemptLogin`. **A failure leaves you signed OUT**, and the script says so and points at
  `rc-login.bat`.
- **THE HOLD RUNNER WAS REPORTING A FALSE GREEN (found 2026-08-09, fix needs `update.bat`).**
  It called `reportSession(true)` whenever `primeToken` returned *a* token — presence, not
  liveness. At 05:42:38Z the access token had expired six minutes earlier and okta-auth-js
  had not yet cleared it, so the runner announced a healthy session, **overwrote keep-warm's
  correct "dead" verdict 80 seconds before keep-warm could state it, and moved
  `session_live_since`** — corrupting the lifetime measurement migration 047 exists to take.
  A green `autocart.rc_session` over a dead session is the 2026-08-07 failure exactly, and
  the **07:30 pre-flight reads that check.** Same family as `notifications.status = 'sent'`
  meaning only "Twilio returned 2xx" and `IsSuccess: true` on a cart that held nothing.
  Fixed with a **local** `tokenSecondsLeft` decode, never a network probe: the report is
  fire-and-forget because at 08:00:00.000 nothing may go in front of the precart. An
  undecodable token now reports NOTHING rather than guessing — keep-warm asks RC properly
  every pass and is the authority on a positive verdict.
- **THE FIRST REAL 8AM HOLD WORKED, 2026-08-09: carted at 15:00:02Z, TWO SECONDS after the
  release, claimed 15:02:01, released.** Every link that had broken before held at once —
  the runner picked it up (unlike 08-07), the cart was correctly timed (unlike 08-08's 85s
  early), the session was live, and the hand-off completed for the first time.
- **AND THE MORNING'S THREE FAILURES WERE ALL MINE, from one missing check.**
  `attemptLogin` had no already-signed-in branch. `maybeAutoLogin` runs because the token it
  can SEE is gone — but loading RC's home page is itself what makes the SPA fetch one, so by
  the time it looked for a sign-in link there was a healthy session and no link to find. It
  reported "the sign-in form did not load", which drove a dead-session verdict, which fired
  two alarm calls, which sent me chasing a phantom pre-check-in modal and telling the owner
  to sign in by hand — over the session that carted the site fifteen minutes later. The
  token proved it: 45 minutes left on a 60-minute token at 15:00 puts its issue at 14:45,
  exactly when the "failed" login ran. **It now asks `isLive()` after the page load, before
  hunting for a form.** Note the banner RC showed ("You have a reservation arriving on
  today's date") is only ever rendered to a SIGNED-IN user — it was evidence of success and
  I read it as the obstacle.
- **The alarm gate was structurally guaranteed to cry wolf** (fixed same day). It fired at
  `ALARM_LEAD_MIN` (45) while the repair does not run until `RC_AUTOLOGIN_LEAD_MIN` (15) —
  so on EVERY hold, not as an edge case, the phone rang half an hour before the thing that
  fixes it. It now waits for `auto sign-in failed` in the reported detail, or for the login
  window to close (`ALARM_AFTER_MIN` = 12, just inside the lead). `worker/alarm-gate.test.mts`
  fails against the 45-minute version.
- **And its rate limit was dead code:** `MIN_GAP_MS` was 15 minutes against a keep-warm that
  reports every 20, so every report cleared the window and nothing was ever suppressed. It
  read like a safeguard in review. 30 minutes now, and the test asserts it exceeds the
  cadence rather than asserting a number.
- **A dead session with a hold <45 min out now RINGS THE PHONE** (`lib/notifications/voice.ts`,
  `holdAtRisk`). Not a louder push: iOS Critical Alerts needs an entitlement Apple grants to
  medical/public-safety apps, and Time Sensitive is a *native* entitlement that would cost
  the 1.0's review-queue position and still is not an alarm. **It calls TWICE, 45s apart,
  and the repeat is the MECHANISM not a retry** — iOS lets a second call from the same
  number within three minutes through Do Not Disturb. Each call rings 25s so the first has
  stopped before the second lands. **Scheduled with `after()` from `next/server` plus
  `maxDuration = 90`**: a bare `setTimeout` in a route handler is frozen with the invocation
  and silently never fires, while the first call still goes out and every log line reads as
  success. Test it from Admin → System Health → **"Ring my phone now"** — the one delivery
  canary that cannot run itself, and worth a button because a 21210 ("not voice-capable")
  is only knowable at call time. `AUTOCART_ALARM_PHONE` overrides the destination.
