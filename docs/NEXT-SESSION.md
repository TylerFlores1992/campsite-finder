# Next session — start here

*Rewritten 2026-08-25 evening; state refreshed 2026-08-26 12:25 PT.*

> ## ONE BUG TO BUILD, ONE READING TO WAIT FOR.
>
> **1. THE BUG (§1) — `dueHolds` carted one campsite TWICE.** The fairness line's first real
> contest, 08-26: both rivals served 14 seconds apart, two distinct RC cart entries, RC accepted
> both. **Designed, NOT built.** This is the top item and it is the only assigned work.
>
> **2. THE RAMP (§2).** The Track A trail is armed and has **still never produced a reading** —
> `trail-*`: **0**. **It has now MISSED TWO RAMPS, not one** (08-25 20:22, ~3.6 GB; and 08-26
> 21:24→21:34 at **9,112 MB / 100% COMMIT**, one pid throughout), against five old
> return-path rows whose newest is 08-26 04:31. The box is alive and sampling — 2,019
> `chromium_memory_samples` rows in 60h, newest 08-27 13:36 PT — so this is a reading about
> the **TRIGGER**, not a dead instrument, and the next move is the trigger rather than the
> sampler. Two candidates the data cannot separate: CDP went quiet at the peak (it has, twice
> before, on two different calls), or gaps split the segment under the 400 MB floor.
> **Do NOT try to stage one**; §2b has the measurement that retires the obvious plan.
>
> **Nothing is live.** No holds, working tree clean. **PR #202 is open** (health-route
> `REAL_UNIT` + the fixture-safety widening) — it touches `src/lib/rc-holds.ts`, so merging
> restarts both pollers. The two 08-26 test holds ran and released themselves; what they did
> and did not prove is in §1c.
>
> Track B (§6) is still unstarted and still wants its own word.

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

## 1. THE DOUBLE-CART BUG — the top item, and it is not built

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

### 1a. The rank-2 row carried no note, so the readout looks clean
`rankHoldLine` writes "another watcher is ahead of you" only to rows already `requested`. The
runner-up was `offered` when the line was ranked and was tapped fourteen seconds later; nothing
re-ranks afterwards. **So a contest that went wrong reads as two successful carts.**

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
exercised. **`cart read back` is still proven on iOS only; Android has never been run.** That
remains the open question, and it needs a human with the app — no agent can do it.

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

**A REAL GAP, FOUND WHILE SETTING THIS UP.** `rankHoldLine` writes the "another watcher is ahead
of you" note only to rows already `requested`. At 05:50:55 the runner-up's row was still
`offered`; it was tapped fourteen seconds later, and nothing re-ranks the line unless another
offer for that unit arrives. **So the rank-2 row may carry no note at all** — which is the one
state the readout uses to tell a queue from an outage. Diagnostic only (no user-facing reader),
recorded rather than fixed mid-flight.

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

| | |
|---|---|
| Master | **`65efba5`** (#199). Trail = #193/#194; Pacific-wall-clock fix = #196; the double-cart write-up = #198. |
| Mini-PC | **`64f9f92`**, applied 13:26:42 PT 08-25. **Deliberately BEHIND master** — #195/#196 are web/worker only and nothing in them needs the box. Confirm with `bot-ask git-status`, never `autocart.bot_version` (COALESCEd, can sit stale beside a live heartbeat). |
| Fly worker | redeployed 05:47 PT 08-26 on #196; both shards beating (`shard 0/2`, `shard 1/2`). |
| Open PRs | none |
| Open issues | **#76**, **#14** |
| Migrations | highest applied **068**; next main-lane number is **069** |
| Holds | **None live.** The two 08-26 test holds released themselves at 45 min (§1c). Four untapped `offered` rows for 08-27 08:00 (`#27`, `#R354`, `#SC58`, `#R314`) — `offered` blocks nothing; a TAP blocks `npm test`, box restarts and the update window. |
| RC session | **healthy at 12:17 PT 08-26** (`okta=ALIVE`), restored 09:20 by an on-demand `test-login`. It goes dead between releases and that is NORMAL. **Do NOT run `rc-login.bat`** — `bot-ask test-login` is the safe remote lever (§1b). |

**Two check-ins are scheduled and enabled — do not create duplicates.**
`trig_01NdJC1SvSDwxZZroAooVKnU` fires **07:40 PT** into a fresh session;
`trig_01CzPKmDUz5MC3tbYFGMTS4a` fires **08:15 PT** with the outcome readout.

---

## 5. Serial rules — and the one I broke

From `docs/LANES.md`: no `npm test`, no second test hold, and nothing that restarts the box,
while a hold is live.

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
- **Three test suites sweep each other's fixtures** (`unit_id LIKE '__t%'`) and `npm test` runs
  files concurrently. That is #76, and §4 above is what it looks like in practice.
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
