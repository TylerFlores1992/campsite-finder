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

## 1. State — 2026-09-11 (leak session)

| | |
|---|---|
| master | `a592e21` (#336) — **verify against `origin/master`, this line ages** |
| mini-PC | **`a68a6d2`** (`bot-ask git-status`, 2026-09-11). **A BOT-SIDE UPDATE IS NOW GENUINELY OWED — #336 changed `ramp-bail.mjs`, `ramp-arm-probe.mjs` and `bot-commands.mjs`** — so `autocart.bot_version` correctly reads *"MISSING bot-side changes"*. **That is EXPECTED and is not a fault, and it needs NO action: the box updates itself in the 02:00-05:00 PT quiet window, which is how it took `a68a6d2` overnight on 09-11.** Do NOT press "Update now" — a forced update ends the RC session for nothing. Confirm arrival with `bot-ask git-status`, never `autocart.bot_version` (it COALESCEs and can show a stale sha beside a live heartbeat). |
| last ramp | **2026-09-11 05:28 UTC, on a browser 611 MINUTES OLD** — five times older than any previously recorded, because ten hours of renewal silence meant nothing recycled it. **It breaks the age framing**: old and burst-free on both axes that defined the 09-10 17:53 JIT outlier, yet its `VMSTACK` reads like a young one (22 distinct of 48, JIT down to 2, `HandlerAdded` carrying 28). So neither age nor burst presence predicts the stack profile, and trip type is the only surviving candidate. Walk: 14,434 regions / 14,433 bases / 28,868 MB, all anonymous — a `middle` event that stopped **1,950 short of 2^14 with thousands of MB of headroom**. Ramp dump `target-silent` for the **fourth** time (`MDPROC` has 8 pids, the walk's TARGET 14676 is not one) — **do not spend another ramp on it.** See CLAUDE.md → "AND THE BROWSER THAT RAMPED WAS 611 MINUTES OLD". |
| **the overnight answer** | **TAKEN, and it is the strongest form: 599.8 minutes — ten hours — with ZERO `bot_events` of any kind** (19:31:28 → 05:31:15 UTC), while `chromium_memory_samples` posted **312 samples** across the same window. That is the healthy self-renewing regime holding overnight, and **the silence is itself the proof the token never lapsed** — `planRenewal` acts on `leftS <= 0`, so ten hours of no trips means every poll found a live token, i.e. RC's SPA re-minted silently and unaided. *(It proves a non-expired token was present, not that RC would have ACCEPTED one — `session_ok` is a different fact.)* Then it **resumed and failed exactly as predicted**: 11.5m, 11.3m (minGap), then **31.5-minute backoffs for six hours straight**. The 96% failure rate watched forward instead of computed backward. CLAUDE.md → "THE OVERNIGHT ANSWER IS IN". |
| health | 16 of 19 ok, **and all three warns are the documented-benign set**: `autocart.rc_session` (RC rejects the token — the ordinary between-releases state, the token lives ~1h and `maybeAutoLogin` restores it at T−30), `autocart.bot_version` (the box has not picked up #336 yet — see the mini-PC row), and `autocart.rc_login` (a rehearsal STAND-DOWN, not a failure). **Above all do not run `rc-login.bat`** — it force-kills the Chromium the token lives in, and that reading has sent people to the box twice over sessions that repaired themselves. |
| fleet | 3/3 shards held, 12 watches, heartbeat 5s — checked after #336's worker deploy |
| holds | **none live**, so the 02:00-05:00 PT update window is open |
| **the leak** | **DIAGNOSED AND CONTAINED, NOT FIXED.** 6 onsets in the 48h to 09-11, `bail:ramp` on all 6, peak `rc_mb` 4,661 MB (was 8-9 GB), free RAM never under 5,140 MB. **The residual is COMMIT**, and as of #336 **option A is BUILT and option B is ANSWERED AND OFF** — §2.2. What is left is a named, measured, NOT-STARTED piece of work: §2.5. |
| migrations | highest `076`; **main's block `077-079`, side lane `080+`** |

**ALL THREE WARNS ARE ORDINARY AND EACH HAS A DESTRUCTIVE-LOOKING REMEDY — do not act on any of
them.** `autocart.bot_version` says *"MISSING bot-side changes"* because #336 is bot-side and the
box has not reached its quiet window yet; it clears by itself. `autocart.rc_session` reading dead
between releases is the RC token's ~1h life. `autocart.rc_login` standing down inside its own
once-per-20h gate is a stand-down, not a failure. **Above all do not run `rc-login.bat`.**

**AND DO NOT READ A RED `autocart.rc_session` WITHIN A FEW MINUTES OF A MERGE AS A REAL DEAD
SESSION.** A numeric `carted` test fixture (`REAL = '0'`, five minutes out) passes `REAL_UNIT`, so
for the length of any `npm test` run — CI on every merge included — the health route counts a hold
ahead and the check reddens over a session with nothing wrong with it. Check whether a Verify run
was in flight first. Full entry in CLAUDE.md.

---

## 2. The leak — DIAGNOSED AND CONTAINED. **IT IS NOT FIXED.** Read before touching anything memory-related.

**`CLAUDE.md` → "THE 32 GiB CEILING IS `base::SharedMemorySecurityPolicy`" and the block directly
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

### 2.2 THE COMMIT RESIDUAL — A BUILT, B ANSWERED AND OFF, C and D open (§2.5 is what is left)

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
- **C — stop the wedge.** The only option addressing the cause. **The recorded counter-argument is
  strong**: a browser replacement is 8x enriched before a ramp, so recycling more often may make
  it worse. Parking the resident page stays refused (it would silence `autocart.rc_session` and
  the phone alarm). Genuinely unexplored: a *leading indicator* of the wedge.
- **D — do nothing, deliberately.** A real option: 6 for 6 on the bail, free RAM never under
  5.1 GB, the mapping hard-capped, and **no human needed since 2026-08-17.**

### 2.3 A SECOND OPEN ITEM, and it is an instrument gap rather than a doubt

One pipe per response needs ~14,433 responses in that renderer inside the burst, and the resident
page's counter read **20 lifetime requests**. `requestCounter.attach(page)` is on the RESIDENT
page alone and `withNetworkTrace` is equally page-scoped, so **dedicated workers, service workers
and the throwaway tabs are invisible to both**. **Do not read "20 requests" as "20 responses in
that renderer."** The one-line fix is `context.on('request')`, which closes the service-worker and
throwaway-tab halves at once; **dedicated workers are NOT settled**, so do not widen the claim.
Bot-side.

### 2.4 STOP DOING THESE

- **Hunting a 2 MiB constant.** The size grep over the whole checkout is clean; ipcz is the worked
  example of a 2 MiB allocation that is COMPUTED, and a size grep is blind to those.
- **Citing "the sections are NOT base shared memory".** That came from the 09-07 VOID dump of a
  healthy *replacement* browser; all four ramp dumps are `target-silent`, so `shared_memory` has
  never been read for a ramping renderer, and the cap proves it is base shared memory.
- **Spending a ramp on the memory dump.** A wedged renderer contributes ZERO allocator dumps at
  every level — settled off-box by `dump-wedge-probe.mjs`.
- **Forcing a ramp.** It is 3-in-6, spends the warm-up's one turn per Okta lifetime, and costs a
  password submission from an address that has eaten a twelve-hour block. Nothing outstanding
  needs one.
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
  the wedge is RC's own promise loop — **frequency is the only variable we own.**

## 3. Other things open — all detail is in `CLAUDE.md`

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
- **Play production release 25 was IN REVIEW as of 2026-09-01 — nine days ago, and nobody in a
  session can read the Play console, so treat that as a date and not as current state.** Ask the
  owner before acting on it. Whenever it lands, the first REAL purchase is what exercises
  webhook → row → entitlement for the first time, carrying two known gaps (HMAC is reported, not
  enforced; out-of-order delivery unhandled). A licence-tester purchase does NOT exercise it —
  `ignoreReason` correctly drops every non-PRODUCTION event, so an absent `subscriptions` row is
  the guard working, not a broken webhook.
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
