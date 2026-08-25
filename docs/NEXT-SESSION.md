# Next session — start here

*Rewritten 2026-08-25, 11:45 PT. Supersedes the 08-24 version entirely.*

> ## THERE IS ASSIGNED WORK THIS TIME. Ground yourself first (§0–§1), then start §2.
>
> The owner's instruction, verbatim: *"start track a trail do whatever we need to fix leak.
> Update box when needed and do tests to stress test."*
>
> That is a **go-ahead for the leak work**, including bot-side changes and box updates. It is
> **not** a go-ahead for Track B (§5) — that is still surgery on the release-critical login
> path and wants its own word.
>
> Read §0 and §1 before touching anything. §1 is short and it is the reason the obvious plan
> (queue a hold, force a ramp, read the sampler) **does not work**.

*Delete this file once the trail has captured a real ramp AND the App Store version has a
decision. It is a handover, not a permanent doc, and a stale one reads like current state.*

---

## 0. Ground yourself — in this order

### 0a. Can you reach production?

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"        # recentRelayFailures names blocked hosts
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://camphawk.app/
```

**Egress was healthy 2026-08-25** — camphawk.app 200, Supabase reachable, bot commands
answering. Only `mcp.vercel.com`, `mcp.sentry.dev` and `flyctl-metrics.fly.dev` are denied.

**It has been revoked mid-session before** (08-23/08-24: 403 to CONNECT for camphawk.app,
`*.supabase.co` and `fly.io`, outliving a session restart). If it is blocked: **report the
hosts and stop.** Do not retry or route around it. The readout scripts fail loudly on an
unreachable DB (`DB query error`, exit 1), so an empty answer is always a real answer.

- **`notifications` is unreadable from an agent session** — RLS answers `policy context
  unavailable`. It fails loudly. Do not plan a verification around it.
- **`GITHUB_TOKEN` is a 14-character placeholder and `GET /user` returns 200.** That is a
  false positive. Anything repo-scoped 403s. Use the GitHub MCP tools.

### 0b. The four readings that tell you where things stand

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts        # the 8am flow
NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts    # Track A (widen the window)
NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts # the ramp series
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status      # what the box is running
```

