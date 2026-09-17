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

## 0.5 DO THIS FIRST — the cure is live, has never fired, and forcing it is DENIED to an unattended session

**The box is on the cure** (`6fc7292` contains `e92a5a6`/#355, checked with `git merge-base
--is-ancestor` rather than by reading a version field), and the arm is unconditional in the
watchdog timer. So "it never ran" is ruled out structurally. **§2.6 is the full account.**

**Ask this ONE query before anything else. It is the whole state of the proof:**

```sql
SELECT count(*) FROM bot_events WHERE detail->>'reason' = 'wedge-recycle';   -- 0 as of 09-17 05:10
```

- **A ~30 s cure can fit entirely between two two-minute memory samples, so the SERIES IS THE
  WRONG INSTRUMENT.** That event is in Postgres and cannot roll out of a log window. **Do not
  read a quiet `chromium_memory_samples` as the cure working.**
- The detector itself is validated: `detail->>'reason'` resolves on 5 of 5 stored
  `request-counts` rows, and the keep-warm emits exactly `snapshot({ reason: 'wedge-recycle' })`.
  So a zero is about the subject, not the query.
- **AND THE ZERO NOW CARRIES ONE POSITIVE RESULT.** The arm has probed every 10 s since
  21:50:59 UTC on 09-16 — **~2,400 probes across ~20 browser lives**, through renewals,
  stand-downs, keepalive checks and five forced restarts — **with zero false positives.** That
  is the half of the cure that costs an RC page load if it is wrong, measured in production on
  Windows/149. It says nothing about the true-positive half.

### FORCING A RAMP IS **DENIED** TO AN UNATTENDED SESSION — this is the blocker

`restart-rc` is refused by the harness classifier as **"Interfere With Workloads"**. That is a
permission denial, not a technical failure, and it is not to be worked around. `test-login` is
not a substitute (below). **So a session with no human present cannot produce the event the cure
needs**, and the proof waits on either a natural ramp or somebody with permission.

- **A HUMAN CAN DO IT IN ONE COMMAND**, and this is the single highest-value thing to ask for:
  `npx tsx scripts/bot-ask.mts restart-rc`, which makes a COLD browser loading RC's home page —
  the young-population shape, **2-for-4** as a deliberate lever. **Pace at ~15 minutes**:
  `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves the RC pair dead. Never
  inside the T−3h warm-up window of a real release.
- **Do not quote the 2-for-4 as today's rate.** The two hits were 09-09 and 09-10, while the
  young/burst population was live; it has not occurred naturally since **09-15 09:04**.

### THE ONE FREE TRIGGER ON THE CALENDAR IS THE 14:30 UTC AUTO-LOGIN — and it will probably miss

A **real user's hold** (`#A124`, unit 4642, rc-357, `requested`, with a fairness-line rival
behind it) releases at **15:00 UTC / 08:00 PT**, so `maybeAutoLogin` fires at **T−30 = 14:30**.
It is an Okta navigation that costs nothing and needs nobody. Both capture watches are armed.

**PREDICTED, SO IT CAN BE FALSIFIED: no ramp.** Okta's window read `11.9999h` (rolling) with an
expiry of **18:49 UTC**, four hours past the trip — so the sign-in is answered from the `idx`
cookie, which is the **11-second, +24 MB** cell and **has never been observed to ramp**. All
three ramping trips on record are `okta=GONE` password forms.

- **It is not zero:** the browser will be ~10 hours old, inside the 52-611 min old band, and what
  kind of trip the 611-minute ramp was making was never recorded.
- **READ IT WITH THE ATTRIBUTION RULE** (`CLAUDE.md` → "THE CURE WATCHES ONE RENDERER OF TWO").
  `maybeAutoLogin` runs in a **throwaway tab** and the cure probes **`residentPage` only**, so a
  ramp in the trip's own renderer is invisible to it — and correctly so, because
  `closeTabBounded` in the `finally` already reclaims that one. **"The cure did not fire" is not
  a verdict on the cure until the ramp is attributed to a renderer.**
- **THE BOX IS HELD UNTIL 15:00.** No `restart-rc`, no `kill-chrome`, no box update, no test
  hold — a stranger is waiting on that campsite and the session takes ~11 minutes to recover
  from a restart.

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

