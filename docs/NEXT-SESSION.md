# Next session — start here

*Rewritten from scratch **2026-09-10** (main lane). It had reached 1,603 lines of stacked dated
blocks, which is the opposite of a handover.*

**This is a HANDOVER, not a permanent doc. `CLAUDE.md` owns every finding.** Nothing here is the
only copy of anything — the ten items that were, got folded into `CLAUDE.md` before this rewrite
(see "TEN THINGS THAT LIVED ONLY IN THE HANDOVER"). **Keep it this way: when a block here goes
stale, delete it rather than striking it through.** Strikethrough belongs in `CLAUDE.md`, where the
correction is itself the record; here it is just weight.

---

## 0. Ground yourself — four commands, in this order

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

## 1. State — 2026-09-10 17:10 UTC

| | |
|---|---|
| master | `7333940` (#325) — **verify against `origin/master`, this line ages** |
| mini-PC | `7333940` — box and master agree; the commit trigger below is LIVE on it |
| health | **18 of 19 ok**, one documented-benign warn |
| fleet | 3/3 shards held, 12 watches |
| holds | **none live**, so the 02:00-05:00 PT update window is open |
| migrations | highest `076`; **main's block `077-079`, side lane `080+`** |

**The one warn is `autocart.rc_session`, and it is the ORDINARY between-releases state.** The RC
token lives ~1h and `maybeAutoLogin` restores it at T−30 of a real release. **Do not act on it, and
above all do not run `rc-login.bat`** — that force-kills the Chromium the token lives in. This
exact reading has sent people to the box twice over sessions that repaired themselves.

---

## 2. The leak — where it actually stands

**Nothing is assigned. There is one lead and it needs your word before it is taken.**

**ESTABLISHED, and none of it needs re-deriving:**

- The ramping renderer maps **~16,384 regions of 2 MiB = 32 GiB exactly**, one allocation base
  each, all anonymous, all READWRITE, pagefile-backed and largely untouched.
- **THE 2^14 CAP IS REAL AND SEPARABLE FROM THE COMMIT LIMIT** (settled 2026-09-10). Against the
  headroom each burst actually had, **9 of 12 walks had room for 1,091-2,808 MORE sections and
  stopped at 16,384 ± 3 anyway**; the 3 that fell short are exactly the 3 lowest commit limits.
  That closes the live doubt that the count was an artifact of when the scan fired.
  **"The three lower readings are consistent with catching a fill in progress" is WITHDRAWN** —
  they are the commit-limited three, which makes such a count a FLOOR on what the allocator
  wanted rather than a sample of its progress.
- **THE WALK-TIME "a few hundred MB from the commit limit" IS THE AFTERMATH, NOT THE STOP.** The
  walk fires ~77 s late and the private-byte climb eats the headroom in between. The sequence is
  three acts: a <=34 s burst of 16,384 sections, then ~2 minutes of private climb at
  450-900 MB/min that walks the box to the edge, then the bail.
- **DO NOT enlarge the pagefile.** On this evidence that buys a bigger burst up to 32 GiB and
  nothing else. And note the real danger is not the peak: it is that the box is walked to within
  a few hundred MB of its commit limit, which is how `supervise.ps1` could not spawn on 08-12.
- **THE 32 GiB ARRIVES IN A BURST OF <=34 SECONDS** (2026-09-10), measured twice at sub-minute
  resolution off the `bot-keepalive` forced samples: commit goes +34,766 MB in 33 s and +29,001 MB
  in 34 s, while `rc_mb` is still at 1,688-1,924 MB. **The mapping and the private-byte climb are
  two different curves and every instrument so far has watched the second one.** At 2 MiB a section
  that is ~450-500 sections/second — not one-per-request, not one-per-frame. **So the question is
  "what tries to allocate 32 GiB of shared memory in a burst, in 2 MiB units, stopping at exactly
  16,384", not "what leaks 2 MiB at a time".**
- **THE RAMP SCAN NOW FIRES ON COMMIT AS WELL AS ON `rcMb`, AND IT IS LIVE ON THE BOX** (#325,
  `RAMP_SCAN_COMMIT_MB = 9000`). The old trigger read *private bytes*, which is the second curve —
  backtested against every stored burst it fired **60-162 s late on 11 of 19 and never early**, i.e.
  it was watching the aftermath by construction. **A second trigger, not a replacement**: `rcMb`
  still fires alone, and the readout names which one did (`trigger rc` / `trigger commit` /
  `trigger both`). **Nothing has exercised it on a real burst yet** — the first natural ramp does.
  A `ramp-scan` row whose `trigger` is `commitUsedMb` with `rcMb` still in the hundreds is the
  reading that says it worked.
- **The mapping is essentially UNTOUCHED** — working set 2,965 MB against private 2,979 MB, so
  26.7 GB of `commit/mapped` is barely resident. It also carries **~1 retained handle** and
  **~4.0 KB of paged pool** per section (deltas against the same scan's own control), so the owner
  holds the region object, not just the view, and these are ~16k distinct kernel section objects.
- Its **main thread spins at 100% of a core** while a control renderer in the same scan burns 0 ms
  — which is why three instruments on three different CDP calls all got silence. CDP is serviced
  on that thread.
- **"Spinning" is precisely "the microtask queue never empties"** (2026-09-10). `HandlerAdded` *is*
  being called, so promises are settling and microtasks are draining — while **posted tasks never
  run**. The event loop never advances to the next task. That is the mechanism behind every silent
  instrument, and behind anything whose release path is a posted task.
- **VMSTACK put the loop in native code**, 42 of 48 samples inside `chrome.dll` — which
  distinguishes native from JIT code, and **not** what drives it. It is `HandlerAdded`, driven by
  the page's promise rejections (below).
- The **RAM arm has not fired since August** — 15+ consecutive ramps, because untouched commit
  never lowers free RAM, so it watches the one resource that is not running out. (It *did* fire,
  three times on 08-18/19, with its own `RUNAWAY` line; "never fired" is wrong and gets quoted.)
  What ends a ramp now is `bail:ramp`, 3-35 s after the scan. Containment is holding at
  **3.4-4.6 GB** against 8-9 GB untreated.

**REFUTED — do not re-run these:**

- **The command buffer / `MappedMemoryManager`.** The GPU-off trial ramped on trial one with the
  identical 32 GiB signature and a GPU process flat at 20 MB. One counterexample refutes; it came
  with the whole walk attached. The 2 MiB match was a coincidence — 2 MiB is a very common
  granularity.
- **Symbols.** The one reachable symbol server 404s our exact key, controlled three ways. Its
  near-neighbours share our TimeDateStamp with a different `SizeOfImage`, so borrowing one would
  name the wrong function confidently.
- **A rejection counter on the resident page** (2026-09-10, refuted *before* building it). The DOM
  `unhandledrejection` event is dispatched from `ProcessQueueNow`, which `ProcessQueue()` **posts
  as a task** — so it, and `page.on('pageerror')`, go silent during exactly the event they would be
  built for. Predicted reading ~0.
- **`RejectedPromises` as the memory.** `reported_as_errors_` is capped at 1,000
  (`kMaxReportedHandlersPendingResolution`), so it cannot grow without limit — consistent with the
  heap trail at 8-11 MB flat.

**THE SPINNING FUNCTION IS NAMED (2026-09-10):** `blink::RejectedPromises::HandlerAdded`,
`third_party/blink/renderer/bindings/core/v8/rejected_promises.cc`, line 222. Confirmed four ways —
the `FROM_HERE` file and function strings and the line number are **in the binary**, and the source
matches the disassembly with nothing left over. Full entry in `CLAUDE.md`; do not re-derive it.

- **It is the SPIN, not the mapping.** `HandlerAdded` scans and erases; it allocates nothing but one
  `BindState` per match. The 32 GiB still has no mechanism.
- **So the question is now: what accumulates as 2 MiB pagefile-backed shared sections while a main
  thread that never yields fails to drain it?** That is sharper than "what leaks?".
- **The 2 MiB data pipe is DROPPED (2026-09-10), not merely unpromoted.** Pairing every walk with
  its own request counter gives requests spanning **717x** (109 -> 78,188) against sections spanning
  **1.23x**, with the two *smallest* request counts producing two of the *largest* section counts.
  Full table in `CLAUDE.md`. Do not re-promote it on the strength of the 2 MiB match.
- **One recorded conclusion is weakened:** "RC's own JavaScript is not the loop and there is no fix
  on our side of the page". The loop is native, but it is *driven* by JS promise rejection.

### THE BRIEF FOR A SESSION THAT WANTS TO FIX IT

**There is exactly one unanswered question: what maps the 2 MiB sections, and why are they never
released.** Everything else above is settled. Two routes, and **both need the owner's word before
starting** — this project's record is three mechanisms guessed at a session's cost each.

**ROUTE A — name the allocator from source.** This is the method that named the spin on 2026-09-10,
and it needs **no ramp, no box update and no symbols**. `raw.githubusercontent.com` serves Chromium
by path (200, controlled) and `mcp__github__search_code` with `repo:chromium/chromium` indexes it.
Look for something that satisfies **all four**, and treat any candidate meeting fewer as unproven:
1. maps **exactly 2 MiB** pagefile-backed anonymous shared sections,
2. **one section per object** (the walk sees one allocation base per region),
3. is **released on the main thread or from a posted task** — that is what makes a wedged event
   loop retain them,
4. plausibly **caps near 16,384**, since the count lands within 0.02% of 2^14 on the top cluster.
**CRITERION 4 IS THE ALLOCATOR'S NUMBER, NOT WINDOWS' — settled 2026-09-10, so do not spend a
session re-raising it.** A 2 MiB section costs exactly 4 KB of paged pool (512 PTEs x 8 bytes,
measured at 4.015-4.017 KB over a 1.23x range of counts), so *"caps at 16,384 sections"* and
*"caps at 64 MiB of paged pool"* are the same sentence in different units — and a Windows quota
would produce 2^14 with no Chromium constant involved. Killed off stored rows two ways: over the
six capped walks the COUNT is the tighter quantity (±0.012% against the byte total's ±0.045%),
and the rank correlation is POSITIVE where a binding byte ceiling predicts a flat pool with the
count varying inversely. Full entry in `CLAUDE.md`.
**There is no standing candidate — the data pipe was dropped on 2026-09-10.** Two limits on the
method, both measured: every real code-search host is **000 at the proxy**, and
`mcp__github__search_code` over `repo:chromium/chromium` works **only for unique identifiers** (a
control on `kLargerDataPipeAllocationSize` returned it; `"2 * 1024 * 1024"` returned 3 files). **So
Route A is reason-then-fetch-by-path and cannot enumerate.** The burst reframing below is what makes
a fresh hunt worth anything: look for something that **chunks a large size into 2 MiB shared
segments and caps at 16,384**, not for something that leaks one at a time.

**ROUTE B — stop the spin instead of the allocator.** The only route that could fix this without
naming what allocates, and the only one plausibly on our side. If the main thread yields, posted
tasks run and anything waiting on one drains. The driver is RC's SPA settling promises at enormous
rate; the long-standing candidate is a retry loop against a 401'd session, which the RDR burst
(**69,060 asks, zero answers of any kind**) is the shape of.
- **THE CHEAP FIRST READING IS NOT AVAILABLE — checked 2026-09-10, and the suspicion was right.**
  `rc_runner_heartbeat` is a **single row**; 047's `session_since`/`session_live_since` are two
  columns updated in place, and 047's own header says the transition "is overwritten by the next
  confirmation of it". `BOT_EVENT_KINDS` is only `ramp-scan`, `tab-close`, `request-counts`,
  `mem-dump` — nothing carries a session verdict. **So there is no time series and the ramp/session
  coincidence cannot be asked retrospectively.** Taking it means recording session state alongside
  ramps first, i.e. building a fifth instrument.
- **Parking the resident page is still refused**, and for a reason unrelated to memory:
  `checkAndReport`'s localStorage rule would make the session verdict permanently inconclusive and
  silence `autocart.rc_session` and the phone alarm.

**AND AN HONEST THIRD ANSWER: there may be no fix we own.** If the driver is RC's own SPA, the
options are "don't leave its page resident" (refused above) or "keep the session healthy so it does
not loop" — both product decisions rather than bug fixes. **Containment already works**: `bail:ramp`
caps ramps at 3.4-4.6 GB against 8-9 GB untreated and the box never goes dark. Saying so is a
legitimate outcome; quietly building a fifth instrument is not.

### Do not do these, each for a recorded reason

- **Do not force a ramp out of impatience, and separate the two numbers before quoting either.**
  **Landing in the `okta=GONE` cell is a GATE and it is reliable** — four for four since #296 added
  the token gate. **Ramping once you are there is a COIN**: of the five ordered attempts two ramped,
  and of the seven `okta=GONE` password trips on record three did. Forcing also spends the warm-up's
  one turn per Okta lifetime and a password submission from an address that has eaten a twelve-hour
  block. Natural ramps arrive every **2.3-18.6 h** (median ~5.4) and every instrument is armed.
  **A forced attempt was spent on 2026-09-10 16:58 and missed** (16 s, no ramp), so that Okta
  lifetime's turn is gone and the next GONE window is ~12 h out.
- **Do not lower `LOW_RAM_MB`** — that killed a working repair on 08-19.
- **Do not lower `MEM_DUMP_STALL_MS`** — 90 s was measured against 133 tab-closes, and a wedged
  renderer contributes zero allocator dumps anyway, so it would fire more often and learn nothing.
- **Do not build Track B** — the renewal's Okta trip is measured flat at −4 MB.
- **Do not park the resident page** — refused by `checkAndReport`'s localStorage rule, which would
  silence `autocart.rc_session` and the phone alarm.
- **Do not rebuild the heap trail, Track A, the RAM arm, or the dump's ownership graph.** Each is
  blind to this allocation for a reason that was knowable before it was built — `JSHeapUsedSize`
  excludes external memory; the sampling profiler reads 1-74 MB against 8-9 GB; untouched commit
  never lowers free RAM; and a wedged renderer contributes zero allocator dumps at every level.

---

## 3. Other things open — all detail is in `CLAUDE.md`

- **One screenshot outstanding, and only the owner can take it.** The Android 16 safe-area fix is
  deployed and web-side, but `env()` is 0 in headless Chromium and this container cannot reach the
  live site, so **nothing has seen it on a phone.** Open `/claim` or `/privacy` on the Pixel; the
  CampHawk mark should clear the clock. Ten seconds.
- **THE APP/STORE SURFACE IS THE SIDE LANE'S AS OF 2026-09-10** (owner's call, recorded in
  `docs/LANES.md`): `docs/APP-STORE.md`, `docs/PLAY-STORE.md`, `docs/STOREKIT-PLAN.md`, both store
  consoles and RevenueCat's. **A main-lane session should not pick these up** — read
  `STOREKIT-PLAN.md`'s "PICKING THIS UP?" block if you need the state, and hand the work over.
  - **`src/lib/**` stays MAIN regardless of topic**, including `native/purchases.ts`,
    `store-plans.ts` and the RevenueCat webhook — a change under `src/lib/auth.ts` or `limits.ts`
    is in `worker-deploy.yml`'s `paths:` and restarts all three pollers.
  - **Still MAIN's, and still open:** HMAC is reported-not-enforced, and out-of-order webhook
    delivery is unhandled (needs a migration, so main's block).
- **Play production release 25 was IN REVIEW as of 2026-09-01 — nine days ago, and nobody in a
  session can read the Play console, so treat that as a date and not as current state.** Ask the
  owner before acting on it. Whenever it lands, the first REAL purchase is what exercises
  webhook → row → entitlement for the first time, carrying two known gaps (HMAC is reported, not
  enforced; out-of-order delivery unhandled). A licence-tester purchase does NOT exercise it —
  `ignoreReason` correctly drops every non-PRODUCTION event, so an absent `subscriptions` row is
  the guard working, not a broken webhook.
- **The release-window Routine self-disables 2026-09-12**, ~2 firings left.
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
- **Two sessions can be the SAME lane** — the branch name does not distinguish them and
  `ListAgents` cannot see a sibling elsewhere. An empty list is not exclusive use of the database.

---

## 5. Traps that have actually fired

- **Never read an exit code through a pipe** — `| tail` reports `tail`'s status and cuts every
  `not ok` line. Two false greens from one command.
- **Read the instrument before reasoning about the code.** The failures here are overwhelmingly
  instruments that were running and unread.
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
- **`sqlit` interpolates, it does not bind**, and throws on a plain object — stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