All of these run **here**, in a sandbox session — `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are already process env vars. **Not on the mini-PC**: nothing under
`scripts/auto-cart-bot/` touches Supabase, and `VAR=1 npx …` is bash syntax that silently does
nothing in cmd.

`NODE_USE_ENV_PROXY=1` is a sandbox-only prefix (it points Node's fetch at the agent proxy).

---

## 1. WHY THE OBVIOUS PLAN DOES NOT WORK — read this before designing anything

**Track A is blind to the ramps by construction.** Established 2026-08-25 and written up in
`CLAUDE.md` → *"THE CONTENTION TEST RAN ITSELF, AND TRACK A WAS POINTED THE WRONG WAY"*.

Three ramps happened on their own in 30 hours:

```
08-24 19:37→19:43   peak 7,250 MB   free 2,217   commit 95%   pid 15092
08-25 02:30→02:40   peak 8,312 MB   free 2,473   commit 98%   pid  1296
08-25 07:31→07:37   peak 7,471 MB   free 2,144   commit 99%   pid 13296
```

Track A has exactly three stored readings — one per ramp hour — and **every one says "this
navigation did NOT ramp"**, and every one sits outside its ramp window.

**The cause:** `reportNativeAlloc` (`rc-keepwarm.mjs` ~1665) fires on the **return path**, after
`attemptLogin`/`renewSession` returns, and is gated on `ramΔ ≤ −400 MB`. A trip killed mid-ramp
never returns, so it never reports. The instrument therefore records, **by selection**, the cheap
retry that *follows* a ramp.

### Three consequences, and they shape the whole job

1. **DO NOT queue a test hold to force a ramp.** Three arrived free of charge and were all
   missed. A staged one would be missed identically, and it locks a real campsite to do it.
2. **THE RAMPING RENDERER MAY NOT BE THE TAB WE SAMPLE.** On 08-25 02:31 the renewal's throwaway
   tab reported **17 MB** of renderer allocation while the family's renderers reached **8,052 MB**
   — and the climb continued for eight minutes after the reading was stored. **CANDIDATE, NOT A
   FINDING:** the allocation is in the **resident page's** renderer, not the throwaway tab's.
   If that is right, PR #142's "first cure" (move the Okta trip into a throwaway tab so the
   renderer dies at close) is aimed at the wrong renderer — which would explain why ramps
   continued after it shipped. **Do not write this in as fact. The trail is what settles it.**
3. **THE GUARD IS NOT A USABLE REPORTING TRIGGER.** The RAM arm needs
   `stalledMs > 60s && freeMb < 2000`. Troughs were 2,217 / 2,473 / 2,144 — it came within
   **144 MB** and did not fire, on six consecutive ramps now. A trail that only prints when the
   guard trips would print never.

---

## 2. THE ASSIGNMENT — the Track A trail

**Goal: one attributed reading from inside a real ramp.** Everything else follows from it.

### 2a. The design, and why it is this shape

The pattern already exists twice in the same function. `rc-keepwarm.mjs` ~2268 runs
`setInterval(renew, WATCHDOG_MS = 10_000)` and on every tick it already:

- samples the **heap trail** via `sampleHeap(heapProbe)` — CDP, and it **freezes** once the
  browser stops answering (measured: newest sample 123s old against a 121s stall);
- samples the **RAM trail** via `os.freemem()` — a syscall, so it never stops answering;
- keeps the last `TRAIL_KEEP` of each and prints both when the RUNAWAY arm fires.

**The native-allocation trail is the same move, one slot over**: sample
`readNativeProfile(sampler)` on that tick, keep the last N, diff against the oldest.

Three things it must get right, each of which is a way this quietly buys nothing:

- **REPORT ON A TRIGGER THAT ACTUALLY FIRES.** Per §1.3, not the RAM arm. The strongest
  candidate is the **post-Okta recycle** (`visitedOkta` → break → reopen): the `gpu-process`
  pid changes across **all six** recorded ramps, so a browser replacement is the one event
  observed to coincide with every single one. A free-RAM-drop threshold read off the RAM trail
  (already sampled, already on this tick) is a reasonable second trigger. Consider both.
- **SAMPLE THE RESIDENT RENDERER, NOT ONLY THE TAB.** See §1.2. `startNativeSampling` currently
  has two call sites (`maybeAutoLogin` ~1232, the renewal tab ~2708) plus the warm-up (~950),
  and all three sample the trip's own renderer. If the resident page is what ramps, none of
  them can see it. **`Memory.startSampling` is absent on the browser-process target** — verified,
  so a reading covers renderers only and the line must say so, as the current one does.
- **FIRE-AND-FORGET WITH AN IN-FLIGHT FLAG.** The timer must never await: once the browser goes
  quiet, every attempt costs its full timeout and they pile up one per tick. Copy `heapInFlight`.
- **`TRAIL_KEEP = 12` IS TOO SHORT FOR THIS EVENT, and it is not obvious.** At a 10-second tick
  that is **two minutes** of history; the ramps run **ten**. So a trail sized like the heap
  trail cannot reach back to the onset — it would show the last fifth of the climb and no
  baseline. That is exactly how the heap trail produced twelve byte-identical samples whose
  newest was already 123s stale. Size the native trail for the event (~10 min of coverage), or
  sample it on a slower sub-cadence than the tick. **Do not reuse `TRAIL_KEEP` unthinkingly.**

`worker/warmup-sampler.test.mts` enumerates every `attemptLogin`/`renewSession` call and requires
each to be sampled or listed in `EXCEPTIONS`. **Extend that guard rather than pinning the new
trail specifically** — a guard that pins one path is the fifth instance of the house shape.

### 2b. Shipping it to the box

Bot-side, so it does nothing until the mini-PC updates.

- **"Update now"** from Admin → System Health, or the quiet window **02:00–05:00 PT**.
- **The 6h release gate is NOT liftable.** A queued hold within 6h of its release refuses the
  update, and that refusal is correct — it is not the 08-12 deadlock.
- **`autocart.bot_version` is a hint, not an answer.** `bot_commit` is COALESCEd and can sit
  stale beside a live heartbeat. `git-status` through `bot_commands` is what answers "did it
  land?".
- Updates have been landing in **~24 seconds** when the lockfile has not moved.

### 2c. Stress testing — what "stress" can honestly mean here

The owner asked for stress tests. **The ramps are the stress, and they arrive ~3× a day
unprompted.** So the test is: ship the trail, update the box, and read the next ramp.

- **The series is the trigger to watch.** `chromium_memory_samples` at 2-minute cadence shows a
  ramp as ~5 samples climbing over ~10 minutes. Poll the memory readout; when a ramp appears,
  the trail should have a reading for it. **A ramp in the series with nothing in
  `native_alloc_readings` means the trail missed it too** — which is itself the reading, and it
  says the trigger is wrong.
- **What would legitimately be staged:** nothing that locks a campsite. If a ramp must be
  provoked, the mechanism is an Okta navigation with Okta GONE — and Okta's expiry is currently
  **rolling** (our own liveness probe refreshes a 12h window; there is an absolute cap behind it
  that has not been characterised). There is **no non-destructive lever** to end the Okta
  session: `restart-rc` and `kill-chrome` leave the profile intact, and `rc-login.bat` kills the
  Chromium the token lives in. **Wait for the cap; do not force it.**
- **Do NOT lower or raise the RAM floor as part of this.** `keepwarm-recycle.test.mts` bounds it
  1500–3000 with recorded reasoning, and moving the trip point is what killed a working repair
  on 2026-08-19. If the trail's evidence argues for changing it, that is a separate, deliberate
  change with its own write-up.

---

## 3. State

| | |
|---|---|
| Master | **`53f1476`** |
| Branch | **`claude/main-lane-docs-0824` @ `07c8fe9` — PUSHED, UNMERGED.** Two commits ahead. Merge it first. |
| Mini-PC | **`18bb337`** |
| Open PRs | none |
| Open issues | **#76**, **#14** |
| Migrations | highest applied **068**; next main-lane number is **069** (`070` is an old side-lane block claim). LANES.md's "next is 060" is stale. |
| Holds | none live. The 08-25 release completed; `expire-holds.ts` sweeps from Fly every 60s. |

The two unmerged commits are docs, comments and one guard — the corrections from 08-25. Nothing
in them needs to reach the mini-PC.

**Two check-ins are scheduled and enabled — do not create duplicates.**
`trig_01NdJC1SvSDwxZZroAooVKnU` fires **07:40 PT** into a fresh session and notifies the owner's
phone. `trig_01CzPKmDUz5MC3tbYFGMTS4a` fires **08:15 PT** into the persistent session with the
outcome readout.

### What happened on 2026-08-25, in one paragraph

The 08:00 release worked: Morro Bay #96 carted at **T+2s**. The fairness line's first live
contest resolved correctly (rank 1 never tapped, so `dueHolds` served rank 2). The owner
deliberately did not claim, which measured something useful — **the unclaimed release at 45
minutes is `expireStaleHolds(45)`, OURS**, with RC answering HTTP 200. So the expiry cascade was
never blocked on RC's unmeasurable cart lapse; it is now purely the owner's call.

---

## 4. Serial rules — binding whenever a hold is queued

From `docs/LANES.md`:

- **No `npm test`** while a hold is live (production DB; it races production's own sweeps).
- **No second test hold.**
- **Nothing that restarts the box** — "Update now", `update.bat`, `restart-rc`, `kill-chrome`.

There is no side lane running as of 2026-08-25, so the box is yours — but check `ListAgents`
before taking it.

---

## 5. Track B — designed, NOT started, needs its own go-ahead

Replay the Okta round trip over `ctx.request` following redirects, exchange the code ourselves:
no page load, no renderer, no gigabytes. Three pieces already exist (we intercept `/authorize`
in `force-login-prompt.mjs`, we read `code_verifier` off the token POST in `rc-token.mjs:108`,
and okta-auth-js's `okta-transaction-storage` is known to the code).

**Still not started deliberately.** It is surgery on the one path between a queued hold and a
missed cart, and **the renderer-only sampler cannot see the browser-process share** — 545 MB of
2,046 on the one event where both were measured. If the growth is there, `ctx.request` may be
the wrong lever entirely. The trail (§2) is what makes this decidable. Building it blind is how
a repair gets credited to the wrong mechanism, which has happened three times.

---

## 6. Recorded, not fixed — do not drive-by these

- **A CI run can turn `autocart.rc_session` RED.** The health route carries its own inline
  `upcoming`/`imminent` counts that never got the `REAL_UNIT` filter, so test fixtures are
  visible to it. The phone is safe (`holdAtRisk` IS filtered); the dashboard is not, and while
  red it prints the destructive `rc-login.bat` remedy over a healthy session. Bounded to the
  length of a run. **The honest fix is one definition instead of three.**
- **The rec.gov `carted` SMS body overflows one segment for 19 campgrounds** (long names, and it
  deliberately does not go through `fitOneSegment` — it is the 08-05 delivery control). Pinned by
  `sms-body.test.mts`; changing it is a decision about the auto-cart path.
- **A token rebroadcast can clear an `expired` verdict** in the claim gate. The honest remedy is
  a sticky `expired` for the run, not refusing unknowns (that locks out older bundles).
- **The live manage token `EQO2oXcQ`** — unrotated, still returns 200, and in git history.
  Rotation is one DELETE from `action_tokens`. **Owner's call**, five sessions running.
- **#76** — `rc-holds.test.mts`'s fixture sweep deletes a concurrent run's live rows.
- **#14** — rec.gov timeout cascade.

---

## 7. Traps that have actually fired

- **`GITHUB_TOKEN` is a 14-character placeholder and `/user` returns 200.** A false positive.
  Repo-scoped calls 403. Use the MCP tools. It once cost a CI watchdog that parsed the refusal
  as "nothing terminal yet" and would have reported `TIMEOUT` on healthy CI.
- **Verify a push against the remote, not local HEAD.** `echo $(git rev-parse --short HEAD)`
  after a push echoes the local sha whatever happened. Use
  `git fetch origin <branch> && git rev-parse origin/<branch>`. This cost a PR containing none
  of its change.
- **Read the readout's `site` column.** `TEST · ` in `unit_name` is written only by
  `rc-test-hold.mts` and is the one unambiguous fixture marker.
- **`claimed` in the readout is `claimed_at ?? released_at`.** A time there does not mean the
  hold was claimed.
- **A guard can pass vacuously.** Every mutation must be verified to APPLY (grep for it) as well
  as to fail. Twenty-three instances of a guard anchored on the wrong thing are recorded in
  `CLAUDE.md`; several matched an import line, a comment, or a function definition instead of
  the call site.
- **`sqlit` interpolates, it does not bind**, and throws on a plain object. Stringify jsonb.
- **No non-ASCII in `.ps1` files**, no `\"` inside a `powershell -Command` string in a `.bat`,
  and no backticks in a SQL comment inside a template literal.