**26 hours with no ramp** (last 09-16 03:51) against a 2.3-18.6 h gap range, and hourly peak
commit flat at **7,200-7,800 MB** throughout. The explanation is read off three instruments:

- **TRIPS FIRED CONSTANTLY AND THEN STOPPED.** `bot_events` carries 33 `tab-close` events in 30
  hours — eleven at 68.3-69.6 s (09-16 17:39 to 22:43), then eight at <=49 s (09-17 00:13 to
  04:31), then **nothing**. The 21-second step-down is now nineteen samples rather than one, and
  **even the 69 s band did not ramp.**
- **THE SILENCE IS THE SPA RE-MINTING, IN THE KEEP-WARM'S OWN LOG.** `token exp in 2m` at
  05:29:26 then `token exp in 41m` at 05:49:26 with **`renewed=no`**. `planRenewal` stands down
  while a token is alive, so there is no Okta trip to be the trigger. **That regime has been
  measured to run TEN HOURS.**
- **AND THE OLD-BAND WAIT HAS ALREADY BEEN RUN AND LOST.** `request-counts` carries `ageMs` at
  every graceful teardown: **a browser lived 704.2 minutes on 09-16 and produced nothing** — the
  longest life on record, the top of the 52-611 min band. So "let a browser age" is not an
  experiment waiting to run.

### THE SCAN IS BLIND — READ `commit_used_mb`, NOT `rc_mb`

`chromium_memory_samples.rc_mb` has been **NULL since 09-17 04:15:30** and the sampler names its
own cause on every tick in the `bot` log: *"8 Chromium had an unreadable command line — this
process may not be elevated"*. One contiguous run after 398 clean samples. `commit_used_mb` is
`Win32_OperatingSystem` and answers perfectly throughout (**~7,040 MB of 43,774** at baseline; a
ramp charges ~32 GiB in <=34 s and takes it to 35-47 GB).

- **So a ramp check keyed on `rc_mb` cannot see one.** Use `rc_mb >= 1500 OR commit_used_mb >= 15000`.
- **AND IT DISABLES THE WHOLE RAMP ARM, INCLUDING ITS COMMIT BAR.** `readLatestMemory` refuses
  the entire reading on a missing rc figure and both arms gate on `known`. **The cure, `HUNG_MS`
  and the RAM arm are unaffected**, so the protection order is cure, `HUNG_MS`, (ramp arm, dead),
  RAM arm. **That makes the box the cleanest test bed it will ever be** — a ramp arriving while
  this holds is uncontested — and the state is not durable, so it is an argument for spending an
  event rather than saving one. Recorded and deliberately NOT fixed: it is the arm that exits the
  process, it needs a box update, and a real user hold releases at 15:00 UTC.
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

### DO NOT UPDATE THE BOX BEFORE THE 15:00 UTC HOLD RESOLVES

The near-miss logging, the six event fields and the recycle-budget decay all reach the box only
on an update. **Wait anyway**, and the reasoning is worth keeping because I reversed it twice.

- **An update runs `stop-all`**, which ends the RC session with a real user hold at 15:00 UTC and
  resets the browser to age 0 — below the 52-minute floor of the only population still firing.
- **The update window shuts at 09:00 UTC regardless** (6 h before the release), and the box takes
  updates itself in the 02:00-05:00 PT quiet window once nothing is queued.
- **If the cure fires before the next update it still reports honestly** — `memKnown: false`,
  `memWhy: "memory reading has no rc figure"`, `commitUsedMb: null`. The discriminator is carried
  independently by `chromium_memory_samples.commit_used_mb` at a two-minute cadence.
- **THE 14:30 AUTO-LOGIN IS THE CHEAP VARIANT, NOT A LIKELY TRIGGER.** Okta's window read
  **11.9997-11.9998 h** all session, which is the ROLLING signature, so T−30 is answered from the
  `idx` cookie in ~11 seconds. The expensive variant has ramped 3 times in 7; **the cheap one
  never has.** Call it the day's one guaranteed Okta navigation and nothing more.

### HOW TO READ THE FIRST FIRING

**Ask this ONE query before anything else. It is the whole state of the proof:**

```sql
SELECT count(*) FROM bot_events WHERE detail->>'reason' = 'wedge-recycle';   -- 0 as of 09-17 06:00
```

A ~30 s cure can fit entirely between two two-minute memory samples, so **the SERIES IS THE WRONG
INSTRUMENT** — that event is in Postgres and cannot roll out of a log window. The detector is
validated (`detail->>'reason'` resolves on 5 of 5 stored `request-counts` rows), so a zero is
about the subject, not the query.

> **PULL `bot-ask tail-log rc-keepwarm` FIRST, BEFORE ANYTHING ELSE.** The box emits
> `requestCounter.snapshot({ reason: 'wedge-recycle' })` and **nothing else** — the request
> counts and the reason. Everything that says what the firing DID is in the log, and **the log
> rolls in ~31 minutes** (measured 09-17: a 70-line read at 06:00 reached back to 05:29, almost
> all of it the two stand-down lines #358 dedupes). The capture watcher that pulls it within
> ~90 s **dies with the session that armed it**.
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

**THE RECYCLE-LOOP DEFECT IS FIXED ON THE BRANCH (`1720e8b`) AND IS STILL LIVE ON THE BOX.**
`WEDGE_MAX_RECYCLES` could never bind — `wedge` was reset on every reopen and every recycle
*produces* a reopen — so `escalate` was dead code and a page that wedges within 30 s of each
fresh load would recycle, reopen and wedge for ever, invisible to `supervise.ps1` because the
process never exits. The fix is `decayedRecycles` (30 m). **Until the box updates: a second
`wedge-recycle` within minutes is that loop**, and `restart-rc` breaks it.

### If a reading IS wanted at a known moment, in order of cost

1. **`rc-test-hold.mts --in 120`** — the only recipe with a recorded hit rate (**3 in 7**). It
   needs **`okta=GONE` AND a dead token**, opens the T−3h..T−30 warm-up window at once with
   ninety minutes of margin, and the hold is deleted the moment the trip is under way so nothing
   is carted. **It refuses while a real hold is live.**
2. **`restart-rc`** — cheapest by far (no campsite, no password, no Okta precondition), **and
   DENIED to an unattended session.** Ask a human.
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

## 1. State — re-verified 2026-09-16, 09:20 PT

| | |
|---|---|
| master | `1b877df`. **No open PRs. One open issue, #243** (worker-deploy goes red when Fly REPLACES a machine rather than updating it — cosmetic; `/api/health/status` is the authority on a red deploy, not the tick). **Verify against `origin/master`, this line ages.** |
| mini-PC | **`7bce397`; web is `1b877df`.** `autocart.bot_version` warns, and as of #355 it reads **"MISSING bot-side changes"** rather than "no bot-side code in the gap" — because for the first time in a fortnight there genuinely IS some: `page-wedge.mjs` and the arm in `rc-keepwarm.mjs`. **So this is the one warn that IS worth acting on, and §0.5 is the ordered task.** It still costs the RC session (~11 min to repair itself unattended) and is still refused inside 6h of a release, so check `autocart.rc_runner` says *no holds due* first. The box also takes it by itself in the 02:00-05:00 PT quiet window — which is how the last bot-side change arrived — so waiting is free if nothing needs testing; **the cure needs testing.** Confirm with `bot-ask git-status`, never this column (it COALESCEs and can show a stale sha beside a live heartbeat). |
| health | **16 of 19 ok.** Overall reads `degraded`, which is simply what three warns render as. **Two of the three are the documented-benign set; `bot_version` is not, as of #355** — see below. |
| fleet | worker heartbeat **6s**, **11 watches**; `poller.shards` **3/3 held**; `poller.capacity` **7/12 across 3 machines, 5 slots free**; watchdog **both tasks firing**. |
| holds | **none live, and none at all in the last 24h** — the readout prints `0 row(s)`, which is the ordinary quiet state and not a broken query. So the **02:00–05:00 PT update window is open**. |
| login rehearsal | **PASSING four nights running** — ✓ 09-13, 09-14, 09-15 and **09-16 03:00**. The bot can still sign itself in; this is the standing evidence for it. |
| the leak | **DIAGNOSED, CONTAINED, AND THE *DURATION* IS CURED — still NOT eliminated.** §2. The page-wedge arm (2026-09-16) closes a wedged page and releases its mappings in seconds; A is built, B is answered and off, **C is now built**. |
| migrations | highest **`078`**. **Main's block is `077-079`, so `079` is the ONLY number left in it** — the main-lane migration after that needs a new block claimed out loud in `docs/LANES.md` first. Side lane `080+`. |

**TWO OF THE THREE WARNS ARE ORDINARY AND EACH HAS A DESTRUCTIVE-LOOKING REMEDY — do not act on
those two. The third changed on 2026-09-16 and is now real.**

- **`autocart.rc_session` — dead 3h00m, `okta session GONE (404)`.** This is the ordinary
  between-releases state with nothing queued: the RC token lives ~1h, and `maybeAutoLogin` gets a
  new one at T−30 of a real hold. **The hold readout prints "only a human sign-in restores it" and
  that line must not be acted on** — `rc-login.bat` force-kills the Chromium the token lives in,
  and that reading has sent people to the box twice over sessions that repaired themselves.
- **`autocart.rc_login` — "no rehearsal has PASSED in 12h25m".** A 03:53 run **skipped** because the
  browser had just been killed (*"a rehearsal now would test the restart, not the login"*), so the
  last PASS is 03:00 the same morning. A stand-down is not a failure.
- **`autocart.bot_version` — box `7bce397`, web `1b877df`. THIS ONE IS NO LONGER BENIGN, and it is
  the only one of the three that changed.** Its detail read *"No bot-side code in the gap"* while
  the gap was three docs PRs; #355 put real bot-side code in it, so it now reads **"MISSING
  bot-side changes"** and means what it says. **Act on it — §0.5.** The other two bullets above
  stand unchanged, and their remedies are still the destructive ones not to reach for.

**AND DO NOT READ A RED `autocart.rc_session` WITHIN A FEW MINUTES OF A MERGE AS A REAL DEAD
SESSION.** A numeric `carted` test fixture (`REAL = '0'`, five minutes out) passes `REAL_UNIT`, so
for the length of any `npm test` run — CI on every merge included — the health route counts a hold
ahead and the check reddens over a session with nothing wrong with it. Check whether a Verify run
was in flight first. Full entry in CLAUDE.md.

---

## 2. The leak — DIAGNOSED, CONTAINED, AND THE DURATION CURED. **IT IS NOT ELIMINATED.** Read before touching anything memory-related.

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
  by this line** — it is 2-for-2, needs no Okta precondition and locks no campsite, and §0.5 is
  the one thing outstanding that needs a ramp.
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
**`CLAUDE.md` → "THE CURE: RECYCLE THE WEDGED PAGE, NOT THE BROWSER" is the full account.**

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
RC's home page, which is the shape the 02:0x cluster turned out to be, and it is **2-for-2**
against a 10% pooled base rate — no campsite, no password submission, no Okta precondition.
**Pace it at ~15 minutes**: `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves
the RC pair dead. n=2, so it is a working lever and not a rate.

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
    the missing mirror fixture) are in CLAUDE.md → **"THE CANCELLATION BADGE MISSES THE ONLY
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
    enforcement* is BR/ID/SG/TH-only until 2027. **Quote the row, not the date** — CLAUDE.md →
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
  group). CLAUDE.md → "THE APPLE PURCHASE CHAIN IS PROVEN". **What is still unexercised is a REAL
  `PRODUCTION` purchase**, carrying the two known gaps below.
- **iOS `1.0 (27)` IS BACK IN THE QUEUE — RESUBMITTED 2026-09-15, SIX ITEMS, NOTHING OUTSTANDING.**
  Apple rejected it that morning on **3.1.2**, no Terms of Use (EULA) link in the App Store
  metadata — an AUTOMATED pre-check, so **nothing about the app was adjudicated** for the third
  submission running. The description genuinely carried no ToU, EULA or Privacy link at all
  (checked, not conceded), and the requirement did not exist before the four IAP products joined a
  submission, so nothing regressed. Fixed with two lines in one field; `src/lib/store-listing.test.mts`
  guards it. Submission `e77ec119-c61f-4e2c-87d0-da4f98859958`, all six **Waiting for Review**,
  same binary. **There is no console work pending — do not go looking for any.**
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
    CLAUDE.md → "SAVING THE METADATA DOES NOT RESOLVE THE ITEM".
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
  Standing facts, unchanged — and read CLAUDE.md → "THE SUBMISSION STATE, WRITTEN DOWN BECAUSE IT
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
- **`sqlit` interpolates, it does not bind**, and throws on a plain object — stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
